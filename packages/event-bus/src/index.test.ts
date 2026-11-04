import assert from 'node:assert';
import test from 'node:test';
import { z } from 'zod';
import {
  createIdempotentHandler,
  createMetricsMiddleware,
  createTracingMiddleware,
  DeadLetterQueue,
  EventBus,
  InMemoryDLQStorage,
  InMemoryEventBusDriver,
  InMemoryIdempotencyStorage,
  InMemoryOutboxStorage,
  OutboxDispatcher,
  RedisClientLike,
  RedisEventBusDriver,
  TransactionalOutbox,
} from './index';

test('1. EventBus - basic publish and subscribe with default InMemory driver', async () => {
  const bus = new EventBus();
  const received: Array<{ orderId: string; amount: number }> = [];

  const unsubscribe = await bus.subscribe<{ orderId: string; amount: number }>(
    'order.created',
    (event) => {
      received.push(event.payload);
    }
  );

  const published = await bus.publish('order.created', {
    orderId: 'ORD-101',
    amount: 250000,
  });

  assert.strictEqual(received.length, 1);
  assert.strictEqual(received[0].orderId, 'ORD-101');
  assert.strictEqual(received[0].amount, 250000);
  assert.strictEqual(published.name, 'order.created');
  assert.ok(published.id);
  assert.ok(published.metadata.timestamp > 0);
  assert.strictEqual(published.version, 1);

  await unsubscribe();
  await bus.close();
});

test('2. EventBus - strongly-typed topic with Zod schema validation', async () => {
  const bus = new EventBus();

  const PaymentSchema = z.object({
    paymentId: z.string(),
    amount: z.number().positive(),
    method: z.enum(['VIETQR', 'MOMO', 'CASH']),
  });

  const PaymentTopic = bus.defineTopic('payment.processed', PaymentSchema);

  let receivedPayload: z.infer<typeof PaymentSchema> | null = null;
  await bus.subscribe(PaymentTopic, (event) => {
    receivedPayload = event.payload;
  });

  // Valid payload succeeds
  await bus.publish(PaymentTopic, {
    paymentId: 'PAY-888',
    amount: 150000,
    method: 'VIETQR',
  });

  const result = receivedPayload as z.infer<typeof PaymentSchema> | null;
  assert.ok(result);
  assert.strictEqual(result.paymentId, 'PAY-888');

  // Invalid payload throws validation error
  await assert.rejects(async () => {
    await bus.publish(PaymentTopic, {
      paymentId: 'PAY-999',
      amount: -500, // Invalid: must be positive
      method: 'BITCOIN' as any, // Invalid: not in enum
    });
  }, (err: unknown) => err instanceof z.ZodError);

  await bus.close();
});

test('3. EventBus - topic wildcard matching (* and #)', async () => {
  const bus = new EventBus();
  const singleWildcardReceived: string[] = [];
  const multiWildcardReceived: string[] = [];

  // Single wildcard matches 1 token
  await bus.subscribe('order.*', (event) => {
    singleWildcardReceived.push(event.name);
  });

  // Multi wildcard matches multiple tokens
  await bus.subscribe('order.#', (event) => {
    multiWildcardReceived.push(event.name);
  });

  await bus.publish('order.created', { id: 1 });
  await bus.publish('order.food.created', { id: 2 });

  // 'order.*' matches 'order.created', but NOT 'order.food.created'
  assert.deepStrictEqual(singleWildcardReceived, ['order.created']);

  // 'order.#' matches both 'order.created' and 'order.food.created'
  assert.deepStrictEqual(multiWildcardReceived, [
    'order.created',
    'order.food.created',
  ]);

  await bus.close();
});

test('4. EventBus - unsubscribe and once option', async () => {
  const bus = new EventBus();
  let normalCount = 0;
  let onceCount = 0;

  const unsubscribe = await bus.subscribe('notification.send', () => {
    normalCount++;
  });

  await bus.subscribe(
    'notification.send',
    () => {
      onceCount++;
    },
    { once: true }
  );

  // First publish
  await bus.publish('notification.send', { msg: 'First' });
  assert.strictEqual(normalCount, 1);
  assert.strictEqual(onceCount, 1);

  // Second publish: once listener should not trigger
  await bus.publish('notification.send', { msg: 'Second' });
  assert.strictEqual(normalCount, 2);
  assert.strictEqual(onceCount, 1);

  // Unsubscribe normal listener
  await unsubscribe();
  await bus.publish('notification.send', { msg: 'Third' });
  assert.strictEqual(normalCount, 2);

  await bus.close();
});

