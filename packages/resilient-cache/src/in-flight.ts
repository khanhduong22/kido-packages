/**
 * In-Flight Request Deduplication Manager (SingleFlight Engine).
 * Collapses concurrent requests for identical keys into a single execution,
 * with Epoch Mutation Protection and Pattern-Based In-Flight Invalidation.
 */
export class InFlightManager {
  private activePromises = new Map<string, Promise<unknown>>();
  private collapsedCount = 0;
  private mutationEpoch = 0;

  /**
   * Run an asynchronous fetcher or join an in-flight promise if one is already running.
   */
  public async dedupe<R>(key: string, fetcher: () => Promise<R>): Promise<R> {
    const existing = this.activePromises.get(key);
    if (existing) {
      this.collapsedCount++;
      return existing as Promise<R>;
    }

    const promise = (async () => {
      try {
        return await fetcher();
      } finally {
        this.activePromises.delete(key);
      }
    })();

    this.activePromises.set(key, promise);
    return promise;
  }

  /**
   * Deduplicate requests with mutation epoch protection.
   * If a mutation occurs (epoch changes) while the fetcher is running,
   * the caller can intercept or discard the stale result before writing it back to cache.
   */
  public async dedupeWithEpoch<R>(
    key: string,
    fetcher: (startEpoch: number) => Promise<R>,
    options?: {
      onStaleDiscard?: (staleValue: R, startEpoch: number, currentEpoch: number) => void;
    }
  ): Promise<R> {
    const startEpoch = this.mutationEpoch;
    const existing = this.activePromises.get(key);
    if (existing) {
      this.collapsedCount++;
      return existing as Promise<R>;
    }

    const promise = (async () => {
      try {
        const result = await fetcher(startEpoch);
        if (this.mutationEpoch !== startEpoch && options?.onStaleDiscard) {
          options.onStaleDiscard(result, startEpoch, this.mutationEpoch);
        }
        return result;
      } finally {
        this.activePromises.delete(key);
      }
    })();

    this.activePromises.set(key, promise);
    return promise;
  }

  /**
   * Invalidate a single active in-flight key synchronously.
   */
  public invalidateKey(key: string): boolean {
    return this.activePromises.delete(key);
  }

  /**
   * Invalidate active in-flight promises matching a glob pattern or RegExp,
   * and bump the mutation epoch to prevent stale concurrent write-back.
   */
  public invalidatePattern(pattern: string | RegExp): number {
    this.bumpMutationEpoch();
    const regex =
      typeof pattern === "string"
        ? new RegExp(
            "^" +
              pattern
                .replace(/[.+^${}()|[\]\\]/g, "\\$&")
                .replace(/\*/g, ".*")
                .replace(/\?/g, ".") +
              "$"
          )
        : pattern;

    let cleared = 0;
    for (const inFlightKey of Array.from(this.activePromises.keys())) {
      if (regex.test(inFlightKey)) {
        this.activePromises.delete(inFlightKey);
        cleared++;
      }
    }
    return cleared;
  }

  /**
   * Increment and return current mutation epoch.
   */
  public bumpMutationEpoch(): number {
    return ++this.mutationEpoch;
  }

  /**
   * Get current mutation epoch.
   */
  public getMutationEpoch(): number {
    return this.mutationEpoch;
  }

  /**
   * Check if a key currently has an active in-flight request.
   */
  public isInFlight(key: string): boolean {
    return this.activePromises.has(key);
  }

  /**
   * Get the number of currently active promises.
   */
  public getActiveCount(): number {
    return this.activePromises.size;
  }

  /**
   * Get total number of concurrent requests that were collapsed into an active promise.
   */
  public getCollapsedCount(): number {
    return this.collapsedCount;
  }

  /**
   * Clear all tracked promises (does not cancel running promises, but untracks keys)
   * and increments mutation epoch.
   */
  public clear(): void {
    this.bumpMutationEpoch();
    this.activePromises.clear();
  }
}

export interface SingleFlightCacheEntry<T> {
  data: T;
  expiresAt: number;
  staleAt: number;
}

export interface SingleFlightOptions {
  ttlMs?: number;
  staleTtlMs?: number;
}

export interface SingleFlightStats {
  hits: number;
  staleHits: number;
  misses: number;
  collapsedCount: number;
}

/**
 * SingleFlight SWR (Stale-While-Revalidate) Micro-Cache Engine.
 * Collapses concurrent in-flight executions for identical keys,
 * serves ultra-fast cached responses within fresh TTL,
 * asynchronously background-revalidates within the SWR window,
 * and shields against UnhandledPromiseRejection during async refresh.
 */
export class SingleFlightSwr {
  private inFlight = new Map<string, Promise<unknown>>();
  private cache = new Map<string, SingleFlightCacheEntry<unknown>>();
  private stats: SingleFlightStats = {
    hits: 0,
    staleHits: 0,
    misses: 0,
    collapsedCount: 0,
  };

