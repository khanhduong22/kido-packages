import { z } from 'zod';

/**
 * Pure universal FIPS 180-4 SHA-256 hex digest (zero `node:crypto` dependency so
 * `@kido/bom-inventory` bundles cleanly in both Browser Vite/Rollup and Node/Bun).
 */
function sha256Hex(input: string): string {
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const rotr = (n: number, x: number) => (x >>> n) | (x << (32 - n));
  const bytes = new TextEncoder().encode(input);
  const bitLen = bytes.length * 8;
  const padLen = (((bytes.length + 8) >> 6) + 1) << 6;
  const buf = new Uint8Array(padLen);
  buf.set(bytes);
  buf[bytes.length] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(padLen - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(padLen - 4, bitLen >>> 0, false);

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const W = new Uint32Array(64);

  for (let i = 0; i < padLen; i += 64) {
    for (let t = 0; t < 16; t++) W[t] = view.getUint32(i + t * 4, false);
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(7, W[t - 15]) ^ rotr(18, W[t - 15]) ^ (W[t - 15] >>> 3);
      const s1 = rotr(17, W[t - 2]) ^ rotr(19, W[t - 2]) ^ (W[t - 2] >>> 10);
      W[t] = (W[t - 16] + s0 + W[t - 7] + s1) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(6, e) ^ rotr(11, e) ^ rotr(25, e);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[t] + W[t]) >>> 0;
      const S0 = rotr(2, a) ^ rotr(13, a) ^ rotr(22, a);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7].map((v) => v.toString(16).padStart(8, '0')).join('');
}

export const SupportedCarrierSchema = z.enum([
  'GHN',
  'VIETTEL_POST',
  'SPX',
  'J_AND_T',
  'VNPOST',
  'OTHER',
]);

export type SupportedCarrier = z.infer<typeof SupportedCarrierSchema>;

export const CarrierNameMap: Record<SupportedCarrier, string> = {
  GHN: 'Giao Hàng Nhanh (GHN Express)',
  VIETTEL_POST: 'Viettel Post',
  SPX: 'SPX Express (Shopee Xpress)',
  J_AND_T: 'J&T Express',
  VNPOST: 'Vietnam Post (Bưu điện Việt Nam)',
  OTHER: 'Đơn vị vận chuyển khác',
};

export const HandoverParcelSchema = z.object({
  trackingNumber: z.string().min(4).describe('Mã vận đơn bưu kiện'),
  orderId: z.string().min(1).describe('Mã đơn hàng nội bộ'),
  weightKg: z.number().positive().describe('Trọng lượng bưu kiện (kg)'),
  codAmount: z.number().nonnegative().default(0).describe('Tiền thu hộ COD (VNĐ)'),
  receiverProvince: z.string().optional().describe('Tỉnh/thành người nhận'),
  scannedAt: z.union([z.string(), z.date()]).default(() => new Date().toISOString()),
});

export type HandoverParcel = z.infer<typeof HandoverParcelSchema>;
export type HandoverParcelInput = z.input<typeof HandoverParcelSchema>;

export const ManifestStatusSchema = z.enum(['OPEN', 'FINALIZED', 'CANCELLED']);
export type ManifestStatus = z.infer<typeof ManifestStatusSchema>;

export const CarrierManifestHeaderSchema = z.object({
  manifestId: z.string().min(1),
  carrierCode: SupportedCarrierSchema,
  warehouseId: z.string().min(1),
  dispatcherStaffId: z.string().min(1),
  dispatcherName: z.string().min(1),
  driverCourierId: z.string().min(1).describe('Mã bưu tá / nhân viên giao nhận bưu cục'),
  driverName: z.string().min(1),
  driverPhone: z.string().min(8),
  licensePlate: z.string().optional().describe('Biển số xe bưu tá'),
});

export type CarrierManifestHeader = z.infer<typeof CarrierManifestHeaderSchema>;
export type CarrierManifestHeaderInput = z.input<typeof CarrierManifestHeaderSchema>;

export interface CarrierHandoverManifest extends CarrierManifestHeader {
  status: ManifestStatus;
  createdAt: string;
  finalizedAt?: string;
  parcels: HandoverParcel[];
  totalParcels: number;
  totalWeightKg: number;
  totalCodAmount: number;
  driverSignatureCode?: string;
  auditHashSha256?: string;
}

export interface ParcelScanResult {
  success: boolean;
  parcel?: HandoverParcel;
  manifest: CarrierHandoverManifest;
  error?: string;
}

