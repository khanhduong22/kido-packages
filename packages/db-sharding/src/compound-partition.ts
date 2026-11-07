/**
 * Compound Key (user_hash, created_at) Sub-Partitioning Engine (DDIA Ch.6)
 * Pattern: Uber / Grab / Binance / Shopee / Stripe
 *
 * Combines DDIA Màn 05 (Range Partitioning + Cold Detach) with
 * DDIA Màn 06 (Key-Hash Sharding):
 *
 * - Level 1 Root Table: PARTITION BY HASH ("customerPhone" / "userId")
 * - Level 1 Shards (0..N-1): PARTITION BY RANGE ("createdAt")
 * - Level 2 Monthly Sub-Partitions: Leaf partitions with local compound B-Tree & BRIN indexes
 * - Compound Query Pruner: Guarantees single-leaf partition scans when hash key + time range are provided
 * - Zero-Lock Concurrent Detach: Allows historical months to be detached in O(1) per shard
 */

import { murmurhash3_32 } from "./murmurhash";

export interface ColumnDefinition {
  name: string;
  type: string;
  nullable?: boolean;
  defaultValue?: string;
}

export interface CompoundRootTableOptions {
  tableName?: string;
  hashColumn?: string;
  rangeColumn?: string;
  idColumn?: string;
  extraColumns?: ColumnDefinition[];
}

export interface CompoundShardDDLOptions {
  tableName?: string;
  totalShards?: number;
  rangeColumn?: string;
}

export interface MonthlySubPartitionDDLOptions {
  tableName?: string;
  totalShards?: number;
  hashColumn?: string;
  rangeColumn?: string;
  year: number;
  month: number;
  includeIndexes?: boolean;
}

export interface FullCompoundSchemaOptions {
  tableName?: string;
  hashColumn?: string;
  rangeColumn?: string;
  totalShards?: number;
  startYear?: number;
  startMonth?: number;
  numMonths?: number;
  extraColumns?: ColumnDefinition[];
}

export interface CompoundPruningOptions {
  tableName?: string;
  hashKeyField?: string;
  rangeField?: string;
  totalShards?: number;
  seed?: number;
}

export interface CompoundPruneResult<TFilter> {
  pruned: boolean;
  targetShardIndex?: number;
  targetShardTable?: string;
  targetSubPartitions: string[];
  singleSubPartitionScan: boolean;
  query: TFilter;
  planSummary: string;
  warning?: string;
}

export interface DetachPartitionOptions {
  tableName?: string;
  year: number;
  month: number;
  shardIndex?: number;
  totalShards?: number;
}

export class CompoundPartitionManager {
  private readonly defaultTable: string;
  private readonly defaultHashCol: string;
  private readonly defaultRangeCol: string;
  private readonly defaultTotalShards: number;

  constructor(options: {
    tableName?: string;
    hashColumn?: string;
    rangeColumn?: string;
    totalShards?: number;
  } = {}) {
    this.defaultTable = options.tableName ?? "StoreOrder";
    this.defaultHashCol = options.hashColumn ?? "customerPhone";
    this.defaultRangeCol = options.rangeColumn ?? "createdAt";
    this.defaultTotalShards = options.totalShards ?? 4;
  }

