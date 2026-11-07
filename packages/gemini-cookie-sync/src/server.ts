import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  COOKIE_ENV_MAP,
  COOKIE_HEADER_NAME,
  GeminiCookies,
  REQUIRED_COOKIE_KEY,
} from './constants';


export interface CookieValidationResult {
  valid: boolean;
  missingKey?: string;
  cookieCount: number;
  hasRequiredCookie: boolean;
  presentKeys: string[];
}

export interface EnvSyncResult {
  updatedKeys: string[];
  count: number;
  envMap: Record<string, string>;
}

export interface ZipEntry {
  name: string;
  data: Buffer | Uint8Array | string;
}

// Precomputed CRC32 table fallback
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[i] = c >>> 0;
}

/**
 * Compute CRC32 checksum for a buffer.
 */
export function computeCrc32(buf: Buffer): number {
  const nodeZlib = zlib as unknown as { crc32?: (b: Buffer) => number };
  if (typeof nodeZlib.crc32 === 'function') {
    return nodeZlib.crc32(buf) >>> 0;
  }
  let crc = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

/**
 * Extract and decode cookies from the X-Gemini-Cookies HTTP header.
 * Handles URL-encoded JSON or direct raw JSON strings.
 */
export function extractCookiesFromHeader(
  headerValue: string | null | undefined
): GeminiCookies | null {
  if (!headerValue || typeof headerValue !== 'string') {
    return null;
  }

  const trimmed = headerValue.trim();
  if (!trimmed) {
    return null;
  }

  let decoded = trimmed;
  try {
    decoded = decodeURIComponent(trimmed);
  } catch {
    // If decode fails, fallback to raw string
  }

  try {
    const parsed = JSON.parse(decoded);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as GeminiCookies;
    }
  } catch {
    try {
      const parsedRaw = JSON.parse(trimmed);
      if (parsedRaw && typeof parsedRaw === 'object' && !Array.isArray(parsedRaw)) {
        return parsedRaw as GeminiCookies;
      }
    } catch {
      // Invalid JSON
    }
  }

  return null;
}

/**
 * Validate that the mandatory cookie (__Secure-1PSID) is present and non-empty.
 */
export function validateRequiredCookies(
  cookies: GeminiCookies | null | undefined,
  requiredKey: string = REQUIRED_COOKIE_KEY
): CookieValidationResult {
  if (!cookies || typeof cookies !== 'object' || Array.isArray(cookies)) {
    return {
      valid: false,
      missingKey: requiredKey,
      cookieCount: 0,
      hasRequiredCookie: false,
      presentKeys: [],
    };
  }

  const keys = Object.keys(cookies);
  const val = cookies[requiredKey];
  const hasRequired = typeof val === 'string' && val.trim().length > 0;

  return {
    valid: hasRequired,
    missingKey: hasRequired ? undefined : requiredKey,
    cookieCount: keys.length,
    hasRequiredCookie: hasRequired,
    presentKeys: keys,
  };
}

/**
 * Map Google cookie names to environment variable names (e.g. __Secure-1PSID -> SECURE_1PSID).
 */
export function mapCookiesToEnv(cookies: GeminiCookies): Record<string, string> {
  const envMap: Record<string, string> = {};
  if (!cookies || typeof cookies !== 'object') {
    return envMap;
  }

  for (const [cookieName, envKey] of Object.entries(COOKIE_ENV_MAP)) {
    if (typeof cookies[cookieName] === 'string' && cookies[cookieName].trim()) {
      envMap[envKey] = cookies[cookieName].trim();
    } else if (typeof cookies[envKey] === 'string' && cookies[envKey].trim()) {
      envMap[envKey] = cookies[envKey].trim();
    }
  }

  return envMap;
}

/**
 * Synchronize cookies into process.env or a target environment dictionary in memory.
 */
export function syncCookiesToEnvironment(
  cookies: GeminiCookies,
  targetEnv: Record<string, string | undefined> = process.env
): EnvSyncResult {
  const envMap = mapCookiesToEnv(cookies);
  const updatedKeys: string[] = [];

  for (const [key, value] of Object.entries(envMap)) {
    targetEnv[key] = value;
    updatedKeys.push(key);
  }

  return {
    updatedKeys,
    count: updatedKeys.length,
    envMap,
  };
}

/**
 * Pure standard-library ZIP archive generator with zero third-party dependencies.
 * Creates a compliant .zip Buffer with DEFLATE compression.
 */
