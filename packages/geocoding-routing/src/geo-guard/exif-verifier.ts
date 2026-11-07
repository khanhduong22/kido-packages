import { vincentyDistance } from './geofence';
import {
  CoordinatesInput,
  ExifGpsMetadata,
  ExifVerifyContext,
  ExifVerifyOptions,
  PhotoMetadata,
  PhotoVerificationResult,
} from './schemas';

export const DEFAULT_EXIF_VERIFY_OPTIONS: ExifVerifyOptions = {
  maxDistanceMeters: 100, // Shelf photo must be taken within 100m of device GPS
  maxTimeDeltaSeconds: 600, // Shelf photo must be taken within 10 minutes (600s) of report submission
  requireGps: true,
  requireTimestamp: true,
};

/**
 * Binary helper class for reading Little/Big Endian values from raw buffer
 */
class BinaryReader {
  private buffer: Uint8Array;
  public isLittleEndian: boolean;

  constructor(buffer: Uint8Array, isLittleEndian: boolean = true) {
    this.buffer = buffer;
    this.isLittleEndian = isLittleEndian;
  }

  public getUint16(offset: number): number {
    if (offset + 2 > this.buffer.length) return 0;
    if (this.isLittleEndian) {
      return this.buffer[offset] | (this.buffer[offset + 1] << 8);
    }
    return (this.buffer[offset] << 8) | this.buffer[offset + 1];
  }

  public getUint32(offset: number): number {
    if (offset + 4 > this.buffer.length) return 0;
    if (this.isLittleEndian) {
      return (
        (this.buffer[offset] |
          (this.buffer[offset + 1] << 8) |
          (this.buffer[offset + 2] << 16) |
          (this.buffer[offset + 3] << 24)) >>>
        0
      );
    }
    return (
      ((this.buffer[offset] << 24) |
        (this.buffer[offset + 1] << 16) |
        (this.buffer[offset + 2] << 8) |
        this.buffer[offset + 3]) >>>
      0
    );
  }

  public getRational(offset: number): number {
    const num = this.getUint32(offset);
    const den = this.getUint32(offset + 4);
    if (den === 0) return 0;
    return num / den;
  }

  public getString(offset: number, length: number): string {
    if (offset + length > this.buffer.length) {
      length = Math.max(0, this.buffer.length - offset);
    }
    let str = '';
    for (let i = 0; i < length; i++) {
      const code = this.buffer[offset + i];
      if (code === 0) break; // Null terminator
      str += String.fromCharCode(code);
    }
    return str.trim();
  }
}

/**
 * Extracts EXIF metadata (GPS, DateTimeOriginal, Camera) from JPEG/HEIC binary data
 */
