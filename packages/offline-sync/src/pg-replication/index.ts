/**
 * @kido/offline-sync — PostgreSQL Logical Replication LSN Monitor &
 * TimescaleDB Continuous Aggregate (CAGG) Advisory-Lock Refresher
 *
 * Harvested & generalized from production data-replication & time-series pipelines:
 * 1. PostgreSQL `XXXX/YYYYYYYY` 64-bit Log Sequence Number (LSN) parser & exact byte lag calculator
 * 2. Logical replication health evaluator (`pg_stat_subscription`, `pg_subscription_rel`, `pg_replication_slots`)
 * 3. Safe SQL builder for subscription publication refresh auto-recovery
 * 4. Advisory-locked Materialized View & TimescaleDB Continuous Aggregate refresher with `22023` overlap immunity
 */

export interface PgSubscriptionStat {
  subname: string;
  pid: number | null;
  received_lsn: string | null;
  latest_end_lsn?: string | null;
  last_msg_send_time?: Date | string | null;
  last_msg_receipt_time?: Date | string | null;
  latest_end_time?: Date | string | null;
}

export interface PgSubscriptionRel {
  srsubid?: number;
  srrelid: string;
  /**
   * PostgreSQL subscription relation state:
   * 'i' = initialize, 'd' = data copying, 'f' = finished table copy,
   * 's' = synchronized, 'r' = ready (normal streaming)
   */
  srsubstate: string;
  srsublsn?: string | null;
}

export interface PgReplicationSlot {
  slot_name: string;
  plugin?: string;
  slot_type?: string;
  active: boolean;
  active_pid?: number | null;
  restart_lsn?: string | null;
  confirmed_flush_lsn: string | null;
}

export interface EvaluateReplicationHealthInput {
  stats: PgSubscriptionStat | null;
  relations: PgSubscriptionRel[];
  slot: PgReplicationSlot | null;
  /** Default: 10 MB (10 * 1024 * 1024 bytes) */
  maxLagBytes?: number;
  /** Default: 5 minutes (300,000 ms) */
  maxStaleMs?: number;
  /** Optional consecutive failure counter for gated auto-recovery */
  consecutiveFailures?: number;
  /** Default: 3 when consecutiveFailures is provided */
  maxConsecutiveFailures?: number;
  /** Optional reference clock for deterministic testing */
  now?: Date | number;
}

export interface ReplicationHealthMetrics {
  tablesReady: number;
  totalTables: number;
  notReadyTables: string[];
  lagBytes: number | null;
  lastMessageAgo: number | null;
  workerPid: number | null;
}

export interface ReplicationHealthReport {
  isHealthy: boolean;
  lastChecked: Date;
  issues: string[];
  warnings: string[];
  shouldTriggerAutoRecovery: boolean;
  metrics: ReplicationHealthMetrics;
}

export interface CaggRefreshWindow {
  viewName: string;
  startOffsetMs: number;
}

export interface PgSqlExecutor {
  queryRaw<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]>;
  executeRaw(sql: string, params?: unknown[]): Promise<unknown>;
}

export type ViewRefreshStatus =
  | 'refreshed'
  | 'skipped_locked'
  | 'skipped_already_materialized';

export interface ViewRefreshResult {
  status: ViewRefreshStatus;
  viewName: string;
  lockKey: string;
  durationMs: number;
}

export interface RefreshContinuousAggregateOptions {
  viewName: string;
  schema?: string;
  startOffsetMs: number;
  /** SQL expression for window end, default `'NULL'` */
  endWindowSql?: string;
  /** SQL expression returning current Unix epoch in ms, default `'public.current_unix_ms()'` */
  currentUnixMsSql?: string;
  /** Prefix for advisory lock key, default `'cagg-refresh'` */
  lockPrefix?: string;
}

export interface RefreshMaterializedViewOptions {
  viewName: string;
  schema?: string;
  /** Default: true */
  concurrently?: boolean;
  /** Default: true */
  useAdvisoryLock?: boolean;
  /** Prefix for advisory lock key, default `'matview-refresh'` */
  lockPrefix?: string;
}

const PG_IDENTIFIER_REGEX = /^[a-zA-Z_][a-zA-Z0-9_$]{0,62}$/;
const PG_LSN_REGEX = /^([0-9a-fA-F]{1,8})\/([0-9a-fA-F]{1,8})$/;

/**
 * Validates a PostgreSQL unquoted identifier (table, view, schema, or subscription name)
 * to prevent SQL injection when building DDL/administrative commands.
 */
