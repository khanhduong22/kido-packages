import type {
  DedupeOptions,
  IndexSearchOptions,
  IndexedDocument,
  NearDuplicateIndexOptions,
  NearDuplicateMatch,
  SimHashInput,
} from './types';
import { computeSimHash, computeSimHashBigInt, hammingDistance, toBigInt64, toHex16 } from './simhash';

/**
 * Extracts four 16-bit blocks from a 64-bit integer.
 * Block 0: bits 0..15
 * Block 1: bits 16..31
 * Block 2: bits 32..47
 * Block 3: bits 48..63
 */
export function extract16BitBlocks(hash: bigint): [number, number, number, number] {
  return [
    Number(hash & 0xffffn),
    Number((hash >> 16n) & 0xffffn),
    Number((hash >> 32n) & 0xffffn),
    Number((hash >> 48n) & 0xffffn),
  ];
}

/**
 * High-performance In-Memory Near-Duplicate Search Index using the Pigeonhole Principle.
 *
 * Problem Solved:
 * Comparing a query fingerprint against N stored documents requires O(N) operations.
 * When N is large (e.g. 100,000+ articles, comments, or ads), O(N) is too slow for real-time.
 *
 * Pigeonhole Principle Solution:
 * A 64-bit SimHash is divided into 4 disjoint blocks of 16 bits each.
 * For any two fingerprints with Hamming distance d <= 3 (similarity >= 95.3%),
 * at least one of the 4 blocks MUST be 100% identical (0 bit difference).
 *
 * By maintaining 4 hash tables (one per block position), we can retrieve all candidates
 * sharing at least one 16-bit block in O(1) average time, reducing candidate verifications
 * from N to a tiny subset, achieving sub-millisecond lookups.
 */
export class NearDuplicateIndex {
  private documents = new Map<string, IndexedDocument>();
  private tables: Array<Map<number, Set<string>>> = [
    new Map(),
    new Map(),
    new Map(),
    new Map(),
  ];

  private defaultDedupeOptions: DedupeOptions;
  private defaultMaxHammingDistance: number;

  constructor(options: NearDuplicateIndexOptions = {}) {
    this.defaultDedupeOptions = options.defaultDedupeOptions || {};
    this.defaultMaxHammingDistance = options.defaultMaxHammingDistance ?? 3;
  }

  /**
   * Total number of indexed documents.
   */
  get size(): number {
    return this.documents.size;
  }

  /**
   * Converts input (raw text or precomputed hex/bigint) to BigInt and hex strings.
   */
  private resolveHash(
    textOrHash: SimHashInput | string,
    options?: DedupeOptions
  ): { bigInt: bigint; hex: string } {
    // If it's a BigInt
    if (typeof textOrHash === 'bigint') {
      const bigInt = toBigInt64(textOrHash);
      return { bigInt, hex: toHex16(bigInt) };
    }

    // If it's already a 16-character hex string (with optional 0x)
    const cleaned = textOrHash.startsWith('0x') || textOrHash.startsWith('0X')
      ? textOrHash.slice(2)
      : textOrHash;

    if (/^[0-9a-fA-F]{16}$/.test(cleaned)) {
      const bigInt = toBigInt64(cleaned);
      return { bigInt, hex: cleaned.toLowerCase() };
    }

    // Otherwise, treat as raw text and compute SimHash
    const mergedOptions = { ...this.defaultDedupeOptions, ...options };
    const bigInt = computeSimHashBigInt(textOrHash, mergedOptions);
    return { bigInt, hex: toHex16(bigInt) };
  }

  /**
   * Inserts a document into the index.
   * If a document with the same ID already exists, it will be updated.
   *
   * @param id Unique document identifier
   * @param textOrHash Raw text string or precomputed SimHash (hex string or BigInt)
   * @param metadata Optional metadata to associate with this document
   * @param options Optional DedupeOptions to override defaults if raw text is passed
   */
  insert(
    id: string,
    textOrHash: SimHashInput | string,
    metadata?: Record<string, unknown>,
    options?: DedupeOptions
  ): IndexedDocument {
    // If updating existing ID, remove old table entries first
    if (this.documents.has(id)) {
      this.delete(id);
    }

    const { bigInt, hex } = this.resolveHash(textOrHash, options);
    const doc: IndexedDocument = {
      id,
      fingerprint: hex,
      fingerprintBigInt: bigInt,
      metadata,
    };

    this.documents.set(id, doc);

    // Index into 4 blocks
    const blocks = extract16BitBlocks(bigInt);
    for (let i = 0; i < 4; i++) {
      const blockVal = blocks[i];
      let bucket = this.tables[i].get(blockVal);
      if (!bucket) {
        bucket = new Set();
        this.tables[i].set(blockVal, bucket);
      }
      bucket.add(id);
    }

    return doc;
  }

  /**
   * Batch inserts multiple documents for high throughput.
   */
  insertBatch(
    items: Array<{
      id: string;
      text?: string;
      hash?: SimHashInput;
      metadata?: Record<string, unknown>;
    }>,
    options?: DedupeOptions
  ): void {
    for (const item of items) {
      const input = item.hash ?? item.text ?? '';
      this.insert(item.id, input, item.metadata, options);
    }
  }

