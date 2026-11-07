/**
 * @file stress-target-server.ts
 * @description Zero-dependency Node.js (node:http) high-concurrency benchmark server
 * backed by @kido/* production algorithms:
 *
 * 1. POST /naive/hot-counter: Row-lock serial contention (UPDATE ... SET count = count + 1)
 * 2. POST /tier0-sme/hot-counter: In-memory micro-batch coalescing (Tier-0 SME Zero-Infra)
 * 3. POST /tier2-bigtech/hot-counter: Atomic Valkey/Lua write-behind + 16-slot sharded counter (Tier-2 Big-Tech)
 * 4. GET /naive/read-replica: 9 x Read Replica Tier S at 100% saturation (rho = 1.0) with Little's Law queue explosion
 * 5. GET /tier1/read-replica: 10 x Read Replica Tier S at 90% utilization (rho = 0.90) keeping 3-query latency < 200ms
 * 6. GET /naive/cache-stampede vs GET /tier2/singleflight-cache: 1,000 concurrent misses vs 1 origin DB query
 * 7. GET /metrics: JSON telemetry summary (queries, write reduction %, p50/p95/p99)
 * 8. POST /reset: Clean state reset
 */

import http from "node:http";
import { pathToFileURL } from "node:url";
import { MicroBatchCoalescer } from "../../packages/hot-counter/src/micro-batch-coalescer.ts";
import { ValkeyWriteBehindCounter, InMemoryValkeySimulator } from "../../packages/hot-counter/src/valkey-write-behind.ts";
import { SlottedCounter, InMemorySlottedCounter, murmurhash3_32 } from "../../packages/hot-counter/src/slotted-counter.ts";
import { InFlightManager, SingleFlightSwr } from "../../packages/resilient-cache/src/in-flight.ts";

export interface LatencyStats {
  count: number;
  min: number;
  max: number;
  avg: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
}

export class LatencyHistogram {
  private samples: number[] = [];

  public record(valMs: number): void {
    this.samples.push(valMs);
  }

  public getStats(): LatencyStats {
    if (this.samples.length === 0) {
      return { count: 0, min: 0, max: 0, avg: 0, p50: 0, p90: 0, p95: 0, p99: 0 };
    }
    const sorted = [...this.samples].sort((a, b) => a - b);
    const n = sorted.length;
    const sum = sorted.reduce((acc, v) => acc + v, 0);

    return {
      count: n,
      min: Number(sorted[0].toFixed(2)),
      max: Number(sorted[n - 1].toFixed(2)),
      avg: Number((sum / n).toFixed(2)),
      p50: Number(sorted[Math.floor(n * 0.50)].toFixed(2)),
      p90: Number(sorted[Math.min(n - 1, Math.floor(n * 0.90))].toFixed(2)),
      p95: Number(sorted[Math.min(n - 1, Math.floor(n * 0.95))].toFixed(2)),
      p99: Number(sorted[Math.min(n - 1, Math.floor(n * 0.99))].toFixed(2)),
    };
  }

  public reset(): void {
    this.samples = [];
  }
}

/**
 * Mutex simulating serial PostgreSQL row-tuple locks for /naive/hot-counter
 */
class RowLockMutex {
  private locked = false;
  private queue: (() => void)[] = [];

