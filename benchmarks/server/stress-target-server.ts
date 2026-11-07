/**
 * @file stress-target-server.ts
 * @description Zero-dependency Node.js (node:http) high-concurrency benchmark server
 * backed by @kido/* production algorithms:
 *
 * 1. Infrastructure:
 *    - POST /naive/hot-counter: Row-lock serial contention (UPDATE ... SET count = count + 1)
 *    - POST /tier0-sme/hot-counter: In-memory micro-batch coalescing (Tier-0 SME Zero-Infra)
 *    - POST /tier2-bigtech/hot-counter: Atomic Valkey/Lua write-behind + 16-slot sharded counter (Tier-2 Big-Tech)
 *    - GET  /naive/read-replica: 9 x Read Replica Tier S at 100% saturation (rho = 1.0) with Little's Law queue explosion
 *    - GET  /tier1/read-replica: 10 x Read Replica Tier S at 90% utilization (rho = 0.90) keeping 3-query latency < 200ms
 *    - GET  /naive/cache-stampede vs GET /tier2/singleflight-cache: 1,000 concurrent misses vs 1 origin DB query
 *
 * 2. Security:
 *    - POST /benchmark/security/anti-spam: 64-bit SimHash deduplication & Hamming distance check
 *    - POST /benchmark/security/audit-trail: SHA-256 cryptographic hash-chain block creation & verification
 *    - POST /benchmark/security/tenant-guard: Multi-tenant RLS query filter injection & isolation assert
 *
 * 3. FinTech:
 *    - POST /benchmark/fintech/wallet-ledger: Double-entry ledger movement & WACB portfolio accounting
 *    - POST /benchmark/fintech/payment-vietqr: EMVCo QR code payload generation & CRC16-CCITT checksum
 *
 * 4. E-Commerce:
 *    - POST /benchmark/ecommerce/discount-loyalty: Dynamic voucher calculation & member tier evaluation
 *    - POST /benchmark/ecommerce/bundle-pricing: Multi-variant tiered bundle pricing evaluation
 *
 * 5. Logistics:
 *    - POST /benchmark/logistics/bom-inventory: Recipe BOM explosion & S-shape 2-Opt TSP warehouse routing
 *    - POST /benchmark/logistics/geocoding-routing: Vincenty ellipsoid geofence & Haversine distance
 *
 * 6. Telemetry & Control:
 *    - GET  /metrics: Multi-domain telemetry summary (latencies, throughput, reductions)
 *    - POST /reset: Clean state reset across all domains
 */

import http from "node:http";
import { pathToFileURL } from "node:url";

// Infrastructure Domain
import { MicroBatchCoalescer } from "../../packages/hot-counter/src/micro-batch-coalescer.ts";
import { ValkeyWriteBehindCounter, InMemoryValkeySimulator } from "../../packages/hot-counter/src/valkey-write-behind.ts";
import { SlottedCounter, InMemorySlottedCounter, murmurhash3_32 } from "../../packages/hot-counter/src/slotted-counter.ts";
import { InFlightManager, SingleFlightSwr } from "../../packages/resilient-cache/src/in-flight.ts";

// Security Domain
import { computeSimHash, hammingDistance } from "../../packages/anti-spam/dist/index.mjs";
import { computeEntryHash, createAuditEntry, verifyChainIntegrity, GENESIS_HASH } from "../../packages/audit-trail/dist/index.mjs";
import { buildTenantWhereClause, assertTenantIsolation } from "../../packages/tenant-guard/dist/index.mjs";

// FinTech Domain
import { WalletLedger, executeWacbTransaction } from "../../packages/wallet-ledger/dist/index.mjs";
import { generateVietQrEmvco, crc16Ccitt } from "../../packages/payment-vietqr/dist/index.mjs";

// E-Commerce Domain
import { calculateVoucherDiscount, determineMemberTier } from "../../packages/discount-loyalty/dist/index.mjs";
import { calculateBundlePricing } from "../../packages/bundle-pricing/dist/index.js";

