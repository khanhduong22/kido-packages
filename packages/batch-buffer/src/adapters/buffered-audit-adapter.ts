import type { AuditEntry, AuditStorageAdapter } from '@kido/audit-trail';
import { HybridBatcher } from '../hybrid-batcher';
import {
  BatcherMetrics,
  BufferBackend,
  RawHybridBatcherOptions,
} from '../types';

export interface BufferedAuditAdapterOptions extends Partial<RawHybridBatcherOptions> {
  backend?: BufferBackend<AuditEntry>;
  onError?: (error: Error, batch: AuditEntry[]) => Promise<void> | void;
  onFlush?: (batch: AuditEntry[], metrics: BatcherMetrics) => void;
}

/**
 * High-Throughput Micro-Batching Adapter wrapping any AuditStorageAdapter.
 * Transforms single-record sequential disk/network I/O operations into
 * optimal dual-triggered micro-batches (50 items or 30-second window).
 *
 * Guarantees immediate read-your-own-writes consistency by combining
 * persisted storage records with pending buffered records during getAll() and getById().
 */
export class BufferedAuditStorageAdapter implements AuditStorageAdapter {
  private readonly underlying: AuditStorageAdapter;
  private readonly batcher: HybridBatcher<AuditEntry>;

  constructor(underlying: AuditStorageAdapter, options?: BufferedAuditAdapterOptions) {
    this.underlying = underlying;

    this.batcher = new HybridBatcher<AuditEntry>({
      maxBatchSize: options?.maxBatchSize ?? 50,
      maxWaitMs: options?.maxWaitMs ?? 30000,
      maxQueueCapacity: options?.maxQueueCapacity ?? 10000,
      backpressurePolicy: options?.backpressurePolicy ?? 'DROP_OLDEST',
      enableGracefulShutdown: options?.enableGracefulShutdown ?? false,
      shutdownTimeoutMs: options?.shutdownTimeoutMs ?? 5000,
      retryOnFailure: options?.retryOnFailure ?? false,
      maxRetries: options?.maxRetries ?? 3,
      retryDelayMs: options?.retryDelayMs ?? 100,
      backend: options?.backend,
      onError: options?.onError,
      onFlush: options?.onFlush,
      flusher: async (batch: AuditEntry[]) => {
        // Fast-path: Check if underlying adapter natively supports bulk batch append
        const underlyingBatch = this.underlying as {
          appendBatch?: (entries: AuditEntry[]) => Promise<void> | void;
        };

        if (typeof underlyingBatch.appendBatch === 'function') {
          await underlyingBatch.appendBatch(batch);
          return;
        }

        // Sequential persistence to preserve strict audit log ordering
        for (const entry of batch) {
          await this.underlying.append(entry);
        }
      },
    });
  }

  /**
   * Append an audit entry into the micro-batching buffer.
   * Flushes immediately if queue hits maxBatchSize (default 50).
   */
  public async append(entry: AuditEntry): Promise<void> {
    await this.batcher.push(entry);
  }

  /**
   * Bulk append an array of audit entries into the micro-batching buffer.
   */
  public async appendBatch(entries: AuditEntry[]): Promise<void> {
    await this.batcher.pushMany(entries);
  }

  /**
   * Query all audit entries, combining both persisted storage records
   * and un-flushed entries currently in the memory buffer.
   */
  public async getAll(): Promise<AuditEntry[]> {
    const persisted = await this.underlying.getAll();
    const pending = await this.batcher.peek();

    if (pending.length === 0) {
      return persisted;
    }

    // Merge persisted + pending, maintaining unique entries by ID
    const seenIds = new Set<string>();
    const merged: AuditEntry[] = [];

    for (const item of persisted) {
      if (!seenIds.has(item.id)) {
        seenIds.add(item.id);
        merged.push(item);
      }
    }

    for (const item of pending) {
      if (!seenIds.has(item.id)) {
        seenIds.add(item.id);
        merged.push(item);
      }
    }

    return merged;
  }

  /**
   * Find an audit record by ID.
   * Checks pending buffer first (fast-path), then falls back to underlying storage.
   */
  public async getById(id: string): Promise<AuditEntry | null> {
    const pending = await this.batcher.peek();
    const foundPending = pending.find((entry) => entry.id === id);
    if (foundPending) {
      return foundPending;
    }

    return this.underlying.getById(id);
  }

  /**
   * Clear both buffer and underlying storage.
   */
  public async clear(): Promise<void> {
    await this.batcher.clear();
    if (typeof this.underlying.clear === 'function') {
      await this.underlying.clear();
    }
  }

  /**
   * Manually trigger a flush of all currently pending items to underlying storage.
   */
  public async flush(): Promise<void> {
    await this.batcher.flush();
  }

  /**
   * Drain all pending items from buffer to storage until buffer is empty.
   */
  public async drain(): Promise<void> {
    await this.batcher.drain();
  }

  /**
   * Graceful shutdown of the batcher engine.
   */
  public async shutdown(options?: { timeoutMs?: number }): Promise<void> {
    await this.batcher.shutdown(options);
  }

  /**
   * Retrieve operational telemetry metrics from the batcher.
   */
  public getMetrics(): BatcherMetrics {
    return this.batcher.getMetrics();
  }

  /**
   * Get direct reference to underlying HybridBatcher.
   */
  public getBatcher(): HybridBatcher<AuditEntry> {
    return this.batcher;
  }

  /**
   * Get direct reference to underlying AuditStorageAdapter.
   */
  public getUnderlying(): AuditStorageAdapter {
    return this.underlying;
  }
}
