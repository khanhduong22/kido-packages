export interface BatchProcessOptions {
  /** Number of items per outer batch. Default: 50 */
  batchSize?: number;
  /** Maximum concurrent tasks within each batch. Default: 10 */
  concurrency?: number;
  /** Delay in milliseconds between batches. Default: 0 */
  delayBetweenBatchesMs?: number;
  /** Alias for delayBetweenBatchesMs */
  delayBetweenBatches?: number;
  /** Delay in milliseconds before each item after the first within a batch. Default: 0 */
  delayBetweenItemsMs?: number;
  /** Alias for delayBetweenItemsMs */
  delayBetweenItems?: number;
}

export interface BatchConcurrencyLimiterOptions {
  /** Default maximum concurrent operations. Default: 10 */
  maxConcurrent?: number;
  /** Default delay between batches in milliseconds. Default: 100 */
  delayBetweenBatchesMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute an array of async task factories in batches of size `limit` using `Promise.allSettled`,
 * with an optional delay between batches.
 */
export async function executeWithConcurrencyLimit<T>(
  tasks: Array<() => Promise<T>>,
  limit = 10,
  delayBetweenBatchesMs = 0,
): Promise<PromiseSettledResult<T>[]> {
  const effectiveLimit = Math.max(1, Math.floor(limit));
  const results: PromiseSettledResult<T>[] = [];

  for (let i = 0; i < tasks.length; i += effectiveLimit) {
    const batch = tasks.slice(i, i + effectiveLimit);
    const batchResults = await Promise.allSettled(batch.map((task) => task()));
    results.push(...batchResults);

    if (i + effectiveLimit < tasks.length && delayBetweenBatchesMs > 0) {
      await sleep(delayBetweenBatchesMs);
    }
  }

  return results;
}

/**
 * Process an array of items in outer batches (`batchSize`) and inner concurrency windows (`concurrency`)
 * using `Promise.allSettled`.
 */
export async function processBatched<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  options: BatchProcessOptions = {},
): Promise<PromiseSettledResult<R>[]> {
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? 50));
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 10));
  const delayBetweenBatchesMs = Math.max(
    0,
    options.delayBetweenBatchesMs ?? options.delayBetweenBatches ?? 0,
  );
  const delayBetweenItemsMs = Math.max(
    0,
    options.delayBetweenItemsMs ?? options.delayBetweenItems ?? 0,
  );

  const results: PromiseSettledResult<R>[] = [];

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchTasks = batch.map((item, batchIndex) => async () => {
      if (delayBetweenItemsMs > 0 && batchIndex > 0) {
        await sleep(delayBetweenItemsMs);
      }
      return fn(item, i + batchIndex);
    });

    const batchResults = await executeWithConcurrencyLimit(
      batchTasks,
      concurrency,
      0,
    );
    results.push(...batchResults);

    if (i + batchSize < items.length && delayBetweenBatchesMs > 0) {
      await sleep(delayBetweenBatchesMs);
    }
  }

  return results;
}

/**
 * Batch Concurrency Limiter to prevent proxy & upstream socket pool exhaustion.
 */
export class BatchConcurrencyLimiter {
  private readonly maxConcurrent: number;
  private readonly delayBetweenBatchesMs: number;

  constructor(options: BatchConcurrencyLimiterOptions = {}) {
    this.maxConcurrent = Math.max(1, Math.floor(options.maxConcurrent ?? 10));
    this.delayBetweenBatchesMs = Math.max(
      0,
      options.delayBetweenBatchesMs ?? 100,
    );
  }

  public async executeWithConcurrencyLimit<T>(
    tasks: Array<() => Promise<T>>,
    limit = this.maxConcurrent,
    delayBetweenBatchesMs = this.delayBetweenBatchesMs,
  ): Promise<PromiseSettledResult<T>[]> {
    return executeWithConcurrencyLimit(tasks, limit, delayBetweenBatchesMs);
  }

  public async executeWithLimit<T>(
    tasks: Array<() => Promise<T>>,
    limit = this.maxConcurrent,
    delayBetweenBatchesMs = this.delayBetweenBatchesMs,
  ): Promise<PromiseSettledResult<T>[]> {
    return executeWithConcurrencyLimit(tasks, limit, delayBetweenBatchesMs);
  }

  public async processBatched<T, R>(
    items: T[],
    fn: (item: T, index: number) => Promise<R>,
    options: BatchProcessOptions = {},
  ): Promise<PromiseSettledResult<R>[]> {
    return processBatched(items, fn, {
      concurrency: this.maxConcurrent,
      delayBetweenBatchesMs: this.delayBetweenBatchesMs,
      ...options,
    });
  }

  public async executeChunked<T, R>(
    items: T[],
    fn: (item: T, index: number) => Promise<R>,
    chunkSize: number,
    concurrencyLimit = this.maxConcurrent,
  ): Promise<PromiseSettledResult<R>[]> {
    return this.processBatched(items, fn, {
      batchSize: chunkSize,
      concurrency: concurrencyLimit,
      delayBetweenBatchesMs: this.delayBetweenBatchesMs,
    });
  }

  public async executeThrottled<T, R>(
    items: T[],
    fn: (item: T, index: number) => Promise<R>,
    minDelayMs: number,
  ): Promise<PromiseSettledResult<R>[]> {
    const results: PromiseSettledResult<R>[] = [];

    for (let i = 0; i < items.length; i++) {
      const startTime = Date.now();
      try {
        const value = await fn(items[i], i);
        results.push({ status: 'fulfilled', value });
      } catch (reason) {
        results.push({ status: 'rejected', reason });
      }

      const elapsed = Date.now() - startTime;
      const remainingDelay = minDelayMs - elapsed;
      if (remainingDelay > 0 && i < items.length - 1) {
        await sleep(remainingDelay);
      }
    }

    return results;
  }

  public getConfig(): { maxConcurrent: number; delayBetweenBatchesMs: number } {
    return {
      maxConcurrent: this.maxConcurrent,
      delayBetweenBatchesMs: this.delayBetweenBatchesMs,
    };
  }
}