  /**
   * Generates Level 1 Root Table DDL: PARTITION BY HASH ("<hashColumn>").
   * Primary key includes (hashColumn, rangeColumn, id) as required by PostgreSQL declarative partitioning.
   */
  public generateRootTableDDL(options: CompoundRootTableOptions = {}): string {
    const table = options.tableName ?? this.defaultTable;
    const hashCol = options.hashColumn ?? this.defaultHashCol;
    const rangeCol = options.rangeColumn ?? this.defaultRangeCol;
    const idCol = options.idColumn ?? "id";

    const defaultCols: ColumnDefinition[] = [
      { name: idCol, type: "TEXT", nullable: false },
      { name: "tenantId", type: "TEXT", nullable: false, defaultValue: "'acme'" },
      { name: "orderNumber", type: "TEXT", nullable: false },
      { name: hashCol, type: "TEXT", nullable: false },
      { name: "customerName", type: "TEXT", nullable: true },
      { name: "totalAmount", type: "DOUBLE PRECISION", nullable: false, defaultValue: "0" },
      { name: "orderStatus", type: "TEXT", nullable: false, defaultValue: "'pending'" },
      { name: "paymentStatus", type: "TEXT", nullable: false, defaultValue: "'unpaid'" },
      { name: rangeCol, type: "TIMESTAMPTZ", nullable: false, defaultValue: "NOW()" },
      { name: "updatedAt", type: "TIMESTAMPTZ", nullable: false, defaultValue: "NOW()" },
    ];

    const columns = options.extraColumns ? [...defaultCols, ...options.extraColumns] : defaultCols;

    const colLines = columns.map((col) => {
      let line = `  "${col.name}" ${col.type}`;
      if (!col.nullable) line += " NOT NULL";
      if (col.defaultValue !== undefined) line += ` DEFAULT ${col.defaultValue}`;
      return line;
    });

    // Primary key must contain all partition keys
    colLines.push(`  PRIMARY KEY ("${hashCol}", "${rangeCol}", "${idCol}")`);

    return [
      `-- Level 1 Root Table (Hash Partitioned by "${hashCol}")`,
      `CREATE TABLE IF NOT EXISTS "${table}" (`,
      colLines.join(",\n"),
      `) PARTITION BY HASH ("${hashCol}");`,
    ].join("\n");
  }

  /**
   * Generates Level 1 Hash Shard Tables (0 .. N-1), each sub-partitioned by RANGE ("<rangeColumn>").
   */
  public generateShardPartitionDDL(options: CompoundShardDDLOptions = {}): string[] {
    const table = options.tableName ?? this.defaultTable;
    const totalShards = options.totalShards ?? this.defaultTotalShards;
    const rangeCol = options.rangeColumn ?? this.defaultRangeCol;

    const ddlList: string[] = [];
    for (let i = 0; i < totalShards; i++) {
      const shardTable = `${table}_s${i}`;
      ddlList.push(
        `CREATE TABLE IF NOT EXISTS "${shardTable}" PARTITION OF "${table}" ` +
        `FOR VALUES WITH (MODULUS ${totalShards}, REMAINDER ${i}) ` +
        `PARTITION BY RANGE ("${rangeCol}");`
      );
    }
    return ddlList;
  }

  /**
   * Generates Level 2 Monthly Leaf Sub-Partitions for all N hash shards in a given year/month.
   * Includes local compound B-Tree ("<hashCol>", "<rangeCol>" DESC) and BRIN ("<rangeCol>") indexes.
   */
  public generateMonthlySubPartitionDDL(options: MonthlySubPartitionDDLOptions): string[] {
    const table = options.tableName ?? this.defaultTable;
    const totalShards = options.totalShards ?? this.defaultTotalShards;
    const hashCol = options.hashColumn ?? this.defaultHashCol;
    const rangeCol = options.rangeColumn ?? this.defaultRangeCol;
    const { year, month } = options;
    const includeIndexes = options.includeIndexes ?? true;

    if (month < 1 || month > 12) {
      throw new Error(`month must be between 1 and 12, received: ${month}`);
    }

    const startIso = `${year}-${String(month).padStart(2, "0")}-01 00:00:00+00`;
    const nextYear = month === 12 ? year + 1 : year;
    const nextMonth = month === 12 ? 1 : month + 1;
    const endIso = `${nextYear}-${String(nextMonth).padStart(2, "0")}-01 00:00:00+00`;
    const monthSuffix = `y${year}m${String(month).padStart(2, "0")}`;

    const statements: string[] = [];

    for (let s = 0; s < totalShards; s++) {
      const shardParent = `${table}_s${s}`;
      const leafTable = `${shardParent}_${monthSuffix}`;

      // Leaf partition statement
      statements.push(
        `CREATE TABLE IF NOT EXISTS "${leafTable}" PARTITION OF "${shardParent}" ` +
        `FOR VALUES FROM ('${startIso}') TO ('${endIso}');`
      );

      // Local high-speed indexes
      if (includeIndexes) {
        const btreeIdx = `idx_${leafTable}_${hashCol}_${rangeCol}`;
        const brinIdx = `idx_${leafTable}_${rangeCol}_brin`;

        statements.push(
          `CREATE INDEX IF NOT EXISTS "${btreeIdx}" ON "${leafTable}" ("${hashCol}", "${rangeCol}" DESC);`
        );
        statements.push(
          `CREATE INDEX IF NOT EXISTS "${brinIdx}" ON "${leafTable}" USING BRIN ("${rangeCol}");`
        );
      }
    }

    return statements;
  }

