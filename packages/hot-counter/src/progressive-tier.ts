/**
 * @file progressive-tier.ts
 * @description 3-Tier Progressive Scale Architecture for Counter Workloads
 *
 * Architecture Evolution:
 * 1. Naive Baseline: Direct `UPDATE table SET counter = counter + 1 WHERE id = $1`
 *    - Bottleneck: Extreme row-level lock contention, MVCC dead tuples, connection pool exhaustion.
 * 2. Tier-0 SME Zero-Infra (`Tier0SmeCounter`):
 *    - Zero-dependency in-process Map<string, number> accumulator + single-statement SQLite/PostgreSQL
 *      `INSERT ... ON CONFLICT DO UPDATE` batch flusher.
 *    - Designed for $5/mo single-VPS SME workloads (< 2,000 writes/sec, $0 Redis/Kafka cost).
 * 3. Tier-1 Growth (`SlottedCounter`):
 *    - 16-slot sharded row counters in PostgreSQL with MurmurHash3 % 16 and SKIP LOCKED fallback.
 *    - 16x concurrency multiplier for strict zero-loss audit compliance without external cache.
 * 4. Tier-2 Big-Tech (`ValkeyWriteBehindCounter`):
 *    - Distributed Valkey HINCRBY + Atomic Lua Drain (`LUA_ATOMIC_DRAIN_HASH`) and Bounded Stock Gate.
 *    - Scale: 100,000+ writes/sec across multi-container clusters (Shopee, Uber, Discord).
 */

import { MicroBatchCoalescer } from "./micro-batch-coalescer";
import { SlottedCounter, SlottedCounterOptions } from "./slotted-counter";
import {
  ValkeyWriteBehindCounter,
  ValkeyWriteBehindOptions,
  ValkeyClientLike,
} from "./valkey-write-behind";

export type CounterTier = "naive" | "tier0-sme" | "tier1-growth" | "tier2-bigtech";

export type SqlDialect = "postgres" | "sqlite";

export interface Tier0SmeCounterOptions {
  tableName?: string;
  idColumn?: string;
  valueColumn?: string;
  updatedAtColumn?: string;
  dialect?: SqlDialect;
  flushIntervalMs?: number;
  maxBatchSize?: number;
  autoStart?: boolean;
  dbExecutor?: (sql: string, params: (string | number)[]) => Promise<void> | void;
}

export interface Tier0FlushResult {
  flushedRows: number;
  zeroNetDropped: number;
  inputEventsInBatch: number;
  sqlStatementsSaved: number;
  sql: string;
  params: (string | number)[];
  executionTimeMs: number;
  reductionPercent: string;
  batchesExecuted: number;
}

export interface Tier0SmeCounterStats {
  totalInputEvents: number;
  totalFlushedRows: number;
  totalZeroNetDropped: number;
  totalFlushes: number;
  pendingKeys: number;
  sqlStatementsSaved: number;
  reductionPercent: string;
}

/**
 * Tier-0 SME Zero-Infra Counter
 *
 * Uses an in-memory Map<string, number> accumulator combined with single-statement
 * `INSERT ... ON CONFLICT DO UPDATE` (UPSERT) batch writes for PostgreSQL or SQLite.
 *
 * Invariants:
 * 1. Zero External Infrastructure: $0 cloud bill, works seamlessly on a $5/mo VPS.
 * 2. Zero Lost Updates: If the DB executor fails, dirty deltas are merged back into the live Map.
 * 3. Net-Zero Elimination: Opposite mutations (+5 then -5) cancel out in RAM before hitting disk.
 */
export class Tier0SmeCounter {
  private readonly tableName: string;
  private readonly idColumn: string;
  private readonly valueColumn: string;
  private readonly updatedAtColumn?: string;
  private readonly dialect: SqlDialect;
  private readonly flushIntervalMs: number;
  private readonly maxBatchSize: number;
  private readonly dbExecutor?: (
    sql: string,
    params: (string | number)[]
  ) => Promise<void> | void;