export function assertValidPgIdentifier(
  identifier: string,
  label = 'identifier',
): string {
  if (!identifier || typeof identifier !== 'string') {
    throw new Error(`Invalid PostgreSQL ${label}: must be a non-empty string`);
  }
  const trimmed = identifier.trim();
  if (!PG_IDENTIFIER_REGEX.test(trimmed)) {
    throw new Error(
      `Invalid PostgreSQL ${label} "${identifier}": must match /^[a-zA-Z_][a-zA-Z0-9_$]{0,62}$/`,
    );
  }
  return trimmed;
}

/**
 * Qualifies a view or table name with a schema (default `'public'`), validating both identifiers.
 */
export function toQualifiedViewName(
  viewName: string,
  defaultSchema = 'public',
): string {
  if (!viewName || typeof viewName !== 'string') {
    throw new Error('Invalid viewName: must be a non-empty string');
  }
  const parts = viewName.trim().split('.');
  if (parts.length === 1) {
    const validSchema = assertValidPgIdentifier(defaultSchema, 'schema');
    const validView = assertValidPgIdentifier(parts[0], 'viewName');
    return `${validSchema}.${validView}`;
  }
  if (parts.length === 2) {
    const validSchema = assertValidPgIdentifier(parts[0], 'schema');
    const validView = assertValidPgIdentifier(parts[1], 'viewName');
    return `${validSchema}.${validView}`;
  }
  throw new Error(
    `Invalid qualified viewName "${viewName}": expected "view" or "schema.view"`,
  );
}

/**
 * Parses a PostgreSQL `XXXX/YYYYYYYY` hexadecimal Log Sequence Number (LSN) into a 64-bit `bigint` byte offset.
 */
export function parsePgLsn(lsn: string): bigint {
  if (!lsn || typeof lsn !== 'string') {
    throw new Error('Invalid PostgreSQL LSN: must be a non-empty string');
  }

  const match = PG_LSN_REGEX.exec(lsn.trim());
  if (!match) {
    throw new Error(
      `Invalid PostgreSQL LSN format "${lsn}": expected hexadecimal "XXXX/YYYYYYYY"`,
    );
  }

  const upper = BigInt(`0x${match[1]}`);
  const lower = BigInt(`0x${match[2]}`);

  return (upper << 32n) + lower;
}

/**
 * Computes exact byte lag between publisher replication slot `confirmed_flush_lsn`
 * and subscriber `received_lsn`.
 */
export function calculateLsnLagBytes(
  confirmedFlushLsn: string,
  receivedLsn: string,
): number {
  const flushOffset = parsePgLsn(confirmedFlushLsn);
  const receivedOffset = parsePgLsn(receivedLsn);
  const diff =
    flushOffset >= receivedOffset
      ? flushOffset - receivedOffset
      : receivedOffset - flushOffset;
  return Number(diff);
}

/**
 * Evaluates PostgreSQL logical replication health across subscriber worker stats,
 * table synchronization states (`srsubstate`), and publisher replication slot LSN lag.
 */
