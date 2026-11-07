/**
 * @kido/offline-sync — PostgreSQL Declarative Range Partitioning & Pruning Bounds
 *
 * Self-contained zero-extension (pg_partman equivalent) partition planner and
 * pruning bounds builder for PostgreSQL 14+ declarative range-partitioned tables.
 */

import type {
  DeclarativePartParentOptions,
  MonthlyPartitionSpec,
  PartitionPruningBounds,
  PlanMonthlyPartitionsOptions,
  PlanWeeklyPartitionsOptions,
  WeeklyPartitionSpec,
} from './types';

const PG_IDENTIFIER_REGEX = /^[a-zA-Z_][a-zA-Z0-9_$]{0,62}$/;

/**
 * Validates a PostgreSQL identifier (table, schema, column name)
 * to prevent SQL injection in DDL generation.
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
 * Builds deterministic partition pruning bounds with a clock-skew buffer.
 * Used for `WHERE created_at >= minCreatedIso AND created_at <= maxCreatedIso`
 * so PostgreSQL query planner prunes irrelevant chunks and scans only matching partitions.
 */
export function buildPartitionPruningBounds(
  startTimestampMs: number,
  endTimestampMs?: number,
  skewBufferMs = 60_000,
): PartitionPruningBounds {
  if (!Number.isFinite(startTimestampMs)) {
    throw new Error('startTimestampMs must be a finite number');
  }
  if (!Number.isFinite(skewBufferMs) || skewBufferMs < 0) {
    throw new Error('skewBufferMs must be a non-negative number');
  }

  const effectiveEndMs = endTimestampMs !== undefined ? endTimestampMs : Date.now();
  if (!Number.isFinite(effectiveEndMs)) {
    throw new Error('endTimestampMs must be a finite number');
  }
  if (effectiveEndMs < startTimestampMs) {
    throw new Error('endTimestampMs cannot be earlier than startTimestampMs');
  }

  const boundedStart = Math.max(0, Math.floor(startTimestampMs - skewBufferMs));
  const boundedEnd = Math.floor(effectiveEndMs + skewBufferMs);

  return {
    minCreatedIso: new Date(boundedStart).toISOString(),
    maxCreatedIso: new Date(boundedEnd).toISOString(),
    startTimestampMs: boundedStart,
    endTimestampMs: boundedEnd,
  };
}

/**
 * Resolves a deterministic ISO cutoff string for cold data fallback.
 * Prevents full-table or all-chunk sequential scans on queries without explicit time bounds.
 */
export function resolveColdFallbackCutoffIso(
  coldFallbackDays = 90,
  nowMs = Date.now(),
): string {
  if (!Number.isFinite(coldFallbackDays) || coldFallbackDays <= 0) {
    throw new Error('coldFallbackDays must be a positive number');
  }
  if (!Number.isFinite(nowMs)) {
    throw new Error('nowMs must be a finite number');
  }

  const cutoffMs = nowMs - coldFallbackDays * 86_400_000;
  return new Date(cutoffMs).toISOString();
}

/**
 * Plans deterministic UTC monthly partition specifications for a parent table.
 * Generates partition names (e.g. `activity_log_2026_10`), range boundaries, and idempotent CREATE TABLE SQL.
 */
export function planMonthlyPartitions(
  options: PlanMonthlyPartitionsOptions,
): MonthlyPartitionSpec[] {
  const schema = assertValidPgIdentifier(options.schema ?? 'public', 'schema');
  const tableName = assertValidPgIdentifier(options.tableName, 'tableName');

  const refDate =
    options.referenceDate instanceof Date
      ? options.referenceDate
      : typeof options.referenceDate === 'number'
        ? new Date(options.referenceDate)
        : new Date();

  if (Number.isNaN(refDate.getTime())) {
    throw new Error('Invalid referenceDate: must be a valid Date or timestamp');
  }

  const premakeMonths = Math.max(0, options.premakeMonths ?? 1);
  const lookbackMonths = Math.max(0, options.lookbackMonths ?? 0);

  const refYear = refDate.getUTCFullYear();
  const refMonth = refDate.getUTCMonth(); // 0-indexed

  const specs: MonthlyPartitionSpec[] = [];

  for (let offset = -lookbackMonths; offset <= premakeMonths; offset++) {
    const totalMonthIndex = refMonth + offset;
    const targetYear = refYear + Math.floor(totalMonthIndex / 12);
    const targetMonth = ((totalMonthIndex % 12) + 12) % 12;

    const startDate = new Date(Date.UTC(targetYear, targetMonth, 1, 0, 0, 0, 0));
    const endDate = new Date(Date.UTC(targetYear, targetMonth + 1, 1, 0, 0, 0, 0));

    const monthStr = String(targetMonth + 1).padStart(2, '0');
    const partitionName = `${tableName}_${targetYear}_${monthStr}`;
    const qualifiedPartitionName = `${schema}.${partitionName}`;
    const qualifiedParentName = `${schema}.${tableName}`;

    const rangeStartIso = startDate.toISOString();
    const rangeEndIso = endDate.toISOString();

    const createSql =
      `CREATE TABLE IF NOT EXISTS ${qualifiedPartitionName} ` +
      `PARTITION OF ${qualifiedParentName} ` +
      `FOR VALUES FROM ('${rangeStartIso}') TO ('${rangeEndIso}');`;

    specs.push({
      partitionName,
      qualifiedPartitionName,
      rangeStartIso,
      rangeEndIso,
      createSql,
    });
  }

  return specs;
}