  private pendingDeltas = new Map<string, number>();
  private inputEventsSinceLastFlush = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  // Lifetime Telemetry
  private totalInputEvents = 0;
  private totalFlushedRows = 0;
  private totalZeroNetDropped = 0;
  private totalFlushes = 0;
  private totalSqlStatementsSaved = 0;

  constructor(options: Tier0SmeCounterOptions = {}) {
    this.tableName = options.tableName ?? "sme_counters";
    this.idColumn = options.idColumn ?? "id";
    this.valueColumn = options.valueColumn ?? "value";
    this.updatedAtColumn = options.updatedAtColumn;
    this.dialect = options.dialect ?? "postgres";
    this.flushIntervalMs = options.flushIntervalMs ?? 1000;
    this.maxBatchSize = options.maxBatchSize ?? 500;
    this.dbExecutor = options.dbExecutor;

    if (options.autoStart) {
      this.start();
    }
  }

  public record(key: string, delta: number = 1): void {
    if (!key || typeof delta !== "number" || isNaN(delta)) {
      return;
    }
    const current = this.pendingDeltas.get(key) ?? 0;
    this.pendingDeltas.set(key, current + delta);
    this.totalInputEvents++;
    this.inputEventsSinceLastFlush++;
  }

  public recordBatch(
    entries: Array<{ key: string; delta: number }> | Record<string, number>
  ): void {
    if (Array.isArray(entries)) {
      for (const entry of entries) {
        this.record(entry.key, entry.delta);
      }
    } else if (entries && typeof entries === "object") {
      for (const [key, delta] of Object.entries(entries)) {
        this.record(key, delta);
      }
    }
  }