  /**
   * Execute with SingleFlight deduplication, micro-cache, and optional Stale-While-Revalidate window.
   * @param key Unique cache/request key
   * @param fetcher Async producer function
   * @param options TTL and SWR duration in milliseconds
   */
  public async execute<T>(
    key: string,
    fetcher: () => Promise<T>,
    options?: SingleFlightOptions
  ): Promise<T> {
    const ttlMs = options?.ttlMs ?? 0;
    const staleTtlMs = options?.staleTtlMs ?? 0;
    const now = Date.now();

    if (ttlMs > 0 && this.cache.has(key)) {
      const entry = this.cache.get(key) as SingleFlightCacheEntry<T>;
      if (now < entry.expiresAt) {
        this.stats.hits++;
        return entry.data;
      }
      if (staleTtlMs > 0 && now < entry.staleAt) {
        this.stats.staleHits++;
        // Trigger background revalidation without blocking caller
        setTimeout(() => {
          this.revalidate(key, fetcher, ttlMs, staleTtlMs).catch(() => {});
        }, 0);
        return entry.data;
      }
      this.cache.delete(key);
    }

    if (this.inFlight.has(key)) {
      this.stats.collapsedCount++;
      return this.inFlight.get(key) as Promise<T>;
    }

    this.stats.misses++;
    return this.revalidate(key, fetcher, ttlMs, staleTtlMs);
  }

  /**
   * Revalidate key, joining in-flight promise if one is already running.
   */
  public revalidate<T>(
    key: string,
    fetcher: () => Promise<T>,
    ttlMs = 0,
    staleTtlMs = 0
  ): Promise<T> {
    const existing = this.inFlight.get(key) as Promise<T> | undefined;
    if (existing) {
      return existing;
    }

    const promise = (async () => {
      try {
        const result = await fetcher();
        if (ttlMs > 0) {
          const completedAt = Date.now();
          this.cache.set(key, {
            data: result,
            expiresAt: completedAt + ttlMs,
            staleAt: completedAt + ttlMs + staleTtlMs,
          });
        }
        return result;
      } finally {
        this.inFlight.delete(key);
      }
    })();

    // Shield against unhandled rejection when revalidation runs detached in background
    promise.catch(() => {});

    this.inFlight.set(key, promise as Promise<unknown>);
    return promise;
  }

  /**
   * Pre-warm multiple keys concurrently in the background.
   */
  public async prewarm<T>(
    entries: Array<{
      key: string;
      fetcher: () => Promise<T>;
      options?: SingleFlightOptions;
    }>
  ): Promise<PromiseSettledResult<T>[]> {
    return Promise.allSettled(
      entries.map((e) => this.execute(e.key, e.fetcher, e.options))
    );
  }

  /**
   * Synchronously invalidate a single key from cache and in-flight tracking.
   */
  public invalidate(key: string): boolean {
    const c = this.cache.delete(key);
    const f = this.inFlight.delete(key);
    return c || f;
  }

  /**
   * Invalidate all keys matching a regex or glob pattern.
   */
  public invalidatePattern(pattern: string | RegExp): number {
    const regex =
      typeof pattern === "string"
        ? new RegExp(
            "^" +
              pattern
                .replace(/[.+^${}()|[\]\\]/g, "\\$&")
                .replace(/\*/g, ".*")
                .replace(/\?/g, ".") +
              "$"
          )
        : pattern;

    let cleared = 0;
    for (const key of Array.from(this.cache.keys())) {
      if (regex.test(key)) {
        this.cache.delete(key);
        cleared++;
      }
    }
    for (const key of Array.from(this.inFlight.keys())) {
      if (regex.test(key)) {
        this.inFlight.delete(key);
      }
    }
    return cleared;
  }

  /**
   * Clear all cache and in-flight promises.
   */
  public clear(): void {
    this.cache.clear();
    this.inFlight.clear();
  }

  /**
   * Get telemetry stats.
   */
  public getStats(): SingleFlightStats {
    return { ...this.stats };
  }

  /**
   * Reset telemetry counters.
   */
  public resetStats(): void {
    this.stats = { hits: 0, staleHits: 0, misses: 0, collapsedCount: 0 };
  }

  /**
   * Get size of cache.
   */
  public getCacheSize(): number {
    return this.cache.size;
  }
}

/**
 * Access or create a global singleton SingleFlightSwr instance.
 * Preserves cache and in-flight state across Next.js / Vite / Fastify / Bun hot module reloads.
 */
export function getGlobalSingleFlight(name = "default"): SingleFlightSwr {
  const globalKey = `__kt_singleflight_${name}`;
  const g = globalThis as unknown as Record<string, SingleFlightSwr | undefined>;
  if (!g[globalKey]) {
    g[globalKey] = new SingleFlightSwr();
  }
  return g[globalKey]!;
}