export function extractExifFromBuffer(data: Uint8Array | Buffer): PhotoMetadata {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);

  // Check JPEG SOI (0xFFD8)
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return { hasExif: false };
  }

  let offset = 2;
  let app1Offset = -1;

  // Scan JPEG segments for APP1 (0xFFE1)
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset++;
      continue;
    }

    const marker = bytes[offset + 1];
    if (marker === 0xe1) {
      // APP1 found
      app1Offset = offset;
      break;
    }

    if (marker === 0xda || marker === 0xd9) {
      // SOS (Start of Scan) or EOI (End of Image) reached
      break;
    }

    const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
    offset += 2 + length;
  }

  if (app1Offset === -1) {
    return { hasExif: false };
  }

  // Check Exif header "Exif\0\0" (0x45, 0x78, 0x69, 0x66, 0x00, 0x00)
  const exifHeaderOffset = app1Offset + 4;
  if (
    bytes[exifHeaderOffset] !== 0x45 ||
    bytes[exifHeaderOffset + 1] !== 0x78 ||
    bytes[exifHeaderOffset + 2] !== 0x69 ||
    bytes[exifHeaderOffset + 3] !== 0x66 ||
    bytes[exifHeaderOffset + 4] !== 0x00 ||
    bytes[exifHeaderOffset + 5] !== 0x00
  ) {
    return { hasExif: false };
  }

  // TIFF header starts 6 bytes after APP1 payload start
  const tiffStart = exifHeaderOffset + 6;
  if (tiffStart + 8 > bytes.length) {
    return { hasExif: false };
  }

  // Byte order: 0x4949 ('II' Little-Endian), 0x4D4D ('MM' Big-Endian)
  const isLittleEndian = bytes[tiffStart] === 0x49 && bytes[tiffStart + 1] === 0x49;
  const reader = new BinaryReader(bytes, isLittleEndian);

  // Validate TIFF 42 magic number
  const magic = reader.getUint16(tiffStart + 2);
  if (magic !== 0x002a && magic !== 0x2a00) {
    return { hasExif: false };
  }

  const ifd0Offset = reader.getUint32(tiffStart + 4);
  let curIfdOffset = tiffStart + ifd0Offset;

  let exifIfdOffset = -1;
  let gpsIfdOffset = -1;
  let cameraMake: string | undefined;
  let cameraModel: string | undefined;
  let software: string | undefined;

  // Read IFD0 entries
  if (curIfdOffset + 2 <= bytes.length) {
    const entryCount = reader.getUint16(curIfdOffset);
    let entryOffset = curIfdOffset + 2;

    for (let i = 0; i < entryCount && entryOffset + 12 <= bytes.length; i++, entryOffset += 12) {
      const tag = reader.getUint16(entryOffset);
      const count = reader.getUint32(entryOffset + 4);
      const valOffset = reader.getUint32(entryOffset + 8);

      if (tag === 0x010f) {
        // Make
        cameraMake = reader.getString(tiffStart + valOffset, count);
      } else if (tag === 0x0110) {
        // Model
        cameraModel = reader.getString(tiffStart + valOffset, count);
      } else if (tag === 0x0131) {
        // Software
        software = reader.getString(tiffStart + valOffset, count);
      } else if (tag === 0x8769) {
        // Exif IFD pointer
        exifIfdOffset = tiffStart + valOffset;
      } else if (tag === 0x8825) {
        // GPS IFD pointer
        gpsIfdOffset = tiffStart + valOffset;
      }
    }
  }

  let capturedAt: Date | undefined;

  // Read Exif IFD for timestamp
  if (exifIfdOffset > 0 && exifIfdOffset + 2 <= bytes.length) {
    const entryCount = reader.getUint16(exifIfdOffset);
    let entryOffset = exifIfdOffset + 2;

    for (let i = 0; i < entryCount && entryOffset + 12 <= bytes.length; i++, entryOffset += 12) {
      const tag = reader.getUint16(entryOffset);
      const count = reader.getUint32(entryOffset + 4);
      const valOffset = reader.getUint32(entryOffset + 8);

      if (tag === 0x9003 || tag === 0x9004) {
        // 0x9003: DateTimeOriginal, 0x9004: CreateDate
        const dateStr = reader.getString(tiffStart + valOffset, count);
        // Format: "YYYY:MM:DD HH:MM:SS"
        const match = dateStr.match(/^(\d{4}):(\d{2}):(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
        if (match) {
          const year = parseInt(match[1], 10);
          const month = parseInt(match[2], 10) - 1;
          const day = parseInt(match[3], 10);
          const hour = parseInt(match[4], 10);
          const min = parseInt(match[5], 10);
          const sec = parseInt(match[6], 10);
          capturedAt = new Date(year, month, day, hour, min, sec);
          break;
        }
      }
    }
  }

  let gps: ExifGpsMetadata | undefined;

  // Read GPS IFD
  if (gpsIfdOffset > 0 && gpsIfdOffset + 2 <= bytes.length) {
    const entryCount = reader.getUint16(gpsIfdOffset);
    let entryOffset = gpsIfdOffset + 2;

    let latRef: string | undefined;
    let lonRef: string | undefined;
    let rawLat: number[] | undefined;
    let rawLon: number[] | undefined;
    let altitude: number | undefined;

    for (let i = 0; i < entryCount && entryOffset + 12 <= bytes.length; i++, entryOffset += 12) {
      const tag = reader.getUint16(entryOffset);
      const valOffset = reader.getUint32(entryOffset + 8);

      if (tag === 0x0001) {
        // GPSLatitudeRef
        latRef = String.fromCharCode(bytes[entryOffset + 8]).toUpperCase();
      } else if (tag === 0x0002) {
        // GPSLatitude (3 rationals: deg, min, sec)
        const p = tiffStart + valOffset;
        rawLat = [
          reader.getRational(p),
          reader.getRational(p + 8),
          reader.getRational(p + 16),
        ];
      } else if (tag === 0x0003) {
        // GPSLongitudeRef
        lonRef = String.fromCharCode(bytes[entryOffset + 8]).toUpperCase();
      } else if (tag === 0x0004) {
        // GPSLongitude (3 rationals: deg, min, sec)
        const p = tiffStart + valOffset;
        rawLon = [
          reader.getRational(p),
          reader.getRational(p + 8),
          reader.getRational(p + 16),
        ];
      } else if (tag === 0x0006) {
        // GPSAltitude
        altitude = reader.getRational(tiffStart + valOffset);
      }
    }

    if (rawLat && rawLon) {
      let lat = rawLat[0] + rawLat[1] / 60 + rawLat[2] / 3600;
      let lon = rawLon[0] + rawLon[1] / 60 + rawLon[2] / 3600;

      if (latRef === 'S') lat = -lat;
      if (lonRef === 'W') lon = -lon;

      gps = {
        latitude: Math.round(lat * 1e7) / 1e7,
        longitude: Math.round(lon * 1e7) / 1e7,
        altitude,
      };
    }
  }

  return {
    hasExif: true,
    gps,
    capturedAt,
    cameraMake,
    cameraModel,
    software,
  };
}

/**
 * Normalizes input timestamp into milliseconds epoch
 */
function toEpochMs(value: number | string | Date): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') {
    return value < 1e11 ? value * 1000 : value;
  }
  return new Date(value).getTime();
}

