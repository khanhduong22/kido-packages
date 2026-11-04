import { z } from 'zod';

/**
 * Strategy to apply when queue reaches its maximum capacity.
 * - DROP_OLDEST: Evict the oldest queued items from the head of the buffer.
 * - DROP_NEWEST: Reject the incoming new item(s) without queuing.
 * - THROW_ERROR: Throw a BatchBufferOverflowError immediately.
 */
export const BackpressurePolicySchema = z.enum([
  'DROP_OLDEST',
  'DROP_NEWEST',
  'THROW_ERROR',
]);

export type BackpressurePolicy = z.infer<typeof BackpressurePolicySchema>;

/**
 * Lifecycle status of the HybridBatcher engine.
 */
export const BatcherStatusSchema = z.enum([
  'idle',
  'running',
  'flushing',
  'stopping',
  'stopped',
]);

export type BatcherStatus = z.infer<typeof BatcherStatusSchema>;

/**
 * Zod validation schema for HybridBatcher configuration options.
 */
export const HybridBatcherOptionsSchema = z.object({
  /**
   * Maximum number of items in a single batch before triggering an immediate flush.
   * Default: 50 items.
   */
  maxBatchSize: z.number().int().positive().default(50),

  /**
   * Maximum wait time in milliseconds before flushing items even if maxBatchSize is not reached.
   * Default: 30,000ms (30 seconds).
   */
  maxWaitMs: z.number().int().positive().default(30000),

  /**
   * Maximum capacity of the pending buffer queue to guard against OOM during downstream lag.
   * Default: 10,000 items.
   */
  maxQueueCapacity: z.number().int().positive().default(10000),

  /**
   * Policy to apply when maximum queue capacity is reached.
   * Default: 'DROP_OLDEST'.
   */
  backpressurePolicy: BackpressurePolicySchema.default('DROP_OLDEST'),

  /**
   * Whether to automatically register SIGINT / SIGTERM listeners for graceful shutdown.
   * Default: false.
   */
  enableGracefulShutdown: z.boolean().default(false),

  /**
   * Maximum timeout in milliseconds to wait for graceful drain during process shutdown.
   * Default: 5,000ms.
   */
  shutdownTimeoutMs: z.number().int().positive().default(5000),

  /**
   * Whether to retry failed batch flushes before discarding or delegating to onError.
   * Default: false.
   */
  retryOnFailure: z.boolean().default(false),

  /**
   * Maximum number of flush retries if retryOnFailure is enabled.
   * Default: 3.
   */
  maxRetries: z.number().int().nonnegative().default(3),

  /**
   * Delay in milliseconds between retry attempts.
   * Default: 100ms.
   */
  retryDelayMs: z.number().int().nonnegative().default(100),
});

export type RawHybridBatcherOptions = z.infer<typeof HybridBatcherOptionsSchema>;

/**
 * Batch flusher function invoked when a batch is ready to be flushed to downstream storage / DB.
 */
export type BatchFlusher<T> = (batch: T[]) => Promise<void> | void;

/**
 * Abstract buffer backend driver (In-Memory, Redis List, Redis Stream, etc.)
 */
export interface BufferBackend<T> {
  /**
   * Push one or multiple items onto the tail of the buffer.
   * Returns current buffer size.
   */
  push(item: T | T[]): Promise<number> | number;

  /**
   * Pop up to `maxCount` items from the head of the buffer in FIFO order.
   */
  popBatch(maxCount: number): Promise<T[]> | T[];

  /**
   * Peek at up to `maxCount` items from the head without removing them.
   */
  peek(maxCount?: number): Promise<T[]> | T[];

  /**
   * Get the current count of items in the buffer.
   */
  size(): Promise<number> | number;

  /**
   * Drop the oldest `count` items from the head of the buffer.
   * Returns actual number of items dropped.
   */
  dropOldest(count: number): Promise<number> | number;

  /**
   * Drop the newest `count` items from the tail of the buffer.
   * Returns actual number of items dropped.
   */
  dropNewest?(count: number): Promise<number> | number;

  /**
   * Clear all items in the buffer.
   */
  clear(): Promise<void> | void;
}

/**
 * Telemetry and operational metrics snapshot for monitoring & alerting.
 */
export interface BatcherMetrics {
  /** Total number of successful batches flushed to downstream sink */
  flushedBatchesCount: number;

  /** Total number of individual items flushed to downstream sink */
  flushedItemsCount: number;

  /** Total number of items dropped due to backpressure queue capacity overflow */
  droppedItemsCount: number;

  /** Total count of errors encountered during batch flushes */
  errorCount: number;

  /** Current number of un-flushed items waiting in the buffer queue */
  currentQueueSize: number;

  /** Timestamp (ms) of the last completed batch flush, or null if no flush occurred yet */
  lastFlushTimestamp: number | null;

  /** Duration (ms) taken by the last flush execution */
  lastFlushDurationMs: number | null;

  /** Whether a flush execution is currently in progress */
  isFlushing: boolean;
}

/**
 * Full configuration options for HybridBatcher<T>.
 */
export interface HybridBatcherOptions<T> extends Partial<RawHybridBatcherOptions> {
  /**
   * Downstream flush handler that receives batches of items.
   */
  flusher: BatchFlusher<T>;

  /**
   * Custom queue storage backend. Defaults to high-performance MemoryBackend<T>.
   */
  backend?: BufferBackend<T>;

  /**
   * Error callback invoked when flusher throws an error.
   */
  onError?: (error: Error, batch: T[]) => Promise<void> | void;

  /**
   * Event hook triggered whenever a batch has successfully flushed.
   */
  onFlush?: (batch: T[], metrics: BatcherMetrics) => void;

  /**
   * Event hook triggered whenever backpressure policy drops items.
   */
  onBackpressure?: (droppedCount: number, policy: BackpressurePolicy) => void;
}

// -----------------------------------------------------------------------------
// Custom Domain Errors
// -----------------------------------------------------------------------------

export class BatchBufferError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BatchBufferError';
  }
}

export class BatchBufferOverflowError extends BatchBufferError {
  public readonly capacity: number;
  public readonly currentSize: number;

  constructor(capacity: number, currentSize: number) {
    super(
      `Batch buffer capacity exceeded! Limit: ${capacity}, Current size: ${currentSize}. Backpressure policy rejected insertion.`
    );
    this.name = 'BatchBufferOverflowError';
    this.capacity = capacity;
    this.currentSize = currentSize;
  }
}

export class BatchBufferShutdownError extends BatchBufferError {
  constructor(message = 'Cannot push items: HybridBatcher is currently shutting down or already stopped.') {
    super(message);
    this.name = 'BatchBufferShutdownError';
  }
}
