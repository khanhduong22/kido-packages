import { CircuitBreaker } from './circuit-breaker';
import { InFlightManager } from './in-flight';
import type {
  CacheAdapter,
  CacheGetOptions,
  CacheStats,
  ResilientCacheOptions,
} from './types';

interface MemoryCacheEntry<T> {
  value: T;
  expiresAt: number;
}

/**
 * High-performance L1 In-Memory Cache with TTL expiration.
 */
export class MemoryL1Cache<T> {
  private store = new Map<string, MemoryCacheEntry<T>>();

  public get(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) return null;

    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  public set(key: string, value: T, ttlMs: number): void {
    this.store.set(key, {
      value,
      expiresAt: Date.now() + Math.max(1, ttlMs),
    });
  }

  public delete(key: string): boolean {
    return this.store.delete(key);
  }

  public clear(): void {
    this.store.clear();
  }

  public size(): number {
    return this.store.size;
  }

  /**
   * Prune expired entries from memory.
   */
  public cleanupExpired(): number {
    const now = Date.now();
    let removed = 0;
    for (const [key, entry] of this.store.entries()) {
      if (now > entry.expiresAt) {
        this.store.delete(key);
        removed++;
      }
    }
    return removed;
  }
}

/**
 * Resilient 3-Tier Cache Engine:
 * - L1: High-speed In-Memory Cache
 * - L2: Remote Cache (Redis/Memcached) protected by Circuit Breaker
 * - L3: Origin Fetcher guarded by In-Flight Request Deduplication
 */
export class ResilientCache<T = unknown> {
  private l1: MemoryL1Cache<T>;
  private l2Adapter?: CacheAdapter<T>;
  private circuitBreaker: CircuitBreaker;
  private inFlight: InFlightManager;
  private l1TtlMs: number;
  private l2TtlMs: number;
  private enableInFlight: boolean;
  private onError?: (error: unknown, operation: string, key?: string) => void;

  private stats: {
    l1Hits: number;
    l2Hits: number;
    misses: number;
    fetches: number;
  } = {
    l1Hits: 0,
    l2Hits: 0,
    misses: 0,
    fetches: 0,
  };

  constructor(options: ResilientCacheOptions<T> = {}) {
    this.l1 = new MemoryL1Cache<T>();
    this.l2Adapter = options.l2Adapter;
    this.l1TtlMs = options.l1TtlMs ?? 30_000;
    this.l2TtlMs = options.l2TtlMs ?? 300_000;
    this.enableInFlight = options.enableInFlightDeduplication ?? true;
    this.onError = options.onError;

    this.circuitBreaker = new CircuitBreaker(options.circuitBreaker);
    this.inFlight = new InFlightManager();
  }

  /**
   * Get value from cache or execute fetcher with deduplication and fail-open fault tolerance.
   */
  public async getOrSet(
    key: string,
    fetcher: () => Promise<T>,
    options: CacheGetOptions = {}
  ): Promise<T> {
    const customTtl = options.ttlMs;
    const effectiveL1Ttl = customTtl ?? this.l1TtlMs;
    const effectiveL2Ttl = customTtl ?? this.l2TtlMs;

    // Step 1: Check L1 Memory Cache
    if (!options.skipL1) {
      const l1Val = this.l1.get(key);
      if (l1Val !== null && l1Val !== undefined) {
        this.stats.l1Hits++;
        return l1Val;
      }
    }

    // Step 2: Check L2 Remote Cache (guarded by Circuit Breaker)
    if (this.l2Adapter && !options.skipL2) {
      try {
        const l2Val = await this.circuitBreaker.execute(
          async () => {
            try {
              return await this.l2Adapter!.get(key);
            } catch (err) {
              this.reportError(err, 'L2_GET', key);
              throw err;
            }
          },
          async () => null // Fail-open: if circuit is open or throws, return null
        );

        if (l2Val !== null && l2Val !== undefined) {
          this.stats.l2Hits++;
          // Backfill into L1 for future fast reads
          this.l1.set(key, l2Val, effectiveL1Ttl);
          return l2Val;
        }
      } catch (err) {
        this.reportError(err, 'L2_GET', key);
        // Fail-open: continue to fetcher
      }
    }

    // Step 3: Cache Miss - Query Fetcher with In-Flight Deduplication
    this.stats.misses++;

    const runFetch = async (): Promise<T> => {
      // Double check L1 in case an earlier in-flight query finished just now
      if (!options.skipL1) {
        const recheckL1 = this.l1.get(key);
        if (recheckL1 !== null && recheckL1 !== undefined) {
          return recheckL1;
        }
      }

      this.stats.fetches++;
      const freshValue = await fetcher();

      // Store in L1
      this.l1.set(key, freshValue, effectiveL1Ttl);

      // Store in L2 asynchronously with circuit breaker guard
      if (this.l2Adapter) {
        this.circuitBreaker
          .execute(
            async () => {
              try {
                await this.l2Adapter!.set(key, freshValue, effectiveL2Ttl);
              } catch (err) {
                this.reportError(err, 'L2_SET', key);
                throw err;
              }
            },
            async () => {} // Silently ignore if breaker is open
          )
          .catch((err) => {
            this.reportError(err, 'L2_SET', key);
          });
      }

      return freshValue;
    };

    if (this.enableInFlight) {
      return this.inFlight.dedupe(key, runFetch);
    }

    return runFetch();
  }

