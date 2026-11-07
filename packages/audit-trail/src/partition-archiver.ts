import { createHash } from 'node:crypto';
import { AuditEntry, IntegrityVerificationResult } from './types';
import { GENESIS_HASH, canonicalJsonStringify, verifyChainIntegrity } from './hash-chain';
import { MerkleTree } from './merkle-tree';

/**
 * Monthly Partition Specification with UTC-safe boundaries
 */
export interface MonthlyPartitionSpec {
  partitionName: string;
  rangeStartIso: string;
  rangeEndIso: string;
  year: number;
  month: number; // 1-indexed (1..12)
  baseTable: string;
}

/**
 * Options for generating PostgreSQL Declarative Partition DDL
 */
export interface PartitionDDLOptions {
  timestampColumn?: string;
  includeParentDDL?: boolean;
  defaultPartitionName?: string;
  includeBrinIndex?: boolean;
  brinPagesPerRange?: number;
  additionalIndexes?: Array<{
    name?: string;
    columns: string[];
    using?: 'btree' | 'brin' | 'gin' | 'hash';
    unique?: boolean;
    where?: string;
  }>;
}

/**
 * Retention and Maintenance configuration for PostgreSQL Declarative Partitioning
 */
export interface PartitionRetentionConfig {
  baseTable?: string;
  premakeMonths?: number; // Months ahead to ensure created (default: 2, like pg_partman)
  hotRetentionMonths?: number; // Months to keep attached as hot tier (default: 3)
  timestampColumn?: string; // Default: "timestamp"
  lookbackMonthsForDetach?: number; // Months to scan for detaching cold partitions (default: 3)
}

/**
 * Generated partition maintenance plan containing upcoming hot and candidate cold partitions
 */
export interface PartitionMaintenancePlan {
  currentPartition: MonthlyPartitionSpec;
  hotPartitionsToEnsure: MonthlyPartitionSpec[];
  coldPartitionsToDetach: MonthlyPartitionSpec[];
  generatedSql: {
    createPartitionsSql: string[];
    createIndexesSql: string[];
    detachPartitionsSql: string[];
  };
}

/**
 * Options for query-level Partition Pruning enforcement
 */
export interface PartitionPruningOptions {
  defaultHotDays?: number; // Default: 30
  now?: Date;
  startDate?: Date | string;
  endDate?: Date | string;
  timestampField?: string; // Default: "timestamp"
}

/**
 * Extracted partition pruning diagnostic metadata
 */
export interface PruningBoundsInfo {
  field: string;
  gte: Date;
  lte: Date;
  durationDays: number;
  isCustomRange: boolean;
}

/**
 * Immutable Cold Tier Archive Manifest produced when sealing a detached partition
 */
export interface ColdPartitionManifest {
  partitionName: string;
  rangeStartIso: string;
  rangeEndIso: string;
  rowCount: number;
  firstRecordId: string;
  firstHash: string;
  lastRecordId: string;
  lastHash: string; // Cryptographic anchor for the next partition's first record
  merkleRoot: string;
  payloadSha256: string;
  archivedAtIso: string;
  storageUri: string;
}

/**
 * Input parameters for sealing a cold partition
 */
export interface SealColdArchiveParams {
  partitionName: string;
  rangeStartIso: string;
  rangeEndIso: string;
  records: AuditEntry[];
  storageUri?: string;
  now?: Date;
  expectedGenesisHash?: string;
}

/**
 * Result of sealing a cold partition archive
 */
export interface SealedColdArchive {
  manifest: ColdPartitionManifest;
  ndjsonPayload: string;
  isValid: boolean;
  chainVerification: IntegrityVerificationResult;
}

/**
 * Boundary verification result connecting cold archive manifest with hot partition records
 */
export interface BoundaryChainVerificationResult extends IntegrityVerificationResult {
  coldAnchorValid: boolean;
  boundaryHash: string;
}

/**
 * PostgreSQL Declarative Range Partition Manager (pg_partman style)
 * Handles monthly partition calculations, DDL generation with BRIN indexing, and maintenance planning.
 */