/**
 * Creates a new open handover manifest for carrier dispatch reconciliation.
 */
export function createHandoverManifest(headerInput: CarrierManifestHeaderInput): CarrierHandoverManifest {
  const header = CarrierManifestHeaderSchema.parse(headerInput);

  return {
    ...header,
    status: 'OPEN',
    createdAt: new Date().toISOString(),
    parcels: [],
    totalParcels: 0,
    totalWeightKg: 0,
    totalCodAmount: 0,
  };
}

/**
 * Scans a parcel into an open handover manifest.
 * Performs duplicate detection against existing parcels in the manifest
 * and against an optional global tracking index.
 */
export function scanParcelToManifest(
  manifest: CarrierHandoverManifest,
  parcelInput: HandoverParcelInput,
  existingGlobalTrackingIndex?: Set<string>
): ParcelScanResult {
  if (manifest.status !== 'OPEN') {
    return {
      success: false,
      manifest,
      error: `Cannot scan parcel: Manifest "${manifest.manifestId}" is ${manifest.status}`,
    };
  }

  const parcel = HandoverParcelSchema.parse(parcelInput);
  const tracking = parcel.trackingNumber.trim().toUpperCase();

  // Duplicate Check 1: In-manifest duplicate
  const isDuplicateInManifest = manifest.parcels.some(
    (p) => p.trackingNumber.toUpperCase() === tracking
  );
  if (isDuplicateInManifest) {
    return {
      success: false,
      manifest,
      error: `Duplicate parcel: Tracking number "${tracking}" already scanned in this manifest`,
    };
  }

  // Duplicate Check 2: Cross-manifest global index check
  if (existingGlobalTrackingIndex && existingGlobalTrackingIndex.has(tracking)) {
    return {
      success: false,
      manifest,
      error: `Duplicate parcel: Tracking number "${tracking}" was already handed over in a previous manifest`,
    };
  }

  // Add parcel and update aggregate metrics
  manifest.parcels.push(parcel);
  manifest.totalParcels = manifest.parcels.length;
  manifest.totalWeightKg = Number(
    manifest.parcels.reduce((sum, p) => sum + p.weightKg, 0).toFixed(2)
  );
  manifest.totalCodAmount = manifest.parcels.reduce((sum, p) => sum + p.codAmount, 0);

  if (existingGlobalTrackingIndex) {
    existingGlobalTrackingIndex.add(tracking);
  }

  return {
    success: true,
    parcel,
    manifest,
  };
}

/**
 * Removes a scanned parcel from an open manifest (e.g. if damaged or mis-scanned).
 */
export function removeParcelFromManifest(
  manifest: CarrierHandoverManifest,
  trackingNumber: string
): boolean {
  if (manifest.status !== 'OPEN') {
    throw new Error(`Cannot remove parcel: Manifest "${manifest.manifestId}" is ${manifest.status}`);
  }

  const target = trackingNumber.trim().toUpperCase();
  const initialCount = manifest.parcels.length;
  manifest.parcels = manifest.parcels.filter((p) => p.trackingNumber.toUpperCase() !== target);

  if (manifest.parcels.length !== initialCount) {
    manifest.totalParcels = manifest.parcels.length;
    manifest.totalWeightKg = Number(
      manifest.parcels.reduce((sum, p) => sum + p.weightKg, 0).toFixed(2)
    );
    manifest.totalCodAmount = manifest.parcels.reduce((sum, p) => sum + p.codAmount, 0);
    return true;
  }
  return false;
}

/**
 * Computes deterministic SHA-256 Audit Hash over the finalized manifest contents.
 * Prevents tampering with parcel counts, weights, or tracking codes after driver sign-off.
 */
export function computeManifestAuditHash(
  manifest: CarrierHandoverManifest,
  driverSignatureCode: string
): string {
  // Sort and serialize each parcel (tracking:weight:cod) for deterministic anti-tamper verification
  const serializedParcels = manifest.parcels
    .map(
      (p) =>
        `${p.trackingNumber.trim().toUpperCase()}:${p.weightKg.toFixed(2)}:${p.codAmount.toFixed(0)}`
    )
    .sort()
    .join(',');

  const computedWeight = manifest.parcels.reduce((sum, p) => sum + p.weightKg, 0);
  const computedCod = manifest.parcels.reduce((sum, p) => sum + p.codAmount, 0);

  const canonicalPayload = [
    manifest.manifestId,
    manifest.carrierCode,
    manifest.warehouseId,
    manifest.dispatcherStaffId,
    manifest.driverCourierId,
    driverSignatureCode.trim(),
    serializedParcels,
    manifest.parcels.length.toString(),
    computedWeight.toFixed(2),
    computedCod.toFixed(0),
  ].join('||');

  return sha256Hex(canonicalPayload);
}