  public start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.flush().catch((err) => {
        // Uncaught async flush errors are safely contained
        console.error("[Tier0SmeCounter] Auto-flush error:", err);
      });
    }, this.flushIntervalMs);
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  public generateBatchUpsertSql(entries: Array<[string, number]>): {
    sql: string;
    params: (string | number)[];
  } {
    if (entries.length === 0) {
      return { sql: "", params: [] };
    }

    const table = `"${this.tableName}"`;
    const idCol = `"${this.idColumn}"`;
    const valCol = `"${this.valueColumn}"`;
    const hasUpdatedAt = Boolean(this.updatedAtColumn);
    const updatedCol = hasUpdatedAt ? `"${this.updatedAtColumn}"` : "";

    const params: (string | number)[] = [];
    const valueTuples: string[] = [];

    if (this.dialect === "postgres") {
      let paramIndex = 1;
      for (const [key, delta] of entries) {
        params.push(key, delta);
        if (hasUpdatedAt) {
          valueTuples.push(`($${paramIndex}, $${paramIndex + 1}, NOW())`);
        } else {
          valueTuples.push(`($${paramIndex}, $${paramIndex + 1})`);
        }
        paramIndex += 2;
      }

      const cols = hasUpdatedAt
        ? `${idCol}, ${valCol}, ${updatedCol}`
        : `${idCol}, ${valCol}`;

      const updateSet = hasUpdatedAt
        ? `${valCol} = ${table}.${valCol} + EXCLUDED.${valCol}, ${updatedCol} = NOW()`
        : `${valCol} = ${table}.${valCol} + EXCLUDED.${valCol}`;

      const sql = `INSERT INTO ${table} (${cols}) VALUES ${valueTuples.join(
        ", "
      )} ON CONFLICT (${idCol}) DO UPDATE SET ${updateSet};`;

      return { sql, params };
    } else {
      // SQLite syntax: ? placeholders and excluded."value"
      for (const [key, delta] of entries) {
        params.push(key, delta);
        if (hasUpdatedAt) {
          valueTuples.push(`(?, ?, CURRENT_TIMESTAMP)`);
        } else {
          valueTuples.push(`(?, ?)`);
        }
      }

      const cols = hasUpdatedAt
        ? `${idCol}, ${valCol}, ${updatedCol}`
        : `${idCol}, ${valCol}`;

      const updateSet = hasUpdatedAt
        ? `${valCol} = ${table}.${valCol} + excluded.${valCol}, ${updatedCol} = CURRENT_TIMESTAMP`
        : `${valCol} = ${table}.${valCol} + excluded.${valCol}`;

      const sql = `INSERT INTO ${table} (${cols}) VALUES ${valueTuples.join(
        ", "
      )} ON CONFLICT (${idCol}) DO UPDATE SET ${updateSet};`;

      return { sql, params };
    }
  }

  public async flush(): Promise<Tier0FlushResult> {
    const startTime = performance.now();
    const snapshot = this.pendingDeltas;
    const inputEvents = this.inputEventsSinceLastFlush;

    // Reset pending buffer atomically in RAM
    this.pendingDeltas = new Map<string, number>();
    this.inputEventsSinceLastFlush = 0;

    // 1. Filter out net-zero accumulated mutations
    const activeEntries: Array<[string, number]> = [];
    let zeroNetDropped = 0;

    for (const [key, delta] of snapshot.entries()) {
      if (delta === 0) {
        zeroNetDropped++;
      } else {
        activeEntries.push([key, delta]);
      }
    }

    if (activeEntries.length === 0) {
      this.totalZeroNetDropped += zeroNetDropped;
      return {
        flushedRows: 0,
        zeroNetDropped,
        inputEventsInBatch: inputEvents,
        sqlStatementsSaved: Math.max(0, inputEvents),
        sql: "",
        params: [],
        executionTimeMs: performance.now() - startTime,
        reductionPercent: inputEvents > 0 ? "100.00%" : "0.00%",
        batchesExecuted: 0,
      };
    }

    // 2. Chunk entries by maxBatchSize
    const batches: Array<Array<[string, number]>> = [];
    for (let i = 0; i < activeEntries.length; i += this.maxBatchSize) {
      batches.push(activeEntries.slice(i, i + this.maxBatchSize));
    }

    let lastSql = "";
    let lastParams: (string | number)[] = [];

    try {
      for (const batch of batches) {
        const { sql, params } = this.generateBatchUpsertSql(batch);
        lastSql = sql;
        lastParams = params;
        if (this.dbExecutor) {
          await this.dbExecutor(sql, params);
        }
      }
    } catch (err) {
      // Invariant: ZERO LOST UPDATES
      // Restore snapshot back into the live Map
      for (const [key, delta] of snapshot.entries()) {
        const currentLive = this.pendingDeltas.get(key) ?? 0;
        this.pendingDeltas.set(key, currentLive + delta);
      }
      this.inputEventsSinceLastFlush += inputEvents;
      throw err;
    }

    const flushedRows = activeEntries.length;
    const statementsSaved = Math.max(0, inputEvents - batches.length);
    const reductionPercent =
      inputEvents > 0
        ? `${((statementsSaved / inputEvents) * 100).toFixed(2)}%`
        : "0.00%";

    this.totalFlushedRows += flushedRows;
    this.totalZeroNetDropped += zeroNetDropped;
    this.totalSqlStatementsSaved += statementsSaved;
    this.totalFlushes++;

    return {
      flushedRows,
      zeroNetDropped,
      inputEventsInBatch: inputEvents,
      sqlStatementsSaved: statementsSaved,
      sql: lastSql,
      params: lastParams,
      executionTimeMs: performance.now() - startTime,
      reductionPercent,
      batchesExecuted: batches.length,
    };
  }

  public getPendingCount(): number {
    return this.pendingDeltas.size;
  }

  public getPendingDelta(key: string): number {
    return this.pendingDeltas.get(key) ?? 0;
  }

  public getPendingDeltas(): Map<string, number> {
    return new Map(this.pendingDeltas);
  }

  public getStats(): Tier0SmeCounterStats {
    const totalEvents = this.totalInputEvents;
    const statementsSaved = this.totalSqlStatementsSaved;
    const reductionPercent =
      totalEvents > 0
        ? `${((statementsSaved / totalEvents) * 100).toFixed(2)}%`
        : "0.00%";

    return {
      totalInputEvents: this.totalInputEvents,
      totalFlushedRows: this.totalFlushedRows,
      totalZeroNetDropped: this.totalZeroNetDropped,
      totalFlushes: this.totalFlushes,
      pendingKeys: this.pendingDeltas.size,
      sqlStatementsSaved: this.totalSqlStatementsSaved,
      reductionPercent,
    };
  }

  public clear(): void {
    this.pendingDeltas.clear();
    this.inputEventsSinceLastFlush = 0;
  }
}