/**
 * Shelf Photo Verifier
 * Matches EXIF GPS coordinates and capture timestamp against the real-time device
 * location and submission timestamp to prevent gallery upload fraud
 */
export function verifyPhotoProof(
  photoInput: Uint8Array | Buffer | PhotoMetadata,
  context: ExifVerifyContext,
  options?: Partial<ExifVerifyOptions>
): PhotoVerificationResult {
  const opts = { ...DEFAULT_EXIF_VERIFY_OPTIONS, ...options };
  const metadata: PhotoMetadata =
    'hasExif' in photoInput
      ? photoInput
      : extractExifFromBuffer(photoInput);

  const flags: string[] = [];
  const reasons: string[] = [];
  let isValid = true;
  let distanceMeters: number | undefined;
  let timeDeltaSeconds: number | undefined;

  // 1. Verify EXIF presence
  if (!metadata.hasExif) {
    flags.push('MISSING_EXIF_METADATA');
    reasons.push('Photo has no EXIF metadata (possibly stripped by messaging app or screenshot)');
    if (opts.requireGps || opts.requireTimestamp) {
      isValid = false;
    }
  }

  // 2. Verify GPS coordinates
  if (!metadata.gps) {
    flags.push('MISSING_EXIF_GPS');
    reasons.push('Photo lacks embedded GPS coordinates');
    if (opts.requireGps) {
      isValid = false;
    }
  } else {
    // Calculate distance between photo GPS and current device GPS
    const photoLocation: CoordinatesInput = {
      lat: metadata.gps.latitude,
      lon: metadata.gps.longitude,
    };

    distanceMeters = vincentyDistance(photoLocation, context.deviceCoordinates);

    if (distanceMeters > opts.maxDistanceMeters) {
      isValid = false;
      flags.push('COORDINATES_MISMATCH');
      reasons.push(
        `Photo GPS distance (${Math.round(distanceMeters)}m) exceeds maximum allowed radius (${opts.maxDistanceMeters}m) from device location`
      );
    }

    // Optional secondary check against store coordinates if provided
    if (context.storeCoordinates) {
      const storeDistance = vincentyDistance(photoLocation, context.storeCoordinates);
      if (storeDistance > opts.maxDistanceMeters) {
        flags.push('STORE_COORDINATES_MISMATCH');
        reasons.push(
          `Photo was taken ${Math.round(storeDistance)}m away from registered store location`
        );
      }
    }
  }

  // 3. Verify Capture Timestamp vs Submission Timestamp
  if (!metadata.capturedAt) {
    flags.push('MISSING_EXIF_TIMESTAMP');
    reasons.push('Photo lacks embedded capture timestamp (DateTimeOriginal)');
    if (opts.requireTimestamp) {
      isValid = false;
    }
  } else {
    const submissionMs = toEpochMs(context.submissionTimestamp);
    const photoMs = toEpochMs(metadata.capturedAt);
    timeDeltaSeconds = Math.round((submissionMs - photoMs) / 1000);

    // If photo was taken in the future by > 60 seconds (clock tampering)
    if (timeDeltaSeconds < -60) {
      isValid = false;
      flags.push('FUTURE_TIMESTAMP_DETECTED');
      reasons.push(
        `Photo capture timestamp is ${Math.abs(timeDeltaSeconds)}s in the future relative to server time`
      );
    } else if (timeDeltaSeconds > opts.maxTimeDeltaSeconds) {
      // Photo is older than max allowed age (e.g. taken hours/days ago, gallery reuse fraud)
      isValid = false;
      flags.push('PHOTO_STALE_GALLERY_FRAUD');
      const minutesAgo = Math.round(timeDeltaSeconds / 60);
      reasons.push(
        `Photo is stale (taken ${minutesAgo} minutes ago, max allowed: ${Math.round(opts.maxTimeDeltaSeconds / 60)} minutes). Rep may have selected an old photo from album`
      );
    }
  }

  if (isValid && flags.length === 0) {
    flags.push('VALID_AUTHENTIC_PHOTO');
    reasons.push('Photo verified: Live capture at store location within allowable time window');
  }

  return {
    isValid,
    flags,
    reasons,
    distanceMeters,
    timeDeltaSeconds,
    extractedMetadata: metadata,
    verifiedAt: new Date().toISOString(),
  };
}