test('5. EventBus - middleware pipeline (tracing and metrics)', async () => {
  const metricsMiddleware = createMetricsMiddleware();
  const tracingMiddleware = createTracingMiddleware({ serviceName: 'order-api' });

  const bus = new EventBus({
    middlewares: [tracingMiddleware, metricsMiddleware],
  });

  let capturedTraceId: string | undefined;
  let capturedCorrelationId: string | undefined;
  let capturedSource: string | undefined;

  await bus.subscribe('inventory.reserved', (event) => {
    capturedTraceId = event.metadata.traceId;
    capturedCorrelationId = event.metadata.correlationId;
    capturedSource = event.metadata.source;
  });

  await bus.publish('inventory.reserved', { sku: 'BURGER-01', qty: 2 });

  // Assert tracing propagation
  assert.ok(capturedTraceId);
  assert.ok(capturedCorrelationId);
  assert.strictEqual(capturedSource, 'order-api');
  assert.strictEqual(capturedTraceId, capturedCorrelationId);

  // Assert metrics
  const stats = metricsMiddleware.getMetrics();
  assert.strictEqual(stats.publishedCount, 1);
  assert.strictEqual(stats.consumedCount, 1);
  assert.strictEqual(stats.errorCount, 0);
  assert.strictEqual(stats.byTopic['inventory.reserved'].published, 1);
  assert.strictEqual(stats.byTopic['inventory.reserved'].consumed, 1);

  await bus.close();
});

test('6. Transactional Outbox - records events during business transaction', async () => {
  const storage = new InMemoryOutboxStorage();
  const outbox = new TransactionalOutbox(storage);

  const mockDbTransaction = { txId: 'tx-999' };

  const record = await outbox.saveEvent(
    'order.created',
    { orderId: 'ORD-555', total: 120000 },
    {
      metadata: { userId: 'user-42' },
      maxRetries: 3,
    },
    mockDbTransaction
  );

  assert.ok(record.id);
  assert.strictEqual(record.eventName, 'order.created');
  assert.strictEqual(record.status, 'PENDING');
  assert.strictEqual(record.retryCount, 0);
  assert.strictEqual(record.metadata.userId, 'user-42');

  const pending = await storage.fetchPending(10);
  assert.strictEqual(pending.length, 1);
  assert.strictEqual(pending[0].id, record.id);
});

test('7. Transactional Outbox - Dispatcher polls and delivers pending events to EventBus', async () => {
  const storage = new InMemoryOutboxStorage();
  const outbox = new TransactionalOutbox(storage);
  const bus = new EventBus();

  const dispatchedEvents: unknown[] = [];
  await bus.subscribe('order.placed', (event) => {
    dispatchedEvents.push(event.payload);
  });

  // Save 2 events to Outbox
  await outbox.saveEvent('order.placed', { orderId: 'ORD-1' });
  await outbox.saveEvent('order.placed', { orderId: 'ORD-2' });

  const dispatcher = new OutboxDispatcher({
    storage,
    eventBus: bus,
    batchSize: 10,
  });

  const count = await dispatcher.pollOnce();
  assert.strictEqual(count, 2);
  assert.strictEqual(dispatchedEvents.length, 2);

  // All events should now be marked as PUBLISHED
  const remainingPending = await storage.fetchPending(10);
  assert.strictEqual(remainingPending.length, 0);

  const allRecords = await storage.getAll();
  assert.ok(allRecords.every((r) => r.status === 'PUBLISHED'));

  await bus.close();
});