  /**
   * Queries the index for near-duplicate documents.
   *
   * @param textOrHash Query text or precomputed fingerprint
   * @param searchOptions Search parameters (maxHammingDistance, minSimilarity, limit, exhaustive)
   * @param dedupeOptions Dedupe options if text needs hashing
   */
  query(
    textOrHash: SimHashInput | string,
    searchOptions: IndexSearchOptions = {},
    dedupeOptions?: DedupeOptions
  ): NearDuplicateMatch[] {
    const { bigInt, hex } = this.resolveHash(textOrHash, dedupeOptions);

    let maxDist = this.defaultMaxHammingDistance;
    if (typeof searchOptions.maxHammingDistance === 'number') {
      maxDist = Math.max(0, Math.min(64, searchOptions.maxHammingDistance));
    } else if (typeof searchOptions.minSimilarity === 'number') {
      const minSim = Math.max(0, Math.min(1, searchOptions.minSimilarity));
      maxDist = Math.floor((1 - minSim) * 64);
    }

    const limit = searchOptions.limit ?? 50;
    const matches: NearDuplicateMatch[] = [];

    if (this.documents.size === 0) {
      return matches;
    }

    // 1. Gather Candidate IDs
    const candidateIds = new Set<string>();

    if (searchOptions.exhaustive || maxDist > 3) {
      // When exhaustive is requested, check all documents directly.
      // Note: for maxDist > 3, pigeonhole on 4 blocks is a heuristic unless exhaustive is used.
      // If exhaustive is explicitly false and maxDist > 3, we still query blocks for fast approximation.
      if (searchOptions.exhaustive) {
        for (const docId of this.documents.keys()) {
          candidateIds.add(docId);
        }
      } else {
        // Collect block matches first
        const blocks = extract16BitBlocks(bigInt);
        for (let i = 0; i < 4; i++) {
          const bucket = this.tables[i].get(blocks[i]);
          if (bucket) {
            for (const docId of bucket) {
              candidateIds.add(docId);
            }
          }
        }
        // If candidateIds is empty and user allows larger distance, fallback to scanning
        if (candidateIds.size === 0 && maxDist >= 6) {
          for (const docId of this.documents.keys()) {
            candidateIds.add(docId);
          }
        }
      }
    } else {
      // Guaranteed 100% recall via Pigeonhole Principle for maxDist <= 3
      const blocks = extract16BitBlocks(bigInt);
      for (let i = 0; i < 4; i++) {
        const bucket = this.tables[i].get(blocks[i]);
        if (bucket) {
          for (const docId of bucket) {
            candidateIds.add(docId);
          }
        }
      }
    }

    // 2. Verify candidates with precise Hamming distance
    for (const docId of candidateIds) {
      const doc = this.documents.get(docId);
      if (!doc) continue;

      const dist = hammingDistance(bigInt, doc.fingerprintBigInt);
      if (dist <= maxDist) {
        const sim = 1 - dist / 64;
        matches.push({
          id: doc.id,
          similarity: sim,
          hammingDistance: dist,
          fingerprint: doc.fingerprint,
          metadata: doc.metadata,
        });
      }
    }

    // 3. Sort by closest match first (ascending hamming distance / descending similarity)
    matches.sort((a, b) => {
      if (a.hammingDistance !== b.hammingDistance) {
        return a.hammingDistance - b.hammingDistance;
      }
      return b.similarity - a.similarity;
    });

    return matches.slice(0, limit);
  }

  /**
   * Helper to find near-duplicates with a given similarity threshold (default: 0.85).
   */
  findNearDuplicates(
    textOrHash: SimHashInput | string,
    threshold = 0.85,
    options: Omit<IndexSearchOptions, 'minSimilarity'> = {}
  ): NearDuplicateMatch[] {
    return this.query(textOrHash, {
      ...options,
      minSimilarity: threshold,
    });
  }

  /**
   * Checks if any near-duplicate exists for the given content.
   * Short-circuits on first match for maximum speed.
   */
  hasNearDuplicate(textOrHash: SimHashInput | string, threshold = 0.85): boolean {
    const results = this.findNearDuplicates(textOrHash, threshold, { limit: 1 });
    return results.length > 0;
  }

  /**
   * Deletes a document by ID from the index and block tables.
   */
  delete(id: string): boolean {
    const doc = this.documents.get(id);
    if (!doc) return false;

    // Remove from 4 block tables
    const blocks = extract16BitBlocks(doc.fingerprintBigInt);
    for (let i = 0; i < 4; i++) {
      const bucket = this.tables[i].get(blocks[i]);
      if (bucket) {
        bucket.delete(id);
        if (bucket.size === 0) {
          this.tables[i].delete(blocks[i]);
        }
      }
    }

    this.documents.delete(id);
    return true;
  }

  /**
   * Retrieves an indexed document by ID.
   */
  get(id: string): IndexedDocument | undefined {
    return this.documents.get(id);
  }

  /**
   * Checks if an ID is present in the index.
   */
  has(id: string): boolean {
    return this.documents.has(id);
  }

  /**
   * Clears all documents and block tables from memory.
   */
  clear(): void {
    this.documents.clear();
    for (let i = 0; i < 4; i++) {
      this.tables[i].clear();
    }
  }

  /**
   * Exports an index dump for serialization/persistence.
   */
  exportDump(): {
    documents: Array<{
      id: string;
      fingerprint: string;
      metadata?: Record<string, unknown>;
    }>;
  } {
    const docs = Array.from(this.documents.values()).map(d => ({
      id: d.id,
      fingerprint: d.fingerprint,
      metadata: d.metadata,
    }));
    return { documents: docs };
  }

  /**
   * Imports a serialized dump into the index.
   */
  importDump(dump: {
    documents: Array<{
      id: string;
      fingerprint: string;
      metadata?: Record<string, unknown>;
    }>;
  }): void {
    this.clear();
    for (const doc of dump.documents) {
      this.insert(doc.id, doc.fingerprint, doc.metadata);
    }
  }
}