  /**
   * Generates full schema DDL: Root Table + N Shard Tables + Sub-Partitions for the requested months.
   */
  public generateFullSchemaDDL(options: FullCompoundSchemaOptions = {}): string {
    const table = options.tableName ?? this.defaultTable;
    const totalShards = options.totalShards ?? this.defaultTotalShards;
    const hashCol = options.hashColumn ?? this.defaultHashCol;
    const rangeCol = options.rangeColumn ?? this.defaultRangeCol;

    const startYear = options.startYear ?? new Date().getUTCFullYear();
    const startMonth = options.startMonth ?? new Date().getUTCMonth() + 1;
    const numMonths = options.numMonths ?? 3;

    const sections: string[] = [];

    // 1. Root Table
    sections.push(this.generateRootTableDDL({
      tableName: table,
      hashColumn: hashCol,
      rangeColumn: rangeCol,
      extraColumns: options.extraColumns,
    }));

    // 2. Level 1 Shards
    sections.push(`-- Level 1 Shards (${totalShards} Modulo Shards)`);
    sections.push(this.generateShardPartitionDDL({
      tableName: table,
      totalShards,
      rangeColumn: rangeCol,
    }).join("\n"));

    // 3. Level 2 Monthly Sub-Partitions
    sections.push(`-- Level 2 Monthly Leaf Sub-Partitions (${numMonths} months x ${totalShards} shards)`);
    let curYear = startYear;
    let curMonth = startMonth;

    for (let m = 0; m < numMonths; m++) {
      const monthStmts = this.generateMonthlySubPartitionDDL({
        tableName: table,
        totalShards,
        hashColumn: hashCol,
        rangeColumn: rangeCol,
        year: curYear,
        month: curMonth,
        includeIndexes: true,
      });
      sections.push(monthStmts.join("\n"));

      curMonth++;
      if (curMonth > 12) {
        curMonth = 1;
        curYear++;
      }
    }

    return sections.join("\n\n");
  }

  /**
   * Compound Query Pruning Enforcer.
   *
   * Verifies that the query includes BOTH the partition hash key AND time range bounds.
   * When both are present, PostgreSQL query planner prunes (N-1) hash shards AND all
   * historical month sub-partitions, scanning exactly 1 single leaf partition!
   *
   * @param filter Query filter object (e.g. Prisma / SQL query params)
   * @param options Pruning options
   */
  public withCompoundShardPruning<TFilter extends Record<string, any>>(
    filter: TFilter,
    options: CompoundPruningOptions = {}
  ): CompoundPruneResult<TFilter> {
    const table = options.tableName ?? this.defaultTable;
    const hashField = options.hashKeyField ?? this.defaultHashCol;
    const rangeField = options.rangeField ?? this.defaultRangeCol;
    const totalShards = options.totalShards ?? this.defaultTotalShards;
    const seed = options.seed ?? 0;

    const hashValue = filter[hashField];
    const hasHashKey = hashValue !== undefined && hashValue !== null && String(hashValue).trim().length > 0;

    const rangeValue = filter[rangeField];
    let startDate: Date | null = null;
    let endDate: Date | null = null;

    if (rangeValue) {
      if (rangeValue instanceof Date) {
        startDate = rangeValue;
        endDate = rangeValue;
      } else if (typeof rangeValue === "object") {
        if (rangeValue.gte || rangeValue.gt) {
          startDate = new Date(rangeValue.gte || rangeValue.gt);
        }
        if (rangeValue.lte || rangeValue.lt) {
          endDate = new Date(rangeValue.lte || rangeValue.lt);
        }
      }
    }

    // Check validity of parsed dates
    const hasValidRange =
      startDate !== null &&
      !isNaN(startDate.getTime()) &&
      endDate !== null &&
      !isNaN(endDate.getTime());

    if (!hasHashKey && !hasValidRange) {
      return {
        pruned: false,
        targetSubPartitions: [],
        singleSubPartitionScan: false,
        query: filter,
        planSummary: `Scatter-gather query: Neither hash key ("${hashField}") nor time range ("${rangeField}") provided. Query will scan all ${totalShards} shards and all historical partitions.`,
        warning: `Missing both shard key "${hashField}" and range filter "${rangeField}". High latency scatter-gather alert!`,
      };
    }

    if (!hasHashKey) {
      return {
        pruned: false,
        targetSubPartitions: [],
        singleSubPartitionScan: false,
        query: filter,
        planSummary: `Hash shard missing: Hash key "${hashField}" omitted. Query will scatter-gather across all ${totalShards} hash shards.`,
        warning: `Missing shard key "${hashField}". Broadcast required across all ${totalShards} shards.`,
      };
    }

    const shardIndex = murmurhash3_32(String(hashValue), seed) % totalShards;
    const shardTable = `${table}_s${shardIndex}`;

    if (!hasValidRange) {
      return {
        pruned: false,
        targetShardIndex: shardIndex,
        targetShardTable: shardTable,
        targetSubPartitions: [],
        singleSubPartitionScan: false,
        query: filter,
        planSummary: `Single-shard routed to "${shardTable}", but time range ("${rangeField}") is missing. Query will scan all monthly partitions inside "${shardTable}".`,
        warning: `Time range "${rangeField}" omitted. Historical months in "${shardTable}" cannot be pruned.`,
      };
    }

    // Both hash key and valid time range provided!
    // Compute target monthly partitions
    const months = this.calculateSpannedMonths(startDate!, endDate!);
    const targetSubPartitions = months.map(
      (m) => `${shardTable}_y${m.year}m${String(m.month).padStart(2, "0")}`
    );

    const singleScan = targetSubPartitions.length === 1;
    const planSummary = singleScan
      ? `Optimized Single-Leaf Scan: Target partition "${targetSubPartitions[0]}" selected. Pruned ${totalShards - 1} hash shards and all cold months.`
      : `Pruned Scan: Target shard "${shardTable}" selected across ${targetSubPartitions.length} monthly sub-partitions: [${targetSubPartitions.join(", ")}]. Pruned ${totalShards - 1} hash shards.`;

    return {
      pruned: true,
      targetShardIndex: shardIndex,
      targetShardTable: shardTable,
      targetSubPartitions,
      singleSubPartitionScan: singleScan,
      query: filter,
      planSummary,
    };
  }