export function createZipBuffer(entries: ZipEntry[]): Buffer {
  const parts: Buffer[] = [];
  const centralDirectory: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const rawData =
      typeof entry.data === 'string'
        ? Buffer.from(entry.data, 'utf8')
        : Buffer.isBuffer(entry.data)
        ? entry.data
        : Buffer.from(entry.data);

    // Standardize path separators to forward slash
    const normalizedName = entry.name.replace(/\\/g, '/').replace(/^\/+/, '');
    const nameBuf = Buffer.from(normalizedName, 'utf8');

    const uncompressedSize = rawData.length;
    const compressed = zlib.deflateRawSync(rawData);
    const compressedSize = compressed.length;
    const crc = computeCrc32(rawData);

    // Local file header (30 bytes)
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // Local file header signature
    localHeader.writeUInt16LE(20, 4); // Version needed to extract (2.0)
    localHeader.writeUInt16LE(0, 6); // General purpose bit flag
    localHeader.writeUInt16LE(8, 8); // Compression method (8 = Deflate)
    localHeader.writeUInt16LE(0, 10); // Mod time
    localHeader.writeUInt16LE(0, 12); // Mod date
    localHeader.writeUInt32LE(crc, 14); // CRC-32
    localHeader.writeUInt32LE(compressedSize, 18); // Compressed size
    localHeader.writeUInt32LE(uncompressedSize, 22); // Uncompressed size
    localHeader.writeUInt16LE(nameBuf.length, 26); // File name length
    localHeader.writeUInt16LE(0, 28); // Extra field length

    parts.push(localHeader, nameBuf, compressed);

    // Central directory header (46 bytes)
    const cdHeader = Buffer.alloc(46);
    cdHeader.writeUInt32LE(0x02014b50, 0); // Central directory header signature
    cdHeader.writeUInt16LE(20, 4); // Version made by
    cdHeader.writeUInt16LE(20, 6); // Version needed to extract
    cdHeader.writeUInt16LE(0, 8); // General purpose bit flag
    cdHeader.writeUInt16LE(8, 10); // Compression method
    cdHeader.writeUInt16LE(0, 12); // Mod time
    cdHeader.writeUInt16LE(0, 14); // Mod date
    cdHeader.writeUInt32LE(crc, 16); // CRC-32
    cdHeader.writeUInt32LE(compressedSize, 20); // Compressed size
    cdHeader.writeUInt32LE(uncompressedSize, 24); // Uncompressed size
    cdHeader.writeUInt16LE(nameBuf.length, 28); // File name length
    cdHeader.writeUInt16LE(0, 30); // Extra field length
    cdHeader.writeUInt16LE(0, 32); // File comment length
    cdHeader.writeUInt16LE(0, 34); // Disk number start
    cdHeader.writeUInt16LE(0, 36); // Internal file attributes
    cdHeader.writeUInt32LE(0, 38); // External file attributes
    cdHeader.writeUInt32LE(offset, 42); // Relative offset of local header

    centralDirectory.push(cdHeader, nameBuf);
    offset += localHeader.length + nameBuf.length + compressed.length;
  }

  const cdBuf = Buffer.concat(centralDirectory);
  const cdOffset = offset;
  const cdSize = cdBuf.length;

  // End of Central Directory (EOCD, 22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD signature
  eocd.writeUInt16LE(0, 4); // Number of this disk
  eocd.writeUInt16LE(0, 6); // Disk where central directory starts
  eocd.writeUInt16LE(entries.length, 8); // Number of central directory records on this disk
  eocd.writeUInt16LE(entries.length, 10); // Total number of central directory records
  eocd.writeUInt32LE(cdSize, 12); // Size of central directory
  eocd.writeUInt32LE(cdOffset, 16); // Offset of central directory
  eocd.writeUInt16LE(0, 20); // Comment length

  return Buffer.concat([...parts, cdBuf, eocd]);
}

/**
 * Locate the bundled Chrome Extension directory in the project or package.
 */
export function resolveExtensionDirectory(customPath?: string): string {
  if (customPath && fs.existsSync(customPath)) {
    return path.resolve(customPath);
  }

  const candidates = [
    path.resolve(__dirname, 'extension'),
    path.resolve(__dirname, '../extension'),
    path.resolve(__dirname, '../src/extension'),
    path.resolve(__dirname, './src/extension'),
    path.resolve(process.cwd(), 'packages/gemini-cookie-sync/src/extension'),
    path.resolve(process.cwd(), 'packages/gemini-cookie-sync/dist/extension'),
    path.resolve(process.cwd(), 'src/extension'),
    path.resolve(process.cwd(), 'static/extension'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.existsSync(path.join(candidate, 'manifest.json'))) {
      return candidate;
    }
  }

  throw new Error(
    `[GeminiCookieSync] Chrome extension directory not found. Searched candidates: ${candidates.join(', ')}`
  );
}

/**
 * Package the Chrome Extension directory into a download-ready ZIP Buffer.
 */
export function createExtensionZipBuffer(extensionDirPath?: string): Buffer {
  const targetDir = resolveExtensionDirectory(extensionDirPath);
  const entries: ZipEntry[] = [];

  function walk(dir: string, baseDir: string) {
    const list = fs.readdirSync(dir);
    for (const item of list) {
      if (item.startsWith('.')) continue; // Skip .DS_Store, hidden files
      const fullPath = path.join(dir, item);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        walk(fullPath, baseDir);
      } else {
        const relativeName = path.relative(baseDir, fullPath).replace(/\\/g, '/');
        const data = fs.readFileSync(fullPath);
        entries.push({ name: relativeName, data });
      }
    }
  }

  walk(targetDir, targetDir);

  if (entries.length === 0) {
    throw new Error(`[GeminiCookieSync] Extension directory is empty: ${targetDir}`);
  }

  return createZipBuffer(entries);
}

/**
 * Lightweight Hono middleware helper for extracting and injecting Gemini cookies.
 */
export function createHonoCookieSyncMiddleware(options: {
  headerName?: string;
  autoSyncEnv?: boolean;
} = {}) {
  const headerName = options.headerName ?? COOKIE_HEADER_NAME;
  const autoSyncEnv = options.autoSyncEnv ?? true;

  return async function cookieSyncMiddleware(
    c: {
      req: { header: (name: string) => string | undefined };
      set: (key: string, value: unknown) => void;
    },
    next: () => Promise<void>
  ) {
    const rawHeader = c.req.header(headerName);
    if (rawHeader) {
      const cookies = extractCookiesFromHeader(rawHeader);
      if (cookies) {
        c.set('geminiCookies', cookies);
        if (autoSyncEnv) {
          syncCookiesToEnvironment(cookies);
        }
      }
    }
    await next();
  };
}
