/**
 * @file micro-batch-coalescer.ts
 * @description Pattern #1: In-Memory Write Coalescing & Micro-Batching Accumulator
 *
 * Problem:
 * 1,000 concurrent increment events updating the same hot row (e.g. product 'marker-60' or
 * multi-channel Shopee/TikTok/POS sold_count) serialize on a single PostgreSQL row tuple lock,
 * creating 1,000 transaction commits, 1,000 WAL write operations, and 1,000 MVCC dead tuples.
 *
 * Solution:
 * Coalesces delta increments in an in-memory Map<string, number> over a short window (e.g. 100ms - 2000ms),
 * discards net-zero mutations (e.g. +5 then -5 in the same window = 0 DB writes), and emits a single,
 * parameterized PostgreSQL `UPDATE ... FROM (VALUES ...)` query updating all affected rows in ONE round-trip.
 *
 * Invariants:
 * 1. Zero Lost Updates: If a flush executor fails, uncommitted deltas are merged back into the live Map.
 * 2. SQL Injection Safety: All table names and column names are validated/quoted, values are parameterized ($1, $2, ...).
 * 3. 99.9% Write Reduction: Reduces 1,000 hot row updates to 1 single statement.
 */

export interface MicroBatchCoalescerOptions {
  tableName?: string;
  idColumn?: string;
  counterColumn?: string;
  updatedAtColumn?: string;
  flushIntervalMs?: number;
  maxDistinctKeys?: number;
}

export interface FlushResult {
  flushedRows: number;
  zeroNetDropped: number;
  inputEventsInBatch: number;
  sqlStatementsSaved: number;
  sql: string;
  params: (string | number)[];
  executionTimeMs: number;
  writeAmplificationReductionRatio: number;
  reductionPercent: string;
}

export interface CoalescerStats {
  totalInputEvents: number;
  totalFlushedRows: number;
  totalZeroNetDropped: number;
  pendingKeys: number;
  sqlStatementsSaved: number;
  writeAmplificationReductionRatio: number;
  reductionPercent: string;
}

export class MicroBatchCoalescer {
  private readonly tableName: string;
  private readonly idColumn: string;
  private readonly counterColumn: string;
  private readonly updatedAtColumn: string;
  private readonly flushIntervalMs: number;
  private readonly maxDistinctKeys: number;

  private pendingDeltas = new Map<string, number>();
  private inputEventsSinceLastFlush = 0;

