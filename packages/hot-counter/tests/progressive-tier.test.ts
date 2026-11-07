import { describe, expect, it } from "bun:test";
import {
  Tier0SmeCounter,
  NaiveRowLockSimulator,
  recommendCounterTier,
  createProgressiveHotCounter,
  InMemoryValkeySimulator,
  SlottedCounter,
  ValkeyWriteBehindCounter,
} from "../src";

describe("3-Tier Progressive Hot Counter Architecture", () => {
  describe("Tier-0 SME Zero-Infra Counter (Tier0SmeCounter)", () => {
    it("accumulates delta mutations in memory in O(1)", () => {
      const counter = new Tier0SmeCounter();
      counter.record("product:shopee:101", 1);
      counter.record("product:shopee:101", 4);
      counter.record("product:tiktok:202", 2);

      expect(counter.getPendingCount()).toBe(2);
      expect(counter.getPendingDelta("product:shopee:101")).toBe(5);
      expect(counter.getPendingDelta("product:tiktok:202")).toBe(2);
    });

    it("supports recordBatch with array and record object", () => {
      const counter = new Tier0SmeCounter();
      counter.recordBatch([
        { key: "item:1", delta: 3 },
        { key: "item:2", delta: 7 },
      ]);
      counter.recordBatch({ "item:1": 2, "item:3": 5 });

      expect(counter.getPendingDelta("item:1")).toBe(5);
      expect(counter.getPendingDelta("item:2")).toBe(7);
      expect(counter.getPendingDelta("item:3")).toBe(5);
    });

    it("automatically drops zero-net deltas before flushing (0 DB writes)", async () => {
      const executedQueries: string[] = [];
      const counter = new Tier0SmeCounter({
        dbExecutor: async (sql) => {
          executedQueries.push(sql);
        },
      });

      counter.record("item:cancelled", 5);
      counter.record("item:cancelled", -5);

      const result = await counter.flush();
      expect(result.flushedRows).toBe(0);
      expect(result.zeroNetDropped).toBe(1);
      expect(result.sqlStatementsSaved).toBe(2);
      expect(executedQueries.length).toBe(0);
    });

    it("generates PostgreSQL parameterized single-statement UPSERT SQL", async () => {
      let executedSql = "";
      let executedParams: (string | number)[] = [];

      const counter = new Tier0SmeCounter({
        tableName: "store_inventory_counters",
        idColumn: "product_id",
        valueColumn: "sold_count",
        updatedAtColumn: "last_sold_at",
        dialect: "postgres",
        dbExecutor: async (sql, params) => {
          executedSql = sql;
          executedParams = params;
        },
      });

      counter.record("sku:can-son-a4", 10);
      counter.record("sku:marker-touch-60", 3);

      const result = await counter.flush();

      expect(result.flushedRows).toBe(2);
      expect(executedSql).toContain('INSERT INTO "store_inventory_counters"');
      expect(executedSql).toContain(
        'ON CONFLICT ("product_id") DO UPDATE SET "sold_count" = "store_inventory_counters"."sold_count" + EXCLUDED."sold_count", "last_sold_at" = NOW()'
      );
      expect(executedSql).toContain("($1, $2, NOW()), ($3, $4, NOW())");
      expect(executedParams).toEqual(["sku:can-son-a4", 10, "sku:marker-touch-60", 3]);
    });

    it("generates SQLite parameterized single-statement UPSERT SQL", async () => {
      let executedSql = "";
      let executedParams: (string | number)[] = [];

      const counter = new Tier0SmeCounter({
        tableName: "sme_page_views",
        idColumn: "path",
        valueColumn: "views",
        dialect: "sqlite",
        dbExecutor: async (sql, params) => {
          executedSql = sql;
          executedParams = params;
        },
      });

      counter.record("/home", 100);
      counter.record("/pricing", 45);

      await counter.flush();

      expect(executedSql).toContain('INSERT INTO "sme_page_views"');
      expect(executedSql).toContain(
        'ON CONFLICT ("path") DO UPDATE SET "views" = "sme_page_views"."views" + excluded."views"'
      );
      expect(executedSql).toContain("(?, ?), (?, ?)");
      expect(executedParams).toEqual(["/home", 100, "/pricing", 45]);
    });

    it("chunks batch writes when pending items exceed maxBatchSize", async () => {
      const batchQueries: string[] = [];
      const counter = new Tier0SmeCounter({
        maxBatchSize: 2,
        dbExecutor: async (sql) => {
          batchQueries.push(sql);
        },
      });

      counter.record("k1", 1);
      counter.record("k2", 2);
      counter.record("k3", 3);
      counter.record("k4", 4);
      counter.record("k5", 5);

      const result = await counter.flush();
      expect(result.flushedRows).toBe(5);
      expect(result.batchesExecuted).toBe(3); // 2 + 2 + 1
      expect(batchQueries.length).toBe(3);
    });

    it("enforces Zero Lost Updates invariant: rolls back pending deltas if DB executor fails", async () => {
      let shouldFail = true;
      const counter = new Tier0SmeCounter({
        dbExecutor: async () => {
          if (shouldFail) {
            throw new Error("Connection refused: PostgreSQL pool down");
          }
        },
      });

      counter.record("post:42:likes", 10);
      counter.record("post:99:likes", 5);

      // First flush fails
      await expect(counter.flush()).rejects.toThrow("Connection refused");

      // Verify pending deltas were NOT wiped out
      expect(counter.getPendingDelta("post:42:likes")).toBe(10);
      expect(counter.getPendingDelta("post:99:likes")).toBe(5);

      // Now new writes arrive in the meantime
      counter.record("post:42:likes", 3);

      // Second flush succeeds
      shouldFail = false;
      const result = await counter.flush();
      expect(result.flushedRows).toBe(2);
      expect(counter.getPendingCount()).toBe(0);
    });

    it("tracks lifetime telemetry statistics", async () => {
      const counter = new Tier0SmeCounter();
      counter.record("a", 1);
      counter.record("a", 2);
      counter.record("b", 1);
      counter.record("b", -1); // net zero

      await counter.flush();

      const stats = counter.getStats();
      expect(stats.totalInputEvents).toBe(4);
      expect(stats.totalFlushedRows).toBe(1);
      expect(stats.totalZeroNetDropped).toBe(1);
      expect(stats.totalFlushes).toBe(1);
      expect(stats.sqlStatementsSaved).toBe(3);
    });
  });

  describe("Naive Row Lock Contention Simulator (NaiveRowLockSimulator)", () => {
    it("executes single row increment with low latency", async () => {
      const sim = new NaiveRowLockSimulator({ rowLockHoldTimeMs: 1 });
      const res = await sim.executeIncrement("post:1");
      expect(res.success).toBe(true);
      expect(res.latencyMs).toBeGreaterThan(0);
    });

    it("simulates row lock contention where concurrent requests on the same key serialize", async () => {
      const holdTimeMs = 2;
      const sim = new NaiveRowLockSimulator({
        connectionPoolSize: 20,
        rowLockHoldTimeMs: holdTimeMs,
      });

      const report = await sim.simulateLoad(10, "post:viral_1");

      expect(report.totalRequests).toBe(10);
      expect(report.successfulRequests).toBe(10);
      expect(report.failedRequests).toBe(0);
      // Because 10 requests on the same row serialize, maxLatency is significantly higher than holdTime
      expect(report.maxLatencyMs).toBeGreaterThanOrEqual(holdTimeMs * 5);
      expect(report.contentionFactor).toBeGreaterThan(1);
    });

    it("allows independent keys to execute concurrently without cross-key lock waiting", async () => {
      const sim = new NaiveRowLockSimulator({
        connectionPoolSize: 10,
        rowLockHoldTimeMs: 5,
      });

      const start = performance.now();
      const [res1, res2] = await Promise.all([
        sim.executeIncrement("key:A"),
        sim.executeIncrement("key:B"),
      ]);
      const duration = performance.now() - start;

      expect(res1.success).toBe(true);
      expect(res2.success).toBe(true);
      // Both run in parallel, total duration is close to 1 holdTime (~5ms), well under 2x holdTime (~10ms)
      expect(duration).toBeLessThan(12);
    });
  });

  describe("Progressive Tier Advisor & Recommendation (recommendCounterTier)", () => {
    it("recommends naive for negligible traffic with zero budget", () => {
      const rec = recommendCounterTier({
        peakWritesPerSec: 10,
        monthlyBudgetUsd: 0,
        hasRedisOrValkey: false,
      });
      expect(rec.tier).toBe("naive");
      expect(rec.estimatedMonthlyCostUsd).toBe(0);
    });

    it("recommends tier0-sme for single-VPS SME workloads (< 2,000 writes/sec)", () => {
      const rec = recommendCounterTier({
        peakWritesPerSec: 1500,
        hasRedisOrValkey: false,
        singleVps: true,
      });
      expect(rec.tier).toBe("tier0-sme");
      expect(rec.estimatedMonthlyCostUsd).toBe(5);
      expect(rec.writeCapacityOpsPerSec).toBeGreaterThanOrEqual(2000);
      expect(rec.recommendedClass).toBe("Tier0SmeCounter");
    });

    it("recommends tier1-growth for regulatory/strict zero-loss requirements", () => {
      const rec = recommendCounterTier({
        peakWritesPerSec: 8000,
        strictZeroLoss: true,
        monthlyBudgetUsd: 50,
      });
      expect(rec.tier).toBe("tier1-growth");
      expect(rec.recommendedClass).toBe("SlottedCounter");
      expect(rec.tradeoffs.pros).toContain("16x concurrency multiplier on hot rows");
    });

    it("recommends tier2-bigtech for ultra-high throughput distributed systems", () => {
      const rec = recommendCounterTier({
        peakWritesPerSec: 50000,
        hasRedisOrValkey: true,
        strictZeroLoss: false,
        monthlyBudgetUsd: 200,
      });
      expect(rec.tier).toBe("tier2-bigtech");
      expect(rec.recommendedClass).toBe("ValkeyWriteBehindCounter");
      expect(rec.writeCapacityOpsPerSec).toBe(100000);
    });
  });

  describe("Unified Factory (createProgressiveHotCounter)", () => {
    it("instantiates Tier0SmeCounter for tier0-sme", () => {
      const created = createProgressiveHotCounter({
        tier: "tier0-sme",
        tier0Options: { tableName: "test_counters" },
      });
      expect(created.tier).toBe("tier0-sme");
      expect(created.instance instanceof Tier0SmeCounter).toBe(true);
    });

    it("instantiates SlottedCounter for tier1-growth", () => {
      const created = createProgressiveHotCounter({
        tier: "tier1-growth",
        tier1Options: { slots: 16 },
      });
      expect(created.tier).toBe("tier1-growth");
      expect(created.instance instanceof SlottedCounter).toBe(true);
    });

    it("instantiates ValkeyWriteBehindCounter for tier2-bigtech", () => {
      const valkey = new InMemoryValkeySimulator();
      const created = createProgressiveHotCounter({
        tier: "tier2-bigtech",
        valkeyClient: valkey,
      });
      expect(created.tier).toBe("tier2-bigtech");
      expect(created.instance instanceof ValkeyWriteBehindCounter).toBe(true);
    });

    it("instantiates NaiveRowLockSimulator for naive tier", () => {
      const created = createProgressiveHotCounter({
        tier: "naive",
      });
      expect(created.tier).toBe("naive");
      expect(created.instance instanceof NaiveRowLockSimulator).toBe(true);
    });
  });
});
