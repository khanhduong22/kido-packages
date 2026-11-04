import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  HybridBatcher,
  MemoryBackend,
  RedisBackend,
  MockRedisClient,
  BufferedAuditStorageAdapter,
  BatchBufferOverflowError,
  BatchBufferShutdownError,
} from './index';
import {
  MemoryStorageAdapter,
  AuditEntry,
  GENESIS_HASH,
  createAuditEntry,
} from '@kido/audit-trail';

// Helper sleep function
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('@kido/batch-buffer Test Suite', () => {
  // ---------------------------------------------------------------------------
  // 1. Dual Trigger: Size Trigger & Time Window Trigger
  // ---------------------------------------------------------------------------
  describe('1. Dual Trigger (Size + Time Window)', () => {
    it('1.1 should immediately flush when buffer hits maxBatchSize (50 items)', async () => {
      const flushedBatches: string[][] = [];

      const batcher = new HybridBatcher<string>({
        maxBatchSize: 50,
        maxWaitMs: 10000, // 10 seconds - will not trigger by time in this test
        flusher: (batch) => {
          flushedBatches.push(batch);
        },
      });

      // Push 49 items: size trigger should NOT fire yet
      for (let i = 1; i <= 49; i++) {
        await batcher.push(`item-${i}`);
      }

      assert.strictEqual(flushedBatches.length, 0);
      assert.strictEqual(await batcher.size(), 49);

      // Push 50th item: size trigger MUST fire immediately
      await batcher.push('item-50');

      // Wait brief microtask for async flush
      await sleep(10);

      assert.strictEqual(flushedBatches.length, 1);
      assert.strictEqual(flushedBatches[0].length, 50);
      assert.strictEqual(flushedBatches[0][0], 'item-1');
      assert.strictEqual(flushedBatches[0][49], 'item-50');
      assert.strictEqual(await batcher.size(), 0);

      await batcher.shutdown();
    });

    it('1.2 should flush multiple consecutive batches when large bulk items are inserted', async () => {
      const flushedBatches: number[][] = [];

      const batcher = new HybridBatcher<number>({
        maxBatchSize: 50,
        maxWaitMs: 10000,
        flusher: (batch) => {
          flushedBatches.push(batch);
        },
      });

      // Bulk push 125 items
      const items = Array.from({ length: 125 }, (_, i) => i + 1);
      await batcher.pushMany(items);

      await sleep(20);

      // Should have flushed 2 batches of 50 = 100 items, leaving 25 items in queue
      assert.strictEqual(flushedBatches.length, 2);
      assert.strictEqual(flushedBatches[0].length, 50);
      assert.strictEqual(flushedBatches[1].length, 50);
      assert.strictEqual(await batcher.size(), 25);

      // Drain remaining 25 items
      await batcher.drain();
      assert.strictEqual(flushedBatches.length, 3);
      assert.strictEqual(flushedBatches[2].length, 25);
      assert.strictEqual(await batcher.size(), 0);

      await batcher.shutdown();
    });

    it('1.3 should flush automatically when maxWaitMs expires even with few items (anti-stale data)', async () => {
      const flushedBatches: string[][] = [];

      const batcher = new HybridBatcher<string>({
        maxBatchSize: 50,
        maxWaitMs: 80, // Short 80ms window for testing
        flusher: (batch) => {
          flushedBatches.push(batch);
        },
      });

      // Push only 3 items (< 50)
      await batcher.push('low-traffic-item-1');
      await batcher.push('low-traffic-item-2');
      await batcher.push('low-traffic-item-3');

      assert.strictEqual(flushedBatches.length, 0);
      assert.strictEqual(await batcher.size(), 3);

      // Wait for time window trigger to fire
      await sleep(150);

      assert.strictEqual(flushedBatches.length, 1);
      assert.strictEqual(flushedBatches[0].length, 3);
      assert.deepStrictEqual(flushedBatches[0], [
        'low-traffic-item-1',
        'low-traffic-item-2',
        'low-traffic-item-3',
      ]);
      assert.strictEqual(await batcher.size(), 0);

      await batcher.shutdown();
    });

    it('1.4 should reset timer window after each flush to prevent premature time flush', async () => {
      const flushTimestamps: number[] = [];

      const batcher = new HybridBatcher<number>({
        maxBatchSize: 5,
        maxWaitMs: 100,
        flusher: () => {
          flushTimestamps.push(Date.now());
        },
      });

      // Push 5 items to trigger SIZE flush
      await batcher.pushMany([1, 2, 3, 4, 5]);
      await sleep(10);
      assert.strictEqual(flushTimestamps.length, 1);

      // Push 1 item: timer starts fresh at ~t=10ms, should fire at ~t=110ms
      await batcher.push(6);
      await sleep(50); // t=60ms (not yet 100ms)
      assert.strictEqual(flushTimestamps.length, 1);

      await sleep(80); // t=140ms (now 100ms has elapsed since push(6))
      assert.strictEqual(flushTimestamps.length, 2);

      await batcher.shutdown();
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Concurrency Mutex & Flush Lock (No Overlapping / Duplicate Writes)
  // ---------------------------------------------------------------------------
  describe('2. Concurrency Mutex & Flush Lock', () => {
    it('2.1 should guarantee that only ONE flush runs at any time even under concurrent pressure', async () => {
      let activeFlushes = 0;
      let maxConcurrentFlushes = 0;
      const flushedItems: number[] = [];

      const batcher = new HybridBatcher<number>({
        maxBatchSize: 10,
        maxWaitMs: 50,
        flusher: async (batch) => {
          activeFlushes++;
          maxConcurrentFlushes = Math.max(maxConcurrentFlushes, activeFlushes);

          // Simulate realistic async DB Bulk Insert latency
          await sleep(30);

          flushedItems.push(...batch);
          activeFlushes--;
        },
      });

      // Concurrently push 50 items and trigger multiple manual flush calls
      await Promise.all([
        (async () => {
          for (let i = 0; i < 25; i++) {
            await batcher.push(i);
          }
        })(),
        (async () => {
          for (let i = 25; i < 50; i++) {
            await batcher.push(i);
          }
        })(),
        batcher.flush(),
        batcher.flush(),
      ]);

      await batcher.drain();

      // Mutex lock assertion: concurrent flushes MUST NEVER exceed 1
      assert.strictEqual(maxConcurrentFlushes, 1);
      assert.strictEqual(activeFlushes, 0);

      // Verify all 50 items were flushed without loss
      assert.strictEqual(flushedItems.length, 50);
      assert.strictEqual(new Set(flushedItems).size, 50);

      await batcher.shutdown();
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Backpressure Guard (DROP_OLDEST, DROP_NEWEST, THROW_ERROR)
  // ---------------------------------------------------------------------------
  describe('3. Backpressure Guard', () => {
    it('3.1 should evict oldest items when policy is DROP_OLDEST on queue overflow', async () => {
      let backpressureEventFired = false;
      let droppedByEvent = 0;

      const batcher = new HybridBatcher<number>({
        maxBatchSize: 100, // Large so size trigger doesn't flush automatically
        maxWaitMs: 10000,
        maxQueueCapacity: 5,
        backpressurePolicy: 'DROP_OLDEST',
        onBackpressure: (dropped, policy) => {
          backpressureEventFired = true;
          droppedByEvent = dropped;
          assert.strictEqual(policy, 'DROP_OLDEST');
        },
        flusher: () => {},
      });

      // Push 5 items (queue full: [1, 2, 3, 4, 5])
      await batcher.pushMany([1, 2, 3, 4, 5]);
      assert.strictEqual(await batcher.size(), 5);

      // Push 3 more items: items 1, 2, 3 must be evicted, queue has [4, 5, 6, 7, 8]
      await batcher.pushMany([6, 7, 8]);
      assert.strictEqual(await batcher.size(), 5);

      const remaining = await batcher.peek();
      assert.deepStrictEqual(remaining, [4, 5, 6, 7, 8]);
      assert.strictEqual(backpressureEventFired, true);
      assert.strictEqual(droppedByEvent, 3);

      const metrics = batcher.getMetrics();
      assert.strictEqual(metrics.droppedItemsCount, 3);

      await batcher.shutdown();
    });

    it('3.2 should reject incoming newest items when policy is DROP_NEWEST on queue overflow', async () => {
      let backpressureEventFired = false;

      const batcher = new HybridBatcher<number>({
        maxBatchSize: 100,
        maxWaitMs: 10000,
        maxQueueCapacity: 5,
        backpressurePolicy: 'DROP_NEWEST',
        onBackpressure: (dropped, policy) => {
          backpressureEventFired = true;
          assert.strictEqual(dropped, 3);
          assert.strictEqual(policy, 'DROP_NEWEST');
        },
        flusher: () => {},
      });

      // Fill buffer to capacity
      await batcher.pushMany([1, 2, 3, 4, 5]);

      // Try pushing 3 more items: they must be rejected
      await batcher.pushMany([6, 7, 8]);

      assert.strictEqual(await batcher.size(), 5);
      const remaining = await batcher.peek();
      assert.deepStrictEqual(remaining, [1, 2, 3, 4, 5]);
      assert.strictEqual(backpressureEventFired, true);

      const metrics = batcher.getMetrics();
      assert.strictEqual(metrics.droppedItemsCount, 3);

      await batcher.shutdown();
    });

    it('3.3 should throw BatchBufferOverflowError when policy is THROW_ERROR on queue overflow', async () => {
      const batcher = new HybridBatcher<number>({
        maxBatchSize: 100,
        maxWaitMs: 10000,
        maxQueueCapacity: 5,
        backpressurePolicy: 'THROW_ERROR',
        flusher: () => {},
      });

      await batcher.pushMany([1, 2, 3, 4, 5]);

      await assert.rejects(
        async () => {
          await batcher.push(6);
        },
        (err: unknown) => {
          assert.ok(err instanceof BatchBufferOverflowError);
          assert.strictEqual(err.capacity, 5);
          assert.strictEqual(err.currentSize, 5);
          return true;
        }
      );

      const metrics = batcher.getMetrics();
      assert.strictEqual(metrics.droppedItemsCount, 1);
      assert.strictEqual(metrics.errorCount, 1);

      await batcher.shutdown();
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Graceful Shutdown & Drain
  // ---------------------------------------------------------------------------
  describe('4. Graceful Shutdown & Drain', () => {
    it('4.1 should drain all pending items cleanly upon shutdown without losing any record', async () => {
      const flushed: number[] = [];

      const batcher = new HybridBatcher<number>({
        maxBatchSize: 10,
        maxWaitMs: 30000, // Long window
        flusher: (batch) => {
          flushed.push(...batch);
        },
      });

      // Push 25 items (not a multiple of 10)
      for (let i = 1; i <= 25; i++) {
        await batcher.push(i);
      }

      await sleep(10);
      // Batches 1 and 2 (20 items) flushed by size; 5 items pending in buffer
      assert.strictEqual(await batcher.size(), 5);

      // Perform graceful shutdown
      await batcher.shutdown();

      // Buffer must be empty and all 25 items received by flusher
      assert.strictEqual(await batcher.size(), 0);
      assert.strictEqual(flushed.length, 25);
      assert.strictEqual(flushed[24], 25);
      assert.strictEqual(batcher.getStatus(), 'stopped');

      // Subsequent pushes should be rejected
      await assert.rejects(
        async () => {
          await batcher.push(26);
        },
        (err: unknown) => err instanceof BatchBufferShutdownError
      );
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Telemetry Metrics
  // ---------------------------------------------------------------------------
  describe('5. Telemetry Metrics', () => {
    it('5.1 should accurately track flushedBatchesCount, flushedItemsCount, and lastFlushDurationMs', async () => {
      const batcher = new HybridBatcher<string>({
        maxBatchSize: 10,
        maxWaitMs: 10000,
        flusher: async () => {
          await sleep(5);
        },
      });

      await batcher.pushMany(Array.from({ length: 30 }, (_, i) => `item-${i}`));
      await sleep(25);

      const metrics = batcher.getMetrics();
      assert.strictEqual(metrics.flushedBatchesCount, 3);
      assert.strictEqual(metrics.flushedItemsCount, 30);
      assert.strictEqual(metrics.errorCount, 0);
      assert.strictEqual(metrics.droppedItemsCount, 0);
      assert.ok(typeof metrics.lastFlushTimestamp === 'number');
      assert.ok(metrics.lastFlushDurationMs !== null && metrics.lastFlushDurationMs >= 0);

      batcher.resetMetrics();
      const resetSnapshot = batcher.getMetrics();
      assert.strictEqual(resetSnapshot.flushedBatchesCount, 0);
      assert.strictEqual(resetSnapshot.flushedItemsCount, 0);

      await batcher.shutdown();
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Storage Backends: MemoryBackend & RedisBackend
  // ---------------------------------------------------------------------------
  describe('6. Storage Backends (Memory & Redis)', () => {
    it('6.1 MemoryBackend should handle FIFO popBatch, peek, dropOldest, and clear properly', async () => {
      const backend = new MemoryBackend<string>({ compactionThreshold: 4 });

      backend.push(['a', 'b', 'c', 'd', 'e']);
      assert.strictEqual(backend.size(), 5);

      const peeked = backend.peek(2);
      assert.deepStrictEqual(peeked, ['a', 'b']);
      assert.strictEqual(backend.size(), 5);

      const batch = backend.popBatch(3);
      assert.deepStrictEqual(batch, ['a', 'b', 'c']);
      assert.strictEqual(backend.size(), 2);

      backend.dropOldest(1);
      assert.strictEqual(backend.size(), 1);
      assert.deepStrictEqual(backend.peek(), ['e']);

      backend.clear();
      assert.strictEqual(backend.size(), 0);
    });

    it('6.2 RedisBackend with MockRedisClient should perform atomic batch popping and list operations', async () => {
      const mockClient = new MockRedisClient();
      const redisBackend = new RedisBackend<string>({
        client: mockClient,
        queueKey: 'test:audit:queue',
        useLuaScript: true,
      });

      await redisBackend.push(['msg-1', 'msg-2', 'msg-3', 'msg-4', 'msg-5']);
      assert.strictEqual(await redisBackend.size(), 5);

      const peekItems = await redisBackend.peek(3);
      assert.deepStrictEqual(peekItems, ['msg-1', 'msg-2', 'msg-3']);

      // Atomic pop batch of 3
      const popped = await redisBackend.popBatch(3);
      assert.deepStrictEqual(popped, ['msg-1', 'msg-2', 'msg-3']);
      assert.strictEqual(await redisBackend.size(), 2);

      // Remaining items
      const remaining = await redisBackend.popBatch(10);
      assert.deepStrictEqual(remaining, ['msg-4', 'msg-5']);
      assert.strictEqual(await redisBackend.size(), 0);

      await redisBackend.clear();
    });

    it('6.3 HybridBatcher should operate seamlessly with RedisBackend', async () => {
      const mockClient = new MockRedisClient();
      const redisBackend = new RedisBackend<number>({
        client: mockClient,
        queueKey: 'distributed:jobs',
      });

      const flushed: number[] = [];
      const batcher = new HybridBatcher<number>({
        backend: redisBackend,
        maxBatchSize: 5,
        maxWaitMs: 10000,
        flusher: (batch) => {
          flushed.push(...batch);
        },
      });

      await batcher.pushMany([10, 20, 30, 40, 50]);
      await sleep(15);

      assert.strictEqual(flushed.length, 5);
      assert.deepStrictEqual(flushed, [10, 20, 30, 40, 50]);
      assert.strictEqual(await batcher.size(), 0);

      await batcher.shutdown();
    });
  });

  // ---------------------------------------------------------------------------
  // 7. Error Handling & Retry Logic
  // ---------------------------------------------------------------------------
  describe('7. Error Recovery & Retry Strategy', () => {
    it('7.1 should retry failed flushes when retryOnFailure is enabled and succeed on recovery', async () => {
      let attempts = 0;

      const batcher = new HybridBatcher<string>({
        maxBatchSize: 2,
        maxWaitMs: 10000,
        retryOnFailure: true,
        maxRetries: 2,
        retryDelayMs: 10,
        flusher: async () => {
          attempts++;
          if (attempts < 3) {
            throw new Error(`Transient DB connection drop (attempt ${attempts})`);
          }
        },
      });

      await batcher.pushMany(['log-1', 'log-2']);
      await sleep(50);

      assert.strictEqual(attempts, 3);
      const metrics = batcher.getMetrics();
      assert.strictEqual(metrics.flushedBatchesCount, 1);
      assert.strictEqual(metrics.errorCount, 2); // 2 transient errors before success

      await batcher.shutdown();
    });

    it('7.2 should invoke onError handler when flush fails exhaustively', async () => {
      let caughtError: Error | null = null;
      let failedBatch: string[] = [];

      const batcher = new HybridBatcher<string>({
        maxBatchSize: 2,
        maxWaitMs: 10000,
        flusher: async () => {
          throw new Error('Downstream DB fatal disk error');
        },
        onError: (err, batch) => {
          caughtError = err;
          failedBatch = batch;
        },
      });

      await batcher.pushMany(['err-1', 'err-2']);
      await sleep(20);

      assert.ok(caughtError !== null);
      assert.strictEqual((caughtError as Error).message, 'Downstream DB fatal disk error');
      assert.deepStrictEqual(failedBatch, ['err-1', 'err-2']);

      await batcher.shutdown();
    });
  });

  // ---------------------------------------------------------------------------
  // 8. BufferedAuditStorageAdapter with @kido/audit-trail
  // ---------------------------------------------------------------------------
  describe('8. BufferedAuditStorageAdapter (@kido/audit-trail)', () => {
    const dummyActor = {
      userId: 'usr_cashier_01',
      role: 'CASHIER',
      ipAddress: '192.168.1.100',
      userAgent: 'Sunmi-POS',
      branchId: 'BRANCH_D1',
    };

    it('8.1 should provide Read-Your-Own-Writes immediate visibility via getAll() and getById()', async () => {
      const underlyingStorage = new MemoryStorageAdapter();
      const bufferedAdapter = new BufferedAuditStorageAdapter(underlyingStorage, {
        maxBatchSize: 50,
        maxWaitMs: 30000, // Not flushed yet
      });

      const entry1 = createAuditEntry(
        {
          actor: dummyActor,
          action: 'ORDER_CREATE',
          entityId: 'ORD_001',
          payload: { totalAmount: 150000 },
        },
        GENESIS_HASH
      );

      const entry2 = createAuditEntry(
        {
          actor: dummyActor,
          action: 'PRICE_OVERRIDE',
          entityId: 'ORD_001',
          payload: { discount: 5000 },
        },
        entry1.currentHash
      );

      // Append 2 entries: they are buffered in memory and not yet flushed to underlying storage
      await bufferedAdapter.append(entry1);
      await bufferedAdapter.append(entry2);

      // Underlying storage should have 0 records
      assert.strictEqual(underlyingStorage.getAll().length, 0);

      // But bufferedAdapter.getAll() should return all 2 records immediately!
      const visibleEntries = await bufferedAdapter.getAll();
      assert.strictEqual(visibleEntries.length, 2);
      assert.strictEqual(visibleEntries[0].id, entry1.id);
      assert.strictEqual(visibleEntries[1].id, entry2.id);

      // getById() should also find pending buffered record
      const fetched = await bufferedAdapter.getById(entry2.id);
      assert.ok(fetched !== null);
      assert.strictEqual(fetched?.id, entry2.id);

      // Flush to underlying storage
      await bufferedAdapter.flush();

      // Now underlying storage also has both records
      assert.strictEqual(underlyingStorage.getAll().length, 2);

      await bufferedAdapter.shutdown();
    });

    it('8.2 should automatically flush batch of 50 audit entries to underlying storage upon reaching size trigger', async () => {
      const underlyingStorage = new MemoryStorageAdapter();
      const bufferedAdapter = new BufferedAuditStorageAdapter(underlyingStorage, {
        maxBatchSize: 50,
        maxWaitMs: 30000,
      });

      let prevHash = GENESIS_HASH;
      const entries: AuditEntry[] = [];
      for (let i = 1; i <= 50; i++) {
        const entry = createAuditEntry(
          {
            actor: dummyActor,
            action: 'ORDER_CREATE',
            entityId: `ORD_${i}`,
            payload: { itemIndex: i },
          },
          prevHash
        );
        entries.push(entry);
        prevHash = entry.currentHash;
      }

      // Append 50 entries
      await bufferedAdapter.appendBatch(entries);
      await sleep(15);

      // Must have flushed to underlying storage automatically!
      const persisted = underlyingStorage.getAll();
      assert.strictEqual(persisted.length, 50);
      assert.strictEqual(persisted[0].entityId, 'ORD_1');
      assert.strictEqual(persisted[49].entityId, 'ORD_50');

      const metrics = bufferedAdapter.getMetrics();
      assert.strictEqual(metrics.flushedBatchesCount, 1);
      assert.strictEqual(metrics.flushedItemsCount, 50);

      await bufferedAdapter.shutdown();
    });
  });
});
