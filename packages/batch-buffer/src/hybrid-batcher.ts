import { MemoryBackend } from './backends/memory-backend';
import {
  BackpressurePolicy,
  BatchBufferOverflowError,
  BatchBufferShutdownError,
  BatchFlusher,
  BatcherMetrics,
  BatcherStatus,
  BufferBackend,
  HybridBatcherOptions,
  HybridBatcherOptionsSchema,
  RawHybridBatcherOptions,
} from './types';

/**
 * High-Performance Hybrid Buffer & Flush Engine.
 * Dual Trigger Architecture:
 * 1. Size Trigger: Flushes immediately when pending items reach `maxBatchSize` (e.g. 50 items).
 * 2. Time Window Trigger: Flushes automatically after `maxWaitMs` (e.g. 30,000ms) to prevent stale data.
 * 3. Concurrency Mutex: Guarantees zero overlapping flushes to prevent duplicate writes or race conditions.
 * 4. Backpressure Guard: Configurable policies ('DROP_OLDEST', 'DROP_NEWEST', 'THROW_ERROR') when queue capacity is reached.
 * 5. Graceful Drain & Shutdown: Cleanly flushes pending items on SIGINT/SIGTERM before exit.
 */
export class HybridBatcher<T> {
  private readonly options: RawHybridBatcherOptions & {
    flusher: BatchFlusher<T>;
    onError?: (error: Error, batch: T[]) => Promise<void> | void;
    onFlush?: (batch: T[], metrics: BatcherMetrics) => void;
    onBackpressure?: (droppedCount: number, policy: BackpressurePolicy) => void;
  };

  private readonly backend: BufferBackend<T>;
  private timer: NodeJS.Timeout | null = null;
  private status: BatcherStatus = 'idle';

  // Concurrency Mutex & Flush Lock State
  private isFlushing = false;
  private flushPromise: Promise<void> | null = null;
  private nextFlushRequested = false;

  // Operational Telemetry Metrics
  private readonly metrics: BatcherMetrics = {
    flushedBatchesCount: 0,
    flushedItemsCount: 0,
    droppedItemsCount: 0,
    errorCount: 0,
    currentQueueSize: 0,
    lastFlushTimestamp: null,
    lastFlushDurationMs: null,
    isFlushing: false,
  };

  private readonly boundSignalHandler: () => void;
  private signalsRegistered = false;

  constructor(options: HybridBatcherOptions<T>) {
    if (!options || typeof options.flusher !== 'function') {
      throw new Error('HybridBatcher requires a valid "flusher" function.');
    }

    // Validate configuration options with Zod defaults
    const validated = HybridBatcherOptionsSchema.parse({
      maxBatchSize: options.maxBatchSize,
      maxWaitMs: options.maxWaitMs,
      maxQueueCapacity: options.maxQueueCapacity,
      backpressurePolicy: options.backpressurePolicy,
      enableGracefulShutdown: options.enableGracefulShutdown,
      shutdownTimeoutMs: options.shutdownTimeoutMs,
      retryOnFailure: options.retryOnFailure,
      maxRetries: options.maxRetries,
      retryDelayMs: options.retryDelayMs,
    });

    this.options = {
      ...validated,
      flusher: options.flusher,
      onError: options.onError,
      onFlush: options.onFlush,
      onBackpressure: options.onBackpressure,
    };

    this.backend = options.backend ?? new MemoryBackend<T>();
    this.status = 'idle';

    this.boundSignalHandler = () => {
      this.shutdown().catch((err) => {
        // Safe logger during signal trap
        console.error('Error during HybridBatcher graceful shutdown:', err);
      });
    };

    if (this.options.enableGracefulShutdown) {
      this.registerSignalHandlers();
    }
  }

  /**
   * Push a single item into the batch buffer.
   * Enforces backpressure policies and triggers immediate size-based flush if threshold is reached.
   */
  public async push(item: T): Promise<number> {
    return this.pushMany([item]);
  }

