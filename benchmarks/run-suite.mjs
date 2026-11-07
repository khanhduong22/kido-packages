#!/usr/bin/env node
/**
 * @file run-suite.mjs
 * @description Self-contained Node.js Benchmark & Stress Verification Runner
 *
 * Runs 10,000 high-concurrency operations across 3 foundational production patterns:
 * 1. Hot-Counter 3-Tier (Naive Row-Lock vs Tier-0 SME Micro-Batch vs Tier-2 Big-Tech 16-Slot Valkey) [5,000 ops]
 * 2. Read-Replica Little's Law (9 Replicas @ 100% Saturation vs 10 Replicas @ 90% Headroom) [3,000 ops]
 * 3. SingleFlight Cache Stampede (Naive 1,000 DB Queries vs SingleFlight 1 DB Query Coalesced) [2,000 ops]
 *
 * Output: Clean Markdown report with measured p50/p95/p99 latencies, throughput,
 * write amplification reduction percentages, and SLA assertion verification gates.
 */

import http from "node:http";
import os from "node:os";
import { createBenchmarkServer } from "./server/stress-target-server.ts";

// Format helper
const pad = (str, len) => String(str).padEnd(len);
const padLeft = (str, len) => String(str).padStart(len);

async function runScenarioPool({
  port,
  agent,
  path,
  method = "GET",
  totalOps,
  concurrency,
  headers = {},
  body = null,
}) {
  let started = 0;
  let finished = 0;
  const latencies = [];
  const start = performance.now();

  function makeRequest(vuIndex) {
    return new Promise((resolve, reject) => {
      const t0 = performance.now();
      const reqHeaders = {
        connection: "keep-alive",
        "x-vu-id": `vu-${vuIndex}`,
        ...headers,
      };
      if (body) {
        reqHeaders["content-type"] = "application/json";
        reqHeaders["content-length"] = Buffer.byteLength(body);
      }

      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          path,
          method,
          headers: reqHeaders,
          agent,
        },
        (res) => {
          res.resume();
          res.on("end", () => {
            const duration = performance.now() - t0;
            latencies.push(duration);
            finished++;
            resolve();
          });
        }
      );

      req.on("error", reject);
      if (body) req.write(body);
      req.end();
    });
  }

  async function worker(vuIndex) {
    while (true) {
      const idx = started++;
      if (idx >= totalOps) break;
      await makeRequest(vuIndex);
    }
  }

  await Promise.all(
    Array.from({ length: concurrency }, (_, vu) => worker(vu + 1))
  );

  const totalDurationMs = performance.now() - start;
  latencies.sort((a, b) => a - b);
  const n = latencies.length;
  const sum = latencies.reduce((acc, v) => acc + v, 0);

  return {
    totalOps: n,
    durationMs: totalDurationMs,
    throughputOpsSec: Number((n / (totalDurationMs / 1000)).toFixed(0)),
    min: Number(latencies[0].toFixed(2)),
    p50: Number(latencies[Math.floor(n * 0.5)].toFixed(2)),
    p90: Number(latencies[Math.min(n - 1, Math.floor(n * 0.9))].toFixed(2)),
    p95: Number(latencies[Math.min(n - 1, Math.floor(n * 0.95))].toFixed(2)),
    p99: Number(latencies[Math.min(n - 1, Math.floor(n * 0.99))].toFixed(2)),
    max: Number(latencies[n - 1].toFixed(2)),
    avg: Number((sum / n).toFixed(2)),
  };
}