export function evaluateLogicalReplicationHealth(
  input: EvaluateReplicationHealthInput,
): ReplicationHealthReport {
  const maxLagBytes = input.maxLagBytes ?? 10 * 1024 * 1024; // 10 MB
  const maxStaleMs = input.maxStaleMs ?? 300_000; // 5 minutes
  const nowDate =
    input.now instanceof Date
      ? input.now
      : typeof input.now === 'number'
        ? new Date(input.now)
        : new Date();
  const nowMs = nowDate.getTime();

  const issues: string[] = [];
  const warnings: string[] = [];
  let isHealthy = true;

  const metrics: ReplicationHealthMetrics = {
    tablesReady: 0,
    totalTables: input.relations.length,
    notReadyTables: [],
    lagBytes: null,
    lastMessageAgo: null,
    workerPid: null,
  };

  // 1. Evaluate subscription worker stats
  if (!input.stats) {
    isHealthy = false;
    issues.push('Subscription statistics not available');
  } else {
    metrics.workerPid = input.stats.pid ?? null;

    if (!input.stats.pid) {
      isHealthy = false;
      issues.push('Subscription worker process is not running');
    }

    if (input.stats.last_msg_receipt_time) {
      const receiptDate =
        input.stats.last_msg_receipt_time instanceof Date
          ? input.stats.last_msg_receipt_time
          : new Date(input.stats.last_msg_receipt_time);
      const receiptMs = receiptDate.getTime();

      if (!Number.isNaN(receiptMs)) {
        const timeSinceLastMsg = Math.max(0, nowMs - receiptMs);
        metrics.lastMessageAgo = timeSinceLastMsg;

        if (timeSinceLastMsg > maxStaleMs) {
          warnings.push(
            `No message received in ${Math.round(timeSinceLastMsg / 60000)} minutes`,
          );
        }
      }
    }
  }

  // 2. Evaluate table replication states (pg_subscription_rel)
  let hasFixableTableIssue = false;
  if (input.relations.length === 0) {
    isHealthy = false;
    hasFixableTableIssue = true;
    issues.push('No tables are being replicated - subscription needs refresh');
  } else {
    const readyTables = input.relations.filter((r) => r.srsubstate === 'r');
    const notReadyTables = input.relations.filter((r) => r.srsubstate !== 'r');

    metrics.tablesReady = readyTables.length;
    metrics.notReadyTables = notReadyTables.map((t) => t.srrelid);

    if (notReadyTables.length > 0) {
      isHealthy = false;
      hasFixableTableIssue = true;
      issues.push(
        `${notReadyTables.length} table(s) not in ready state: ${metrics.notReadyTables.join(', ')}`,
      );
    }
  }

  // 3. Evaluate publisher replication slot & LSN byte lag
  if (input.slot) {
    if (!input.slot.active) {
      isHealthy = false;
      issues.push('Replication slot is not active');
    }

    if (input.slot.confirmed_flush_lsn && input.stats?.received_lsn) {
      const lagBytes = calculateLsnLagBytes(
        input.slot.confirmed_flush_lsn,
        input.stats.received_lsn,
      );
      metrics.lagBytes = lagBytes;

      if (lagBytes > maxLagBytes) {
        warnings.push(
          `High replication lag: ${(lagBytes / 1024 / 1024).toFixed(2)} MB`,
        );
      }
    }
  }

  // 4. Determine whether auto-recovery (`ALTER SUBSCRIPTION ... REFRESH PUBLICATION`) should trigger
  const thresholdMet =
    input.consecutiveFailures === undefined
      ? true
      : input.consecutiveFailures >= (input.maxConsecutiveFailures ?? 3);

  const shouldTriggerAutoRecovery =
    !isHealthy && hasFixableTableIssue && thresholdMet;

  return {
    isHealthy,
    lastChecked: nowDate,
    issues,
    warnings,
    shouldTriggerAutoRecovery,
    metrics,
  };
}

/**
 * Safely validates the subscription identifier and builds the PostgreSQL
 * `ALTER SUBSCRIPTION <name> REFRESH PUBLICATION WITH (copy_data = true|false)` SQL statement.
 */
export function buildSubscriptionAutoRecoverySql(
  subscriptionName: string,
  copyData = true,
): string {
  const safeSubName = assertValidPgIdentifier(
    subscriptionName,
    'subscriptionName',
  );
  return `ALTER SUBSCRIPTION ${safeSubName} REFRESH PUBLICATION WITH (copy_data = ${copyData ? 'true' : 'false'})`;
}

/**
 * Detects whether a database error corresponds to PostgreSQL error code `22023`
 * (`invalid_parameter_value` / TimescaleDB `overlaps with existing range` when a window is already materialized).
 */
export function isAlreadyMaterializedPgError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const err = error as { message?: string; code?: string; meta?: { code?: string } };
  const message = typeof err.message === 'string' ? err.message : '';
  const dbCodeMatch = /Code:\s*`?(\w+)`?/i.exec(message);
  const extractedCode = dbCodeMatch?.[1] ?? err.code ?? err.meta?.code;

  return (
    extractedCode === '22023' ||
    message.toLowerCase().includes('overlaps with existing range')
  );
}

/**
 * Coordinates PostgreSQL `REFRESH MATERIALIZED VIEW CONCURRENTLY` and TimescaleDB
 * `CALL refresh_continuous_aggregate(...)` using session-level `pg_try_advisory_lock(hashtext(lockKey))`
 * to prevent overlapping refreshes across cron ticks or worker instances.
 */
export class AdvisoryLockedViewRefresher {
  constructor(private readonly executor: PgSqlExecutor) {}

  /**
   * Attempts to acquire a non-blocking session advisory lock via `pg_try_advisory_lock(hashtext($1))`.
   */
  async tryAcquireLock(lockKey: string): Promise<boolean> {
    const rows = await this.executor.queryRaw<{ locked?: boolean }>(
      'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
      [lockKey],
    );
    return Boolean(rows[0]?.locked);
  }