/**
 * Utility helper to construct a synthetic JPEG image buffer with valid EXIF metadata
 * Useful for unit testing and offline verification simulations
 */
export function createSyntheticExifJpeg(options: {
  lat: number;
  lon: number;
  capturedAt?: Date;
  make?: string;
  model?: string;
}): Buffer {
  const date = options.capturedAt ?? new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  const dateStr = `${date.getFullYear()}:${pad(date.getMonth() + 1)}:${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}\0`;

  const make = (options.make ?? 'Samsung') + '\0';
  const model = (options.model ?? 'Galaxy S24') + '\0';

  // Coordinate decomposition
  const absLat = Math.abs(options.lat);
  const latDeg = Math.floor(absLat);
  const latMin = Math.floor((absLat - latDeg) * 60);
  const latSec = Math.round(((absLat - latDeg) * 60 - latMin) * 60 * 1000); // in 1/1000 sec
  const latRef = options.lat >= 0 ? 'N' : 'S';

  const absLon = Math.abs(options.lon);
  const lonDeg = Math.floor(absLon);
  const lonMin = Math.floor((absLon - lonDeg) * 60);
  const lonSec = Math.round(((absLon - lonDeg) * 60 - lonMin) * 60 * 1000);
  const lonRef = options.lon >= 0 ? 'E' : 'W';

  // Build binary buffer in Little-Endian ('II')
  // Layout:
  // [0..1] SOI 0xFF, 0xD8
  // [2..3] APP1 0xFF, 0xE1
  // [4..5] APP1 length
  // [6..11] "Exif\0\0"
  // [12..] TIFF header:
  //   0: "II" (0x49, 0x49)
  //   2: 0x002A
  //   4: IFD0 offset = 8
  //   8: IFD0 entry count = 4
  //      Tag 0x010F (Make), Tag 0x0110 (Model), Tag 0x8769 (ExifIFD), Tag 0x8825 (GPSIFD)
  //   ExifIFD:
  //      Tag 0x9003 (DateTimeOriginal)
  //   GPSIFD:
  //      Tag 0x0001 (LatRef), Tag 0x0002 (Lat), Tag 0x0003 (LonRef), Tag 0x0004 (Lon)

  // Allocate 1024 bytes buffer
  const buf = Buffer.alloc(1024, 0);

  // SOI
  buf[0] = 0xff;
  buf[1] = 0xd8;

  // APP1 marker
  buf[2] = 0xff;
  buf[3] = 0xe1;

  // "Exif\0\0"
  buf.write('Exif\0\0', 6, 'ascii');

  const tiffStart = 12;
  // Byte order Little-Endian
  buf[tiffStart] = 0x49;
  buf[tiffStart + 1] = 0x49;
  buf.writeUInt16LE(0x002a, tiffStart + 2);
  buf.writeUInt32LE(8, tiffStart + 4); // IFD0 offset relative to tiffStart

  let p = tiffStart + 8; // Start of IFD0
  const numIfd0Entries = 4;
  buf.writeUInt16LE(numIfd0Entries, p);
  p += 2;

  // Entry 1: Make (0x010F)
  const makeOffset = 250;
  buf.writeUInt16LE(0x010f, p);
  buf.writeUInt16LE(2, p + 2); // ASCII
  buf.writeUInt32LE(make.length, p + 4);
  buf.writeUInt32LE(makeOffset, p + 8);
  buf.write(make, tiffStart + makeOffset, 'ascii');
  p += 12;

  // Entry 2: Model (0x0110)
  const modelOffset = 280;
  buf.writeUInt16LE(0x0110, p);
  buf.writeUInt16LE(2, p + 2);
  buf.writeUInt32LE(model.length, p + 4);
  buf.writeUInt32LE(modelOffset, p + 8);
  buf.write(model, tiffStart + modelOffset, 'ascii');
  p += 12;

  // Entry 3: ExifIFD (0x8769)
  const exifIfdOffset = 100;
  buf.writeUInt16LE(0x8769, p);
  buf.writeUInt16LE(4, p + 2); // LONG
  buf.writeUInt32LE(1, p + 4);
  buf.writeUInt32LE(exifIfdOffset, p + 8);
  p += 12;

  // Entry 4: GPSIFD (0x8825)
  const gpsIfdOffset = 150;
  buf.writeUInt16LE(0x8825, p);
  buf.writeUInt16LE(4, p + 2); // LONG
  buf.writeUInt32LE(1, p + 4);
  buf.writeUInt32LE(gpsIfdOffset, p + 8);
  p += 12;

  // Next IFD offset = 0
  buf.writeUInt32LE(0, p);

  // Write ExifIFD at exifIfdOffset
  let ep = tiffStart + exifIfdOffset;
  buf.writeUInt16LE(1, ep); // 1 entry
  ep += 2;

  // Tag 0x9003 DateTimeOriginal
  const dateStrOffset = 320;
  buf.writeUInt16LE(0x9003, ep);
  buf.writeUInt16LE(2, ep + 2); // ASCII
  buf.writeUInt32LE(dateStr.length, ep + 4);
  buf.writeUInt32LE(dateStrOffset, ep + 8);
  buf.write(dateStr, tiffStart + dateStrOffset, 'ascii');

  // Write GPSIFD at gpsIfdOffset
  let gp = tiffStart + gpsIfdOffset;
  buf.writeUInt16LE(4, gp); // 4 entries
  gp += 2;

  // GPS Tag 0x0001: GPSLatitudeRef
  buf.writeUInt16LE(0x0001, gp);
  buf.writeUInt16LE(2, gp + 2); // ASCII
  buf.writeUInt32LE(2, gp + 4);
  buf[gp + 8] = latRef.charCodeAt(0);
  buf[gp + 9] = 0;
  gp += 12;

  // GPS Tag 0x0002: GPSLatitude
  const latDataOffset = 360;
  buf.writeUInt16LE(0x0002, gp);
  buf.writeUInt16LE(5, gp + 2); // RATIONAL
  buf.writeUInt32LE(3, gp + 4);
  buf.writeUInt32LE(latDataOffset, gp + 8);
  // Write 3 rationals for Lat
  let lp = tiffStart + latDataOffset;
  buf.writeUInt32LE(latDeg, lp);
  buf.writeUInt32LE(1, lp + 4);
  buf.writeUInt32LE(latMin, lp + 8);
  buf.writeUInt32LE(1, lp + 12);
  buf.writeUInt32LE(latSec, lp + 16);
  buf.writeUInt32LE(1000, lp + 20);
  gp += 12;

  // GPS Tag 0x0003: GPSLongitudeRef
  buf.writeUInt16LE(0x0003, gp);
  buf.writeUInt16LE(2, gp + 2); // ASCII
  buf.writeUInt32LE(2, gp + 4);
  buf[gp + 8] = lonRef.charCodeAt(0);
  buf[gp + 9] = 0;
  gp += 12;

  // GPS Tag 0x0004: GPSLongitude
  const lonDataOffset = 400;
  buf.writeUInt16LE(0x0004, gp);
  buf.writeUInt16LE(5, gp + 2); // RATIONAL
  buf.writeUInt32LE(3, gp + 4);
  buf.writeUInt32LE(lonDataOffset, gp + 8);
  // Write 3 rationals for Lon
  let lnp = tiffStart + lonDataOffset;
  buf.writeUInt32LE(lonDeg, lnp);
  buf.writeUInt32LE(1, lnp + 4);
  buf.writeUInt32LE(lonMin, lnp + 8);
  buf.writeUInt32LE(1, lnp + 12);
  buf.writeUInt32LE(lonSec, lnp + 16);
  buf.writeUInt32LE(1000, lnp + 20);
  gp += 12;

  // Set APP1 length: from byte 4 to total APP1 payload
  const app1PayloadLength = 480;
  buf.writeUInt16BE(app1PayloadLength + 2, 4);

  // Append JPEG EOI (0xFF, 0xD9) at the end
  const totalLength = 6 + app1PayloadLength;
  buf[totalLength] = 0xff;
  buf[totalLength + 1] = 0xd9;

  return buf.subarray(0, totalLength + 2);
}