// Logistics Domain
import { optimizeSshape2OptRoute, RecipeCatalog, explodeBOM, DEFAULT_FNB_RECIPES } from "../../packages/bom-inventory/dist/index.mjs";
import { vincentyDistance, haversineDistance } from "../../packages/geocoding-routing/dist/index.mjs";

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

function readRequestBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", () => resolve(""));
  });
}

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

  // 7. Security domain state
  let antiSpamRequests = 0;
  const antiSpamLatencies = new LatencyHistogram();
  const refSimhash = computeSimHash("Khuyen mai cuc soc giam gia 50% hom nay");

  let auditTrailRequests = 0;
  let lastAuditHash = GENESIS_HASH;
  const auditTrailLatencies = new LatencyHistogram();

  let tenantGuardRequests = 0;
  const tenantGuardLatencies = new LatencyHistogram();

  // 8. FinTech domain state
  let walletLedgerRequests = 0;
  const walletLedger = new WalletLedger();
  const walletLedgerLatencies = new LatencyHistogram();

  let vietqrRequests = 0;
  const vietqrLatencies = new LatencyHistogram();

  // 9. E-Commerce domain state
  let discountRequests = 0;
  const discountLatencies = new LatencyHistogram();

  let bundleRequests = 0;
  const bundleLatencies = new LatencyHistogram();

  // 10. Logistics domain state
  let bomRequests = 0;
  const bomRecipeCatalog = new RecipeCatalog(DEFAULT_FNB_RECIPES);
  const bomLatencies = new LatencyHistogram();

  let geocodingRequests = 0;
  const geocodingLatencies = new LatencyHistogram();

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

    antiSpamRequests = 0;
    antiSpamLatencies.reset();

    auditTrailRequests = 0;
    lastAuditHash = GENESIS_HASH;
    auditTrailLatencies.reset();

    tenantGuardRequests = 0;
    tenantGuardLatencies.reset();

    walletLedgerRequests = 0;
    walletLedger.clear();
    walletLedgerLatencies.reset();

    vietqrRequests = 0;
    vietqrLatencies.reset();

    discountRequests = 0;
    discountLatencies.reset();

    bundleRequests = 0;
    bundleLatencies.reset();

    bomRequests = 0;
    bomLatencies.reset();

    geocodingRequests = 0;
    geocodingLatencies.reset();
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
      security: {
        antiSpam: {
          requests: antiSpamRequests,
          latencies: antiSpamLatencies.getStats(),
        },
        auditTrail: {
          requests: auditTrailRequests,
          latencies: auditTrailLatencies.getStats(),
        },
        tenantGuard: {
          requests: tenantGuardRequests,
          latencies: tenantGuardLatencies.getStats(),
        },
      },
      fintech: {
        walletLedger: {
          requests: walletLedgerRequests,
          latencies: walletLedgerLatencies.getStats(),
        },
        paymentVietqr: {
          requests: vietqrRequests,
          latencies: vietqrLatencies.getStats(),
        },
      },
      ecommerce: {
        discountLoyalty: {
          requests: discountRequests,
          latencies: discountLatencies.getStats(),
        },
        bundlePricing: {
          requests: bundleRequests,
          latencies: bundleLatencies.getStats(),
        },
      },
      logistics: {
        bomInventory: {
          requests: bomRequests,
          latencies: bomLatencies.getStats(),
        },
        geocodingRouting: {
          requests: geocodingRequests,
          latencies: geocodingLatencies.getStats(),
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

    // =========================================================================
    // 1. INFRASTRUCTURE ENDPOINTS
    // =========================================================================

    // --- 1A. POST /naive/hot-counter ---
    if (method === "POST" && pathname === "/naive/hot-counter") {
      const start = performance.now();
      naiveRequests++;

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

    // --- 1B. POST /tier0-sme/hot-counter ---
    if (method === "POST" && pathname === "/tier0-sme/hot-counter") {
      const start = performance.now();
      smeRequests++;

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

    // --- 1C. POST /tier2-bigtech/hot-counter ---
    if (method === "POST" && pathname === "/tier2-bigtech/hot-counter") {
      const start = performance.now();
      bigtechRequests++;

      const callerId = (req.headers["x-vu-id"] as string) ||
        (req.headers["x-caller-id"] as string) ||
        `vu-${Math.floor(Math.random() * 10000)}`;

      const slotId = murmurhash3_32(callerId) % 16;
      slottedSim.increment("product", "hot-product-sku-1", callerId, 1);
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

    // --- 1D. GET /naive/read-replica ---
    if (method === "GET" && pathname === "/naive/read-replica") {
      const start = performance.now();
      naiveReplicaRequests++;

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

    // --- 1E. GET /tier1/read-replica ---
    if (method === "GET" && pathname === "/tier1/read-replica") {
      const start = performance.now();
      tier1ReplicaRequests++;

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

    // --- 1F. GET /naive/cache-stampede ---
    if (method === "GET" && pathname === "/naive/cache-stampede") {
      const start = performance.now();
      naiveStampedeRequests++;

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

    // --- 1G. GET /tier2/singleflight-cache ---
    if (method === "GET" && pathname === "/tier2/singleflight-cache") {
      const start = performance.now();
      singleflightRequests++;

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

    // =========================================================================
    // 2. SECURITY DOMAIN ENDPOINTS
    // =========================================================================

    // --- 2A. POST /benchmark/security/anti-spam ---
    if (method === "POST" && pathname === "/benchmark/security/anti-spam") {
      const start = performance.now();
      antiSpamRequests++;

      const bodyStr = await readRequestBody(req);
      let text = "Khuyến mãi cực sốc giảm giá 50% mua ngay hôm nay";
      try {
        if (bodyStr) {
          const parsed = JSON.parse(bodyStr);
          if (parsed.text) text = parsed.text;
        }
      } catch {}

      const simhash = computeSimHash(text);
      const distance = hammingDistance(simhash, refSimhash);
      const isNearDuplicate = distance <= 5;

      const elapsed = performance.now() - start;
      antiSpamLatencies.record(elapsed);

      return json(200, {
        status: "ok",
        domain: "security",
        operation: "simhash-dedupe",
        simhash,
        distance,
        isNearDuplicate,
        latencyMs: Number(elapsed.toFixed(2)),
      });
    }

    // --- 2B. POST /benchmark/security/audit-trail ---
    if (method === "POST" && pathname === "/benchmark/security/audit-trail") {
      const start = performance.now();
      auditTrailRequests++;

      const entry = createAuditEntry({
        action: "ORDER_CREATED",
        actor: { userId: `user-${(auditTrailRequests % 50) + 1}` },
        resource: { type: "order", id: `order-${auditTrailRequests}` },
        details: { amount: 1500000, itemsCount: 3 },
      }, lastAuditHash);

      lastAuditHash = computeEntryHash(entry, lastAuditHash);

      const elapsed = performance.now() - start;
      auditTrailLatencies.record(elapsed);

      return json(200, {
        status: "ok",
        domain: "security",
        operation: "sha256-hashchain",
        hash: lastAuditHash,
        entryIndex: auditTrailRequests,
        latencyMs: Number(elapsed.toFixed(2)),
      });
    }

    // --- 2C. POST /benchmark/security/tenant-guard ---
    if (method === "POST" && pathname === "/benchmark/security/tenant-guard") {
      const start = performance.now();
      tenantGuardRequests++;

      const tenantId = `tenant-${(tenantGuardRequests % 20) + 1}`;
      const where = buildTenantWhereClause({ tenantId });
      assertTenantIsolation({ tenantId }, { tenantId });

      const elapsed = performance.now() - start;
      tenantGuardLatencies.record(elapsed);

      return json(200, {
        status: "ok",
        domain: "security",
        operation: "rls-filter-injection",
        tenantId,
        whereClause: where.clause,
        latencyMs: Number(elapsed.toFixed(2)),
      });
    }

    // =========================================================================
    // 3. FINTECH DOMAIN ENDPOINTS
    // =========================================================================

    // --- 3A. POST /benchmark/fintech/wallet-ledger ---
    if (method === "POST" && pathname === "/benchmark/fintech/wallet-ledger") {
      const start = performance.now();
      walletLedgerRequests++;

      const walletId = `wallet-${(walletLedgerRequests % 20) + 1}`;
      if (!walletLedger.getWallet(walletId)) {
        walletLedger.createWallet(walletId, `user-${walletId}`);
      }

      walletLedger.creditUseAccount({
        walletId,
        amount: 10000,
        idempotencyKey: `tx-${walletLedgerRequests}-${Date.now()}`,
        description: "Benchmark balance credit",
      });

      const portfolioState = executeWacbTransaction(
        { holdings: [], realizedPnl: [], cashBalance: 50000000 },
        {
          symbol: "VNM",
          side: "BUY",
          quantity: 10,
          price: 135000,
          fee: 500,
          transactedAt: new Date().toISOString(),
        }
      );

      const elapsed = performance.now() - start;
      walletLedgerLatencies.record(elapsed);

      return json(200, {
        status: "ok",
        domain: "fintech",
        operation: "double-entry-ledger-and-wacb",
        walletId,
        balance: walletLedger.getWallet(walletId)?.useAccount.available,
        holdingsCount: portfolioState.holdings.length,
        latencyMs: Number(elapsed.toFixed(2)),
      });
    }

    // --- 3B. POST /benchmark/fintech/payment-vietqr ---
    if (method === "POST" && pathname === "/benchmark/fintech/payment-vietqr") {
      const start = performance.now();
      vietqrRequests++;

      const emvcoPayload = generateVietQrEmvco({
        bank: "970422", // MBBank
        accountNumber: "09012345678",
        accountName: "KIDO PACKAGES",
        amount: 500000,
        description: `ORDER ${vietqrRequests}`,
      });
      const crc = crc16Ccitt(emvcoPayload);

      const elapsed = performance.now() - start;
      vietqrLatencies.record(elapsed);

      return json(200, {
        status: "ok",
        domain: "fintech",
        operation: "vietqr-emvco-crc16",
        payloadLength: emvcoPayload.length,
        crc,
        latencyMs: Number(elapsed.toFixed(2)),
      });
    }

    // =========================================================================
    // 4. E-COMMERCE DOMAIN ENDPOINTS
    // =========================================================================

    // --- 4A. POST /benchmark/ecommerce/discount-loyalty ---
    if (method === "POST" && pathname === "/benchmark/ecommerce/discount-loyalty") {
      const start = performance.now();
      discountRequests++;

      const voucherResult = calculateVoucherDiscount(
        {
          id: "v-super-sale",
          code: "SUPERSALE20",
          name: "Flash Super Sale 20%",
          type: "PERCENTAGE",
          value: 20,
          minOrderValue: 100000,
          isActive: true,
        },
        {
          subtotal: 500000,
          items: [{ id: "item-101", name: "Premium Polo", price: 250000, quantity: 2 }],
        }
      );

      const memberTier = determineMemberTier(2500000);

      const elapsed = performance.now() - start;
      discountLatencies.record(elapsed);

      return json(200, {
        status: "ok",
        domain: "ecommerce",
        operation: "voucher-discount-and-tier",
        discountAmount: voucherResult.discountAmount,
        finalTotal: voucherResult.finalTotal,
        memberTier,
        latencyMs: Number(elapsed.toFixed(2)),
      });
    }

    // --- 4B. POST /benchmark/ecommerce/bundle-pricing ---
    if (method === "POST" && pathname === "/benchmark/ecommerce/bundle-pricing") {
      const start = performance.now();
      bundleRequests++;

      const bundleResult = calculateBundlePricing(
        {
          id: "bundle-tier-3",
          name: "Buy 3 Save 30%",
          quantity: 3,
          discountPercent: 30,
          basePricePerUnit: 150000,
        },
        {
          slots: [
            { variantId: "var-1", quantity: 1, unitPrice: 150000 },
            { variantId: "var-2", quantity: 1, unitPrice: 150000 },
            { variantId: "var-3", quantity: 1, unitPrice: 150000 },
          ],
        }
      );

      const elapsed = performance.now() - start;
      bundleLatencies.record(elapsed);

      return json(200, {
        status: "ok",
        domain: "ecommerce",
        operation: "bundle-pricing-tier",
        finalPrice: bundleResult.finalBundlePrice,
        savings: bundleResult.totalSavings,
        latencyMs: Number(elapsed.toFixed(2)),
      });
    }

    // =========================================================================
    // 5. LOGISTICS DOMAIN ENDPOINTS
    // =========================================================================

    // --- 5A. POST /benchmark/logistics/bom-inventory ---
    if (method === "POST" && pathname === "/benchmark/logistics/bom-inventory") {
      const start = performance.now();
      bomRequests++;

      const exploded = explodeBOM(
        "RECIPE-TRA-DAO-CAM-SA",
        50,
        bomRecipeCatalog,
        { includeWaste: true }
      );

      const route = optimizeSshape2OptRoute([
        { sku: "BB-LY-PP-500", binLocation: "WH-01-01-01-01", quantity: 50 },
        { sku: "NVL-SIRO-DAO", binLocation: "WH-02-01-01-02", quantity: 2500 },
        { sku: "BB-NAP-KIM-CUONG", binLocation: "WH-01-02-01-01", quantity: 50 },
      ]);

      const elapsed = performance.now() - start;
      bomLatencies.record(elapsed);

      return json(200, {
        status: "ok",
        domain: "logistics",
        operation: "bom-explosion-and-2opt-tsp",
        rawMaterialsCount: exploded.rawMaterials.length,
        routeStopsCount: route.stops.length,
        latencyMs: Number(elapsed.toFixed(2)),
      });
    }

    // --- 5B. POST /benchmark/logistics/geocoding-routing ---
    if (method === "POST" && pathname === "/benchmark/logistics/geocoding-routing") {
      const start = performance.now();
      geocodingRequests++;

      const origin = { latitude: 16.0544, longitude: 108.2022 };
      const destination = { latitude: 15.8801, longitude: 108.3380 };

      const havDistanceKm = haversineDistance(origin, destination);
      const vincDistanceM = vincentyDistance(origin, destination);

      const elapsed = performance.now() - start;
      geocodingLatencies.record(elapsed);

      return json(200, {
        status: "ok",
        domain: "logistics",
        operation: "vincenty-and-haversine",
        haversineKm: Number(havDistanceKm.toFixed(2)),
        vincentyMeters: Number(vincDistanceM.toFixed(1)),
        latencyMs: Number(elapsed.toFixed(2)),
      });
    }

    // =========================================================================
    // 6. TELEMETRY & SERVER CONTROL
    // =========================================================================

    // --- 6A. GET /metrics ---
    if (method === "GET" && pathname === "/metrics") {
      return json(200, getMetrics());
    }

    // --- 6B. POST /reset ---
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
    console.log(`  Infrastructure:`);
    console.log(`    POST /naive/hot-counter`);
    console.log(`    POST /tier0-sme/hot-counter`);
    console.log(`    POST /tier2-bigtech/hot-counter`);
    console.log(`    GET  /naive/read-replica`);
    console.log(`    GET  /tier1/read-replica`);
    console.log(`    GET  /naive/cache-stampede`);
    console.log(`    GET  /tier2/singleflight-cache`);
    console.log(`  Security:`);
    console.log(`    POST /benchmark/security/anti-spam`);
    console.log(`    POST /benchmark/security/audit-trail`);
    console.log(`    POST /benchmark/security/tenant-guard`);
    console.log(`  FinTech:`);
    console.log(`    POST /benchmark/fintech/wallet-ledger`);
    console.log(`    POST /benchmark/fintech/payment-vietqr`);
    console.log(`  E-Commerce:`);
    console.log(`    POST /benchmark/ecommerce/discount-loyalty`);
    console.log(`    POST /benchmark/ecommerce/bundle-pricing`);
    console.log(`  Logistics:`);
    console.log(`    POST /benchmark/logistics/bom-inventory`);
    console.log(`    POST /benchmark/logistics/geocoding-routing`);
    console.log(`  Telemetry:`);
    console.log(`    GET  /metrics`);
    console.log(`    POST /reset`);
  });

  process.on("SIGINT", async () => {
    console.log("\n[stress-target-server] Shutting down...");
    await benchServer.stop();
    process.exit(0);
  });
}
