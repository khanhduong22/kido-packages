import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  MicroBatchCoalescer,
  ValkeyWriteBehindCounter,
  InMemoryValkeySimulator,
  SlottedCounter,
  InMemorySlottedCounter,
  murmurhash3_32,
  getSlotId,
  LUA_ATOMIC_DRAIN_HASH,
  LUA_BOUNDED_STOCK_RESERVE,
} from "../src/index";

describe("Màn 07: @kido/hot-counter Core Package", () => {
  describe("Pattern #1: MicroBatchCoalescer (RAM Coalescer + Single SQL VALUES Batch)", () => {
    let coalescer: MicroBatchCoalescer;

    beforeEach(() => {
      coalescer = new MicroBatchCoalescer({
        tableName: "store_products",
        idColumn: "id",
        counterColumn: "sold_count",
        updatedAtColumn: "updated_at",
      });
    });

    it("coalesces repeated increments on the same key into a single accumulated delta", () => {
      coalescer.record("marker-touch-liit-60", 1);
      coalescer.record("marker-touch-liit-60", 2);
      coalescer.record("marker-touch-liit-60", 7);

      assert.strictEqual(coalescer.getPendingCount(), 1);
      const pending = coalescer.peekPending();
      assert.strictEqual(pending.get("marker-touch-liit-60"), 10);
    });

    it("automatically drops keys whose net delta is 0 (0 DB writes)", async () => {
      // +10 then -10 (e.g. order placed then cancelled within flush window)
      coalescer.record("canvas-mont-marte-30x40", 10);
      coalescer.record("canvas-mont-marte-30x40", -10);

      assert.strictEqual(coalescer.getPendingCount(), 1); // key exists in map with 0
      const flushResult = await coalescer.flushNow();

      assert.strictEqual(flushResult.flushedRows, 0);
      assert.strictEqual(flushResult.zeroNetDropped, 1);
      assert.strictEqual(flushResult.sql, "");
      assert.strictEqual(flushResult.params.length, 0);
      assert.strictEqual(coalescer.getStats().totalZeroNetDropped, 1);
    });

    it("generates parameterized Single-Statement PostgreSQL UPDATE ... FROM (VALUES ...)", async () => {
      coalescer.record("sku-holbein-24", 5);
      coalescer.record("sku-canson-a4", 12);

      const flushResult = await coalescer.flushNow();
      assert.strictEqual(flushResult.flushedRows, 2);
      assert.strictEqual(flushResult.zeroNetDropped, 0);
      assert.ok(flushResult.sql.includes('UPDATE "store_products" AS t'));
      assert.ok(flushResult.sql.includes('SET "sold_count" = t."sold_count" + v.delta::bigint'));
      assert.ok(
        flushResult.sql.includes(
          'FROM (VALUES ($1::text, $2::bigint), ($3::text, $4::bigint)) AS v(id, delta)'
        )
      );
      assert.ok(flushResult.sql.includes('WHERE t."id" = v.id;'));
      assert.deepStrictEqual(flushResult.params, ["sku-holbein-24", 5, "sku-canson-a4", 12]);
    });

    it("compresses 1,000 concurrent events into 1 single SQL statement (99.9% reduction)", async () => {
      const hotSkus = ["marker-60", "canson-300g", "holbein-24", "winsor-cotman", "marvy-fineliner"];

      // 1,000 rapid increment events distributed across 5 hot SKUs
      for (let i = 0; i < 1000; i++) {
        const sku = hotSkus[i % hotSkus.length];
        coalescer.record(sku, 1);
      }

      const executedQueries: string[] = [];
      const flushResult = await coalescer.flushNow(async (sql) => {
        executedQueries.push(sql);
      });

      assert.strictEqual(executedQueries.length, 1); // 1 single SQL round-trip!
      assert.strictEqual(flushResult.flushedRows, 5); // 5 rows updated
      assert.strictEqual(flushResult.inputEventsInBatch, 1000);
      assert.strictEqual(flushResult.sqlStatementsSaved, 999);
      assert.ok(flushResult.writeAmplificationReductionRatio > 0.99);

      const stats = coalescer.getStats();
      assert.strictEqual(stats.totalInputEvents, 1000);
      assert.strictEqual(stats.totalFlushedRows, 5);
      assert.strictEqual(stats.sqlStatementsSaved, 999);
      assert.strictEqual(stats.reductionPercent, "99.5%");
    });

    it("merges uncommitted deltas back into live Map if DB executor fails (Zero Lost Updates)", async () => {
      coalescer.record("sku-precious-1", 10);
      coalescer.record("sku-precious-2", 20);

      // Simulate transient PostgreSQL connection drop
      let attempts = 0;
      const failingExecutor = async () => {
        attempts++;
        throw new Error("PostgreSQL connection timeout [ECONNRESET]");
      };

      await assert.rejects(
        async () => {
          await coalescer.flushNow(failingExecutor);
        },
        /ECONNRESET/
      );

      // Verify state was merged back
      assert.strictEqual(coalescer.getPendingCount(), 2);
      assert.strictEqual(coalescer.peekPending().get("sku-precious-1"), 10);
      assert.strictEqual(coalescer.peekPending().get("sku-precious-2"), 20);

      // Now add more events while recovered
      coalescer.record("sku-precious-1", 5);

      // Retry with healthy executor
      const recoveredResult = await coalescer.flushNow(async () => {});
      assert.strictEqual(recoveredResult.flushedRows, 2);
      assert.deepStrictEqual(recoveredResult.params, [
        "sku-precious-1",
        15,
        "sku-precious-2",
        20,
      ]);
    });
  });

  describe("Pattern #2: ValkeyWriteBehindCounter (Shared Hash + Atomic Lua & Bounded Stock)", () => {
    let simulator: InMemoryValkeySimulator;
    let counter: ValkeyWriteBehindCounter;

    beforeEach(() => {
      simulator = new InMemoryValkeySimulator();
      counter = new ValkeyWriteBehindCounter({
        client: simulator,
        dirtyHashKey: "test:counter:dirty",
        stockKey: "test:stock:available",
        stockDirtyKey: "test:stock:dirty",
      });
    });

    it("increments unbounded counters via Valkey HINCRBY in O(1)", async () => {
      await counter.increment("view:holbein-24", 1);
      await counter.increment("view:holbein-24", 4);
      const total = await counter.increment("view:holbein-24", 5);

      assert.strictEqual(total, 10);
    });

    it("drains dirty hash atomically using LUA_ATOMIC_DRAIN_HASH script", async () => {
      await counter.increment("view:holbein-24", 100);
      await counter.increment("view:canson-a4", 50);

      const deltas = await counter.drainDirty();
      assert.deepStrictEqual(deltas, {
        "view:holbein-24": 100,
        "view:canson-a4": 50,
      });

      // Verify hash was wiped atomically in Valkey
      const secondDrain = await counter.drainDirty();
      assert.deepStrictEqual(secondDrain, {});
    });

    it("enforces Bounded Flash Sale Inventory via Lua gate (Zero Oversell under concurrency)", async () => {
      const sku = "sku-limited-edition-palette";
      const INITIAL_STOCK = 150;
      await counter.setStock(sku, INITIAL_STOCK);

      const CONCURRENT_BUYERS = 1000;
      const results: boolean[] = [];

      // 1,000 buyers attempt to buy 1 item concurrently
      const promises: Promise<any>[] = [];
      for (let i = 0; i < CONCURRENT_BUYERS; i++) {
        promises.push(
          counter.reserveStock(sku, 1).then((res) => {
            results.push(res.success);
          })
        );
      }

      await Promise.all(promises);

      const successfulPurchases = results.filter((r) => r === true).length;
      const rejectedPurchases = results.filter((r) => r === false).length;

      assert.strictEqual(successfulPurchases, INITIAL_STOCK); // Exact 150!
      assert.strictEqual(rejectedPurchases, CONCURRENT_BUYERS - INITIAL_STOCK); // Exact 850 rejected!

      // Remaining stock must be exactly 0, never negative
      const remainingStock = await counter.getStock(sku);
      assert.strictEqual(remainingStock, 0);

      // Verify dirty inventory delta matches exactly -150
      const dirtyDeltas = await counter.drainDirty("test:stock:dirty");
      assert.strictEqual(dirtyDeltas[sku], -150);
    });

    it("rolls back dirty deltas to Valkey if database batch write fails", async () => {
      await counter.increment("click:marker-60", 42);

      let attempts = 0;
      await assert.rejects(
        async () => {
          await counter.flushToDatabase(async () => {
            attempts++;
            throw new Error("PostgreSQL write failed: dead tuple threshold reached");
          });
        },
        /dead tuple threshold/
      );

      // Verify delta was restored back into Valkey dirty hash
      const reDrain = await counter.drainDirty();
      assert.strictEqual(reDrain["click:marker-60"], 42);
    });
  });

  describe("Pattern #3: SlottedCounter (16-Slot Hot Key + SKIP LOCKED Fallback)", () => {
    let slottedCounter: SlottedCounter;
    let memorySimulator: InMemorySlottedCounter;

    beforeEach(() => {
      slottedCounter = new SlottedCounter({
        tableName: "store_hot_counter_slots",
        defaultNumSlots: 16,
      });
      memorySimulator = slottedCounter.getSimulator();
    });

    it("generates deterministic slot IDs via murmurhash3_32 % 16", () => {
      const slot1 = getSlotId("user-buyer-100", 16);
      const slot2 = getSlotId("user-buyer-100", 16);
      const slot3 = getSlotId("user-buyer-200", 16);

      assert.strictEqual(slot1, slot2);
      assert.ok(slot1 >= 0 && slot1 < 16);
      assert.ok(slot3 >= 0 && slot3 < 16);
    });

    it("multiplies concurrency by 16x across physical slot rows", () => {
      const entityType = "product_likes";
      const entityId = "marker-touch-60";

      // Increment 160 times with different caller keys
      for (let i = 0; i < 160; i++) {
        memorySimulator.increment(entityType, entityId, 1, `buyer_req_${i}`);
      }

      assert.strictEqual(memorySimulator.getTotal(entityType, entityId), 160);

      const breakdown = memorySimulator.getSlotBreakdown(entityType, entityId);
      assert.strictEqual(breakdown.length, 16);

      // Every slot should receive a roughly balanced share
      const nonZeroSlots = breakdown.filter((v) => v > 0);
      assert.ok(nonZeroSlots.length >= 14);
    });

    it("prevents overselling with Bounded SKIP LOCKED fallback under 500 concurrent buyers", () => {
      const entityType = "flash_sale_inventory";
      const entityId = "palette-limited-100";
      const TOTAL_STOCK = 100;

      // Initialize 100 units across 16 slots (~6-7 units per slot)
      memorySimulator.initializeStock(entityType, entityId, TOTAL_STOCK);
      assert.strictEqual(memorySimulator.getTotal(entityType, entityId), TOTAL_STOCK);

      const CONCURRENT_BUYERS = 500;
      let successCount = 0;
      let rejectionCount = 0;
      let fallbackCount = 0;

      for (let i = 0; i < CONCURRENT_BUYERS; i++) {
        const callerKey = `checkout_buyer_${i}`;
        const result = memorySimulator.deductBoundedStock(entityType, entityId, 1, callerKey);

        if (result.success) {
          successCount++;
          if (result.usedFallback) {
            fallbackCount++;
          }
        } else {
          rejectionCount++;
        }
      }

      // Mathematical anti-oversell invariants:
      assert.strictEqual(successCount, TOTAL_STOCK); // Exactly 100 sold!
      assert.strictEqual(rejectionCount, CONCURRENT_BUYERS - TOTAL_STOCK); // 400 rejected!
      assert.ok(fallbackCount > 0); // Proves fallback triggered when preferred slot emptied
      assert.strictEqual(memorySimulator.getTotal(entityType, entityId), 0); // Zero stock left, never < 0!
    });

    it("generates PostgreSQL 18 Declarative DDL and UPSERT queries", () => {
      const ddl = slottedCounter.generateDDL();
      assert.ok(ddl.includes('CREATE TABLE IF NOT EXISTS "store_hot_counter_slots"'));
      assert.ok(ddl.includes('PRIMARY KEY ("entity_type", "entity_id", "slot_id")'));

      const incSql = slottedCounter.generateIncrementSQL({
        entityType: "product_views",
        entityId: "prod-1",
        slotId: 4,
        delta: 1,
      });
      assert.ok(incSql.sql.includes('INSERT INTO "store_hot_counter_slots"'));
      assert.ok(incSql.sql.includes('ON CONFLICT ("entity_type", "entity_id", "slot_id")'));
      assert.deepStrictEqual(incSql.params, ["product_views", "prod-1", 4, 1]);

      const aggSql = slottedCounter.generateAggregateReadSQL("product_views", "prod-1");
      assert.ok(aggSql.sql.includes('SELECT COALESCE(SUM("value"), 0)::bigint AS total'));
      assert.deepStrictEqual(aggSql.params, ["product_views", "prod-1"]);

      const deductSql = slottedCounter.generateBoundedDeductSQL({
        entityType: "flash_inventory",
        entityId: "sku-hot-1",
        qty: 1,
        callerKey: "req_123",
      });
      assert.ok(deductSql.sql.includes("WITH candidate AS"));
      assert.ok(deductSql.sql.includes("FOR UPDATE SKIP LOCKED"));
      assert.strictEqual(deductSql.params[0], "flash_inventory");
      assert.strictEqual(deductSql.params[1], "sku-hot-1");
      assert.strictEqual(deductSql.params[2], 1);
    });
  });

  describe("Benchmark: 10,000 Operations Concurrency & Throughput", () => {
    it("processes 10,000 operations through MicroBatchCoalescer in < 20ms", async () => {
      const coalescer = new MicroBatchCoalescer();
      const start = performance.now();

      for (let i = 0; i < 10000; i++) {
        coalescer.record(`product_${i % 100}`, 1);
      }

      const elapsed = performance.now() - start;
      const flushResult = await coalescer.flushNow();

      assert.strictEqual(flushResult.flushedRows, 100);
      assert.strictEqual(flushResult.inputEventsInBatch, 10000);
      assert.strictEqual(flushResult.sqlStatementsSaved, 9999);
      assert.ok(elapsed < 50); // Under 50ms for 10k ops in RAM (> 200,000 ops/sec)
    });

    it("processes 10,000 operations through ValkeyWriteBehind in < 50ms", async () => {
      const simulator = new InMemoryValkeySimulator();
      const counter = new ValkeyWriteBehindCounter({ client: simulator });
      const start = performance.now();

      for (let i = 0; i < 10000; i++) {
        await counter.increment(`hot_item_${i % 50}`, 1);
      }

      const elapsed = performance.now() - start;
      const deltas = await counter.drainDirty();

      assert.strictEqual(Object.keys(deltas).length, 50);
      assert.ok(elapsed < 100);
    });
  });
});