  /**
   * Bulk push multiple items into the batch buffer.
   */
  public async pushMany(items: T[]): Promise<number> {
    if (this.status === 'stopping' || this.status === 'stopped') {
      throw new BatchBufferShutdownError();
    }

    if (items.length === 0) {
      return this.size();
    }

    const currentSize = await this.backend.size();
    const capacity = this.options.maxQueueCapacity;
    const projectedSize = currentSize + items.length;

    let itemsToInsert = items;

    if (projectedSize > capacity) {
      switch (this.options.backpressurePolicy) {
        case 'THROW_ERROR': {
          this.metrics.droppedItemsCount += items.length;
          this.metrics.errorCount++;
          this.options.onBackpressure?.(items.length, 'THROW_ERROR');
          throw new BatchBufferOverflowError(capacity, currentSize);
        }

        case 'DROP_NEWEST': {
          const availableSlots = Math.max(0, capacity - currentSize);
          const droppedCount = items.length - availableSlots;
          this.metrics.droppedItemsCount += droppedCount;
          this.options.onBackpressure?.(droppedCount, 'DROP_NEWEST');

          if (availableSlots === 0) {
            return currentSize;
          }
          itemsToInsert = items.slice(0, availableSlots);
          break;
        }

        case 'DROP_OLDEST':
        default: {
          const overflowCount = projectedSize - capacity;
          const dropped = await this.backend.dropOldest(overflowCount);
          this.metrics.droppedItemsCount += dropped;
          this.options.onBackpressure?.(dropped, 'DROP_OLDEST');
          break;
        }
      }
    }

    // Insert items into storage backend
    const newSize = await this.backend.push(itemsToInsert);
    this.status = 'running';

    // Start timer window if not currently active
    if (!this.timer && newSize > 0) {
      this.startTimer();
    }

    // Dual Trigger 1: Size Trigger (Threshold reached)
    if (newSize >= this.options.maxBatchSize) {
      this.triggerAsyncFlush();
    }

    return newSize;
  }

  /**
   * Explicitly triggers an immediate flush and awaits its completion.
   * If a flush is already executing, waits for it and proceeds with remaining items.
   */
  public async flush(): Promise<void> {
    if (this.status === 'stopped') return;
    await this.executeFlushLoop();
  }

  /**
   * Drain all pending items from the buffer until the queue size reaches 0.
   * Flushes items in batches up to `maxBatchSize`.
   */
  public async drain(): Promise<void> {
    while ((await this.backend.size()) > 0) {
      await this.executeFlushLoop();
    }
  }

  /**
   * Graceful shutdown:
   * 1. Stops accepting new items (rejects future push calls).
   * 2. Clears active time window timers.
   * 3. Drains all pending buffer items with a timeout guard.
   * 4. Detaches system signal listeners.
   */
  public async shutdown(options?: { timeoutMs?: number }): Promise<void> {
    if (this.status === 'stopping' || this.status === 'stopped') {
      return;
    }

    this.status = 'stopping';
    this.clearTimer();
    this.detachSignalHandlers();

    const timeoutMs = options?.timeoutMs ?? this.options.shutdownTimeoutMs;

    try {
      await Promise.race([
        this.drain(),
        new Promise<void>((_, reject) => {
          const t = setTimeout(() => {
            reject(new Error(`HybridBatcher graceful shutdown timed out after ${timeoutMs}ms`));
          }, timeoutMs);
          t.unref?.();
        }),
      ]);
    } finally {
      this.status = 'stopped';
    }
  }

  /**
   * Peek at items currently waiting in the buffer without dequeuing them.
   */
  public async peek(maxCount?: number): Promise<T[]> {
    return this.backend.peek(maxCount);
  }

  /**
   * Return the current number of pending items in the queue.
   */
  public async size(): Promise<number> {
    return this.backend.size();
  }

  /**
   * Get current operational telemetry metrics snapshot.
   */
  public getMetrics(): BatcherMetrics {
    return {
      ...this.metrics,
      isFlushing: this.isFlushing,
    };
  }

  /**
   * Asynchronously update current queue size in metrics and return snapshot.
   */
  public async refreshMetrics(): Promise<BatcherMetrics> {
    this.metrics.currentQueueSize = await this.backend.size();
    return this.getMetrics();
  }

  /**
   * Reset operational counters.
   */
  public resetMetrics(): void {
    this.metrics.flushedBatchesCount = 0;
    this.metrics.flushedItemsCount = 0;
    this.metrics.droppedItemsCount = 0;
    this.metrics.errorCount = 0;
    this.metrics.lastFlushTimestamp = null;
    this.metrics.lastFlushDurationMs = null;
  }

  /**
   * Return current lifecycle status.
   */
  public getStatus(): BatcherStatus {
    return this.status;
  }

  /**
   * Discard all pending items in buffer and cancel timers.
   */
  public async clear(): Promise<void> {
    this.clearTimer();
    await this.backend.clear();
    this.metrics.currentQueueSize = 0;
    if (this.status === 'running') {
      this.status = 'idle';
    }
  }

