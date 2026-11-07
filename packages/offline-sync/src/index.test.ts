import assert from 'node:assert';
import test from 'node:test';
import {
  ConflictResolver,
  DefaultNetworkDetector,
  ISyncRemoteAdapter,
  MemoryOutboxStorage,
  OfflinePOSStore,
  OutboxQueue,
  SyncEngine,
  SyncPushResult,
  compareUUIDv7,
  isValidUUIDv7,
  uuidv7,
  uuidv7Timestamp,
} from './index';

// ==========================================
// TEST SUITE 1: UUIDv7 RFC 9562 & MONOTONICITY
// ==========================================

test('UUIDv7: generates valid RFC 9562 UUIDv7 format with correct version and variant', () => {
  const id = uuidv7();
  assert.ok(isValidUUIDv7(id), `Generated ID "${id}" should be a valid UUIDv7`);

  // Check version field is 7
  const parts = id.split('-');
  assert.strictEqual(parts.length, 5);
  assert.strictEqual(parts[2][0], '7', 'Version must be 7');

  // Check variant is 8, 9, a, or b (RFC 4122/9562 variant 10xx)
  const variantChar = parts[3][0].toLowerCase();
  assert.ok(
    ['8', '9', 'a', 'b'].includes(variantChar),
    `Variant char must be one of 8, 9, a, b. Got: ${variantChar}`
  );
});

test('UUIDv7: timestamp extraction matches current time and respects custom timestamp', () => {
  const customTime = 1700000000000; // Fixed timestamp
  const idWithCustom = uuidv7(customTime);
  const extracted = uuidv7Timestamp(idWithCustom);
  assert.strictEqual(extracted, customTime);

  const now = Date.now();
  const currentId = uuidv7();
  const currentExtracted = uuidv7Timestamp(currentId);
  assert.ok(
    Math.abs(currentExtracted - now) <= 100,
    `Extracted timestamp ${currentExtracted} should be close to now ${now}`
  );
});

test('UUIDv7: generates strictly monotonic increasing IDs in rapid succession', () => {
  const ids: string[] = [];
  for (let i = 0; i < 50; i++) {
    ids.push(uuidv7());
  }

  for (let i = 1; i < ids.length; i++) {
    const prev = ids[i - 1];
    const curr = ids[i];
    const cmp = compareUUIDv7(prev, curr);
    assert.strictEqual(
      cmp,
      -1,
      `Expected prev (${prev}) < curr (${curr}) for monotonic sequence`
    );
  }
});

// ==========================================
// TEST SUITE 2: OUTBOX QUEUE & FIFO ORDERING
// ==========================================

test('OutboxQueue: enqueues mutations and preserves chronological order', async () => {
  const storage = new MemoryOutboxStorage();
  const queue = new OutboxQueue(storage);

  const t1 = 1700000000000;
  const t2 = 1700000001000;
  const t3 = 1700000002000;

  // Insert out of order
  await queue.enqueue({
    entityType: 'ORDER',
    action: 'CREATE',
    payload: { orderNo: 2 },
    timestamp: t2,
  });
  await queue.enqueue({
    entityType: 'ORDER',
    action: 'CREATE',
    payload: { orderNo: 1 },
    timestamp: t1,
  });
  await queue.enqueue({
    entityType: 'ORDER',
    action: 'CREATE',
    payload: { orderNo: 3 },
    timestamp: t3,
  });

  const pending = await queue.getPending();
  assert.strictEqual(pending.length, 3);
  assert.strictEqual(pending[0].payload.orderNo, 1);
  assert.strictEqual(pending[1].payload.orderNo, 2);
  assert.strictEqual(pending[2].payload.orderNo, 3);
});

test('OutboxQueue: transitions mutation states (PENDING -> SYNCING -> SYNCED / FAILED)', async () => {
  const queue = new OutboxQueue(new MemoryOutboxStorage());

  const m1 = await queue.enqueue({
    entityType: 'PRODUCT',
    action: 'UPDATE',
    payload: { price: 50000 },
  });

  assert.strictEqual(m1.status, 'PENDING');
  assert.strictEqual(m1.retryCount, 0);

  // Mark syncing
  await queue.markSyncing([m1.id]);
  let updated = await queue.getById(m1.id);
  assert.strictEqual(updated?.status, 'SYNCING');
  assert.ok(updated?.lastAttemptAt !== undefined);

  // Mark failed (retryable)
  await queue.markFailed(m1.id, 'Network timeout', false);
  updated = await queue.getById(m1.id);
  assert.strictEqual(updated?.status, 'PENDING');
  assert.strictEqual(updated?.retryCount, 1);
  assert.strictEqual(updated?.error, 'Network timeout');

  // Mark synced
  await queue.markSynced(m1.id, 42);
  updated = await queue.getById(m1.id);
  assert.strictEqual(updated?.status, 'SYNCED');
  assert.strictEqual(updated?.version, 42);
  assert.strictEqual(updated?.error, undefined);
});

