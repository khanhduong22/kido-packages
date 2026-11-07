/**
 * Deterministic MurmurHash3 (32-bit x86 variant)
 * Produces an unsigned 32-bit integer in the range [0, 4294967295].
 *
 * Mathematical Invariants:
 * - 100% deterministic across all OS, CPU architectures, and runtimes (Bun, Node, Deno, Browser).
 * - High-speed avalanche property: 1 bit difference produces ~50% bit flip.
 * - Standard C-equivalent integer overflow via Math.imul.
 * - Zero external runtime dependencies.
 */

const C1 = 0xcc9e2d51;
const C2 = 0x1b873593;
const C3 = 0xe6546b64;
const MIX1 = 0x85ebca6b;
const MIX2 = 0xc2b2ae35;

/**
 * Computes deterministic 32-bit MurmurHash3 (unsigned integer 0 .. 4294967295).
 *
 * @param key String input to hash
 * @param seed Optional 32-bit seed (default 0)
 * @returns Unsigned 32-bit integer
 */
export function murmurhash3_32(key: string, seed: number = 0): number {
  if (typeof key !== "string") {
    key = String(key ?? "");
  }

  const bytes = new TextEncoder().encode(key);
  const len = bytes.length;
  let h1 = seed >>> 0;

  // Process 4-byte blocks
  const nblocks = Math.floor(len / 4);
  for (let i = 0; i < nblocks; i++) {
    const idx = i * 4;
    let k1 =
      bytes[idx] |
      (bytes[idx + 1] << 8) |
      (bytes[idx + 2] << 16) |
      (bytes[idx + 3] << 24);

    k1 = Math.imul(k1, C1);
    k1 = (k1 << 15) | (k1 >>> 17);
    k1 = Math.imul(k1, C2);

    h1 ^= k1;
    h1 = (h1 << 13) | (h1 >>> 19);
    h1 = (Math.imul(h1, 5) + C3) | 0;
  }

  // Process tail (remaining 1..3 bytes)
  let k1 = 0;
  const tailIdx = nblocks * 4;
  const rem = len & 3;

  if (rem === 3) {
    k1 ^= bytes[tailIdx + 2] << 16;
  }
  if (rem >= 2) {
    k1 ^= bytes[tailIdx + 1] << 8;
  }
  if (rem >= 1) {
    k1 ^= bytes[tailIdx];
    k1 = Math.imul(k1, C1);
    k1 = (k1 << 15) | (k1 >>> 17);
    k1 = Math.imul(k1, C2);
    h1 ^= k1;
  }

  // Finalization mix
  h1 ^= len;
  h1 ^= h1 >>> 16;
  h1 = Math.imul(h1, MIX1);
  h1 ^= h1 >>> 13;
  h1 = Math.imul(h1, MIX2);
  h1 ^= h1 >>> 16;

  return h1 >>> 0;
}

/**
 * Computes a 64-bit unsigned BigInt hash derived from dual MurmurHash3 seeds.
 * Suitable for distributed 64-bit token spaces (Cassandra / ScyllaDB / Snowflake).
 */
export function murmurhash3_64(key: string, seed: number = 0): bigint {
  const h1 = BigInt(murmurhash3_32(key, seed));
  const h2 = BigInt(murmurhash3_32(key, (seed ^ 0x5bd1e995) >>> 0));
  return ((h1 << 32n) | h2) & 0xffffffffffffffffn;
}

/**
 * Calculates deterministic modulo shard ID: murmurhash3_32(key, seed) % numShards.
 * Guaranteed to return an integer in [0, numShards - 1].
 */
export function getShardId(key: string, numShards: number, seed: number = 0): number {
  if (numShards <= 0 || !Number.isInteger(numShards)) {
    throw new Error(`numShards must be a positive integer, received: ${numShards}`);
  }
  return murmurhash3_32(key, seed) % numShards;
}

/**
 * Formats a 32-bit unsigned integer as an 8-character lowercase hex string.
 */
export function toHexHash(hash32: number): string {
  return (hash32 >>> 0).toString(16).padStart(8, "0");
}
