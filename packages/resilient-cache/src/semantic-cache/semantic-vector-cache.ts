import { cosineDistance } from "./vector-math";
import { normalizeSearchQuery, buildExactQueryHash } from "./text-normalizer";

export interface SemanticCacheEntry<T = any> {
  key: string;
  vector: number[];
  payload: T;
  timestamp: number;
  ttlMs?: number;
  accessCount: number;
  lastAccessed: number;
}

export interface SemanticCacheHit<T = any> {
  key: string;
  payload: T;
  distance: number;
  matchType: "EXACT" | "SEMANTIC";
}

export interface SemanticVectorCacheOptions {
  /** Maximum entries retained per namespace (LRU eviction). Default: 500 */
  maxEntriesPerNamespace?: number;
  /** Default cosine distance threshold for semantic hit (0.0 to 1.0). Default: 0.12 */
  defaultDistanceThreshold?: number;
  /** Default TTL in milliseconds. Default: 24 hours */
  defaultTtlMs?: number;
}

/**
 * High-performance In-Memory Semantic Vector Response Cache
 * Dual-tier: Instant Exact Hash lookup + Fast Linear AVX-friendly Cosine Distance scan.
 * Multi-tenant namespace isolated, auto-evicting LRU with TTL support.
 */
export class SemanticVectorCache<T = any> {
  private readonly maxEntries: number;
  private readonly defaultThreshold: number;
  private readonly defaultTtlMs: number;
  private accessSeq = 0;

  // Map<namespace, Map<exactKey, SemanticCacheEntry<T>>>
  private readonly stores = new Map<string, Map<string, SemanticCacheEntry<T>>>();

  constructor(options?: SemanticVectorCacheOptions) {
    this.maxEntries = options?.maxEntriesPerNamespace ?? 500;
    this.defaultThreshold = options?.defaultDistanceThreshold ?? 0.12;
    this.defaultTtlMs = options?.defaultTtlMs ?? 24 * 60 * 60 * 1000;
  }

  private getNamespaceMap(namespace: string): Map<string, SemanticCacheEntry<T>> {
    let map = this.stores.get(namespace);
    if (!map) {
      map = new Map<string, SemanticCacheEntry<T>>();
      this.stores.set(namespace, map);
    }
    return map;
  }

  /**
   * Stores an entry with both text query key and dense vector.
   */
  set(
    queryText: string,
    vector: number[],
    payload: T,
    options?: { namespace?: string; ttlMs?: number }
  ): void {
    const namespace = options?.namespace ?? "default";
    const map = this.getNamespaceMap(namespace);
    const normalized = normalizeSearchQuery(queryText);
    const hash = buildExactQueryHash(normalized);
    const now = Date.now();
    const ttlMs = options?.ttlMs ?? this.defaultTtlMs;

    const seq = ++this.accessSeq;

    // Enforce LRU eviction if full
    if (map.size >= this.maxEntries && !map.has(hash)) {
      // Find oldest by lastAccessed
      let oldestKey: string | null = null;
      let oldestSeq = Infinity;
      for (const [k, v] of map.entries()) {
        if (v.lastAccessed < oldestSeq) {
          oldestSeq = v.lastAccessed;
          oldestKey = k;
        }
      }
      if (oldestKey) map.delete(oldestKey);
    }

    map.set(hash, {
      key: queryText,
      vector,
      payload,
      timestamp: now,
      ttlMs,
      accessCount: 1,
      lastAccessed: seq,
    });
  }

  /**
   * Searches for a matching cached answer by query text first (exact),
   * then by dense vector (semantic).
   */
  get(
    queryText: string,
    vector?: number[] | null,
    options?: { namespace?: string; maxDistance?: number }
  ): SemanticCacheHit<T> | null {
    const namespace = options?.namespace ?? "default";
    const map = this.getNamespaceMap(namespace);
    if (map.size === 0) return null;

    const now = Date.now();
    const normalized = normalizeSearchQuery(queryText);
    const hash = buildExactQueryHash(normalized);

    // 1. Tier 1: Check Exact Hash
    const exact = map.get(hash);
    if (exact) {
      if (exact.ttlMs && now - exact.timestamp > exact.ttlMs) {
        map.delete(hash);
      } else {
        exact.accessCount++;
        exact.lastAccessed = ++this.accessSeq;
        return {
          key: exact.key,
          payload: exact.payload,
          distance: 0.0,
          matchType: "EXACT",
        };
      }
    }

    // 2. Tier 2: Check Semantic Vector if provided
    if (!vector || vector.length === 0) return null;
    const threshold = options?.maxDistance ?? this.defaultThreshold;

    let bestMatch: SemanticCacheEntry<T> | null = null;
    let bestDist = Infinity;
    let bestKey: string | null = null;

    for (const [k, entry] of map.entries()) {
      if (entry.ttlMs && now - entry.timestamp > entry.ttlMs) {
        map.delete(k);
        continue;
      }

      const dist = cosineDistance(vector, entry.vector);
      if (dist <= threshold && dist < bestDist) {
        bestDist = dist;
        bestMatch = entry;
        bestKey = k;
      }
    }

    if (bestMatch && bestKey) {
      bestMatch.accessCount++;
      bestMatch.lastAccessed = ++this.accessSeq;
      return {
        key: bestMatch.key,
        payload: bestMatch.payload,
        distance: Number(bestDist.toFixed(4)),
        matchType: "SEMANTIC",
      };
    }

    return null;
  }

  /**
   * Deletes a specific entry by query text.
   */
  delete(queryText: string, namespace = "default"): boolean {
    const map = this.stores.get(namespace);
    if (!map) return false;
    const normalized = normalizeSearchQuery(queryText);
    const hash = buildExactQueryHash(normalized);
    return map.delete(hash);
  }

  /**
   * Clears an entire namespace or all namespaces.
   */
  clear(namespace?: string): void {
    if (namespace) {
      this.stores.delete(namespace);
    } else {
      this.stores.clear();
    }
  }

  /**
   * Returns total active entry count in a namespace.
   */
  size(namespace = "default"): number {
    return this.stores.get(namespace)?.size ?? 0;
  }
}