  /**
   * Generates Zero-Lock Per-Shard Cold Detach SQL.
   *
   * Utilizes PostgreSQL `DETACH PARTITION ... CONCURRENTLY` to detach cold months
   * without blocking concurrent writes or reads on active hot partitions!
   *
   * @param options Detach options (year, month, shardIndex or all shards)
   * @returns Array of ALTER TABLE DETACH PARTITION CONCURRENTLY statements
   */
  public buildCompoundDetachSQL(options: DetachPartitionOptions): string[] {
    const table = options.tableName ?? this.defaultTable;
    const totalShards = options.totalShards ?? this.defaultTotalShards;
    const { year, month } = options;

    if (month < 1 || month > 12) {
      throw new Error(`month must be between 1 and 12, received: ${month}`);
    }

    const monthSuffix = `y${year}m${String(month).padStart(2, "0")}`;
    const statements: string[] = [];

    if (options.shardIndex !== undefined) {
      const s = options.shardIndex;
      const shardParent = `${table}_s${s}`;
      const leafTable = `${shardParent}_${monthSuffix}`;
      statements.push(
        `ALTER TABLE "${shardParent}" DETACH PARTITION "${leafTable}" CONCURRENTLY;`
      );
    } else {
      for (let s = 0; s < totalShards; s++) {
        const shardParent = `${table}_s${s}`;
        const leafTable = `${shardParent}_${monthSuffix}`;
        statements.push(
          `ALTER TABLE "${shardParent}" DETACH PARTITION "${leafTable}" CONCURRENTLY;`
        );
      }
    }

    return statements;
  }

  /**
   * Helper to compute list of { year, month } between two dates (inclusive).
   */
  private calculateSpannedMonths(start: Date, end: Date): Array<{ year: number; month: number }> {
    const results: Array<{ year: number; month: number }> = [];
    let curYear = start.getUTCFullYear();
    let curMonth = start.getUTCMonth() + 1;

    const endYear = end.getUTCFullYear();
    const endMonth = end.getUTCMonth() + 1;

    while (curYear < endYear || (curYear === endYear && curMonth <= endMonth)) {
      results.push({ year: curYear, month: curMonth });
      curMonth++;
      if (curMonth > 12) {
        curMonth = 1;
        curYear++;
      }
    }

    return results;
  }
}
