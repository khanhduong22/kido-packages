import type { BufferedViewCounterOptions, FlushResult } from './types';

/**
 * In-Memory Buffered View Counter with sliding window visitor deduplication.
 * Prevents DB write storms by batching view counter increments.
 */
export class BufferedViewCounter {
  private dedupWindowMs: number;
  private flushIntervalMs: number;
  private maxBatchSize: number;
  private onFlush: (batch: Map<string, number>) => Promise<void> | void;
  private onError?: (error: unknown) => void;

  // Deduplication cache: key = `${targetId}::${visitorId}`, value = lastSeenTimestamp
  private dedupCache = new Map<string, number>();

  // Aggregated view counts pending flush: key = targetId, value = count
  private pendingViews = new Map<string, number>();

  private timer: ReturnType<typeof setInterval> | null = null;
  private isFlushing = false;

  constructor(options: BufferedViewCounterOptions) {
    this.dedupWindowMs = Math.max(1, options.dedupWindowMs ?? 15 * 60 * 1000);
    this.flushIntervalMs = Math.max(1, options.flushIntervalMs ?? 10_000);
    this.maxBatchSize = Math.max(1, options.maxBatchSize ?? 500);
    this.onFlush = options.onFlush;
    this.onError = options.onError;

    this.startAutoFlush();
  }

  /**
   * Record a view attempt.
   * Returns true if counted as a valid new view, or false if deduplicated.
   */
  public recordView(targetId: string, visitorId: string): boolean {
    const now = Date.now();
    const dedupKey = `${targetId}::${visitorId}`;
    const lastSeen = this.dedupCache.get(dedupKey);

    if (lastSeen !== undefined && now - lastSeen < this.dedupWindowMs) {
      // Duplicate view within the dedup window
      return false;
    }

    // Update visitor timestamp
    this.dedupCache.set(dedupKey, now);

    // Increment pending view counter for targetId
    const currentCount = this.pendingViews.get(targetId) ?? 0;
    this.pendingViews.set(targetId, currentCount + 1);

    // If batch size threshold reached, trigger immediate flush asynchronously
    if (this.pendingViews.size >= this.maxBatchSize && !this.isFlushing) {
      this.flush().catch((err) => {
        this.reportError(err);
      });
    }

    return true;
  }

  /**
   * Get total number of pending views waiting to be flushed.
   */
  public getPendingTotal(): number {
    let total = 0;
    for (const count of this.pendingViews.values()) {
      total += count;
    }
    return total;
  }

  /**
   * Get pending count for a specific target.
   */
  public getPendingCount(targetId: string): number {
    return this.pendingViews.get(targetId) ?? 0;
  }

  /**
   * Flush pending batched views to persistence handler.
   */
  public async flush(): Promise<FlushResult> {
    if (this.pendingViews.size === 0) {
      this.pruneExpiredDedup();
      return {
        flushedItems: 0,
        totalViews: 0,
        timestamp: Date.now(),
      };
    }

    this.isFlushing = true;

    // Atomically swap map
    const batch = this.pendingViews;
    this.pendingViews = new Map<string, number>();

    let totalViews = 0;
    for (const count of batch.values()) {
      totalViews += count;
    }

    const flushedItems = batch.size;

    try {
      await this.onFlush(batch);
    } catch (err) {
      // On failure, re-merge back into pendingViews so counts aren't lost
      for (const [targetId, count] of batch.entries()) {
        const existing = this.pendingViews.get(targetId) ?? 0;
        this.pendingViews.set(targetId, existing + count);
      }
      this.reportError(err);
      throw err;
    } finally {
      this.isFlushing = false;
      this.pruneExpiredDedup();
    }

    return {
      flushedItems,
      totalViews,
      timestamp: Date.now(),
    };
  }

  /**
   * Prune stale entries from the in-memory visitor deduplication cache.
   */
  public pruneExpiredDedup(): number {
    const now = Date.now();
    let removed = 0;
    for (const [key, timestamp] of this.dedupCache.entries()) {
      if (now - timestamp >= this.dedupWindowMs) {
        this.dedupCache.delete(key);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Start periodic auto-flush timer.
   */
  public startAutoFlush(intervalMs?: number): void {
    if (intervalMs) {
      this.flushIntervalMs = Math.max(100, intervalMs);
    }
    this.stopAutoFlush();
    this.timer = setInterval(() => {
      this.flush().catch((err) => {
        this.reportError(err);
      });
    }, this.flushIntervalMs);
  }

  /**
   * Stop auto-flush timer without flushing.
   */
  public stopAutoFlush(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Stop auto-flush timer and flush all pending views cleanly.
   */
  public async stop(): Promise<FlushResult> {
    this.stopAutoFlush();
    return await this.flush();
  }

  private reportError(err: unknown): void {
    if (this.onError) {
      try {
        this.onError(err);
      } catch {
        // Prevent crashing error handler
      }
    }
  }
}
