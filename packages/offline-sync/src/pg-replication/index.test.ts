import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  parsePgLsn,
  calculateLsnLagBytes,
  evaluateLogicalReplicationHealth,
  buildSubscriptionAutoRecoverySql,
  assertValidPgIdentifier,
  toQualifiedViewName,
  isAlreadyMaterializedPgError,
  AdvisoryLockedViewRefresher,
  type PgSqlExecutor,
} from '../index';

describe('@kido/offline-sync — PostgreSQL Logical Replication & TimescaleDB CAGG Refresher', () => {
  test('1. parsePgLsn & calculateLsnLagBytes: accurately parses 64-bit hex LSNs and computes byte lag', () => {
    assert.equal(parsePgLsn('0/0'), 0n);
    assert.equal(parsePgLsn('0/16B3748'), 0x16b3748n);
    assert.equal(parsePgLsn('1/00000000'), 0x100000000n);
    assert.equal(parsePgLsn('2A/FF000100'), (0x2an << 32n) + 0xff000100n);

    // Exact 16 MB lag across upper/lower 32-bit boundary
    const flushLsn = '1/01000000';
    const receivedLsn = '1/00000000';
    assert.equal(calculateLsnLagBytes(flushLsn, receivedLsn), 16 * 1024 * 1024);
    assert.equal(calculateLsnLagBytes(receivedLsn, flushLsn), 16 * 1024 * 1024);

    assert.throws(() => parsePgLsn(''), /Invalid PostgreSQL LSN/);
    assert.throws(() => parsePgLsn('invalid-lsn'), /Invalid PostgreSQL LSN format/);
    assert.throws(() => parsePgLsn('123456789/0'), /Invalid PostgreSQL LSN format/);
  });

  test('2. evaluateLogicalReplicationHealth: reports healthy when worker is active, tables are ready, and lag is low', () => {
    const now = new Date('2026-10-16T12:00:00.000Z');
    const report = evaluateLogicalReplicationHealth({
      stats: {
        subname: 'processor_sub',
        pid: 4182,
        received_lsn: '0/16B3748',
        last_msg_receipt_time: new Date('2026-10-16T11:59:30.000Z'),
      },
      relations: [
        { srrelid: 'public.stocks', srsubstate: 'r' },
        { srrelid: 'public.stock_ohlc', srsubstate: 'r' },
      ],
      slot: {
        slot_name: 'processor_sub',
        active: true,
        confirmed_flush_lsn: '0/16B3848', // 256 bytes difference
      },
      now,
    });

    assert.equal(report.isHealthy, true);
    assert.equal(report.issues.length, 0);
    assert.equal(report.warnings.length, 0);
    assert.equal(report.shouldTriggerAutoRecovery, false);
    assert.equal(report.metrics.tablesReady, 2);
    assert.equal(report.metrics.totalTables, 2);
    assert.equal(report.metrics.lagBytes, 256);
    assert.equal(report.metrics.lastMessageAgo, 30_000);
    assert.equal(report.metrics.workerPid, 4182);
  });

  test('3. evaluateLogicalReplicationHealth: detects dead worker, non-ready tables, inactive slot, stale messages, and high lag', () => {
    const now = new Date('2026-10-16T12:00:00.000Z');
    const report = evaluateLogicalReplicationHealth({
      stats: {
        subname: 'processor_sub',
        pid: null,
        received_lsn: '1/00000000',
        last_msg_receipt_time: new Date('2026-10-16T11:45:00.000Z'), // 15 mins ago
      },
      relations: [
        { srrelid: 'public.stocks', srsubstate: 'r' },
        { srrelid: 'public.news', srsubstate: 'd' }, // copying data, not ready
      ],
      slot: {
        slot_name: 'processor_sub',
        active: false,
        confirmed_flush_lsn: '1/02000000', // 32 MB lag
      },
      consecutiveFailures: 3,
      maxConsecutiveFailures: 3,
      now,
    });

    assert.equal(report.isHealthy, false);
    assert.equal(report.shouldTriggerAutoRecovery, true);
    assert.equal(report.metrics.tablesReady, 1);
    assert.equal(report.metrics.totalTables, 2);
    assert.deepEqual(report.metrics.notReadyTables, ['public.news']);
    assert.equal(report.metrics.lagBytes, 32 * 1024 * 1024);

    assert.ok(
      report.issues.includes('Subscription worker process is not running'),
    );
    assert.ok(
      report.issues.includes('1 table(s) not in ready state: public.news'),
    );
    assert.ok(report.issues.includes('Replication slot is not active'));
    assert.ok(
      report.warnings.some((w) => w.includes('No message received in 15 minutes')),
    );
    assert.ok(
      report.warnings.some((w) => w.includes('High replication lag: 32.00 MB')),
    );
  });

  test('4. evaluateLogicalReplicationHealth: gates auto-recovery on consecutiveFailures when specified', () => {
    const reportBelowThreshold = evaluateLogicalReplicationHealth({
      stats: { subname: 'processor_sub', pid: 1001, received_lsn: '0/100' },
      relations: [],
      slot: null,
      consecutiveFailures: 1,
      maxConsecutiveFailures: 3,
    });

    assert.equal(reportBelowThreshold.isHealthy, false);
    assert.equal(reportBelowThreshold.shouldTriggerAutoRecovery, false);

    const reportAtThreshold = evaluateLogicalReplicationHealth({
      stats: { subname: 'processor_sub', pid: 1001, received_lsn: '0/100' },
      relations: [],
      slot: null,
      consecutiveFailures: 3,
      maxConsecutiveFailures: 3,
    });

    assert.equal(reportAtThreshold.isHealthy, false);
    assert.equal(reportAtThreshold.shouldTriggerAutoRecovery, true);
  });

  test('5. buildSubscriptionAutoRecoverySql & identifier validation: prevents SQL injection', () => {
    assert.equal(
      buildSubscriptionAutoRecoverySql('processor_sub'),
      'ALTER SUBSCRIPTION processor_sub REFRESH PUBLICATION WITH (copy_data = true)',
    );
    assert.equal(
      buildSubscriptionAutoRecoverySql('analytics_sub_01', false),
      'ALTER SUBSCRIPTION analytics_sub_01 REFRESH PUBLICATION WITH (copy_data = false)',
    );

    assert.throws(
      () => buildSubscriptionAutoRecoverySql('processor_sub; DROP TABLE users;--'),
      /Invalid PostgreSQL subscriptionName/,
    );
    assert.throws(
      () => assertValidPgIdentifier('123_invalid'),
      /Invalid PostgreSQL identifier/,
    );
    assert.equal(
      toQualifiedViewName('stock_ohlc_5m'),
      'public.stock_ohlc_5m',
    );
    assert.equal(
      toQualifiedViewName('market.stock_ohlc_5m'),
      'market.stock_ohlc_5m',
    );
  });

  test('6. AdvisoryLockedViewRefresher: coordinates CAGG & Materialized View refresh, skips overlapping locks, and handles PG 22023 gracefully', async () => {
    const executedLog: Array<{ sql: string; params?: unknown[] }> = [];
    let lockAvailable = true;
    let throwOverlapError = false;

    const mockExecutor: PgSqlExecutor = {
      async queryRaw<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
        executedLog.push({ sql, params });
        if (sql.includes('pg_try_advisory_lock')) {
          return [{ locked: lockAvailable } as unknown as T];
        }
        return [];
      },
      async executeRaw(sql: string, params?: unknown[]): Promise<unknown> {
        executedLog.push({ sql, params });
        if (throwOverlapError && sql.includes('refresh_continuous_aggregate')) {
          const err = new Error(
            'Raw query failed. Code: `22023`. Message: refresh window too small / overlaps with existing range',
          );
          throw err;
        }
        return 1;
      },
    };

    const refresher = new AdvisoryLockedViewRefresher(mockExecutor);

    // Case A: Successful CAGG refresh acquires and releases advisory lock
    const res1 = await refresher.refreshContinuousAggregate({
      viewName: 'stock_ohlc_1m',
      startOffsetMs: 3_600_000,
    });
    assert.equal(res1.status, 'refreshed');
    assert.equal(res1.viewName, 'public.stock_ohlc_1m');
    assert.equal(res1.lockKey, 'cagg-refresh:public.stock_ohlc_1m');
    assert.ok(
      executedLog.some((e) =>
        e.sql.includes(
          "CALL refresh_continuous_aggregate('public.stock_ohlc_1m', public.current_unix_ms() - 3600000, NULL)",
        ),
      ),
    );
    assert.ok(
      executedLog.some(
        (e) =>
          e.sql.includes('pg_advisory_unlock') &&
          e.params?.[0] === 'cagg-refresh:public.stock_ohlc_1m',
      ),
    );

    // Case B: Lock already held by another worker -> skips cleanly without unlocking someone else's lock
    executedLog.length = 0;
    lockAvailable = false;
    const res2 = await refresher.refreshContinuousAggregate({
      viewName: 'stock_ohlc_1m',
      startOffsetMs: 3_600_000,
    });
    assert.equal(res2.status, 'skipped_locked');
    assert.equal(executedLog.length, 1); // Only pg_try_advisory_lock was called

    // Case C: PostgreSQL error 22023 (overlaps with existing range) -> treated as skipped_already_materialized and unlocks
    executedLog.length = 0;
    lockAvailable = true;
    throwOverlapError = true;
    const res3 = await refresher.refreshContinuousAggregate({
      viewName: 'stock_ohlc_5m',
      startOffsetMs: 7_200_000,
    });
    assert.equal(res3.status, 'skipped_already_materialized');
    assert.ok(isAlreadyMaterializedPgError({ code: '22023' }));
    assert.ok(
      executedLog.some((e) => e.sql.includes('pg_advisory_unlock')),
      'Advisory lock must still be released in finally block after 22023',
    );

    // Case D: Batch refresh of CAGG windows + Materialized View CONCURRENTLY
    executedLog.length = 0;
    throwOverlapError = false;
    const batchResults = await refresher.refreshBatch(
      [{ viewName: 'stock_ohlc_15m', startOffsetMs: 86_400_000 }],
      ['stock_ohlc_day_latest'],
    );
    assert.equal(batchResults.length, 2);
    assert.equal(batchResults[0].status, 'refreshed');
    assert.equal(batchResults[1].status, 'refreshed');
    assert.ok(
      executedLog.some(
        (e) =>
          e.sql ===
          'REFRESH MATERIALIZED VIEW CONCURRENTLY public.stock_ohlc_day_latest',
      ),
    );
  });
});