test('OutboxQueue: statistics summary and purging synced records', async () => {
  const queue = new OutboxQueue(new MemoryOutboxStorage());

  const m1 = await queue.enqueue({ entityType: 'A', action: 'CREATE', payload: {}, timestamp: 1000 });
  const m2 = await queue.enqueue({ entityType: 'B', action: 'CREATE', payload: {}, timestamp: 1000 });
  await queue.markSynced(m1.id);

  let stats = await queue.getStats();
  assert.strictEqual(stats.synced, 1);
  assert.strictEqual(stats.pending, 1);
  assert.strictEqual(stats.total, 2);

  // Purge synced
  const purged = await queue.purgeSynced(0); // purge all past synced
  assert.strictEqual(purged, 1);

  stats = await queue.getStats();
  assert.strictEqual(stats.synced, 0);
  assert.strictEqual(stats.pending, 1);
  assert.strictEqual(stats.total, 1);
});

// ==========================================
// TEST SUITE 3: SYNC ENGINE & EXPONENTIAL BACKOFF
// ==========================================

test('SyncEngine: performs batch push to remote adapter when online', async () => {
  const storage = new MemoryOutboxStorage();
  const queue = new OutboxQueue(storage);
  const network = new DefaultNetworkDetector({ initialOnline: true });

  await queue.enqueue({ entityType: 'USER', action: 'CREATE', payload: { name: 'Alice' } });
  await queue.enqueue({ entityType: 'USER', action: 'CREATE', payload: { name: 'Bob' } });

  const pushedBatches: string[][] = [];
  const mockRemote: ISyncRemoteAdapter = {
    async push(mutations) {
      pushedBatches.push(mutations.map((m) => m.id));
      return mutations.map((m) => ({
        mutationId: m.id,
        success: true,
        serverVersion: 10,
      }));
    },
  };

  const engine = new SyncEngine({
    storage,
    remote: mockRemote,
    networkDetector: network,
    batchSize: 10,
  });

  const results = await engine.syncNow();
  assert.strictEqual(results.length, 2);
  assert.strictEqual(pushedBatches.length, 1);
  assert.strictEqual(pushedBatches[0].length, 2);

  const remainingPending = await storage.getPending();
  assert.strictEqual(remainingPending.length, 0);

  const stats = await queue.getStats();
  assert.strictEqual(stats.synced, 2);
  assert.strictEqual(stats.pending, 0);
});

test('SyncEngine: pauses sync when offline and resumes when reconnected', async () => {
  const storage = new MemoryOutboxStorage();
  const queue = new OutboxQueue(storage);
  const network = new DefaultNetworkDetector({ initialOnline: false });

  await queue.enqueue({ entityType: 'ITEM', action: 'CREATE', payload: {} });

  let pushCalled = false;
  const mockRemote: ISyncRemoteAdapter = {
    async push(mutations) {
      pushCalled = true;
      return mutations.map((m) => ({ mutationId: m.id, success: true }));
    },
  };

  const engine = new SyncEngine({
    storage,
    remote: mockRemote,
    networkDetector: network,
  });

  // Offline: should return empty and not call push
  const offlineResults = await engine.syncNow();
  assert.strictEqual(offlineResults.length, 0);
  assert.strictEqual(pushCalled, false);

  // Switch to online
  network.setOnline(true);
  const onlineResults = await engine.syncNow();
  assert.strictEqual(onlineResults.length, 1);
  assert.strictEqual(pushCalled, true);
});

