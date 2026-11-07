/**
 * @kido/offline-sync — PostgreSQL Partition Archiver Types & Interfaces
 *
 * Types for:
 * 1. Declarative Range Partitioning & Pruning Bounds
 * 2. Zero-Lock Detach & Cold-Tier S3/R2 NDJSON Gzip Offload Engine
 * 3. TimescaleDB Hypertable & Compression/Retention Policy Builder
 */

export interface PartitionPruningBounds {
  minCreatedIso: string;
  maxCreatedIso: string;
  startTimestampMs: number;
  endTimestampMs: number;
}

export interface MonthlyPartitionSpec {
  partitionName: string;
  qualifiedPartitionName: string;
  rangeStartIso: string;
  rangeEndIso: string;
  createSql: string;
}

export interface WeeklyPartitionSpec {
  partitionName: string;
  qualifiedPartitionName: string;
  rangeStartIso: string;
  rangeEndIso: string;
  createSql: string;
}

export interface PlanMonthlyPartitionsOptions {
  tableName: string;
  schema?: string;
  referenceDate?: Date | number;
  premakeMonths?: number;
  lookbackMonths?: number;
}

export interface PlanWeeklyPartitionsOptions {
  tableName: string;
  schema?: string;
  referenceDate?: Date | number;
  premakeWeeks?: number;
  lookbackWeeks?: number;
}

export interface DeclarativePartParentOptions {
  tableName: string;
  schema?: string;
  partitionColumn?: string;
  columnsSql: string;
  createDefaultPartition?: boolean;
}

export interface ColdArchiveManifest {
  tableName: string;
  partitionName: string;
  objectKey: string;
  rowCount: number;
  uncompressedBytes: number;
  compressedBytes: number;
  compressionRatio: number;
  sha256Checksum: string;
  rangeStartIso: string;
  rangeEndIso: string;
  createdAtIso: string;
}

export interface CompressRowsMeta {
  tableName: string;
  partitionName: string;
  rangeStartIso: string;
  rangeEndIso: string;
  keyPrefix?: string;
  now?: Date;
}

export interface CompressRowsResult {
  buffer: Buffer;
  manifest: ColdArchiveManifest;
}

export interface ColdStoragePutResult {
  uploadedBytes: number;
  uploadedSha256: string;
  objectKey?: string;
  etag?: string;
}

export interface ColdStorageAdapter {
  putObject(params: {
    key: string;
    body: Buffer;
    contentType?: string;
    metadata?: Record<string, string>;
  }): Promise<ColdStoragePutResult>;
}

export interface PgSqlExecutor {
  queryRaw<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]>;
  executeRaw(sql: string, params?: unknown[]): Promise<unknown>;
}

export interface ArchivePartitionOptions {
  parentTable: string;
  partitionName: string;
  schema?: string;
  rangeStartIso: string;
  rangeEndIso: string;
  keyPrefix?: string;
  concurrently?: boolean;
  dropAfterVerify?: boolean;
}

export interface ArchivePartitionResult {
  detached: boolean;
  manifest: ColdArchiveManifest;
  buffer: Buffer;
  dropped: boolean;
  archiveUploadResult: ColdStoragePutResult;
  manifestUploadResult?: ColdStoragePutResult;
}

export interface TimescaleHypertablePolicyOptions {
  tableName: string;
  schema?: string;
  timeColumn?: string;
  chunkInterval?: string;
  /** Optional space-hash partitioning column (e.g. 'symbol' or 'user_id') */
  spaceColumn?: string;
  /** Number of space-hash partitions when spaceColumn is set (default: 4) */
  spacePartitions?: number;
  segmentBy?: string | string[];
  orderBy?: string;
  compressAfter?: string;
  retainAfter?: string;
}
