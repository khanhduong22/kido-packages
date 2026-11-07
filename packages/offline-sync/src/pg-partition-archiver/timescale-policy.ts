/**
 * @kido/offline-sync — TimescaleDB Hypertable & Tiered Storage Policy Builder
 *
 * Generates idempotent SQL statements for TimescaleDB:
 * 1. Hypertable initialization with custom chunk intervals (default 7 days)
 * 2. Explicit chunk interval enforcement
 * 3. Compression settings with segmentby and orderby columns
 * 4. Automated compression policy (INTERVAL ...)
 * 5. Automated retention / drop chunk policy (INTERVAL ...)
 */

import { assertValidPgIdentifier } from './declarative-partition';
import type { TimescaleHypertablePolicyOptions } from './types';

const INTERVAL_REGEX = /^[0-9]+\s+[a-zA-Z]+$/;

/**
 * Validates a PostgreSQL / TimescaleDB interval string (e.g. "7 days", "14 days", "90 days").
 */
export function assertValidInterval(interval: string, label = 'interval'): string {
  if (!interval || typeof interval !== 'string') {
    throw new Error(`Invalid PostgreSQL ${label}: must be a non-empty string`);
  }
  const trimmed = interval.trim();
  if (!INTERVAL_REGEX.test(trimmed)) {
    throw new Error(
      `Invalid PostgreSQL ${label} "${interval}": expected format e.g. "7 days" or "90 days"`,
    );
  }
  return trimmed;
}

/**
 * Validates an ORDER BY column expression (e.g. "created_at DESC" or "timestamp ASC").
 */
export function assertValidOrderBy(orderBy: string): string {
  if (!orderBy || typeof orderBy !== 'string') {
    throw new Error('Invalid orderBy: must be a non-empty string');
  }
  const parts = orderBy.trim().split(/\s+/);
  if (parts.length > 2) {
    throw new Error(`Invalid orderBy expression: "${orderBy}"`);
  }
  assertValidPgIdentifier(parts[0], 'orderBy column');
  if (parts.length === 2) {
    const dir = parts[1].toUpperCase();
    if (dir !== 'ASC' && dir !== 'DESC') {
      throw new Error(`Invalid orderBy direction "${parts[1]}": expected ASC or DESC`);
    }
  }
  return orderBy.trim();
}

/**
 * Generates an array of individual idempotent TimescaleDB SQL statements
 * for hypertable creation, compression policies, and retention policies.
 */
export function buildTimescaleHypertablePolicyStatements(
  options: TimescaleHypertablePolicyOptions,
): string[] {
  const schema = assertValidPgIdentifier(options.schema ?? 'public', 'schema');
  const tableName = assertValidPgIdentifier(options.tableName, 'tableName');
  const timeColumn = assertValidPgIdentifier(
    options.timeColumn ?? 'created_at',
    'timeColumn',
  );
  const chunkInterval = assertValidInterval(
    options.chunkInterval ?? '7 days',
    'chunkInterval',
  );

  const statements: string[] = [];

  // 1. Create hypertable idempotently
  statements.push(
    `SELECT create_hypertable('${schema}.${tableName}', '${timeColumn}', chunk_time_interval => INTERVAL '${chunkInterval}', if_not_exists => TRUE);`,
  );

  // 2. Set chunk time interval
  statements.push(
    `SELECT set_chunk_time_interval('${schema}.${tableName}', INTERVAL '${chunkInterval}');`,
  );

  // 2b. Optional Space + Time Compound Partitioning (by_hash(spaceColumn, spacePartitions))
  if (options.spaceColumn !== undefined) {
    const safeSpaceCol = assertValidPgIdentifier(
      options.spaceColumn,
      'spaceColumn',
    );
    const numSlices = options.spacePartitions ?? 4;
    if (!Number.isInteger(numSlices) || numSlices <= 0) {
      throw new Error(
        `Invalid spacePartitions "${options.spacePartitions}": must be a positive integer`,
      );
    }
    statements.push(
      `SELECT add_dimension('${schema}.${tableName}', by_hash('${safeSpaceCol}', ${numSlices}), if_not_exists => TRUE);`,
    );
  }

  // 3 & 4. Compression configuration and compression policy
  if (options.segmentBy !== undefined || options.compressAfter !== undefined) {
    const orderBy = options.orderBy
      ? assertValidOrderBy(options.orderBy)
      : `${timeColumn} DESC`;

    let segmentClause = '';
    if (options.segmentBy !== undefined) {
      const segmentCols = Array.isArray(options.segmentBy)
        ? options.segmentBy
        : [options.segmentBy];

      if (segmentCols.length === 0) {
        throw new Error('segmentBy must contain at least one column identifier');
      }

      const safeCols = segmentCols.map((col) =>
        assertValidPgIdentifier(col, 'segmentBy column'),
      );
      segmentClause = `, timescaledb.compress_segmentby = '${safeCols.join(', ')}'`;
    }

    statements.push(
      `ALTER TABLE ${schema}.${tableName} SET (timescaledb.compress${segmentClause}, timescaledb.compress_orderby = '${orderBy}');`,
    );

    if (options.compressAfter !== undefined) {
      const compressAfter = assertValidInterval(
        options.compressAfter,
        'compressAfter',
      );
      statements.push(
        `SELECT add_compression_policy('${schema}.${tableName}', INTERVAL '${compressAfter}', if_not_exists => TRUE);`,
      );
    }
  }

  // 5. Retention policy
  if (options.retainAfter !== undefined) {
    const retainAfter = assertValidInterval(options.retainAfter, 'retainAfter');
    statements.push(
      `SELECT add_retention_policy('${schema}.${tableName}', INTERVAL '${retainAfter}', if_not_exists => TRUE);`,
    );
  }

  return statements;
}

/**
 * Generates idempotent TimescaleDB SQL statements joined into a single executable script.
 */
export function buildTimescaleHypertablePolicySql(
  options: TimescaleHypertablePolicyOptions,
): string {
  const statements = buildTimescaleHypertablePolicyStatements(options);
  return statements.join('\n\n');
}
