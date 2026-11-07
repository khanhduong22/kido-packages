import { describe, expect, it } from "bun:test";
import {
  calculateLittleLawLatency,
  planReadReplicaCluster,
  SmeReadWriteSplitter,
} from "../src";

describe("Tier-0 SME Read-Write Splitter & Little's Law Queueing Theory", () => {
  describe("1. Little's Law Latency Calculations (calculateLittleLawLatency)", () => {
    it("computes sub-50ms latency under light load (rho = 0.50)", () => {
      const result = calculateLittleLawLatency({
        arrivalRateRps: 250,
        capacityRps: 500,
        baseServiceMs: 20,
      });

      expect(result.utilizationRho).toBe(0.5);
      expect(result.latencyMs).toBe(40);
      expect(result.queueWaitMs).toBe(20);
      expect(result.isSaturated).toBe(false);
      expect(result.hasExplosionRisk).toBe(false);
      expect(result.status).toBe("OPTIMAL");
      expect(result.latencyFormatted).toBe("40ms");
    });

    it("maintains <= 200ms latency when rho <= 0.90 (10 x 500 req/s replicas @ 4,500 sql_read/s)", () => {
      const result = calculateLittleLawLatency({
        arrivalRateRps: 4500,
        capacityRps: 5000, // 10 replicas x 500 req/s
        baseServiceMs: 20,
        queriesPerRequest: 1,
      });

      expect(result.utilizationRho).toBe(0.9);
      expect(result.latencyMs).toBe(200);
      expect(result.isSaturated).toBe(false);
      expect(result.hasExplosionRisk).toBe(true); // Exceeds 85% headroom guard
      expect(result.status).toBe("NEAR_SATURATION");
      expect(result.latencyFormatted).toBe("200ms");
      // Little's Law: L = 4,500 * 0.200s = 900 in-flight queries
      expect(result.averageInFlightQueries).toBe(900);
    });

    it("proves 1.42s latency explosion and App Server slot starvation at 100% capacity (rho = 1.0, 9 x 500 req/s)", () => {
      const result = calculateLittleLawLatency({
        arrivalRateRps: 4500,
        capacityRps: 4500, // 9 replicas x 500 req/s (100% capacity)
        baseServiceMs: 20,
        queriesPerRequest: 1,
      });

      expect(result.utilizationRho).toBe(1.0);
      expect(result.isSaturated).toBe(true);
      expect(result.hasExplosionRisk).toBe(true);
      expect(result.status).toBe("SATURATED_EXPLOSION");
      // Latency explodes to 1.42s (1420ms)
      expect(result.latencyMs).toBe(1420);
      expect(result.latencyFormatted).toBe("1.42s");
      // Little's Law: L = 4,500 * 1.42s = 6,390 in-flight queries
      expect(result.averageInFlightQueries).toBe(6390);
      expect(result.recommendation).toContain("DANGER: Utilization is 100%+");
    });

    it("handles queriesPerRequest multiplier correctly", () => {
      const result = calculateLittleLawLatency({
        arrivalRateRps: 1500,
        queriesPerRequest: 3, // 1,500 HTTP reqs * 3 SQL queries = 4,500 queries/s
        capacityRps: 5000,
        baseServiceMs: 20,
      });

      expect(result.totalSqlQueriesPerSec).toBe(4500);
      expect(result.utilizationRho).toBe(0.9);
      expect(result.latencyMs).toBe(200);
    });

    it("throws error for non-positive capacity or negative arrival", () => {
      expect(() =>
        calculateLittleLawLatency({ arrivalRateRps: 100, capacityRps: 0 })
      ).toThrow("Capacity (capacityRps) must be greater than 0");

      expect(() =>
        calculateLittleLawLatency({ arrivalRateRps: -10, capacityRps: 500 })
      ).toThrow("Arrival rate (arrivalRateRps) cannot be negative");
    });
  });

  describe("2. Cluster Capacity Planner (planReadReplicaCluster)", () => {
    it("compares Naive 9-replica plan (1.42s latency) vs Recommended 10-replica plan (200ms latency)", () => {
      const plan = planReadReplicaCluster({
        readRequestsPerSec: 4500,
        queriesPerRequest: 1,
        replicaTierCapacityRps: 500,
        replicaCostUsd: 20,
        maxUtilizationRho: 0.90, // target rho <= 0.90
        baseServiceMs: 20,
      });

      // Naive plan: 4500 / 500 = 9 replicas
      expect(plan.naivePlan.replicas).toBe(9);
      expect(plan.naivePlan.totalCapacityRps).toBe(4500);
      expect(plan.naivePlan.utilizationRho).toBe(1.0);
      expect(plan.naivePlan.monthlyCostUsd).toBe(180);
      expect(plan.naivePlan.estimatedLatencyMs).toBe(1420);
      expect(plan.naivePlan.estimatedLatencyFormatted).toBe("1.42s");
      expect(plan.naivePlan.inFlightQueries).toBe(6390);
      expect(plan.naivePlan.status).toBe("SATURATED_EXPLOSION");
      expect(plan.naivePlan.appServerStarvationRisk).toBe(true);

      // Recommended plan with Headroom Guard: 4500 / (500 * 0.90) = 10 replicas
      expect(plan.recommendedPlan.replicas).toBe(10);
      expect(plan.recommendedPlan.totalCapacityRps).toBe(5000);
      expect(plan.recommendedPlan.utilizationRho).toBe(0.90);
      expect(plan.recommendedPlan.monthlyCostUsd).toBe(200);
      expect(plan.recommendedPlan.estimatedLatencyMs).toBe(200);
      expect(plan.recommendedPlan.estimatedLatencyFormatted).toBe("200ms");
      expect(plan.recommendedPlan.inFlightQueries).toBe(900);
      expect(plan.recommendedPlan.headroomPercent).toBe(10);

      // Financial & performance trade-off proof:
      expect(plan.costDifferenceUsd).toBe(20); // only +$20/mo
      expect(plan.costIncreasePercent).toBe("11.1%");
      expect(plan.latencyImprovementFactor).toBe(7.1); // 7.1x faster
      expect(plan.analysis).toContain("Little's Law Headroom Proof");
    });
  });

  describe("3. SmeReadWriteSplitter Routing Engine", () => {
    const primaryUrl = "postgresql://user:pass@10.0.0.1:5432/primary_db";
    const replicas = [
      "postgresql://user:pass@10.0.0.2:5432/replica_1",
      "postgresql://user:pass@10.0.0.3:5432/replica_2",
    ];

    it("routes write operations directly to Primary DB", () => {
      const splitter = new SmeReadWriteSplitter({ primaryUrl, replicas });

      const res1 = splitter.routeQuery({
        sql: "INSERT INTO store_orders (id, total) VALUES (1, 100)",
      });
      expect(res1.target).toBe("primary");
      expect(res1.url).toBe(primaryUrl);
      expect(res1.reason).toBe("WRITE_OPERATION");

      const res2 = splitter.routeQuery({
        sql: "UPDATE store_products SET stock = stock - 1 WHERE id = 10",
      });
      expect(res2.target).toBe("primary");
      expect(res2.reason).toBe("WRITE_OPERATION");

      const res3 = splitter.routeQuery({
        sql: "DELETE FROM session_tokens WHERE expires_at < NOW()",
      });
      expect(res3.target).toBe("primary");
      expect(res3.reason).toBe("WRITE_OPERATION");
    });

    it("routes queries with explicit FOR UPDATE to Primary DB", () => {
      const splitter = new SmeReadWriteSplitter({ primaryUrl, replicas });
      const res = splitter.routeQuery({
        sql: "SELECT * FROM store_inventory WHERE sku = 'abc' FOR UPDATE",
      });
      expect(res.target).toBe("primary");
      expect(res.reason).toBe("WRITE_OPERATION");
    });

    it("routes explicit forcePrimary flag to Primary DB", () => {
      const splitter = new SmeReadWriteSplitter({ primaryUrl, replicas });
      const res = splitter.routeQuery({
        sql: "SELECT * FROM users WHERE id = 1",
        forcePrimary: true,
      });
      expect(res.target).toBe("primary");
      expect(res.reason).toBe("EXPLICIT_PRIMARY");
    });

    it("enforces Read-Your-Own-Writes Session Stickiness after user write", () => {
      const splitter = new SmeReadWriteSplitter({
        primaryUrl,
        replicas,
        stickySessionWindowMs: 3000,
      });

      const userId = "usr_998877";

      // 1. User performs a write operation
      splitter.routeQuery({
        sql: "UPDATE user_profiles SET full_name = 'Khanh Duong' WHERE id = 'usr_998877'",
        userId,
      });

      // 2. Immediate subsequent read from same user MUST go to Primary
      const read1 = splitter.routeQuery({
        sql: "SELECT * FROM user_profiles WHERE id = 'usr_998877'",
        userId,
      });
      expect(read1.target).toBe("primary");
      expect(read1.reason).toBe("STICKY_SESSION_READ_YOUR_OWN_WRITES");

      // 3. Another user's read goes to Replica
      const otherRead = splitter.routeQuery({
        sql: "SELECT * FROM products",
        userId: "other_user",
      });
      expect(otherRead.target).toBe("replica");
      expect(otherRead.reason).toBe("READ_REPLICA_BALANCED");

      // 4. After sticky window expires, user query routes to Replica again
      const futureTime = Date.now() + 5000;
      expect(splitter.isUserInStickyWindow(userId, futureTime)).toBe(false);
    });

    it("round-robins read queries across healthy read replicas", () => {
      const splitter = new SmeReadWriteSplitter({ primaryUrl, replicas });

      const q1 = splitter.routeQuery({ sql: "SELECT * FROM products" });
      const q2 = splitter.routeQuery({ sql: "SELECT * FROM categories" });
      const q3 = splitter.routeQuery({ sql: "SELECT * FROM tags" });

      expect(q1.target).toBe("replica");
      expect(q1.replicaId).toBe("replica-1");
      expect(q2.target).toBe("replica");
      expect(q2.replicaId).toBe("replica-2");
      expect(q3.target).toBe("replica");
      expect(q3.replicaId).toBe("replica-1"); // wraps around
    });

    it("falls back to Primary DB automatically when all replicas are degraded", () => {
      const splitter = new SmeReadWriteSplitter({
        primaryUrl,
        replicas,
        fallbackToPrimaryOnDegraded: true,
      });

      // Mark both replicas unhealthy
      splitter.markReplicaHealthy("replica-1", false);
      splitter.markReplicaHealthy("replica-2", false);

      expect(splitter.getHealthyReplicas().length).toBe(0);

      // Read query now automatically falls back to Primary
      const res = splitter.routeQuery({ sql: "SELECT * FROM products" });
      expect(res.target).toBe("primary");
      expect(res.url).toBe(primaryUrl);
      expect(res.reason).toBe("FALLBACK_NO_HEALTHY_REPLICAS");
    });

    it("evaluates cluster headroom using Little's Law", () => {
      const splitter = new SmeReadWriteSplitter({
        primaryUrl,
        replicas: [
          { id: "rep-1", url: "url1", capacityRps: 500 },
          { id: "rep-2", url: "url2", capacityRps: 500 },
        ],
      });

      expect(splitter.getTotalReplicaCapacityRps()).toBe(1000);

      const headroom = splitter.evaluateClusterHeadroom(800);
      expect(headroom.utilizationRho).toBe(0.8);
      expect(headroom.status).toBe("HEALTHY");
      expect(headroom.latencyMs).toBe(100);
    });
  });
});