  /**
   * Direct read from L1 and L2 without calling a fetcher.
   */
  public async get(
    key: string,
    options: CacheGetOptions = {}
  ): Promise<T | null> {
    if (!options.skipL1) {
      const l1Val = this.l1.get(key);
      if (l1Val !== null && l1Val !== undefined) {
        this.stats.l1Hits++;
        return l1Val;
      }
    }

    if (this.l2Adapter && !options.skipL2) {
      try {
        const l2Val = await this.circuitBreaker.execute(
          async () => {
            try {
              return await this.l2Adapter!.get(key);
            } catch (err) {
              this.reportError(err, 'L2_GET', key);
              throw err;
            }
          },
          async () => null
        );

        if (l2Val !== null && l2Val !== undefined) {
          this.stats.l2Hits++;
          this.l1.set(key, l2Val, options.ttlMs ?? this.l1TtlMs);
          return l2Val;
        }
      } catch (err) {
        this.reportError(err, 'L2_GET', key);
      }
    }

    return null;
  }

  /**
   * Write directly to L1 and L2.
   */
  public async set(key: string, value: T, ttlMs?: number): Promise<void> {
    const effectiveL1Ttl = ttlMs ?? this.l1TtlMs;
    const effectiveL2Ttl = ttlMs ?? this.l2TtlMs;

    this.l1.set(key, value, effectiveL1Ttl);

    if (this.l2Adapter) {
      try {
        await this.circuitBreaker.execute(
          async () => {
            try {
              await this.l2Adapter!.set(key, value, effectiveL2Ttl);
            } catch (err) {
              this.reportError(err, 'L2_SET', key);
              throw err;
            }
          },
          async () => {}
        );
      } catch (err) {
        this.reportError(err, 'L2_SET', key);
      }
    }
  }

  /**
   * Invalidate key in both L1 and L2.
   */
  public async delete(key: string): Promise<void> {
    this.l1.delete(key);

    if (this.l2Adapter) {
      try {
        await this.circuitBreaker.execute(
          async () => {
            try {
              await this.l2Adapter!.delete(key);
            } catch (err) {
              this.reportError(err, 'L2_DELETE', key);
              throw err;
            }
          },
          async () => {}
        );
      } catch (err) {
        this.reportError(err, 'L2_DELETE', key);
      }
    }
  }

  /**
   * Clear all keys in L1 and L2.
   */
  public async clear(): Promise<void> {
    this.l1.clear();

    if (this.l2Adapter?.clear) {
      try {
        await this.circuitBreaker.execute(
          async () => {
            try {
              await this.l2Adapter!.clear!();
            } catch (err) {
              this.reportError(err, 'L2_CLEAR');
              throw err;
            }
          },
          async () => {}
        );
      } catch (err) {
        this.reportError(err, 'L2_CLEAR');
      }
    }
  }

  public getStats(): CacheStats {
    return {
      l1Hits: this.stats.l1Hits,
      l2Hits: this.stats.l2Hits,
      misses: this.stats.misses,
      fetches: this.stats.fetches,
      inFlightSaves: this.inFlight.getCollapsedCount(),
      circuitState: this.circuitBreaker.getState(),
    };
  }

  public getCircuitBreaker(): CircuitBreaker {
    return this.circuitBreaker;
  }

  public getInFlightManager(): InFlightManager {
    return this.inFlight;
  }

  public getL1Cache(): MemoryL1Cache<T> {
    return this.l1;
  }

  private reportError(err: unknown, operation: string, key?: string): void {
    if (this.onError) {
      try {
        this.onError(err, operation, key);
      } catch {
        // Prevent telemetry crashes
      }
    }
  }
}