test('8. Transactional Outbox - handles retries with exponential backoff on dispatch failure', async () => {
  const storage = new InMemoryOutboxStorage();
  const outbox = new TransactionalOutbox(storage);
  const bus = new EventBus();

  // Subscribe a failing handler to simulate transient failure
  await bus.subscribe('order.failing', () => {
    throw new Error('Downstream network timeout');
  });

  const record = await outbox.saveEvent(
    'order.failing',
    { orderId: 'FAIL-1' },
    { maxRetries: 3 }
  );

  const dispatcher = new OutboxDispatcher({
    storage,
    eventBus: bus,
    backoffFactorMs: 1000,
    maxRetries: 3,
  });

  // 1st attempt fails
  const published = await dispatcher.pollOnce();
  assert.strictEqual(published, 0);

  const updatedRecord = await storage.getById(record.id);
  assert.ok(updatedRecord);
  assert.strictEqual(updatedRecord.status, 'PENDING');
  assert.strictEqual(updatedRecord.retryCount, 1);
  assert.strictEqual(updatedRecord.lastError, 'Downstream network timeout');
  assert.ok(updatedRecord.nextRetryAt);
  // nextRetryAt should be set in the future (backoffFactorMs * 2^0 = 1000ms)
  assert.ok(updatedRecord.nextRetryAt.getTime() > Date.now());

  await bus.close();
});

test('9. Transactional Outbox & DLQ - routes to DLQ when max retries exceeded', async () => {
  const storage = new InMemoryOutboxStorage();
  const outbox = new TransactionalOutbox(storage);
  const dlq = new DeadLetterQueue();
  const bus = new EventBus();

  await bus.subscribe('order.fatal', () => {
    throw new Error('Fatal unrecoverable error');
  });

  // Max retries set to 1
  await outbox.saveEvent('order.fatal', { id: 'FATAL-1' }, { maxRetries: 1 });

  const dispatcher = new OutboxDispatcher({
    storage,
    eventBus: bus,
    dlq,
    maxRetries: 1,
  });

  await dispatcher.pollOnce();

  // Storage should mark as FAILED
  const allRecords = await storage.getAll();
  assert.strictEqual(allRecords[0].status, 'FAILED');

  // DLQ should have received the record
  const dlqRecords = await dlq.list();
  assert.strictEqual(dlqRecords.length, 1);
  assert.strictEqual(dlqRecords[0].failureReason, 'Fatal unrecoverable error');
  assert.strictEqual(dlqRecords[0].topic, 'order.fatal');
  assert.strictEqual(dlqRecords[0].status, 'QUEUED');

  await bus.close();
});

test('10. Idempotent Consumer - prevents duplicate processing of same event', async () => {
  const idempotencyStorage = new InMemoryIdempotencyStorage();
  let executionCount = 0;
  let duplicateNotified = 0;

  const rawHandler = async (_event: { id: string; payload: { item: string } }) => {
    executionCount++;
  };

  const protectedHandler = createIdempotentHandler<{ item: string }>({
    consumerName: 'order-service',
    storage: idempotencyStorage,
    handler: rawHandler as any,
    onDuplicate: () => {
      duplicateNotified++;
    },
  });

  const eventEnvelope = {
    id: 'evt-uuid-12345',
    name: 'item.purchased',
    payload: { item: 'Laptop' },
    metadata: { timestamp: Date.now() },
    version: 1,
  };

  // First execution: handler executes
  await protectedHandler(eventEnvelope);
  assert.strictEqual(executionCount, 1);
  assert.strictEqual(duplicateNotified, 0);

  // Second execution (duplicate event): handler skipped!
  await protectedHandler(eventEnvelope);
  assert.strictEqual(executionCount, 1);
  assert.strictEqual(duplicateNotified, 1);

  // Different consumer name processes independently
  const emailConsumerHandler = createIdempotentHandler<{ item: string }>({
    consumerName: 'email-notifier',
    storage: idempotencyStorage,
    handler: rawHandler as any,
  });

  await emailConsumerHandler(eventEnvelope);
  assert.strictEqual(executionCount, 2);
});

test('11. Idempotent Consumer - does NOT mark processed if handler throws error', async () => {
  const idempotencyStorage = new InMemoryIdempotencyStorage();
  let attempts = 0;

  const flakyHandler = async () => {
    attempts++;
    if (attempts === 1) {
      throw new Error('Temporary database deadlock');
    }
  };

  const protectedHandler = createIdempotentHandler({
    consumerName: 'inventory-worker',
    storage: idempotencyStorage,
    handler: flakyHandler,
  });

  const eventEnvelope = {
    id: 'evt-flaky-99',
    name: 'stock.deduct',
    payload: {},
    metadata: { timestamp: Date.now() },
    version: 1,
  };

  // 1st attempt throws
  await assert.rejects(async () => {
    await protectedHandler(eventEnvelope);
  }, /Temporary database deadlock/);

  assert.strictEqual(attempts, 1);
  // Not marked as processed
  const isProcessed = await idempotencyStorage.isProcessed('evt-flaky-99', 'inventory-worker');
  assert.strictEqual(isProcessed, false);

  // 2nd retry attempt succeeds and marks as processed
  await protectedHandler(eventEnvelope);
  assert.strictEqual(attempts, 2);
  const isNowProcessed = await idempotencyStorage.isProcessed('evt-flaky-99', 'inventory-worker');
  assert.strictEqual(isNowProcessed, true);
});