/**
 * Finalizes the handover manifest with the driver's signature / authorization code,
 * locks the manifest from further edits, and stamps the SHA-256 audit hash.
 */
export function finalizeHandoverManifest(
  manifest: CarrierHandoverManifest,
  driverSignatureCode: string
): CarrierHandoverManifest {
  if (manifest.status !== 'OPEN') {
    throw new Error(`Manifest "${manifest.manifestId}" is already ${manifest.status}`);
  }
  if (manifest.parcels.length === 0) {
    throw new Error('Cannot finalize an empty handover manifest without any scanned parcels');
  }
  if (!driverSignatureCode || driverSignatureCode.trim().length < 3) {
    throw new Error('Valid driver authorization signature code is required to finalize handover');
  }

  const cleanedSig = driverSignatureCode.trim();
  const hash = computeManifestAuditHash(manifest, cleanedSig);

  manifest.status = 'FINALIZED';
  manifest.driverSignatureCode = cleanedSig;
  manifest.auditHashSha256 = hash;
  manifest.finalizedAt = new Date().toISOString();

  return manifest;
}

/**
 * Cryptographically verifies the integrity of a finalized manifest against tampering.
 */
export function verifyManifestAuditHash(manifest: CarrierHandoverManifest): boolean {
  if (manifest.status !== 'FINALIZED' || !manifest.driverSignatureCode || !manifest.auditHashSha256) {
    return false;
  }

  const expectedHash = computeManifestAuditHash(manifest, manifest.driverSignatureCode);
  return manifest.auditHashSha256 === expectedHash;
}

/**
 * Generates a clean text/markdown summary receipt of the handover manifest
 * suitable for printing or physical sign-off archiving.
 */
export function generateManifestReceipt(manifest: CarrierHandoverManifest): string {
  const carrierName = CarrierNameMap[manifest.carrierCode] || manifest.carrierCode;
  const isVerified = verifyManifestAuditHash(manifest);

  const lines = [
    '================================================================',
    '       BIÊN BẢN BÀN GIAO BƯU KIỆN XUẤT KHO / CARRIER MANIFEST    ',
    '================================================================',
    `Mã biên bản: ${manifest.manifestId}`,
    `Đơn vị vận chuyển: ${carrierName} (${manifest.carrierCode})`,
    `Kho xuất hàng: ${manifest.warehouseId}`,
    `Nhân viên xuất kho: ${manifest.dispatcherName} (ID: ${manifest.dispatcherStaffId})`,
    `Bưu tá nhận hàng: ${manifest.driverName} (Mã bưu tá: ${manifest.driverCourierId})`,
    `Số điện thoại: ${manifest.driverPhone} | Biển số xe: ${manifest.licensePlate || 'N/A'}`,
    `Thời gian lập: ${manifest.createdAt}`,
    `Thời gian hoàn tất: ${manifest.finalizedAt || 'Chưa chốt'}`,
    '----------------------------------------------------------------',
    `TỔNG SỐ BƯU KIỆN: ${manifest.totalParcels} kiện`,
    `TỔNG TRỌNG LƯỢNG: ${manifest.totalWeightKg} kg`,
    `TỔNG TIỀN COD: ${manifest.totalCodAmount.toLocaleString('vi-VN')} VNĐ`,
    '----------------------------------------------------------------',
    'DANH SÁCH BƯU KIỆN:',
  ];

  manifest.parcels.forEach((p, idx) => {
    lines.push(
      `  ${idx + 1}. [${p.trackingNumber}] Đơn: ${p.orderId} | ${p.weightKg}kg | COD: ${p.codAmount.toLocaleString('vi-VN')}đ`
    );
  });

  lines.push('----------------------------------------------------------------');
  lines.push(`Chữ ký bưu tá: ${manifest.driverSignatureCode || 'Chưa ký'}`);
  lines.push(`SHA-256 Audit Hash: ${manifest.auditHashSha256 || 'Chưa tạo'}`);
  lines.push(`Tính toàn vẹn kiểm toán: ${isVerified ? 'HỢP LỆ (VERIFIED)' : 'CHƯA XÁC MINH'}`);
  lines.push('================================================================');

  return lines.join('\n');
}