export class PgRangePartitionManager {
  /**
   * Calculate UTC-safe monthly partition specifications handling December -> January rollovers cleanly.
   */
  public static getMonthlyPartitionSpec(date: Date, baseTable: string = 'AuditLog'): MonthlyPartitionSpec {
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1; // 1-12

    const paddedMonth = String(month).padStart(2, '0');
    const partitionName = `${baseTable}_y${year}m${paddedMonth}`;

    const rangeStart = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
    // Date.UTC with month handles 12 -> 0 of next year automatically
    const rangeEnd = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));

    return {
      partitionName,
      rangeStartIso: rangeStart.toISOString(),
      rangeEndIso: rangeEnd.toISOString(),
      year,
      month,
      baseTable,
    };
  }

  /**
   * Helper to format UTC ISO string into PostgreSQL timestamp with time zone literal format:
   * 'YYYY-MM-DD 00:00:00+00'
   */
  public static formatPgTimestampLiteral(isoString: string): string {
    const d = new Date(isoString);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mi = String(d.getUTCMinutes()).padStart(2, '0');
    const ss = String(d.getUTCSeconds()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}+00`;
  }

  /**
   * Generate idempotent PostgreSQL DDL for a monthly range partition with local BRIN indexing.
   */
  public static buildPartitionDDL(
    spec: MonthlyPartitionSpec,
    options: PartitionDDLOptions = {}
  ): string {
    const timestampCol = options.timestampColumn ?? 'timestamp';
    const brinPages = options.brinPagesPerRange ?? 32;
    const includeBrin = options.includeBrinIndex !== false;
    const statements: string[] = [];

    // Optional parent table and default partition DDL
    if (options.includeParentDDL) {
      const defaultPartName = options.defaultPartitionName ?? `${spec.baseTable}_default`;
      statements.push(
        `-- Parent declarative partitioned table\n` +
        `CREATE TABLE IF NOT EXISTS "${spec.baseTable}" (\n` +
        `  "id" TEXT NOT NULL,\n` +
        `  "${timestampCol}" TIMESTAMPTZ NOT NULL DEFAULT NOW(),\n` +
        `  "userId" TEXT,\n` +
        `  "action" TEXT NOT NULL,\n` +
        `  "status" TEXT NOT NULL DEFAULT 'SUCCESS',\n` +
        `  "ipAddress" TEXT,\n` +
        `  "userAgent" TEXT,\n` +
        `  "details" JSONB,\n` +
        `  CONSTRAINT "pk_${spec.baseTable}" PRIMARY KEY ("id", "${timestampCol}")\n` +
        `) PARTITION BY RANGE ("${timestampCol}");`
      );
      statements.push(
        `CREATE TABLE IF NOT EXISTS "${defaultPartName}" PARTITION OF "${spec.baseTable}" DEFAULT;`
      );
    }

    const startPg = this.formatPgTimestampLiteral(spec.rangeStartIso);
    const endPg = this.formatPgTimestampLiteral(spec.rangeEndIso);

    // Monthly Child Partition
    statements.push(
      `CREATE TABLE IF NOT EXISTS "${spec.partitionName}" PARTITION OF "${spec.baseTable}" ` +
      `FOR VALUES FROM ('${startPg}') TO ('${endPg}');`
    );

    // BRIN (Block Range Index) on timestamp column
    // BRIN indexes use 99% less RAM and disk than B-Tree for append-only sequential timestamps
    if (includeBrin) {
      statements.push(
        `CREATE INDEX IF NOT EXISTS "idx_${spec.partitionName}_${timestampCol}_brin" ` +
        `ON "${spec.partitionName}" USING BRIN ("${timestampCol}") WITH (pages_per_range = ${brinPages});`
      );
    }

    // Additional local partition indexes
    if (options.additionalIndexes && options.additionalIndexes.length > 0) {
      for (const idx of options.additionalIndexes) {
        const idxName = idx.name ?? `idx_${spec.partitionName}_${idx.columns.join('_')}`;
        const usingClause = idx.using ? ` USING ${idx.using.toUpperCase()}` : '';
        const uniqueClause = idx.unique ? ' UNIQUE' : '';
        const whereClause = idx.where ? ` WHERE ${idx.where}` : '';
        const cols = idx.columns.map((c) => `"${c}"`).join(', ');

        statements.push(
          `CREATE${uniqueClause} INDEX IF NOT EXISTS "${idxName}" ` +
          `ON "${spec.partitionName}"${usingClause} (${cols})${whereClause};`
        );
      }
    }

    return statements.join('\n');
  }

  /**
   * Generates PostgreSQL zero-lock concurrent partition detach DDL (PostgreSQL 14-18).
   * DETACH PARTITION CONCURRENTLY never blocks concurrent writes or check-ins.
   */
  public static buildDetachPartitionConcurrentlySQL(
    partitionName: string,
    baseTable: string = 'AuditLog'
  ): string {
    return `ALTER TABLE "${baseTable}" DETACH PARTITION "${partitionName}" CONCURRENTLY;`;
  }

  /**
   * Plan maintenance for upcoming hot partitions and candidate cold partitions.
   * - Ensures hot partitions exist for current month + next `premakeMonths` (default: 2, pg_partman style).
   * - Identifies cold partitions older than `hotRetentionMonths` (default: 3) to detach concurrently.
   */
  public static planPartitionMaintenance(
    now: Date = new Date(),
    config: PartitionRetentionConfig = {}
  ): PartitionMaintenancePlan {
    const baseTable = config.baseTable ?? 'AuditLog';
    const premakeMonths = config.premakeMonths ?? 2;
    const hotRetentionMonths = config.hotRetentionMonths ?? 3;
    const timestampCol = config.timestampColumn ?? 'timestamp';
    const lookbackMonths = config.lookbackMonthsForDetach ?? 3;

    const currentPartition = this.getMonthlyPartitionSpec(now, baseTable);

    // 1. Calculate Hot Partitions (current month + premakeMonths ahead)
    const hotPartitionsToEnsure: MonthlyPartitionSpec[] = [];
    const createPartitionsSql: string[] = [];
    const createIndexesSql: string[] = [];

    for (let offset = 0; offset <= premakeMonths; offset++) {
      const targetDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
      const spec = this.getMonthlyPartitionSpec(targetDate, baseTable);
      hotPartitionsToEnsure.push(spec);

      const ddl = this.buildPartitionDDL(spec, {
        timestampColumn: timestampCol,
        includeBrinIndex: true,
      });

      const ddlParts = ddl.split('\n');
      if (ddlParts[0]) createPartitionsSql.push(ddlParts[0]);
      if (ddlParts[1]) createIndexesSql.push(ddlParts[1]);
    }

    // 2. Calculate Cold Partitions to Detach
    // Any partition older than hotRetentionMonths prior to current month is a cold candidate
    const coldPartitionsToDetach: MonthlyPartitionSpec[] = [];
    const detachPartitionsSql: string[] = [];

    for (let offset = hotRetentionMonths + lookbackMonths; offset >= hotRetentionMonths + 1; offset--) {
      const coldDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1));
      const coldSpec = this.getMonthlyPartitionSpec(coldDate, baseTable);
      coldPartitionsToDetach.push(coldSpec);
      detachPartitionsSql.push(this.buildDetachPartitionConcurrentlySQL(coldSpec.partitionName, baseTable));
    }

    return {
      currentPartition,
      hotPartitionsToEnsure,
      coldPartitionsToDetach,
      generatedSql: {
        createPartitionsSql,
        createIndexesSql,
        detachPartitionsSql,
      },
    };
  }
}

/**
 * Injects explicit range bounds on the partition key into Prisma/SQL where clauses.
 * In PostgreSQL, Partition Pruning (enable_partition_pruning = on) ONLY activates when
 * the query's WHERE clause contains explicit bounds on the partition key.
 *
 * Without bounds, PostgreSQL scans ALL partitions. With bounds, PostgreSQL prunes 100%
 * of inactive partitions in O(1) time.
 */
export function withPartitionPruningBounds<T extends Record<string, any>>(
  where: T,
  options: PartitionPruningOptions = {}
): T & Record<string, { gte: Date; lte: Date }> {
  const timestampField = options.timestampField ?? 'timestamp';
  const defaultHotDays = Math.max(1, options.defaultHotDays ?? 30);
  const now = options.now ? new Date(options.now) : new Date();

  const clonedWhere: Record<string, any> = { ...where };
  const existingFieldWhere = clonedWhere[timestampField];

  let gte: Date;
  let lte: Date;

  // 1. Resolve explicit startDate from options or existing where
  if (options.startDate) {
    gte = new Date(options.startDate);
  } else if (existingFieldWhere && typeof existingFieldWhere === 'object' && existingFieldWhere.gte) {
    gte = new Date(existingFieldWhere.gte);
  } else if (existingFieldWhere && typeof existingFieldWhere === 'object' && existingFieldWhere.gt) {
    gte = new Date(existingFieldWhere.gt);
  } else {
    // Default to hot window: now - defaultHotDays
    gte = new Date(now.getTime() - defaultHotDays * 24 * 60 * 60 * 1000);
  }

  // 2. Resolve explicit endDate from options or existing where
  if (options.endDate) {
    const end = new Date(options.endDate);
    if (typeof options.endDate === 'string' && options.endDate.length <= 10) {
      end.setUTCHours(23, 59, 59, 999);
    }
    lte = end;
  } else if (existingFieldWhere && typeof existingFieldWhere === 'object' && existingFieldWhere.lte) {
    lte = new Date(existingFieldWhere.lte);
  } else if (existingFieldWhere && typeof existingFieldWhere === 'object' && existingFieldWhere.lt) {
    lte = new Date(existingFieldWhere.lt);
  } else {
    // Default to now + 60s skew allowance
    lte = new Date(now.getTime() + 60 * 1000);
  }

  // Ensure gte <= lte
  if (gte.getTime() > lte.getTime()) {
    const temp = gte;
    gte = lte;
    lte = temp;
  }

  clonedWhere[timestampField] = {
    ...(typeof existingFieldWhere === 'object' && existingFieldWhere !== null ? existingFieldWhere : {}),
    gte,
    lte,
  };

  return clonedWhere as T & Record<string, { gte: Date; lte: Date }>;
}

/**
 * Diagnostic helper to inspect active partition pruning bounds and calculate query window
 */
export function extractPruningBounds(
  where: Record<string, any>,
  timestampField: string = 'timestamp'
): PruningBoundsInfo | null {
  const fieldVal = where[timestampField];
  if (!fieldVal || typeof fieldVal !== 'object') return null;

  const gte = fieldVal.gte instanceof Date ? fieldVal.gte : fieldVal.gte ? new Date(fieldVal.gte) : null;
  const lte = fieldVal.lte instanceof Date ? fieldVal.lte : fieldVal.lte ? new Date(fieldVal.lte) : null;

  if (!gte || !lte) return null;

  const durationMs = lte.getTime() - gte.getTime();
  const durationDays = Math.max(0, Math.round((durationMs / (24 * 60 * 60 * 1000)) * 10) / 10);

  return {
    field: timestampField,
    gte,
    lte,
    durationDays,
    isCustomRange: durationDays !== 30,
  };
}

/**
 * Uber/Stripe-style Zero-Lock Cold Tier Archiver & Cryptographic Boundary Anchor
 * Eliminates DELETE table locks, WAL bloat, and preserves SHA-256 hash chains across partition detaches.
 */
export class ColdTierArchiver {
  /**
   * Generates PostgreSQL zero-lock concurrent partition detach DDL (PostgreSQL 14-18)
   */
  public static buildDetachPartitionConcurrentlySQL(
    partitionName: string,
    baseTable: string = 'AuditLog'
  ): string {
    return PgRangePartitionManager.buildDetachPartitionConcurrentlySQL(partitionName, baseTable);
  }

  /**
   * Seals a detached partition into an immutable Cold Partition Manifest and NDJSON payload.
   * Verifies 100% internal cryptographic chain integrity and computes the Merkle Root.
   */
  public static sealColdPartitionArchive(params: SealColdArchiveParams): SealedColdArchive {
    const {
      partitionName,
      rangeStartIso,
      rangeEndIso,
      records,
      storageUri = `s3://cold-archive/audit-log/${partitionName}.ndjson.gz`,
      now = new Date(),
      expectedGenesisHash,
    } = params;

    const rowCount = records.length;

    // Handle empty partition
    if (rowCount === 0) {
      const emptyPayload = '';
      const emptySha = createHash('sha256').update(emptyPayload).digest('hex');
      const manifest: ColdPartitionManifest = {
        partitionName,
        rangeStartIso,
        rangeEndIso,
        rowCount: 0,
        firstRecordId: 'EMPTY',
        firstHash: GENESIS_HASH,
        lastRecordId: 'EMPTY',
        lastHash: GENESIS_HASH,
        merkleRoot: GENESIS_HASH,
        payloadSha256: emptySha,
        archivedAtIso: now.toISOString(),
        storageUri,
      };

      return {
        manifest,
        ndjsonPayload: emptyPayload,
        isValid: true,
        chainVerification: {
          isValid: true,
          totalRecords: 0,
          tamperedIndex: null,
          tamperedRecordId: null,
          reason: null,
        },
      };
    }

    // 1. Verify internal chain integrity
    const chainVerification = verifyChainIntegrity(
      records,
      expectedGenesisHash ?? records[0].previousHash
    );

    // 2. Compute Merkle Root across all records in the partition
    const merkleTree = new MerkleTree(records);
    const merkleRoot = merkleTree.getRoot();

    // 3. Serialize records to deterministic NDJSON format
    const ndjsonLines = records.map((entry) => canonicalJsonStringify(entry));
    const ndjsonPayload = ndjsonLines.join('\n') + '\n';
    const payloadSha256 = createHash('sha256').update(ndjsonPayload).digest('hex');

    const firstEntry = records[0];
    const lastEntry = records[rowCount - 1];

    const manifest: ColdPartitionManifest = {
      partitionName,
      rangeStartIso,
      rangeEndIso,
      rowCount,
      firstRecordId: firstEntry.id,
      firstHash: firstEntry.currentHash,
      lastRecordId: lastEntry.id,
      lastHash: lastEntry.currentHash, // <-- The cryptographic boundary anchor!
      merkleRoot,
      payloadSha256,
      archivedAtIso: now.toISOString(),
      storageUri,
    };

    return {
      manifest,
      ndjsonPayload,
      isValid: chainVerification.isValid,
      chainVerification,
    };
  }

  /**
   * Solves the Cryptographic Hash Chain + Partition Detach Paradox.
   *
   * When partition M-1 is detached and archived, the first record of hot partition M has:
   *   hotRecords[0].previousHash === coldManifest_M_minus_1.lastHash (NOT GENESIS_HASH).
   *
   * This method validates:
   * 1. Cold manifest integrity (anchors present and format valid).
   * 2. Boundary connection: hotRecords[0].previousHash === coldManifest.lastHash.
   * 3. Hot partition sequential chain integrity starting from coldManifest.lastHash.
   */
  public static verifyChainWithColdManifest(
    hotRecords: AuditEntry[],
    coldManifest: ColdPartitionManifest
  ): BoundaryChainVerificationResult {
    // 1. Validate manifest anchors
    if (!coldManifest.lastHash || coldManifest.lastHash.length !== 64) {
      return {
        isValid: false,
        totalRecords: hotRecords.length,
        tamperedIndex: 0,
        tamperedRecordId: hotRecords[0]?.id ?? null,
        reason: 'Cold manifest has invalid or missing lastHash anchor',
        coldAnchorValid: false,
        boundaryHash: coldManifest.lastHash || '',
      };
    }

    // If hot records are empty, boundary is vacuously valid
    if (hotRecords.length === 0) {
      return {
        isValid: true,
        totalRecords: 0,
        tamperedIndex: null,
        tamperedRecordId: null,
        reason: null,
        coldAnchorValid: true,
        boundaryHash: coldManifest.lastHash,
      };
    }

    // 2. Verify boundary continuity: hot[0].previousHash must match coldManifest.lastHash
    const firstHotRecord = hotRecords[0];
    if (firstHotRecord.previousHash !== coldManifest.lastHash) {
      return {
        isValid: false,
        totalRecords: hotRecords.length,
        tamperedIndex: 0,
        tamperedRecordId: firstHotRecord.id,
        reason: `Partition boundary tamper detected: hot partition record[0].previousHash (${firstHotRecord.previousHash}) does not match cold manifest lastHash anchor (${coldManifest.lastHash})`,
        details: {
          hotFirstRecordId: firstHotRecord.id,
          hotFirstPreviousHash: firstHotRecord.previousHash,
          coldManifestLastHash: coldManifest.lastHash,
          coldPartitionName: coldManifest.partitionName,
        },
        coldAnchorValid: false,
        boundaryHash: coldManifest.lastHash,
      };
    }

    // 3. Verify hot partition internal chain continuity from the cold anchor
    const chainResult = verifyChainIntegrity(hotRecords, coldManifest.lastHash);

    return {
      ...chainResult,
      coldAnchorValid: true,
      boundaryHash: coldManifest.lastHash,
    };
  }
}