  public async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  public release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      next();
    } else {
      this.locked = false;
    }
  }

  public reset(): void {
    this.locked = false;
    this.queue = [];
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createBenchmarkServer() {
  const startTime = Date.now();

  // 1. Hot-counter naive state
  const rowMutex = new RowLockMutex();
  let naiveCounter = 0;
  let naiveSqlStatements = 0;
  let naiveRequests = 0;
  const naiveLatencies = new LatencyHistogram();

  // 2. Hot-counter Tier-0 SME state
  let smeRequests = 0;
  let smeSqlStatements = 0;
  const smeLatencies = new LatencyHistogram();
  const coalescer = new MicroBatchCoalescer({
    tableName: "products",
    idColumn: "id",
    counterColumn: "view_count",
    flushIntervalMs: 30,
    maxDistinctKeys: 5000,
  });

  coalescer.start(async (_sql, _params) => {
    // Simulated batch SQL write: UPDATE products SET ... FROM (VALUES ...)
    await sleep(1.0);
    smeSqlStatements++;
  });

  // 3. Hot-counter Tier-2 Big-Tech state
  let bigtechRequests = 0;
  let bigtechSqlStatements = 0;
  const bigtechLatencies = new LatencyHistogram();
  const valkeySim = new InMemoryValkeySimulator();
  const valkeyCounter = new ValkeyWriteBehindCounter({
    client: valkeySim,
    dirtyHashKey: "buffer:dirty_hot_counter",
    flushIntervalMs: 50,
  });
  const slottedMaster = new SlottedCounter({ defaultNumSlots: 16 });
  const slottedSim: InMemorySlottedCounter = slottedMaster.getSimulator();

  // Background drain for Valkey write-behind
  const bigtechDrainTimer = setInterval(async () => {
    try {
      await valkeyCounter.flushToDatabase(async (_deltas) => {
        // Simulated single batched SQL statement
        await sleep(1.0);
        bigtechSqlStatements++;
      });
    } catch {
      // Handled inside flushToDatabase
    }
  }, 40);

  // 4 & 5. Read-replica Little's Law state
  let naiveReplicaRequests = 0;
  let tier1ReplicaRequests = 0;
  const naiveReplicaLatencies = new LatencyHistogram();
  const tier1ReplicaLatencies = new LatencyHistogram();

  // 6. Cache stampede state
  let naiveStampedeRequests = 0;
  let naiveStampedeDbQueries = 0;
  const naiveStampedeLatencies = new LatencyHistogram();

  let singleflightRequests = 0;
  let singleflightDbQueries = 0;
  const singleflightLatencies = new LatencyHistogram();
  const singleFlight = new SingleFlightSwr();

  const resetAll = () => {
    rowMutex.reset();
    naiveCounter = 0;
    naiveSqlStatements = 0;
    naiveRequests = 0;
    naiveLatencies.reset();

    smeRequests = 0;
    smeSqlStatements = 0;
    smeLatencies.reset();
    coalescer.resetStats();

    bigtechRequests = 0;
    bigtechSqlStatements = 0;
    bigtechLatencies.reset();
    valkeySim.clear();
    valkeyCounter.resetStats();
    slottedSim.clear();

    naiveReplicaRequests = 0;
    tier1ReplicaRequests = 0;
    naiveReplicaLatencies.reset();
    tier1ReplicaLatencies.reset();

    naiveStampedeRequests = 0;
    naiveStampedeDbQueries = 0;
    naiveStampedeLatencies.reset();

    singleflightRequests = 0;
    singleflightDbQueries = 0;
    singleflightLatencies.reset();
    singleFlight.clear();
  };

  const getMetrics = () => {
    const uptimeSec = Number(((Date.now() - startTime) / 1000).toFixed(1));

    // Hot-counter metrics
    const naiveWriteRed = "0.0%";
    const smeReduction = smeRequests > 0
      ? `${(((smeRequests - smeSqlStatements) / smeRequests) * 100).toFixed(1)}%`
      : "0.0%";
    const bigtechReduction = bigtechRequests > 0
      ? `${(((bigtechRequests - bigtechSqlStatements) / bigtechRequests) * 100).toFixed(1)}%`
      : "0.0%";

    // Cache stampede metrics
    const singleflightReduction = singleflightRequests > 0
      ? `${(((singleflightRequests - singleflightDbQueries) / singleflightRequests) * 100).toFixed(1)}%`
      : "0.0%";

    return {
      uptimeSeconds: uptimeSec,
      hotCounter: {
        naive: {
          requests: naiveRequests,
          sqlExecuted: naiveSqlStatements,
          writeReductionPercent: naiveWriteRed,
          latencies: naiveLatencies.getStats(),
        },
        tier0Sme: {
          requests: smeRequests,
          sqlExecuted: smeSqlStatements,
          writeReductionPercent: smeReduction,
          latencies: smeLatencies.getStats(),
        },
        tier2Bigtech: {
          requests: bigtechRequests,
          sqlExecuted: bigtechSqlStatements,
          writeReductionPercent: bigtechReduction,
          latencies: bigtechLatencies.getStats(),
        },
      },
      readReplica: {
        naive9Replicas: {
          requests: naiveReplicaRequests,
          utilization: 1.0,
          sqlPerRequest: 3,
          totalSqlQueries: naiveReplicaRequests * 3,
          latencies: naiveReplicaLatencies.getStats(),
        },
        tier110Replicas: {
          requests: tier1ReplicaRequests,
          utilization: 0.90,
          sqlPerRequest: 3,
          totalSqlQueries: tier1ReplicaRequests * 3,
          latencies: tier1ReplicaLatencies.getStats(),
        },
      },
      cacheStampede: {
        naive: {
          requests: naiveStampedeRequests,
          originDbQueries: naiveStampedeDbQueries,
          queryReductionPercent: "0.0%",
          latencies: naiveStampedeLatencies.getStats(),
        },
        tier2Singleflight: {
          requests: singleflightRequests,
          originDbQueries: singleflightDbQueries,
          collapsedRequests: singleFlight.getStats().collapsedCount + singleFlight.getStats().hits,
          queryReductionPercent: singleflightReduction,
          latencies: singleflightLatencies.getStats(),
        },
      },
    };
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;
    const method = req.method ?? "GET";

    const json = (statusCode: number, data: unknown) => {
      res.writeHead(statusCode, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "*",
      });
      res.end(JSON.stringify(data));
    };

    if (method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "*",
      });
      res.end();
      return;
    }

    // --- 1. POST /naive/hot-counter ---
    if (method === "POST" && pathname === "/naive/hot-counter") {
      const start = performance.now();
      naiveRequests++;

      // Simulates row tuple lock queueing + WAL write
      await rowMutex.acquire();
      try {
        await sleep(0.5); // Simulated disk WAL flush + tuple lock hold
        naiveCounter++;
        naiveSqlStatements++;
      } finally {
        rowMutex.release();
      }

      const elapsed = performance.now() - start;
      naiveLatencies.record(elapsed);

      return json(200, {
        status: "ok",
        tier: "naive",
        counter: naiveCounter,
        sqlStatements: 1,
        latencyMs: Number(elapsed.toFixed(2)),
      });
    }

    // --- 2. POST /tier0-sme/hot-counter ---
    if (method === "POST" && pathname === "/tier0-sme/hot-counter") {
      const start = performance.now();
      smeRequests++;

      // In-memory micro-batch coalescing
      coalescer.record("hot-product-sku-1", 1);

      const elapsed = performance.now() - start;
      smeLatencies.record(elapsed);

      return json(200, {
        status: "ok",
        tier: "tier0-sme",
        coalesced: true,
        pending: coalescer.getPendingCount(),
        latencyMs: Number(elapsed.toFixed(2)),
      });
    }

    // --- 3. POST /tier2-bigtech/hot-counter ---
    if (method === "POST" && pathname === "/tier2-bigtech/hot-counter") {
      const start = performance.now();
      bigtechRequests++;

      const callerId = (req.headers["x-vu-id"] as string) ||
        (req.headers["x-caller-id"] as string) ||
        `vu-${Math.floor(Math.random() * 10000)}`;

      // 16-slot sharded hashing
      const slotId = murmurhash3_32(callerId) % 16;
      slottedSim.increment("product", "hot-product-sku-1", callerId, 1);

      // Atomic Valkey/Lua write-behind buffer
      await valkeyCounter.increment("hot-product-sku-1", 1);

      const elapsed = performance.now() - start;
      bigtechLatencies.record(elapsed);

      return json(200, {
        status: "ok",
        tier: "tier2-bigtech",
        slotId,
        callerId,
        latencyMs: Number(elapsed.toFixed(2)),
      });
    }

    // --- 4. GET /naive/read-replica ---
    // Simulates 9 x Read Replica Tier S at 100% saturation (rho = 1.0)
    // 3 sequential SQL queries per page read -> Little's Law 1/(1-rho) queue blowup
    if (method === "GET" && pathname === "/naive/read-replica") {
      const start = performance.now();
      naiveReplicaRequests++;

      // In a saturated rho = 1.0 queue, delay per query explodes due to zero headroom
      // Base service time: 2.0ms. Queue factor: ~60x - 90x
      const jitter = 0.85 + Math.random() * 0.3;
      const queueDelayPerQuery = 2.0 * 65.0 * jitter; // ~130ms queue wait per query
      const queryDurationMs = 2.0 + queueDelayPerQuery; // ~132ms
      const totalPageDuration = queryDurationMs * 3; // 3 sequential SQL queries ~396ms - 450ms+

      await sleep(totalPageDuration);

      const elapsed = performance.now() - start;
      naiveReplicaLatencies.record(elapsed);

      return json(200, {
        status: "ok",
        tier: "naive-9-replicas",
        utilization: 1.0,
        sequentialQueries: 3,
        latencyMs: Number(elapsed.toFixed(2)),
      });
    }

    // --- 5. GET /tier1/read-replica ---
    // Simulates 10 x Read Replica Tier S at 90% utilization (rho = 0.90)
    // 10% headroom absorbs bursts -> keeping 3-query latency well under 200ms
    if (method === "GET" && pathname === "/tier1/read-replica") {
      const start = performance.now();
      tier1ReplicaRequests++;

      // Queuing delay for rho = 0.90 is strictly bounded: rho / (1 - rho) = 9.0x
      const jitter = 0.85 + Math.random() * 0.3;
      const queueDelayPerQuery = 2.0 * 9.0 * jitter; // ~18ms queue wait per query
      const queryDurationMs = 2.0 + queueDelayPerQuery; // ~20ms
      const totalPageDuration = queryDurationMs * 3; // 3 sequential SQL queries ~60ms (< 200ms SLA!)

      await sleep(totalPageDuration);

      const elapsed = performance.now() - start;
      tier1ReplicaLatencies.record(elapsed);

      return json(200, {
        status: "ok",
        tier: "tier1-10-replicas",
        utilization: 0.90,
        sequentialQueries: 3,
        latencyMs: Number(elapsed.toFixed(2)),
      });
    }

    // --- 6. GET /naive/cache-stampede ---
    // Every concurrent miss executes an independent origin DB query
    if (method === "GET" && pathname === "/naive/cache-stampede") {
      const start = performance.now();
      naiveStampedeRequests++;

      // Origin DB query (simulated 25ms uncoalesced load)
      await sleep(25);
      naiveStampedeDbQueries++;

      const elapsed = performance.now() - start;
      naiveStampedeLatencies.record(elapsed);

      return json(200, {
        status: "ok",
        mode: "naive-stampede",
        dbQueriesExecuted: 1,
        latencyMs: Number(elapsed.toFixed(2)),
      });
    }

    // --- 6. GET /tier2/singleflight-cache ---
    // 1,000 concurrent misses collapsed into 1 single origin DB query
    if (method === "GET" && pathname === "/tier2/singleflight-cache") {
      const start = performance.now();
      singleflightRequests++;

      // Coalesces all in-flight callers into 1 single execution with SWR/TTL caching
      const data = await singleFlight.execute("product:black-friday-deal", async () => {
        await sleep(25);
        singleflightDbQueries++;
        return { deal: "50% OFF Limited Stock", timestamp: Date.now() };
      }, { ttlMs: 10000 });

      const elapsed = performance.now() - start;
      singleflightLatencies.record(elapsed);

      return json(200, {
        status: "ok",
        mode: "tier2-singleflight",
        data,
        collapsedRequests: singleFlight.getStats().collapsedCount,
        latencyMs: Number(elapsed.toFixed(2)),
      });
    }

    // --- 7. GET /metrics ---
    if (method === "GET" && pathname === "/metrics") {
      return json(200, getMetrics());
    }

    // --- 8. POST /reset ---
    if (method === "POST" && pathname === "/reset") {
      resetAll();
      return json(200, { status: "reset_ok", timestamp: Date.now() });
    }

    // 404 fallback
    return json(404, { error: "Not found", path: pathname });
  });

  return {
    server,
    start: (port: number = 4040): Promise<number> => {
      return new Promise((resolve) => {
        server.listen(port, "127.0.0.1", 1024, () => {
          const addr = server.address();
          const actualPort = typeof addr === "object" && addr ? addr.port : port;
          resolve(actualPort);
        });
      });
    },
    stop: (): Promise<void> => {
      coalescer.stop();
      clearInterval(bigtechDrainTimer);
      return new Promise((resolve) => {
        server.close(() => resolve());
      });
    },
    reset: resetAll,
    getMetrics,
  };
}

// CLI direct run detection
const isDirectCli = process.argv[1] &&
  (process.argv[1].endsWith("stress-target-server.ts") ||
   process.argv[1].endsWith("stress-target-server.js"));

if (isDirectCli) {
  const port = Number(process.env.PORT || 4040);
  const benchServer = createBenchmarkServer();
  benchServer.start(port).then((actualPort) => {
    console.log(`[stress-target-server] Running on http://127.0.0.1:${actualPort}`);
    console.log(`Endpoints:`);
    console.log(`  POST /naive/hot-counter`);
    console.log(`  POST /tier0-sme/hot-counter`);
    console.log(`  POST /tier2-bigtech/hot-counter`);
    console.log(`  GET  /naive/read-replica`);
    console.log(`  GET  /tier1/read-replica`);
    console.log(`  GET  /naive/cache-stampede`);
    console.log(`  GET  /tier2/singleflight-cache`);
    console.log(`  GET  /metrics`);
    console.log(`  POST /reset`);
  });

  process.on("SIGINT", async () => {
    console.log("\n[stress-target-server] Shutting down...");
    await benchServer.stop();
    process.exit(0);
  });
}
