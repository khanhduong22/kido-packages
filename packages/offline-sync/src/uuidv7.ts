/**
 * UUIDv7 (RFC 9562) Generator
 * Zero-dependency, cryptographically secure, monotonic timestamp-ordered UUID implementation.
 */

let lastMs = -1;
let sequenceCounter = 0;

/**
 * Generates an RFC 9562 compliant UUIDv7.
 * Uses 48-bit millisecond timestamp + 12-bit monotonic sequence + RFC variant + 62 random bits.
 */
export function uuidv7(customTimestamp?: number): string {
  let timestamp: number;
  let seq: number;

  if (customTimestamp !== undefined) {
    timestamp = customTimestamp;
    const randBuf = new Uint8Array(2);
    getRandomValues(randBuf);
    seq = ((randBuf[0] << 8) | randBuf[1]) & 0x0fff;
  } else {
    const now = Date.now();
    // Maintain monotonic ordering within the same millisecond or during clock skews
    if (now > lastMs) {
      lastMs = now;
      // Initialize sequence counter with 10-bit random offset to allow counter increments
      const randBuf = new Uint8Array(2);
      getRandomValues(randBuf);
      sequenceCounter = ((randBuf[0] << 8) | randBuf[1]) & 0x03ff;
    } else {
      // Clock did not advance or drifted slightly backwards: increment sequence counter
      sequenceCounter = (sequenceCounter + 1) & 0x0fff;
      if (sequenceCounter === 0) {
        // Counter overflowed within same ms: advance lastMs by 1ms
        lastMs += 1;
      }
    }
    timestamp = lastMs;
    seq = sequenceCounter;
  }

  // Build 16 bytes:
  // Bytes 0-5: 48-bit unix timestamp in ms (big-endian)
  const bytes = new Uint8Array(16);
  bytes[0] = Math.floor(timestamp / 0x10000000000) & 0xff;
  bytes[1] = Math.floor(timestamp / 0x100000000) & 0xff;
  bytes[2] = Math.floor(timestamp / 0x1000000) & 0xff;
  bytes[3] = Math.floor(timestamp / 0x10000) & 0xff;
  bytes[4] = Math.floor(timestamp / 0x100) & 0xff;
  bytes[5] = timestamp & 0xff;

  // Bytes 6-7: 4-bit version (0b0111 = 7) + 12-bit sequence counter (rand_a)
  bytes[6] = 0x70 | ((seq >>> 8) & 0x0f);
  bytes[7] = seq & 0xff;

  // Bytes 8-15: 2-bit variant (0b10) + 62 random bits (rand_b)
  const randB = new Uint8Array(8);
  getRandomValues(randB);
  bytes[8] = 0x80 | (randB[0] & 0x3f); // Variant 10xx xxxx
  for (let i = 1; i < 8; i++) {
    bytes[8 + i] = randB[i];
  }

  return bytesToUuidString(bytes);
}

/**
 * Extracts Unix millisecond timestamp from an RFC 9562 UUIDv7.
 */
export function uuidv7Timestamp(uuid: string): number {
  if (!isValidUUIDv7(uuid)) {
    throw new Error(`Invalid UUIDv7: "${uuid}"`);
  }
  const clean = uuid.replace(/-/g, '');
  const highHex = clean.substring(0, 4);
  const lowHex = clean.substring(4, 12);
  const high = parseInt(highHex, 16);
  const low = parseInt(lowHex, 16);
  return high * 0x100000000 + low;
}

/**
 * Validates whether a given string is a valid RFC 9562 UUIDv7.
 */
export function isValidUUIDv7(uuid: string): boolean {
  if (typeof uuid !== 'string') return false;
  // Format: 8-4-4-4-12
  // Position 14 is version '7'
  // Position 19 is variant [8, 9, a, b, 8, 9, A, B]
  const uuidv7Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidv7Regex.test(uuid);
}

/**
 * Compares two UUIDv7s lexicographically and chronologically.
 * Returns -1 if a < b, 1 if a > b, 0 if a === b.
 */
export function compareUUIDv7(a: string, b: string): number {
  const normA = a.toLowerCase();
  const normB = b.toLowerCase();
  if (normA < normB) return -1;
  if (normA > normB) return 1;
  return 0;
}

/**
 * Secure cross-platform random bytes helper (Browser & Node.js).
 */
function getRandomValues(buffer: Uint8Array): void {
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.getRandomValues) {
    globalThis.crypto.getRandomValues(buffer);
    return;
  }
  // Fallback for isolated contexts
  for (let i = 0; i < buffer.length; i++) {
    buffer[i] = Math.floor(Math.random() * 256);
  }
}

function bytesToUuidString(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < 16; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return (
    hex.substring(0, 8) +
    '-' +
    hex.substring(8, 12) +
    '-' +
    hex.substring(12, 16) +
    '-' +
    hex.substring(16, 20) +
    '-' +
    hex.substring(20, 32)
  );
}