/**
 * Naive Row Lock Contention Simulator
 *
 * Empirically simulates the naive approach:
 * `UPDATE posts SET likes = likes + 1 WHERE id = $1`
 *
 * Demonstrates:
 * 1. Row-level mutex serial queueing: N concurrent writes to the same row wait in line.
 * 2. Connection pool starvation: With pool size M < N, threads starve waiting for a connection.
 * 3. Latency explosion: Average and P95/P99 latency scales linearly with request volume.
 */
export interface NaiveRowLockSimulatorOptions {
  connectionPoolSize?: number;
  rowLockHoldTimeMs?: number;
  connectionAcquisitionTimeoutMs?: number;
}

export interface NaiveSimulationResult {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  maxLatencyMs: number;
  totalDurationMs: number;
  throughputOpsSec: number;
  contentionFactor: number;
}

export class NaiveRowLockSimulator {
  private readonly connectionPoolSize: number;
  private readonly rowLockHoldTimeMs: number;
  private readonly connectionTimeoutMs: number;

  private availableConnections: number;
  private connectionWaiters: Array<() => void> = [];
  private rowLocks = new Map<string, Promise<void>>();

  constructor(options: NaiveRowLockSimulatorOptions = {}) {
    this.connectionPoolSize = options.connectionPoolSize ?? 10;
    this.rowLockHoldTimeMs = options.rowLockHoldTimeMs ?? 2;
    this.connectionTimeoutMs = options.connectionAcquisitionTimeoutMs ?? 2000;
    this.availableConnections = this.connectionPoolSize;
  }

  private async acquireConnection(): Promise<boolean> {
    if (this.availableConnections > 0) {
      this.availableConnections--;
      return true;
    }

    return new Promise<boolean>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;

      const onAcquired = () => {
        if (timer) clearTimeout(timer);
        resolve(true);
      };

      timer = setTimeout(() => {
        const idx = this.connectionWaiters.indexOf(onAcquired);
        if (idx !== -1) {
          this.connectionWaiters.splice(idx, 1);
        }
        resolve(false);
      }, this.connectionTimeoutMs);

      this.connectionWaiters.push(onAcquired);
    });
  }

  private releaseConnection(): void {
    if (this.connectionWaiters.length > 0) {
      const next = this.connectionWaiters.shift()!;
      next();
    } else {
      this.availableConnections++;
    }
  }

  public async executeIncrement(
    key: string,
    delta: number = 1
  ): Promise<{ success: boolean; latencyMs: number; lockWaitMs: number; error?: string }> {
    const start = performance.now();

    // 1. Acquire DB connection from pool
    const hasConn = await this.acquireConnection();
    if (!hasConn) {
      return {
        success: false,
        latencyMs: performance.now() - start,
        lockWaitMs: 0,
        error: "Connection pool timeout (App Server slot starvation)",
      };
    }

    const waitStart = performance.now();

    try {
      // 2. Acquire row-level lock (serial execution for identical row key)
      const currentLock = this.rowLocks.get(key) ?? Promise.resolve();

      let releaseLock!: () => void;
      const nextLock = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
      this.rowLocks.set(key, nextLock);

      await currentLock;
      const lockWaitMs = performance.now() - waitStart;

      // 3. Simulate row lock hold time (SQL execution + WAL write + commit)
      await new Promise((resolve) => setTimeout(resolve, this.rowLockHoldTimeMs));

      releaseLock();
      return {
        success: true,
        latencyMs: performance.now() - start,
        lockWaitMs,
      };
    } finally {
      this.releaseConnection();
    }
  }

  public async simulateLoad(
    concurrentRequests: number,
    key: string = "hot_post_100"
  ): Promise<NaiveSimulationResult> {
    const overallStart = performance.now();
    const promises: Array<Promise<{ success: boolean; latencyMs: number }>> = [];

    for (let i = 0; i < concurrentRequests; i++) {
      promises.push(this.executeIncrement(key));
    }

    const results = await Promise.all(promises);
    const totalDurationMs = performance.now() - overallStart;

    const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
    const successful = results.filter((r) => r.success).length;
    const failed = results.length - successful;

    const sum = latencies.reduce((acc, l) => acc + l, 0);
    const avgLatencyMs = sum / (latencies.length || 1);
    const p50LatencyMs = latencies[Math.floor(latencies.length * 0.5)] ?? 0;
    const p95LatencyMs = latencies[Math.floor(latencies.length * 0.95)] ?? 0;
    const p99LatencyMs = latencies[Math.floor(latencies.length * 0.99)] ?? 0;
    const maxLatencyMs = latencies[latencies.length - 1] ?? 0;

    const throughputOpsSec =
      totalDurationMs > 0 ? (successful / (totalDurationMs / 1000)) : 0;

    // Contention factor: ratio of p95 latency to baseline single-request hold time
    const contentionFactor =
      this.rowLockHoldTimeMs > 0 ? p95LatencyMs / this.rowLockHoldTimeMs : 1;

    return {
      totalRequests: concurrentRequests,
      successfulRequests: successful,
      failedRequests: failed,
      avgLatencyMs: Math.round(avgLatencyMs * 100) / 100,
      p50LatencyMs: Math.round(p50LatencyMs * 100) / 100,
      p95LatencyMs: Math.round(p95LatencyMs * 100) / 100,
      p99LatencyMs: Math.round(p99LatencyMs * 100) / 100,
      maxLatencyMs: Math.round(maxLatencyMs * 100) / 100,
      totalDurationMs: Math.round(totalDurationMs * 100) / 100,
      throughputOpsSec: Math.round(throughputOpsSec * 10) / 10,
      contentionFactor: Math.round(contentionFactor * 10) / 10,
    };
  }
}