  /**
   * Best-effort release of session advisory lock via `pg_advisory_unlock(hashtext($1))`.
   */
  async releaseLock(lockKey: string): Promise<void> {
    try {
      await this.executor.executeRaw(
        'SELECT pg_advisory_unlock(hashtext($1))',
        [lockKey],
      );
    } catch {
      // Best-effort unlock; session-scoped advisory locks auto-release on disconnect
    }
  }

  /**
   * Refreshes a TimescaleDB Continuous Aggregate within an advisory lock,
   * skipping overlapping runs and gracefully treating error `22023` as already materialized.
   */
  async refreshContinuousAggregate(
    options: RefreshContinuousAggregateOptions,
  ): Promise<ViewRefreshResult> {
    const qualifiedView = toQualifiedViewName(
      options.viewName,
      options.schema ?? 'public',
    );
    const startOffsetMs = Math.floor(options.startOffsetMs);
    if (!Number.isFinite(startOffsetMs) || startOffsetMs < 0) {
      throw new Error(
        `Invalid startOffsetMs "${options.startOffsetMs}": must be a non-negative integer`,
      );
    }

    const currentUnixMsSql =
      options.currentUnixMsSql ?? 'public.current_unix_ms()';
    const endWindowSql = options.endWindowSql ?? 'NULL';
    const lockPrefix = options.lockPrefix ?? 'cagg-refresh';
    const lockKey = `${lockPrefix}:${qualifiedView}`;

    const startTime = Date.now();
    let hasLock = false;

    try {
      hasLock = await this.tryAcquireLock(lockKey);
      if (!hasLock) {
        return {
          status: 'skipped_locked',
          viewName: qualifiedView,
          lockKey,
          durationMs: Date.now() - startTime,
        };
      }

      await this.executor.executeRaw(
        `CALL refresh_continuous_aggregate('${qualifiedView}', ${currentUnixMsSql} - ${startOffsetMs}, ${endWindowSql})`,
      );

      return {
        status: 'refreshed',
        viewName: qualifiedView,
        lockKey,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      if (isAlreadyMaterializedPgError(error)) {
        return {
          status: 'skipped_already_materialized',
          viewName: qualifiedView,
          lockKey,
          durationMs: Date.now() - startTime,
        };
      }
      throw error;
    } finally {
      if (hasLock) {
        await this.releaseLock(lockKey);
      }
    }
  }

  /**
   * Refreshes a standard PostgreSQL Materialized View (with `CONCURRENTLY` by default)
   * guarded by a non-blocking advisory lock.
   */
  async refreshMaterializedView(
    options: RefreshMaterializedViewOptions,
  ): Promise<ViewRefreshResult> {
    const qualifiedView = toQualifiedViewName(
      options.viewName,
      options.schema ?? 'public',
    );
    const concurrently = options.concurrently ?? true;
    const useAdvisoryLock = options.useAdvisoryLock ?? true;
    const lockPrefix = options.lockPrefix ?? 'matview-refresh';
    const lockKey = `${lockPrefix}:${qualifiedView}`;

    const startTime = Date.now();
    let hasLock = false;

    try {
      if (useAdvisoryLock) {
        hasLock = await this.tryAcquireLock(lockKey);
        if (!hasLock) {
          return {
            status: 'skipped_locked',
            viewName: qualifiedView,
            lockKey,
            durationMs: Date.now() - startTime,
          };
        }
      }

      const concurrentClause = concurrently ? 'CONCURRENTLY ' : '';
      await this.executor.executeRaw(
        `REFRESH MATERIALIZED VIEW ${concurrentClause}${qualifiedView}`,
      );

      return {
        status: 'refreshed',
        viewName: qualifiedView,
        lockKey,
        durationMs: Date.now() - startTime,
      };
    } finally {
      if (hasLock) {
        await this.releaseLock(lockKey);
      }
    }
  }

  /**
   * Sequentially refreshes a batch of TimescaleDB Continuous Aggregate windows
   * followed by optional standard Materialized Views.
   */
  async refreshBatch(
    caggWindows: CaggRefreshWindow[],
    materializedViews: string[] = [],
    schema = 'public',
  ): Promise<ViewRefreshResult[]> {
    const results: ViewRefreshResult[] = [];

    for (const window of caggWindows) {
      const res = await this.refreshContinuousAggregate({
        viewName: window.viewName,
        startOffsetMs: window.startOffsetMs,
        schema,
      });
      results.push(res);
    }

    for (const viewName of materializedViews) {
      const res = await this.refreshMaterializedView({
        viewName,
        schema,
        concurrently: true,
      });
      results.push(res);
    }

    return results;
  }
}