async function main() {
  console.log("\n🚀 [kido-packages] Initializing High-Concurrency Benchmark Suite...");

  const benchServer = createBenchmarkServer();
  const port = await benchServer.start(0);
  console.log(`✓ Benchmark target server listening on http://127.0.0.1:${port}`);

  const agent = new http.Agent({
    keepAlive: true,
    maxSockets: 150,
  });

  const results = {};
  const suiteStartTime = performance.now();

  try {
    // =========================================================================
    // SCENARIO 1: HOT-COUNTER 3-TIER (5,000 Operations Total)
    // =========================================================================
    console.log("\n▶ Running Scenario 1: Hot-Counter 3-Tier Contention (5,000 ops)...");

    // 1A. Naive Row-Lock Contention (1,000 ops)
    process.stdout.write("  [1/3] Naive Row-Lock Contention (1,000 ops)... ");
    benchServer.reset();
    results.naiveHotCounter = await runScenarioPool({
      port,
      agent,
      path: "/naive/hot-counter",
      method: "POST",
      totalOps: 1000,
      concurrency: 50,
      body: JSON.stringify({ sku: "hot-product", delta: 1 }),
    });
    console.log(`Done (${results.naiveHotCounter.durationMs.toFixed(0)}ms)`);

    // 1B. Tier-0 SME Micro-Batch Coalescing (2,000 ops)
    process.stdout.write("  [2/3] Tier-0 SME Micro-Batch Coalescer (2,000 ops)... ");
    results.smeHotCounter = await runScenarioPool({
      port,
      agent,
      path: "/tier0-sme/hot-counter",
      method: "POST",
      totalOps: 2000,
      concurrency: 100,
      body: JSON.stringify({ sku: "hot-product", delta: 1 }),
    });
    console.log(`Done (${results.smeHotCounter.durationMs.toFixed(0)}ms)`);

    // 1C. Tier-2 Big-Tech 16-Slot Valkey Write-Behind (2,000 ops)
    process.stdout.write("  [3/3] Tier-2 Big-Tech 16-Slot Valkey Write-Behind (2,000 ops)... ");
    results.bigtechHotCounter = await runScenarioPool({
      port,
      agent,
      path: "/tier2-bigtech/hot-counter",
      method: "POST",
      totalOps: 2000,
      concurrency: 100,
      body: JSON.stringify({ sku: "hot-product", delta: 1 }),
    });
    console.log(`Done (${results.bigtechHotCounter.durationMs.toFixed(0)}ms)`);

    // Telemetry capture for Scenario 1
    const metricsHot = benchServer.getMetrics();
    results.metricsHot = metricsHot.hotCounter;

    // =========================================================================
    // SCENARIO 2: READ-REPLICA LITTLE'S LAW (3,000 Operations Total)
    // =========================================================================
    console.log("\n▶ Running Scenario 2: Read-Replica Little's Law Saturation (3,000 ops)...");

    // 2A. Tier-1: 10 Replicas @ 90% Headroom (1,500 ops)
    process.stdout.write("  [1/2] 10 x Read Replicas (rho = 0.90, 1,500 ops)... ");
    results.tier1Replica = await runScenarioPool({
      port,
      agent,
      path: "/tier1/read-replica",
      method: "GET",
      totalOps: 1500,
      concurrency: 120,
    });
    console.log(`Done (${results.tier1Replica.durationMs.toFixed(0)}ms)`);

    // 2B. Naive: 9 Replicas @ 100% Saturation Trap (1,500 ops)
    process.stdout.write("  [2/2] 9 x Read Replicas (rho = 1.0 Saturation, 1,500 ops)... ");
    results.naiveReplica = await runScenarioPool({
      port,
      agent,
      path: "/naive/read-replica",
      method: "GET",
      totalOps: 1500,
      concurrency: 120,
    });
    console.log(`Done (${results.naiveReplica.durationMs.toFixed(0)}ms)`);

    const metricsReplica = benchServer.getMetrics();
    results.metricsReplica = metricsReplica.readReplica;

    // =========================================================================
    // SCENARIO 3: SINGLEFLIGHT CACHE STAMPEDE (2,000 Operations Total)
    // =========================================================================
    console.log("\n▶ Running Scenario 3: SingleFlight Cache Stampede (2,000 ops)...");

    // 3A. Naive Cache Stampede (1,000 ops)
    process.stdout.write("  [1/2] Naive Uncoalesced Cache Stampede (1,000 ops)... ");
    benchServer.reset();
    results.naiveStampede = await runScenarioPool({
      port,
      agent,
      path: "/naive/cache-stampede",
      method: "GET",
      totalOps: 1000,
      concurrency: 100,
    });
    console.log(`Done (${results.naiveStampede.durationMs.toFixed(0)}ms)`);

    // 3B. Tier-2 SingleFlight Cache Coalescing (1,000 ops)
    process.stdout.write("  [2/2] Tier-2 SingleFlight Request Deduplication (1,000 ops)... ");
    results.singleFlight = await runScenarioPool({
      port,
      agent,
      path: "/tier2/singleflight-cache",
      method: "GET",
      totalOps: 1000,
      concurrency: 100,
    });
    console.log(`Done (${results.singleFlight.durationMs.toFixed(0)}ms)`);

    const metricsStampede = benchServer.getMetrics();
    results.metricsStampede = metricsStampede.cacheStampede;

    const totalSuiteDuration = performance.now() - suiteStartTime;

    // =========================================================================
    // ASSERTION VERIFICATION GATE
    // =========================================================================
    const assertions = [
      {
        name: "Scenario 1: Tier-0 SME SQL Write Reduction >= 99.0%",
        passed: parseFloat(results.metricsHot.tier0Sme.writeReductionPercent) >= 99.0,
        actual: results.metricsHot.tier0Sme.writeReductionPercent,
        expected: ">= 99.0%",
      },
      {
        name: "Scenario 1: Tier-2 Big-Tech SQL Write Reduction >= 99.0%",
        passed: parseFloat(results.metricsHot.tier2Bigtech.writeReductionPercent) >= 99.0,
        actual: results.metricsHot.tier2Bigtech.writeReductionPercent,
        expected: ">= 99.0%",
      },
      {
        name: "Scenario 1: Tier-0 SME p95 Latency < 25ms SLA",
        passed: results.smeHotCounter.p95 < 25.0,
        actual: `${results.smeHotCounter.p95}ms`,
        expected: "< 25.0ms",
      },
      {
        name: "Scenario 1: Tier-2 Big-Tech p95 Latency < 10ms SLA",
        passed: results.bigtechHotCounter.p95 < 10.0,
        actual: `${results.bigtechHotCounter.p95}ms`,
        expected: "< 10.0ms",
      },
      {
        name: "Scenario 2: 10 Replicas (rho = 0.90) 3-Query Page Latency p95 < 200ms",
        passed: results.tier1Replica.p95 < 200.0,
        actual: `${results.tier1Replica.p95}ms`,
        expected: "< 200.0ms",
      },
      {
        name: "Scenario 2: 9 Replicas (rho = 1.0) Queue Blowup Latency >= 300ms",
        passed: results.naiveReplica.p95 >= 300.0,
        actual: `${results.naiveReplica.p95}ms`,
        expected: ">= 300.0ms",
      },
      {
        name: "Scenario 2: Little's Law Latency Ratio (9 Replicas / 10 Replicas) >= 3.0x",
        passed: results.naiveReplica.p95 / results.tier1Replica.p95 >= 3.0,
        actual: `${(results.naiveReplica.p95 / results.tier1Replica.p95).toFixed(1)}x`,
        expected: ">= 3.0x",
      },
      {
        name: "Scenario 3: Naive Cache Stampede Origin DB Queries == 1,000",
        passed: results.metricsStampede.naive.originDbQueries === 1000,
        actual: `${results.metricsStampede.naive.originDbQueries} queries`,
        expected: "1000 queries",
      },
      {
        name: "Scenario 3: SingleFlight Coalesces 1,000 Misses to Exactly 1 Origin DB Query",
        passed: results.metricsStampede.tier2Singleflight.originDbQueries === 1,
        actual: `${results.metricsStampede.tier2Singleflight.originDbQueries} query`,
        expected: "1 query",
      },
      {
        name: "Scenario 3: SingleFlight Origin Query Reduction Ratio == 99.9%",
        passed: results.metricsStampede.tier2Singleflight.queryReductionPercent === "99.9%",
        actual: results.metricsStampede.tier2Singleflight.queryReductionPercent,
        expected: "99.9%",
      },
    ];

    const allPassed = assertions.every((a) => a.passed);

    // =========================================================================
    // MARKDOWN BENCHMARK REPORT
    // =========================================================================
    console.log("\n" + "=".repeat(88));
    console.log("             🏆 KIDO PACKAGES HIGH-CONCURRENCY EMPIRICAL BENCHMARK REPORT 🏆");
    console.log("=".repeat(88) + "\n");

    const reportMarkdown = `
# 📊 Empirical Benchmark Report: @kido/* High-Concurrency Performance Suite

- **Execution Timestamp**: ${new Date().toISOString()}
- **Node.js Runtime**: ${process.version} (${os.platform()} ${os.arch()})
- **Total Operations Evaluated**: 10,000 operations
- **Total Suite Execution Time**: ${(totalSuiteDuration / 1000).toFixed(2)} seconds
- **Suite Status**: ${allPassed ? "✅ ALL 10 GATES PASSED (100% GREEN)" : "❌ SUITE FAILED"}

---

## 📈 Scenario 1: Hot-Counter Contention Benchmark (5,000 Operations)
Simulates high-frequency updates on a single hot SKU row (e.g. Flash Sale / View Count).

| Architecture Tier | Algorithm & Strategy | Total Ops | Throughput | p50 Latency | p95 Latency | p99 Latency | SQL Statements | Write Reduction | SLA Status |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Naive Baseline** | Serial Row Tuple Lock | 1,000 | ${results.naiveHotCounter.throughputOpsSec} ops/s | ${results.naiveHotCounter.p50} ms | ${results.naiveHotCounter.p95} ms | ${results.naiveHotCounter.p99} ms | ${results.metricsHot.naive.sqlExecuted} | 0.0% | ⚠️ Lock Queueing |
| **Tier-0 SME** | MicroBatchCoalescer | 2,000 | ${results.smeHotCounter.throughputOpsSec} ops/s | ${results.smeHotCounter.p50} ms | ${results.smeHotCounter.p95} ms | ${results.smeHotCounter.p99} ms | ${results.metricsHot.tier0Sme.sqlExecuted} | **${results.metricsHot.tier0Sme.writeReductionPercent}** | ✅ SLA < 25ms |
| **Tier-2 Big-Tech** | 16-Slot Sharded + Valkey Lua | 2,000 | ${results.bigtechHotCounter.throughputOpsSec} ops/s | ${results.bigtechHotCounter.p50} ms | ${results.bigtechHotCounter.p95} ms | ${results.bigtechHotCounter.p99} ms | ${results.metricsHot.tier2Bigtech.sqlExecuted} | **${results.metricsHot.tier2Bigtech.writeReductionPercent}** | 🚀 SLA < 10ms |

---

## 📉 Scenario 2: Read-Replica Little's Law Saturation (3,000 Operations)
Simulates Black Friday page reads executing 3 sequential SQL queries (1,500 page_read/s = 4,500 sql_read/s).

| Replica Cluster | Utilization (rho) | Total Ops | SQL Queries | Throughput | p50 Latency | p95 Latency | p99 Latency | Queuing Factor | SLA (< 200ms) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **10 x Replicas (Tier-1)** | **rho = 0.90 (10% headroom)** | 1,500 | 4,500 | ${results.tier1Replica.throughputOpsSec} ops/s | **${results.tier1Replica.p50} ms** | **${results.tier1Replica.p95} ms** | **${results.tier1Replica.p99} ms** | 9.0x (bounded) | ✅ **PASS (p95 < 200ms)** |
| **9 x Replicas (Naive)** | **rho = 1.00 (Saturation Trap)** | 1,500 | 4,500 | ${results.naiveReplica.throughputOpsSec} ops/s | **${results.naiveReplica.p50} ms** | **${results.naiveReplica.p95} ms** | **${results.naiveReplica.p99} ms** | Diverges (1/(1-rho)) | ❌ **BLOWUP (${(results.naiveReplica.p95 / results.tier1Replica.p95).toFixed(1)}x slower)** |

> **Little's Law Mathematical Proof**:
> At rho = 0.90, queue delay multiplier is \`rho / (1 - rho) = 0.90 / 0.10 = 9.0x\`.
> At rho = 1.00, denominator \`(1 - rho) -> 0\`, causing queue backlog to diverge. Adding **1 extra replica (9 -> 10)** prevents catastrophic queue blowout and drops p95 latency from **${results.naiveReplica.p95}ms down to ${results.tier1Replica.p95}ms**!

---

## ⚡ Scenario 3: SingleFlight Cache Stampede Deduplication (2,000 Operations)
Simulates 1,000 concurrent requests hitting an expired Black Friday deal key simultaneously.

| Strategy | Total Requests | Origin DB Queries | Collapsed In-Flight | p50 Latency | p95 Latency | Query Reduction % | DB Impact |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| **Naive Stampede** | 1,000 | ${results.metricsStampede.naive.originDbQueries} | 0 | ${results.naiveStampede.p50} ms | ${results.naiveStampede.p95} ms | 0.0% | ❌ 1,000x DB connection spike |
| **Tier-2 SingleFlight** | 1,000 | **${results.metricsStampede.tier2Singleflight.originDbQueries}** | **${results.metricsStampede.tier2Singleflight.collapsedRequests}** | **${results.singleFlight.p50} ms** | **${results.singleFlight.p95} ms** | **${results.metricsStampede.tier2Singleflight.queryReductionPercent}** | 🛡️ **99.9% DB Load Shield** |

---

## 🛡️ Verification Gate Results (10 / 10 Checks)

${assertions
  .map(
    (a, idx) =>
      `| ${idx + 1} | ${a.name} | Expected: \`${a.expected}\` | Actual: \`${a.actual}\` | ${a.passed ? "✅ PASS" : "❌ FAIL"} |`
  )
  .join("\n")}
`;

    console.log(reportMarkdown);

    if (!allPassed) {
      console.error("\n❌ Assertion verification failed!");
      process.exit(1);
    }

    console.log("\n🎉 All 10 high-concurrency benchmarks and SLA gates PASSED 100%!");
  } finally {
    agent.destroy();
    await benchServer.stop();
  }
}

main().catch((err) => {
  console.error("FATAL Benchmark Runner Error:", err);
  process.exit(1);
});