test('SyncEngine: exponential backoff calculation and retry handling on remote failure', async () => {
  const storage = new MemoryOutboxStorage();
  const queue = new OutboxQueue(storage);
  const network = new DefaultNetworkDetector({ initialOnline: true });

  const m = await queue.enqueue({ entityType: 'PAYMENT', action: 'CREATE', payload: {} });

  const mockRemote: ISyncRemoteAdapter = {
    async push(mutations) {
      return mutations.map((item) => ({
        mutationId: item.id,
        success: false,
        error: '503 Service Unavailable',
      }));
    },
  };

  const engine = new SyncEngine({
    storage,
    remote: mockRemote,
    networkDetector: network,
    initialBackoffMs: 1000,
    maxBackoffMs: 16000,
    backoffMultiplier: 2,
    maxRetries: 3,
  });

  // Check exponential backoff delays
  const b0 = engine.calculateBackoff(0);
  assert.ok(b0 >= 1000 && b0 <= 1200, `Expected ~1000ms delay, got ${b0}`);
  const b1 = engine.calculateBackoff(1);
  assert.ok(b1 >= 2000 && b1 <= 2400, `Expected ~2000ms delay, got ${b1}`);
  const b2 = engine.calculateBackoff(2);
  assert.ok(b2 >= 4000 && b2 <= 4800, `Expected ~4000ms delay, got ${b2}`);
  const b5 = engine.calculateBackoff(5);
  assert.ok(b5 <= 18000, `Expected capped delay around maxBackoff, got ${b5}`);

  // First failed sync: retryCount becomes 1
  await engine.syncNow();
  let item = await queue.getById(m.id);
  assert.strictEqual(item?.retryCount, 1);
  assert.strictEqual(item?.status, 'PENDING');

  // Second failed sync: retryCount becomes 2
  await engine.syncNow();
  item = await queue.getById(m.id);
  assert.strictEqual(item?.retryCount, 2);

  // Third failed sync: reaches maxRetries (3), marks terminal FAILED
  await engine.syncNow();
  item = await queue.getById(m.id);
  assert.strictEqual(item?.retryCount, 3);
  assert.strictEqual(item?.status, 'FAILED');
});

// ==========================================
// TEST SUITE 4: CONFLICT RESOLVER (LWW, VECTOR CLOCK, APPEND-ONLY)
// ==========================================

test('ConflictResolver: Last-Write-Wins resolves based on newer timestamp and version', () => {
  const local = {
    id: 'entity-1',
    data: { title: 'Local Version' },
    version: 1,
    updatedAt: 2000,
  };
  const remote = {
    id: 'entity-1',
    data: { title: 'Remote Version' },
    version: 2,
    updatedAt: 1000,
  };

  // Local timestamp is newer (2000 > 1000), local wins
  const res1 = ConflictResolver.resolve(local, remote, 'LAST_WRITE_WINS');
  assert.strictEqual(res1.winner, 'local');
  assert.strictEqual(res1.entity.data.title, 'Local Version');
  assert.strictEqual(res1.entity.version, 3); // Bumped version

  // Remote timestamp is newer (3000 > 2000), remote wins
  const remoteNewer = { ...remote, updatedAt: 3000 };
  const res2 = ConflictResolver.resolve(local, remoteNewer, 'LAST_WRITE_WINS');
  assert.strictEqual(res2.winner, 'remote');
  assert.strictEqual(res2.entity.data.title, 'Remote Version');
});

test('ConflictResolver: Vector Clocks detects dominance and concurrent edits', () => {
  // Local dominates: [nodeA: 2, nodeB: 1] > [nodeA: 1, nodeB: 1]
  const rel1 = ConflictResolver.compareVectorClocks(
    { nodeA: 2, nodeB: 1 },
    { nodeA: 1, nodeB: 1 }
  );
  assert.strictEqual(rel1, 'LOCAL_DOMINATES');

  // Remote dominates: [nodeA: 1, nodeB: 1] < [nodeA: 1, nodeB: 2]
  const rel2 = ConflictResolver.compareVectorClocks(
    { nodeA: 1, nodeB: 1 },
    { nodeA: 1, nodeB: 2 }
  );
  assert.strictEqual(rel2, 'REMOTE_DOMINATES');

  // Concurrent: [nodeA: 2, nodeB: 1] vs [nodeA: 1, nodeB: 2]
  const rel3 = ConflictResolver.compareVectorClocks(
    { nodeA: 2, nodeB: 1 },
    { nodeA: 1, nodeB: 2 }
  );
  assert.strictEqual(rel3, 'CONCURRENT');

  // Vector clock merge
  const merged = ConflictResolver.mergeVectorClocks(
    { nodeA: 2, nodeB: 1, nodeC: 0 },
    { nodeA: 1, nodeB: 3, nodeC: 5 }
  );
  assert.deepStrictEqual(merged, { nodeA: 2, nodeB: 3, nodeC: 5 });
});

test('ConflictResolver: Append-Only preserves financial entries and creates compensating adjustments', () => {
  const localFinancial = {
    id: 'inv-101',
    isFinancial: true,
    data: { amount: 150000, customer: 'Nguyen Van A' },
    version: 1,
    updatedAt: 1000,
  };
  const remoteFinancial = {
    id: 'inv-101',
    isFinancial: true,
    data: { amount: 120000, customer: 'Nguyen Van A' },
    version: 2,
    updatedAt: 1500,
  };

  const res = ConflictResolver.resolve(localFinancial, remoteFinancial);
  assert.strictEqual(res.isAppendOnly, true);
  assert.strictEqual(res.winner, 'merged');

  // Must generate supplementary adjustment record for the 30,000 VND delta
  assert.ok(res.supplementaryRecords && res.supplementaryRecords.length === 1);
  const adj = res.supplementaryRecords[0];
  assert.strictEqual(adj.isFinancial, true);
  assert.strictEqual((adj.data as Record<string, unknown>).adjustmentDelta, 30000);
});