/**
 * Tier Recommendation Advisor
 */
export interface CounterTierRecommendation {
  tier: CounterTier;
  tierName: string;
  reason: string;
  estimatedMonthlyCostUsd: number;
  writeCapacityOpsPerSec: number;
  recommendedClass: string;
  tradeoffs: {
    pros: string[];
    cons: string[];
  };
}

export interface RecommendCounterTierInput {
  peakWritesPerSec: number;
  hasRedisOrValkey?: boolean;
  strictZeroLoss?: boolean;
  monthlyBudgetUsd?: number;
  singleVps?: boolean;
}

export function recommendCounterTier(
  input: RecommendCounterTierInput
): CounterTierRecommendation {
  const {
    peakWritesPerSec,
    hasRedisOrValkey = false,
    strictZeroLoss = false,
    monthlyBudgetUsd = 20,
    singleVps = false,
  } = input;

  // Level 1: Trivial writes and zero budget
  if (peakWritesPerSec <= 30 && monthlyBudgetUsd === 0) {
    return {
      tier: "naive",
      tierName: "Naive Direct Row Update",
      reason:
        "Peak traffic is negligible (< 30 writes/sec). Direct DB UPDATE is simple, but will fail under sudden bursts.",
      estimatedMonthlyCostUsd: 0,
      writeCapacityOpsPerSec: 50,
      recommendedClass: "NaiveRowLockSimulator",
      tradeoffs: {
        pros: ["Zero setup overhead", "Immediate read-your-own-writes"],
        cons: [
          "Row lock contention under bursts",
          "MVCC table bloat from dead tuples",
        ],
      },
    };
  }

  // Tier 1: Growth with strict zero loss / compliance direct to DB (or peak writes > 2,000 without Redis)
  if (strictZeroLoss && peakWritesPerSec <= 20000) {
    return {
      tier: "tier1-growth",
      tierName: "Tier-1 Growth 16-Slot Sharded Counter",
      reason:
        "Strict zero-loss compliance requires immediate direct-to-database writes without memory buffer risk. 16-Slot Counter splits tuple locks across 16 rows (16x multiplier) with SKIP LOCKED inventory fallback.",
      estimatedMonthlyCostUsd: 40,
      writeCapacityOpsPerSec: 15000,
      recommendedClass: "SlottedCounter",
      tradeoffs: {
        pros: [
          "Synchronous direct-to-PostgreSQL persistence",
          "16x concurrency multiplier on hot rows",
          "Anti-oversell flash sale inventory protection via SKIP LOCKED",
          "Sub-millisecond composite index aggregation",
        ],
        cons: [
          "Requires 16 physical rows per logical entity",
          "Read query requires SUM(value) aggregation over 16 slot rows",
        ],
      },
    };
  }

  // Tier 0: SME Zero-Infra (< 2,000 writes/sec, low budget, single VPS, or no Redis)
  if (
    peakWritesPerSec <= 2000 ||
    singleVps ||
    monthlyBudgetUsd < 15 ||
    (!hasRedisOrValkey && peakWritesPerSec <= 5000)
  ) {
    return {
      tier: "tier0-sme",
      tierName: "Tier-0 SME Zero-Infra Micro-Batcher",
      reason:
        "Workload fits within single-VPS capacity (< 2,000 writes/sec). In-memory Map accumulator + single SQL UPSERT provides 99.9% write reduction for $0 extra infrastructure cost.",
      estimatedMonthlyCostUsd: 5,
      writeCapacityOpsPerSec: 2500,
      recommendedClass: "Tier0SmeCounter",
      tradeoffs: {
        pros: [
          "Zero external dependencies (no Redis/Kafka needed)",
          "Runs smoothly on $5/mo VPS",
          "UPSERT automatically handles missing counter rows",
          "Re-merges uncommitted deltas on failure (Zero Lost Updates)",
        ],
        cons: [
          "Counts are buffered in process RAM until flush interval (e.g. 1s)",
          "Cannot coordinate across multiple stateless API instances without shared state",
        ],
      },
    };
  }

  // Tier 2: Big-Tech High Concurrency Distributed Write-Behind
  return {
    tier: "tier2-bigtech",
    tierName: "Tier-2 Big-Tech Valkey Write-Behind",
    reason:
      "High write velocity (> 20,000 writes/sec) and multi-container cluster. Valkey HINCRBY + Atomic Lua Drain delivers sub-millisecond O(1) mutations and 100k+ ops/sec throughput.",
    estimatedMonthlyCostUsd: 120,
    writeCapacityOpsPerSec: 100000,
    recommendedClass: "ValkeyWriteBehindCounter",
    tradeoffs: {
      pros: [
        "100,000+ ops/sec distributed throughput",
        "Atomic Lua drain eliminates race-condition wipe-outs",
        "Sub-millisecond API response latency",
        "Rollback restoration on DB failure",
      ],
      cons: [
        "Requires Valkey/Redis instance in infra topology",
        "Asynchronous eventual consistency down to database",
      ],
    },
  };
}

