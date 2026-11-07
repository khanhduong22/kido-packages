import type { DedupeOptions, SimHashInput, SimHash64 } from './types';
import { fnv1a64, bigIntToHex16, toBigInt64, toHex16 } from './hash';
import { tokenize } from './tokenizer';

/**
 * Computes a 64-bit Charikar SimHash fingerprint of a text string,
 * returning an unsigned 64-bit BigInt.
 *
 * Algorithm (Moses Charikar, 2002):
 * 1. Extract feature tokens and weights (word/char n-grams, Vietnamese normalization).
 * 2. Hash each feature into a 64-bit integer using FNV-1a 64-bit.
 * 3. Accumulate weighted 64-dimensional vector:
 *    - For bit i = 0..63: if bit is 1, add weight; if bit is 0, subtract weight.
 * 4. Generate final 64-bit fingerprint:
 *    - bit i = 1 if vector[i] > 0, else 0.
 */
export function computeSimHashBigInt(text: string, options: DedupeOptions = {}): bigint {
  const tokenWeights = tokenize(text, options);

  if (tokenWeights.size === 0) {
    return 0n;
  }

  // 64-element accumulation vector
  const v = new Float64Array(64);

  for (const [token, weight] of tokenWeights.entries()) {
    const hash = fnv1a64(token);
    for (let i = 0; i < 64; i++) {
      const bit = (hash >> BigInt(i)) & 1n;
      if (bit === 1n) {
        v[i] += weight;
      } else {
        v[i] -= weight;
      }
    }
  }

  let fingerprint = 0n;
  for (let i = 0; i < 64; i++) {
    if (v[i] > 0) {
      fingerprint |= (1n << BigInt(i));
    }
  }

  return fingerprint;
}

/**
 * Computes a 64-bit Charikar SimHash fingerprint of a text string,
 * returning a 16-character lowercase hexadecimal string.
 *
 * Example: computeSimHash("Văn Tới Calisthenics") -> "8a4f10bc9312fe40"
 */
export function computeSimHash(text: string, options: DedupeOptions = {}): SimHash64 {
  const bigIntHash = computeSimHashBigInt(text, options);
  return bigIntToHex16(bigIntHash);
}

/**
 * Calculates the bitwise Hamming distance between two 64-bit SimHash fingerprints.
 * Accepts both 16-character hex strings and BigInt values.
 *
 * Uses Brian Kernighan's bit-counting popcount algorithm (O(set_bits)).
 * Returns an integer between 0 (identical) and 64 (complete opposites).
 */
export function hammingDistance(hashA: SimHashInput, hashB: SimHashInput): number {
  const a = toBigInt64(hashA);
  const b = toBigInt64(hashB);
  let xor = (a ^ b) & 0xffffffffffffffffn;

  let count = 0;
  while (xor > 0n) {
    xor &= (xor - 1n);
    count++;
  }

  return count;
}

/**
 * Calculates similarity coefficient between two 64-bit SimHash fingerprints.
 * Returns a float between 0.0 (0% match) and 1.0 (100% exact match).
 * Formula: 1 - (hammingDistance / 64).
 */
export function similarity(hashA: SimHashInput, hashB: SimHashInput): number {
  const dist = hammingDistance(hashA, hashB);
  return 1 - dist / 64;
}

/**
 * Determines whether two 64-bit fingerprints are near-duplicates
 * based on a similarity threshold (default: 0.85).
 *
 * Threshold guide:
 * - 1.00: Exact match (Hamming distance = 0)
 * - 0.95: Very high similarity (Hamming distance <= 3)
 * - 0.90: High similarity (Hamming distance <= 6)
 * - 0.85: Default near-duplicate threshold (Hamming distance <= 9)
 * - 0.80: Loose similarity (Hamming distance <= 12)
 */
export function isNearDuplicate(
  hashA: SimHashInput,
  hashB: SimHashInput,
  threshold = 0.85
): boolean {
  return similarity(hashA, hashB) >= threshold;
}

export { toBigInt64, toHex16, bigIntToHex16, hex16ToBigInt } from './hash';