// ==========================================
// TEST SUITE 5: OFFLINE POS STORE & RECEIPT & VIETQR
// ==========================================

test('OfflinePOSStore: creates order offline, checks stock reservation, and formats K80 receipt', async () => {
  const queue = new OutboxQueue(new MemoryOutboxStorage());
  const store = new OfflinePOSStore(queue);

  store.registerProduct({
    id: 'prod-tra-sua',
    name: 'Tra Sua Oolong Nuong',
    price: 35000,
    stock: 10,
    sku: 'TS-01',
  });

  store.registerProduct({
    id: 'prod-banh-ngot',
    name: 'Banh Croissant Bo Phap',
    price: 25000,
    stock: 5,
    sku: 'BC-01',
  });

  // Verify initial stock
  assert.strictEqual(store.getAvailableStock('prod-tra-sua'), 10);

  // Create order
  const order = await store.createOrder({
    items: [
      { productId: 'prod-tra-sua', quantity: 2 },
      { productId: 'prod-banh-ngot', quantity: 1, discount: 5000 },
    ],
    cashierId: 'THU_NGAN_01',
  });

  assert.ok(order.id);
  assert.strictEqual(order.items.length, 2);
  // Tra sua: 2 * 35k = 70k. Banh: 25k - 5k = 20k. Subtotal = 90k
  assert.strictEqual(order.subtotal, 90000);
  // VAT 8%: 90k * 0.08 = 7,200 đ
  assert.strictEqual(order.taxAmount, 7200);
  assert.strictEqual(order.totalAmount, 97200);
  assert.strictEqual(order.paymentStatus, 'UNPAID');

  // Verify stock reservation deducted from available stock
  assert.strictEqual(store.getAvailableStock('prod-tra-sua'), 8);
  assert.strictEqual(store.getAvailableStock('prod-banh-ngot'), 4);

  // Verify outbox mutation was automatically enqueued
  const pending = await queue.getPending();
  assert.strictEqual(pending.length, 1);
  assert.strictEqual(pending[0].entityType, 'ORDER');
  assert.strictEqual(pending[0].action, 'CREATE');

  // Verify K80 Thermal Receipt
  const receipt = store.printK80Receipt(order.id);
  assert.ok(receipt.includes('KT SMART RETAIL STORE'));
  assert.ok(receipt.includes('Tra Sua Oolong Nuong'));
  assert.ok(receipt.includes('97.200 đ'));
  assert.ok(receipt.includes('HÓA ĐƠN THANH TOÁN (K80)'));
  assert.ok(receipt.includes(order.orderCode));
});

test('OfflinePOSStore: handles offline VietQR deposits and enqueues financial ledger mutations', async () => {
  const queue = new OutboxQueue(new MemoryOutboxStorage());
  const store = new OfflinePOSStore(queue);

  store.registerProduct({
    id: 'prod-combo',
    name: 'Combo An Sang',
    price: 100000,
    stock: 20,
  });

  const order = await store.createOrder({
    items: [{ productId: 'prod-combo', quantity: 1 }],
  });

  // Total amount: 100,000 + 8% VAT = 108,000 đ
  assert.strictEqual(order.totalAmount, 108000);

  // Customer deposits 50,000 VND via VietQR transfer
  const updatedOrder = await store.receiveVietQrDeposit(
    order.id,
    50000,
    'TXN_VIETQR_998877',
    'Deposit 50k via VietQR'
  );

  assert.strictEqual(updatedOrder.depositAmount, 50000);
  assert.strictEqual(updatedOrder.paymentStatus, 'PARTIALLY_PAID');

  // Customer pays remaining 58,000 VND
  const fullyPaidOrder = await store.receiveVietQrDeposit(
    order.id,
    58000,
    'TXN_VIETQR_998878',
    'Final settlement 58k'
  );

  assert.strictEqual(fullyPaidOrder.depositAmount, 108000);
  assert.strictEqual(fullyPaidOrder.paymentStatus, 'PAID');

  // Check outbox queue mutations: 1 ORDER CREATE + 2 FINANCIAL_TRANSACTION CREATE
  const allMutations = await queue.list();
  assert.strictEqual(allMutations.length, 3);
  assert.strictEqual(allMutations[0].entityType, 'ORDER');
  assert.strictEqual(allMutations[1].entityType, 'FINANCIAL_TRANSACTION');
  assert.strictEqual(allMutations[1].isFinancial, true);
  assert.strictEqual(allMutations[2].entityType, 'FINANCIAL_TRANSACTION');
  assert.strictEqual(allMutations[2].isFinancial, true);
});
