/**
 * 64-bit FNV-1a (Fowler-Noll-Vo) non-cryptographic hash function.
 * Fast, uniform bit distribution, zero external dependencies.
 */

const FNV_OFFSET_BASIS_64 = 0xcbf29ce484222325n;
const FNV_PRIME_64 = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

const textEncoder = new TextEncoder();

/**
 * Computes 64-bit FNV-1a hash of a UTF-8 string, returning an unsigned 64-bit BigInt.
 */
export function fnv1a64(str: string): bigint {
  const bytes = textEncoder.encode(str);
  let hash = FNV_OFFSET_BASIS_64;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= BigInt(bytes[i]);
    hash = (hash * FNV_PRIME_64) & MASK_64;
  }
  return hash;
}

/**
 * Computes 64-bit FNV-1a hash of a Uint8Array byte buffer.
 */
export function fnv1a64Bytes(bytes: Uint8Array): bigint {
  let hash = FNV_OFFSET_BASIS_64;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= BigInt(bytes[i]);
    hash = (hash * FNV_PRIME_64) & MASK_64;
  }
  return hash;
}

/**
 * Converts a 64-bit BigInt to a padded 16-character lowercase hexadecimal string.
 * Example: 0x1a2b3c4d5e6f7089n -> "1a2b3c4d5e6f7089"
 */
export function bigIntToHex16(val: bigint): string {
  const unsignedVal = val & MASK_64;
  return unsignedVal.toString(16).padStart(16, '0').toLowerCase();
}

/**
 * Parses a 16-character hexadecimal string into an unsigned 64-bit BigInt.
 * Accepts optional leading "0x" prefix.
 */
export function hex16ToBigInt(hex: string): bigint {
  const cleaned = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
  if (!/^[0-9a-fA-F]{1,16}$/.test(cleaned)) {
    throw new Error(`Invalid 64-bit hexadecimal SimHash string: "${hex}"`);
  }
  return BigInt(`0x${cleaned}`) & MASK_64;
}

/**
 * Normalizes any SimHashInput (string hex or bigint) to an unsigned 64-bit BigInt.
 */
export function toBigInt64(input: string | bigint): bigint {
  if (typeof input === 'bigint') {
    return input & MASK_64;
  }
  return hex16ToBigInt(input);
}

/**
 * Normalizes any SimHashInput to a 16-character lowercase hex string.
 */
export function toHex16(input: string | bigint): string {
  if (typeof input === 'string') {
    const cleaned = input.startsWith('0x') || input.startsWith('0X') ? input.slice(2) : input;
    if (/^[0-9a-fA-F]{1,16}$/.test(cleaned)) {
      return cleaned.padStart(16, '0').toLowerCase();
    }
  }
  return bigIntToHex16(toBigInt64(input));
}