test('12. Dead Letter Queue - supports replay/redrive to EventBus', async () => {
  const dlq = new DeadLetterQueue();
  const bus = new EventBus();

  const replayedEvents: unknown[] = [];
  await bus.subscribe('payment.refund', (event) => {
    replayedEvents.push(event.payload);
  });

  // Enqueue a failed event into DLQ
  const record = await dlq.sendToDLQ({
    event: {
      id: 'refund-evt-01',
      name: 'payment.refund',
      payload: { refundId: 'REF-1', amount: 50000 },
      metadata: { timestamp: Date.now() },
      version: 1,
    },
    error: new Error('Bank gateway unavailable'),
    topic: 'payment.refund',
    retryCount: 3,
    consumerName: 'refund-processor',
  });

  assert.strictEqual(record.status, 'QUEUED');

  // Trigger Replay
  const success = await dlq.replay(record.id, bus);
  assert.strictEqual(success, true);
  assert.strictEqual(replayedEvents.length, 1);
  // @ts-expect-error cast payload
  assert.strictEqual(replayedEvents[0].refundId, 'REF-1');

  // Record status should be updated to REPLAYED
  const updated = await dlq.getById(record.id);
  assert.strictEqual(updated?.status, 'REPLAYED');

  // Replaying again returns false
  const repeat = await dlq.replay(record.id, bus);
  assert.strictEqual(repeat, false);

  await bus.close();
});

test('13. RedisEventBusDriver - mock Redis client verifies XADD and XREADGROUP stream operations', async () => {
  const xaddCalls: Array<{ key: string; args: unknown[] }> = [];
  const xackCalls: Array<{ key: string; group: string; ids: string[] }> = [];

  const mockRedisClient: RedisClientLike = {
    xadd: async (key: string, ...args: unknown[]) => {
      xaddCalls.push({ key, args });
      return '1700000000000-0';
    },
    xgroup: async () => 'OK',
    xreadgroup: async () => {
      // Simulate 1 batch then null to avoid endless polling loop in test
      if (xackCalls.length === 0) {
        return [
          [
            'eventbus:stream:audit.log',
            [
              [
                '1700000000000-0',
                [
                  'event',
                  JSON.stringify({
                    id: '123e4567-e89b-12d3-a456-426614174000',
                    name: 'audit.log',
                    payload: { action: 'USER_LOGIN' },
                    metadata: { timestamp: Date.now() },
                    version: 1,
                  }),
                ],
              ],
            ],
          ],
        ];
      }
      return null;
    },
    xack: async (key: string, group: string, ...ids: string[]) => {
      xackCalls.push({ key, group, ids });
      return 1;
    },
    disconnect: () => {},
  };

  const redisDriver = new RedisEventBusDriver({
    client: mockRedisClient,
    streamPrefix: 'eventbus:stream:',
    blockTimeoutMs: 10,
  });

  const bus = new EventBus({ driver: redisDriver });
  assert.strictEqual(bus.getDriverName(), 'redis-streams');

  // Test publishing
  await bus.publish('audit.log', { action: 'USER_LOGIN' });
  assert.strictEqual(xaddCalls.length, 1);
  assert.strictEqual(xaddCalls[0].key, 'eventbus:stream:audit.log');

  // Test subscription & ACK
  let receivedAction = '';
  const unsubscribe = await bus.subscribe(
    'audit.log',
    (event) => {
      // @ts-expect-error cast payload
      receivedAction = event.payload.action;
    },
    { once: true }
  );

  // Wait a tick for background polling loop
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.strictEqual(receivedAction, 'USER_LOGIN');
  assert.strictEqual(xackCalls.length, 1);
  assert.strictEqual(xackCalls[0].ids[0], '1700000000000-0');

  await unsubscribe();
  await bus.close();
});