/**
 * Plans deterministic UTC weekly (7-day) partition specifications for a parent table.
 * Uses ISO 8601 week numbering (e.g. `activity_log_2026_w44`) with Monday-to-Monday boundaries.
 */
export function planWeeklyPartitions(
  options: PlanWeeklyPartitionsOptions,
): WeeklyPartitionSpec[] {
  const schema = assertValidPgIdentifier(options.schema ?? 'public', 'schema');
  const tableName = assertValidPgIdentifier(options.tableName, 'tableName');

  const refDate =
    options.referenceDate instanceof Date
      ? options.referenceDate
      : typeof options.referenceDate === 'number'
        ? new Date(options.referenceDate)
        : new Date();

  if (Number.isNaN(refDate.getTime())) {
    throw new Error('Invalid referenceDate: must be a valid Date or timestamp');
  }

  const premakeWeeks = Math.max(0, options.premakeWeeks ?? 1);
  const lookbackWeeks = Math.max(0, options.lookbackWeeks ?? 0);

  // Align to Monday 00:00:00.000 UTC of reference date
  const dayOfWeek = refDate.getUTCDay() || 7; // Monday = 1 ... Sunday = 7
  const refMonday = new Date(
    Date.UTC(
      refDate.getUTCFullYear(),
      refDate.getUTCMonth(),
      refDate.getUTCDate() - (dayOfWeek - 1),
      0,
      0,
      0,
      0,
    ),
  );

  const specs: WeeklyPartitionSpec[] = [];

  for (let offset = -lookbackWeeks; offset <= premakeWeeks; offset++) {
    const startMonday = new Date(refMonday.getTime() + offset * 7 * 86_400_000);
    const endMonday = new Date(startMonday.getTime() + 7 * 86_400_000);

    // ISO 8601 week calculation based on Thursday of the week
    const thursday = new Date(startMonday.getTime() + 3 * 86_400_000);
    const isoYear = thursday.getUTCFullYear();
    const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
    const firstMonday = new Date(
      Date.UTC(isoYear, 0, 4 - ((firstThursday.getUTCDay() || 7) - 1)),
    );
    const weekNumber =
      1 + Math.round((startMonday.getTime() - firstMonday.getTime()) / (7 * 86_400_000));

    const weekStr = String(weekNumber).padStart(2, '0');
    const partitionName = `${tableName}_${isoYear}_w${weekStr}`;
    const qualifiedPartitionName = `${schema}.${partitionName}`;
    const qualifiedParentName = `${schema}.${tableName}`;

    const rangeStartIso = startMonday.toISOString();
    const rangeEndIso = endMonday.toISOString();

    const createSql =
      `CREATE TABLE IF NOT EXISTS ${qualifiedPartitionName} ` +
      `PARTITION OF ${qualifiedParentName} ` +
      `FOR VALUES FROM ('${rangeStartIso}') TO ('${rangeEndIso}');`;

    specs.push({
      partitionName,
      qualifiedPartitionName,
      rangeStartIso,
      rangeEndIso,
      createSql,
    });
  }

  return specs;
}

/**
 * Builds idempotent SQL statement(s) to create a declarative range-partitioned parent table
 * and an optional default partition for unmatched ranges.
 */
export function buildDeclarativePartParentSql(
  options: DeclarativePartParentOptions,
): string {
  const schema = assertValidPgIdentifier(options.schema ?? 'public', 'schema');
  const tableName = assertValidPgIdentifier(options.tableName, 'tableName');
  const partitionColumn = assertValidPgIdentifier(
    options.partitionColumn ?? 'created_at',
    'partitionColumn',
  );

  if (!options.columnsSql || typeof options.columnsSql !== 'string') {
    throw new Error('columnsSql must be a non-empty string');
  }

  const trimmedColumns = options.columnsSql.trim().replace(/^;+|;+$/g, '');
  const parentSql = `CREATE TABLE IF NOT EXISTS ${schema}.${tableName} (\n  ${trimmedColumns}\n) PARTITION BY RANGE (${partitionColumn});`;

  if (options.createDefaultPartition) {
    const defaultPartitionName = `${tableName}_default`;
    const defaultSql = `CREATE TABLE IF NOT EXISTS ${schema}.${defaultPartitionName} PARTITION OF ${schema}.${tableName} DEFAULT;`;
    return `${parentSql}\n\n${defaultSql}`;
  }

  return parentSql;
}

/**
 * Returns the individual idempotent SQL statements for declarative parent table creation.
 */
export function buildDeclarativePartParentStatements(
  options: DeclarativePartParentOptions,
): string[] {
  const sql = buildDeclarativePartParentSql(options);
  return sql
    .split(';\n\n')
    .map((s) => (s.endsWith(';') ? s : `${s};`))
    .filter((s) => s.length > 1);
}