  // ---------------------------------------------------------------------------
  // Internal Flush Engine & Mutex Lock
  // ---------------------------------------------------------------------------

  private triggerAsyncFlush(): void {
    this.executeFlushLoop().catch((err) => {
      // In background flush, log or delegate to error handler
      if (!this.options.onError) {
        console.error('Unhandled error in HybridBatcher background flush:', err);
      }
    });
  }

  /**
   * Concurrency Mutex: Guarantees that only ONE flush process is active at any time.
   */
  private async executeFlushLoop(): Promise<void> {
    if (this.isFlushing) {
      this.nextFlushRequested = true;
      if (this.flushPromise) {
        await this.flushPromise;
      }
      return;
    }

    this.isFlushing = true;
    this.metrics.isFlushing = true;
    this.nextFlushRequested = false;

    this.flushPromise = (async () => {
      try {
        await this.flushSingleBatch();
      } finally {
        this.isFlushing = false;
        this.metrics.isFlushing = false;
        this.flushPromise = null;
      }
    })();

    await this.flushPromise;

    // Reschedule timer after flush
    const remainingSize = await this.backend.size();
    this.metrics.currentQueueSize = remainingSize;

    if (remainingSize === 0) {
      this.clearTimer();
      if (this.status === 'running') {
        this.status = 'idle';
      }
    } else {
      // Reset timer window to prevent premature timeout flush
      this.startTimer();

      // If more items waiting than maxBatchSize or next flush was requested while locked
      if (this.nextFlushRequested || remainingSize >= this.options.maxBatchSize) {
        await this.executeFlushLoop();
      }
    }
  }

  /**
   * Pops up to `maxBatchSize` items and executes downstream `flusher` with retry logic.
   */
  private async flushSingleBatch(): Promise<void> {
    const currentSize = await this.backend.size();
    if (currentSize === 0) {
      return;
    }

    const batch = await this.backend.popBatch(this.options.maxBatchSize);
    if (batch.length === 0) {
      return;
    }

    let attempt = 0;
    const maxAttempts = this.options.retryOnFailure ? this.options.maxRetries + 1 : 1;
    let flushSuccess = false;
    let lastError: Error | null = null;

    while (attempt < maxAttempts && !flushSuccess) {
      attempt++;
      const startTime = Date.now();
      try {
        await this.options.flusher(batch);
        const duration = Date.now() - startTime;

        this.metrics.flushedBatchesCount++;
        this.metrics.flushedItemsCount += batch.length;
        this.metrics.lastFlushTimestamp = Date.now();
        this.metrics.lastFlushDurationMs = duration;
        flushSuccess = true;

        this.options.onFlush?.(batch, this.getMetrics());
      } catch (err: unknown) {
        lastError = err instanceof Error ? err : new Error(String(err));
        this.metrics.errorCount++;

        if (attempt < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, this.options.retryDelayMs));
        }
      }
    }

    if (!flushSuccess && lastError) {
      if (this.options.onError) {
        try {
          await this.options.onError(lastError, batch);
        } catch (handlerErr) {
          console.error('Error in HybridBatcher onError handler:', handlerErr);
        }
      } else {
        throw lastError;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Time Window Timer Management
  // ---------------------------------------------------------------------------

  private startTimer(): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.handleTimerTick();
    }, this.options.maxWaitMs);

    // Prevent unreferenced timer from keeping Node process alive
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private handleTimerTick(): void {
    this.clearTimer();
    // Dual Trigger 2: Time Window Trigger (anti-stale flush)
    this.triggerAsyncFlush();
  }

  // ---------------------------------------------------------------------------
  // Process Signal Handlers
  // ---------------------------------------------------------------------------

  private registerSignalHandlers(): void {
    if (this.signalsRegistered) return;
    try {
      process.on('SIGINT', this.boundSignalHandler);
      process.on('SIGTERM', this.boundSignalHandler);
      this.signalsRegistered = true;
    } catch {
      // Ignore if not in standard Node environment
    }
  }

  public detachSignalHandlers(): void {
    if (!this.signalsRegistered) return;
    try {
      process.removeListener('SIGINT', this.boundSignalHandler);
      process.removeListener('SIGTERM', this.boundSignalHandler);
      this.signalsRegistered = false;
    } catch {
      // Ignore
    }
  }
}
