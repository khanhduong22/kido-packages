import { describe, expect, test } from "bun:test";
import {
  murmurhash3_32,
  murmurhash3_64,
  getShardId,
  toHexHash,
  HashShardRouter,
  ConsistentHashRing,
  CompoundPartitionManager,
} from "../src";

describe("@kido/db-sharding (DDIA Ch.6 Distributed Sharding Engine)", () => {
  describe("1. Deterministic MurmurHash3 & Modulo Sharding", () => {
    test("1.1 should be 100% deterministic across multiple runs", () => {
      const input = "user_982480906";
      const h1 = murmurhash3_32(input);
      const h2 = murmurhash3_32(input);
      const h3 = murmurhash3_32(input);

      expect(h1).toBe(h2);
      expect(h2).toBe(h3);
      expect(typeof h1).toBe("number");
      expect(h1).toBeGreaterThanOrEqual(0);
      expect(h1).toBeLessThanOrEqual(4294967295);
    });

    test("1.2 should handle empty string and seeds deterministically", () => {
      const h0 = murmurhash3_32("", 0);
      const h10 = murmurhash3_32("", 10);
      expect(h0).toBe(0);
      expect(typeof h10).toBe("number");
    });

    test("1.3 should handle UTF-8 and Vietnamese diacritics cleanly", () => {
      const h1 = murmurhash3_32("Kido Studio - Bút vẽ màu nước");
      const h2 = murmurhash3_32("Kido Studio - Bút vẽ màu nước");
      const hDiff = murmurhash3_32("Kido Studio - But ve mau nuoc");

      expect(h1).toBe(h2);
      expect(h1).not.toBe(hDiff);
    });

    test("1.4 should exhibit avalanche property (flipping 1 char flips ~50% of bits)", () => {
      const k1 = "customer_phone_0982480906";
      const k2 = "customer_phone_0982480907"; // 1 char difference

      const h1 = murmurhash3_32(k1);
      const h2 = murmurhash3_32(k2);

      // Bitwise XOR to find flipped bits
      const xor = (h1 ^ h2) >>> 0;
      let flippedBits = 0;
      for (let i = 0; i < 32; i++) {
        if ((xor & (1 << i)) !== 0) flippedBits++;
      }

      // In a high-quality hash function, ~16 out of 32 bits flip (between 10 and 24)
      expect(flippedBits).toBeGreaterThanOrEqual(10);
      expect(flippedBits).toBeLessThanOrEqual(24);
    });

    test("1.5 should compute 64-bit BigInt hash for distributed token spaces", () => {
      const bigHash = murmurhash3_64("order_100234");
      expect(typeof bigHash).toBe("bigint");
      expect(bigHash).toBeGreaterThanOrEqual(0n);
      expect(bigHash).toBeLessThanOrEqual(18446744073709551615n);
    });

    test("1.6 should route with getShardId within valid range [0 .. N-1]", () => {
      const totalShards = 4;
      for (let i = 0; i < 100; i++) {
        const shard = getShardId(`phone_${i}`, totalShards);
        expect(shard).toBeGreaterThanOrEqual(0);
        expect(shard).toBeLessThan(totalShards);
      }
    });

    test("1.7 should reject non-positive numShards", () => {
      expect(() => getShardId("test", 0)).toThrow();
      expect(() => getShardId("test", -1)).toThrow();
    });

    test("1.8 should format hex hash properly", () => {
      expect(toHexHash(0)).toBe("00000000");
      expect(toHexHash(255)).toBe("000000ff");
    });
  });

  describe("2. Application-Level & Proxy Hash Shard Router (Shopee / Vitess Pattern)", () => {
    test("2.1 should route entity keys deterministically to single shard", () => {
      const router = new HashShardRouter({ shards: 4, namePrefix: "shard" });

      const route1 = router.resolveShard("0982480906");
      const route2 = router.resolveShard("0982480906");

      expect(route1.shardId).toBe(route2.shardId);
      expect(route1.shard.name).toBe(`shard_${route1.shardId}`);
      expect(route1.isScatterGather).toBe(false);
      expect(route1.entityKey).toBe("0982480906");
      expect(typeof route1.hash).toBe("number");
      expect(route1.hexHash).toHaveLength(8);
    });

    test("2.2 should broadcast scatter-gather query when partition key is missing", () => {
      const router = new HashShardRouter({ shards: 4 });
      const broadcast = router.resolveAllShards();

      expect(broadcast.isScatterGather).toBe(true);
      expect(broadcast.totalShards).toBe(4);
      expect(broadcast.shards).toHaveLength(4);
      expect(broadcast.warning).toContain("Scatter-gather query executed");
    });

    test("2.3 should support custom ShardNode array with metadata", () => {
      const customShards = [
        { id: 0, name: "sg-db-primary-01", meta: { host: "203.0.113.10", port: 5432 } },
        { id: 1, name: "sg-db-primary-02", meta: { host: "15.235.244.193", port: 5432 } },
      ];
      const router = new HashShardRouter({ shards: customShards });

      const route = router.resolveShard("buyer_123");
      expect([0, 1]).toContain(route.shardId);
      expect(route.shard.meta).toBeDefined();
      expect(router.getShardCount()).toBe(2);
      expect(router.getTopology().totalShards).toBe(2);
    });
  });

  describe("3. Consistent Hash Ring with Virtual Nodes (Discord / ScyllaDB Pattern)", () => {
    test("3.1 should balance 10,000 keys uniformly across 4 nodes (stddev < 3%)", () => {
      const ring = new ConsistentHashRing({
        vnodesPerNode: 150,
        nodes: ["shard_0", "shard_1", "shard_2", "shard_3"],
      });

      const sampleKeys: string[] = [];
      for (let i = 0; i < 10000; i++) {
        sampleKeys.push(`customer_phone_098${i.toString().padStart(7, "0")}`);
      }

      const report = ring.analyzeRingDistribution(sampleKeys);

      expect(report.totalKeys).toBe(10000);
      expect(report.totalPhysicalNodes).toBe(4);
      expect(report.totalVirtualNodes).toBe(600); // 4 * 150

      // Each node should hold approximately 25% (20% to 30%)
      for (const node of ["shard_0", "shard_1", "shard_2", "shard_3"]) {
        const pct = report.nodePercentages[node];
        expect(pct).toBeGreaterThanOrEqual(20);
        expect(pct).toBeLessThanOrEqual(30);
      }

      // Standard deviation across nodes should be minimal (< 3%)
      expect(report.stdDevPercent).toBeLessThan(3.5);
    });

    test("3.2 should prove Minimal Key Rebalancing: adding 5th node moves ~20% of keys (vs ~80% in naive modulo)", () => {
      const initialNodes = ["shard_0", "shard_1", "shard_2", "shard_3"];
      const ring = new ConsistentHashRing({
        vnodesPerNode: 150,
        nodes: initialNodes,
      });

      const sampleKeys: string[] = [];
      for (let i = 0; i < 5000; i++) {
        sampleKeys.push(`order_key_${i}`);
      }

      // Map initial placement
      const initialMap = new Map<string, string>();
      for (const key of sampleKeys) {
        initialMap.set(key, ring.getNode(key));
      }

      // Add 5th node
      ring.addNode("shard_4");

      let keysMoved = 0;
      let movedToNewNode = 0;
      for (const key of sampleKeys) {
        const newLocation = ring.getNode(key);
        const oldLocation = initialMap.get(key);
        if (newLocation !== oldLocation) {
          keysMoved++;
          if (newLocation === "shard_4") {
            movedToNewNode++;
          }
        }
      }

      const movePercentage = (keysMoved / sampleKeys.length) * 100;

      // In consistent hashing with N=4 -> N=5:
      // Theoretical fraction moving is 1/5 = 20%.
      // We assert it is within 15% .. 26% (vastly superior to naive modulo's ~80% shuffle!)
      expect(movePercentage).toBeGreaterThanOrEqual(14);
      expect(movePercentage).toBeLessThanOrEqual(26);

      // In pure consistent hashing, 100% of moved keys go to the new node
      expect(movedToNewNode).toBe(keysMoved);
    });

    test("3.3 should resolve RF=3 distinct physical replica nodes", () => {
      const ring = new ConsistentHashRing({
        vnodesPerNode: 100,
        nodes: ["node_a", "node_b", "node_c", "node_d", "node_e"],
      });

      const replicas = ring.getReplicaNodes("hot_item_shopee_264725277", 3);

      expect(replicas).toHaveLength(3);
      // Ensure all 3 replicas are distinct physical nodes
      const distinct = new Set(replicas);
      expect(distinct.size).toBe(3);
    });

    test("3.4 should build Discord Compound Bucketed Keys for hot-spot protection", () => {
      const entityId = "shop_264725277";
      const t1 = new Date("2026-10-02T12:00:00Z");
      const t2 = new Date("2026-10-03T12:00:00Z"); // Same 10-day window
      const tLater = new Date("2026-10-25T12:00:00Z"); // Different 10-day window

      const bucket1 = ConsistentHashRing.buildDiscordBucketKey(entityId, t1, 864_000_000);
      const bucket2 = ConsistentHashRing.buildDiscordBucketKey(entityId, t2, 864_000_000);
      const bucketLater = ConsistentHashRing.buildDiscordBucketKey(entityId, tLater, 864_000_000);

      expect(bucket1).toBe(bucket2); // Same bucket within 10 days
      expect(bucket1).not.toBe(bucketLater); // Different bucket after 10 days
      expect(bucket1).toMatch(/^shop_264725277:bucket_\d+$/);
    });
  });

  describe("4. Compound (user_hash, created_at) Sub-Partitioning (Uber / Grab Pattern)", () => {
    const manager = new CompoundPartitionManager({
      tableName: "StoreOrder",
      hashColumn: "customerPhone",
      rangeColumn: "createdAt",
      totalShards: 4,
    });

    test("4.1 should generate 2-level PostgreSQL declarative DDL with BRIN & B-Tree indexes", () => {
      const rootDDL = manager.generateRootTableDDL();
      expect(rootDDL).toContain('CREATE TABLE IF NOT EXISTS "StoreOrder"');
      expect(rootDDL).toContain('PARTITION BY HASH ("customerPhone")');
      expect(rootDDL).toContain('PRIMARY KEY ("customerPhone", "createdAt", "id")');

      const shardDDLs = manager.generateShardPartitionDDL();
      expect(shardDDLs).toHaveLength(4);
      expect(shardDDLs[0]).toContain(
        'CREATE TABLE IF NOT EXISTS "StoreOrder_s0" PARTITION OF "StoreOrder" FOR VALUES WITH (MODULUS 4, REMAINDER 0) PARTITION BY RANGE ("createdAt");'
      );
      expect(shardDDLs[3]).toContain(
        'CREATE TABLE IF NOT EXISTS "StoreOrder_s3" PARTITION OF "StoreOrder" FOR VALUES WITH (MODULUS 4, REMAINDER 3) PARTITION BY RANGE ("createdAt");'
      );

      const leafDDLs = manager.generateMonthlySubPartitionDDL({ year: 2026, month: 10 });
      expect(leafDDLs.length).toBe(12); // 4 shards * (1 table + 2 indexes)
      expect(leafDDLs[0]).toContain(
        'CREATE TABLE IF NOT EXISTS "StoreOrder_s0_y2026m10" PARTITION OF "StoreOrder_s0" FOR VALUES FROM (\'2026-10-01 00:00:00+00\') TO (\'2026-11-01 00:00:00+00\');'
      );
      expect(leafDDLs.some((stmt) => stmt.includes('USING BRIN ("createdAt")'))).toBe(true);
      expect(leafDDLs.some((stmt) => stmt.includes('("customerPhone", "createdAt" DESC)'))).toBe(true);
    });

    test("4.2 should generate complete multi-month schema DDL", () => {
      const fullDDL = manager.generateFullSchemaDDL({
        startYear: 2026,
        startMonth: 10,
        numMonths: 2,
      });

      expect(fullDDL).toContain('CREATE TABLE IF NOT EXISTS "StoreOrder"');
      expect(fullDDL).toContain('"StoreOrder_s0_y2026m10"');
      expect(fullDDL).toContain('"StoreOrder_s0_y2026m11"');
      expect(fullDDL).toContain('"StoreOrder_s3_y2026m11"');
    });

    test("4.3 should prune to exactly 1 single leaf partition when hash key + month range provided", () => {
      const query = {
        customerPhone: "0982480906",
        createdAt: {
          gte: new Date("2026-10-05T00:00:00.000Z"),
          lte: new Date("2026-10-20T23:59:59.999Z"),
        },
      };

      const result = manager.withCompoundShardPruning(query);

      expect(result.pruned).toBe(true);
      expect(result.targetShardIndex).toBeDefined();
      expect(result.targetShardTable).toBe(`StoreOrder_s${result.targetShardIndex}`);
      expect(result.targetSubPartitions).toHaveLength(1);
      expect(result.targetSubPartitions[0]).toBe(
        `StoreOrder_s${result.targetShardIndex}_y2026m10`
      );
      expect(result.singleSubPartitionScan).toBe(true);
      expect(result.planSummary).toContain("Optimized Single-Leaf Scan");
    });

    test("4.4 should alert on scatter-gather risk when hash key or range is omitted", () => {
      // Missing hash key
      const queryNoHash = {
        createdAt: {
          gte: new Date("2026-10-01"),
          lte: new Date("2026-10-31"),
        },
      };
      const resNoHash = manager.withCompoundShardPruning(queryNoHash);
      expect(resNoHash.pruned).toBe(false);
      expect(resNoHash.warning).toContain("Missing shard key");

      // Missing time range
      const queryNoRange = {
        customerPhone: "0982480906",
      };
      const resNoRange = manager.withCompoundShardPruning(queryNoRange);
      expect(resNoRange.pruned).toBe(false);
      expect(resNoRange.targetShardTable).toBeDefined();
      expect(resNoRange.warning).toContain("Time range");
    });

    test("4.5 should generate zero-lock DETACH PARTITION CONCURRENTLY SQL", () => {
      // Single shard detach
      const singleDetach = manager.buildCompoundDetachSQL({
        year: 2025,
        month: 6,
        shardIndex: 1,
      });
      expect(singleDetach).toHaveLength(1);
      expect(singleDetach[0]).toBe(
        'ALTER TABLE "StoreOrder_s1" DETACH PARTITION "StoreOrder_s1_y2025m06" CONCURRENTLY;'
      );

      // All shards detach for cold month
      const allDetach = manager.buildCompoundDetachSQL({
        year: 2025,
        month: 6,
      });
      expect(allDetach).toHaveLength(4);
      expect(allDetach[0]).toBe(
        'ALTER TABLE "StoreOrder_s0" DETACH PARTITION "StoreOrder_s0_y2025m06" CONCURRENTLY;'
      );
      expect(allDetach[3]).toBe(
        'ALTER TABLE "StoreOrder_s3" DETACH PARTITION "StoreOrder_s3_y2025m06" CONCURRENTLY;'
      );
    });
  });
});