  // Lifetime Telemetry
  private totalInputEvents = 0;
  private totalFlushedRows = 0;
  private totalZeroNetDropped = 0;
  private totalSqlStatementsSaved = 0;

  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: MicroBatchCoalescerOptions = {}) {
    this.tableName = options.tableName ?? "store_products";
    this.idColumn = options.idColumn ?? "id";
    this.counterColumn = options.counterColumn ?? "sold_count";
    this.updatedAtColumn = options.updatedAtColumn ?? "updated_at";
    this.flushIntervalMs = options.flushIntervalMs ?? 1000;
    this.maxDistinctKeys = options.maxDistinctKeys ?? 500;
  }

  /**
   * Records a delta increment for a given entity key.
   * Runs in O(1) in-memory RAM.
   */
  public record(key: string, delta: number = 1): void {
    if (!key || typeof delta !== "number" || isNaN(delta)) {
      return;
    }
    const current = this.pendingDeltas.get(key) ?? 0;
    this.pendingDeltas.set(key, current + delta);
    this.totalInputEvents++;
    this.inputEventsSinceLastFlush++;
  }

  /**
   * Records a batch of entity deltas.
   */
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

  /**
   * Read-only inspection of currently pending uncoalesced deltas.
   */
  public peekPending(): ReadonlyMap<string, number> {
    return new Map(this.pendingDeltas);
  }

  /**
   * Count of distinct pending keys waiting to be flushed.
   */
  public getPendingCount(): number {
    return this.pendingDeltas.size;
  }

  /**
   * Constructs an injection-safe, parameterized Single-Statement PostgreSQL UPDATE
   * using the `FROM (VALUES ($1::text, $2::bigint), ...)` pattern.
   *
   * Drops any entry where net delta === 0.
   */
  public buildBatchUpdateSQL(
    deltas: Array<[string, number]> | Map<string, number> | Record<string, number>
  ): { sql: string; params: (string | number)[]; rowCount: number; zeroNetDropped: number } {
    const rawEntries: Array<[string, number]> =
      deltas instanceof Map
        ? Array.from(deltas.entries())
        : Array.isArray(deltas)
        ? deltas
        : Object.entries(deltas);

    const activeEntries: Array<[string, number]> = [];
    let zeroNetDropped = 0;

    for (const [key, delta] of rawEntries) {
      if (delta === 0) {
        zeroNetDropped++;
      } else {
        activeEntries.push([key, delta]);
      }
    }

    if (activeEntries.length === 0) {
      return {
        sql: "",
        params: [],
        rowCount: 0,
        zeroNetDropped,
      };
    }

    const valuePlaceholders: string[] = [];
    const params: (string | number)[] = [];

    activeEntries.forEach(([key, delta], index) => {
      const p1 = index * 2 + 1;
      const p2 = index * 2 + 2;
      valuePlaceholders.push(`($${p1}::text, $${p2}::bigint)`);
      params.push(key, delta);
    });

    // Sanitized quoted identifiers
    const safeTable = `"${this.tableName.replace(/"/g, '""')}"`;
    const safeId = `"${this.idColumn.replace(/"/g, '""')}"`;
    const safeCounter = `"${this.counterColumn.replace(/"/g, '""')}"`;
    const safeUpdatedAt = `"${this.updatedAtColumn.replace(/"/g, '""')}"`;

    const sql = [
      `UPDATE ${safeTable} AS t`,
      `SET ${safeCounter} = t.${safeCounter} + v.delta::bigint,`,
      `    ${safeUpdatedAt} = NOW()`,
      `FROM (VALUES ${valuePlaceholders.join(", ")}) AS v(id, delta)`,
      `WHERE t.${safeId} = v.id;`,
    ].join("\n");

    return {
      sql,
      params,
      rowCount: activeEntries.length,
      zeroNetDropped,
    };
  }

  /**
   * Drains the pending buffer and executes the coalesced single SQL statement.
   *
   * Invariant:
   * If `executor` throws a transient database error, all extracted deltas
   * are safely merged back into `this.pendingDeltas` so ZERO counts are lost!
   */
  public async flushNow(
    executor?: (sql: string, params: (string | number)[]) => Promise<any>
  ): Promise<FlushResult> {
    const startMs = Date.now();

    if (this.pendingDeltas.size === 0) {
      return {
        flushedRows: 0,
        zeroNetDropped: 0,
        inputEventsInBatch: 0,
        sqlStatementsSaved: 0,
        sql: "",
        params: [],
        executionTimeMs: 0,
        writeAmplificationReductionRatio: 0,
        reductionPercent: "0.0%",
      };
    }

    // Atomic snapshot and drain of in-memory buffer
    const snapshot = new Map(this.pendingDeltas);
    const inputCount = this.inputEventsSinceLastFlush;
    this.pendingDeltas.clear();
    this.inputEventsSinceLastFlush = 0;

    const { sql, params, rowCount, zeroNetDropped } = this.buildBatchUpdateSQL(snapshot);

    this.totalZeroNetDropped += zeroNetDropped;

    // If all entries cancelled out to 0 net delta
    if (rowCount === 0) {
      return {
        flushedRows: 0,
        zeroNetDropped,
        inputEventsInBatch: inputCount,
        sqlStatementsSaved: inputCount,
        sql: "",
        params: [],
        executionTimeMs: Date.now() - startMs,
        writeAmplificationReductionRatio: inputCount > 0 ? 1 : 0,
        reductionPercent: "100.0%",
      };
    }

    if (executor) {
      try {
        await executor(sql, params);
      } catch (error) {
        // Safe Re-Merge on Failure: merge snapshot deltas back into pendingDeltas
        for (const [key, delta] of snapshot.entries()) {
          const current = this.pendingDeltas.get(key) ?? 0;
          this.pendingDeltas.set(key, current + delta);
        }
        this.inputEventsSinceLastFlush += inputCount;
        throw error;
      }
    }

    this.totalFlushedRows += rowCount;
    const statementsSaved = Math.max(0, inputCount - 1);
    this.totalSqlStatementsSaved += statementsSaved;

    const reductionRatio = inputCount > 0 ? (inputCount - 1) / inputCount : 0;
    const reductionPercent = `${(reductionRatio * 100).toFixed(1)}%`;

    return {
      flushedRows: rowCount,
      zeroNetDropped,
      inputEventsInBatch: inputCount,
      sqlStatementsSaved: statementsSaved,
      sql,
      params,
      executionTimeMs: Date.now() - startMs,
      writeAmplificationReductionRatio: reductionRatio,
      reductionPercent,
    };
  }

  /**
   * Lifetime telemetry metrics.
   */
  public getStats(): CoalescerStats {
    const ratio =
      this.totalInputEvents > 0
        ? (this.totalInputEvents - this.totalFlushedRows) / this.totalInputEvents
        : 0;

    return {
      totalInputEvents: this.totalInputEvents,
      totalFlushedRows: this.totalFlushedRows,
      totalZeroNetDropped: this.totalZeroNetDropped,
      pendingKeys: this.pendingDeltas.size,
      sqlStatementsSaved: this.totalSqlStatementsSaved,
      writeAmplificationReductionRatio: ratio,
      reductionPercent: `${(ratio * 100).toFixed(1)}%`,
    };
  }

  /**
   * Resets all lifetime telemetry and drops pending buffer.
   */
  public resetStats(): void {
    this.pendingDeltas.clear();
    this.inputEventsSinceLastFlush = 0;
    this.totalInputEvents = 0;
    this.totalFlushedRows = 0;
    this.totalZeroNetDropped = 0;
    this.totalSqlStatementsSaved = 0;
  }

  /**
   * Starts periodic background flushing.
   */
  public start(executor: (sql: string, params: (string | number)[]) => Promise<any>): void {
    if (this.timer) return;
    this.timer = setInterval(async () => {
      if (this.pendingDeltas.size > 0) {
        try {
          await this.flushNow(executor);
        } catch {
          // Handled and merged back inside flushNow
        }
      }
    }, this.flushIntervalMs);
  }

  /**
   * Stops periodic background flushing.
   */
  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