/**
 * Unified Progressive Hot Counter Factory
 */
export interface ProgressiveHotCounterConfig {
  tier: CounterTier;
  tier0Options?: Tier0SmeCounterOptions;
  tier1Options?: SlottedCounterOptions;
  tier2Options?: ValkeyWriteBehindOptions;
  valkeyClient?: ValkeyClientLike;
  naiveOptions?: NaiveRowLockSimulatorOptions;
}

export function createProgressiveHotCounter(config: ProgressiveHotCounterConfig): {
  tier: CounterTier;
  instance:
    | Tier0SmeCounter
    | SlottedCounter
    | ValkeyWriteBehindCounter
    | NaiveRowLockSimulator;
} {
  switch (config.tier) {
    case "naive":
      return {
        tier: "naive",
        instance: new NaiveRowLockSimulator(config.naiveOptions),
      };

    case "tier0-sme":
      return {
        tier: "tier0-sme",
        instance: new Tier0SmeCounter(config.tier0Options),
      };

    case "tier1-growth":
      return {
        tier: "tier1-growth",
        instance: new SlottedCounter(config.tier1Options),
      };

    case "tier2-bigtech":
      return {
        tier: "tier2-bigtech",
        instance: new ValkeyWriteBehindCounter({
          ...config.tier2Options,
          client: config.valkeyClient ?? config.tier2Options?.client,
        }),
      };

    default:
      throw new Error(`Unsupported counter tier: ${config.tier}`);
  }
}
