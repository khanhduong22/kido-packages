/**
 * @kido/offline-sync — PostgreSQL Partition Archiver Test Suite
 *
 * Tests:
 * 1. Declarative Range Partitioning & Pruning Bounds
 * 2. Zero-Lock Detach & Cold-Tier S3/R2 Offload Engine
 * 3. TimescaleDB Hypertable & Storage Policy Builder
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ColdTierPartitionArchiver,
  assertValidPgIdentifier,
  buildDeclarativePartParentSql,
  buildDeclarativePartParentStatements,
  buildDetachPartitionSql,
  buildPartitionPruningBounds,
  buildTimescaleHypertablePolicySql,
  buildTimescaleHypertablePolicyStatements,
  compressRowsToNdjsonGzip,
  decompressNdjsonGzipToRows,
  planMonthlyPartitions,
  planWeeklyPartitions,
  resolveColdFallbackCutoffIso,
} from './index';
import type { ColdStorageAdapter, ColdStoragePutResult, PgSqlExecutor } from './types';

describe('@kido/offline-sync — pg-partition-archiver', () => {
  describe('Pattern 1: Declarative Range Partitioning & Partition Pruning', () => {
    it('buildPartitionPruningBounds: calculates bounded ISO range with 60s skew buffer', () => {
      const startMs = 1761825600000; // 2025-10-30T12:00:00.000Z
      const endMs = 1761832800000; // 2025-10-30T14:00:00.000Z

      const bounds = buildPartitionPruningBounds(startMs, endMs, 60_000);

      assert.equal(bounds.startTimestampMs, startMs - 60_000);
      assert.equal(bounds.endTimestampMs, endMs + 60_000);
      assert.equal(bounds.minCreatedIso, new Date(startMs - 60_000).toISOString());
      assert.equal(bounds.maxCreatedIso, new Date(endMs + 60_000).toISOString());
    });

    it('buildPartitionPruningBounds: defaults end timestamp and handles zero floor', () => {
      const bounds = buildPartitionPruningBounds(10_000, 20_000, 30_000);
      assert.equal(bounds.startTimestampMs, 0); // Math.max(0, 10000 - 30000)
      assert.equal(bounds.minCreatedIso, '1970-01-01T00:00:00.000Z');

      assert.throws(
        () => buildPartitionPruningBounds(5000, 1000),
        /endTimestampMs cannot be earlier than startTimestampMs/,
      );
    });

    it('resolveColdFallbackCutoffIso: computes deterministic cutoff date', () => {
      const nowMs = new Date('2026-10-30T00:00:00.000Z').getTime();
      const cutoff = resolveColdFallbackCutoffIso(90, nowMs);

      const expectedDate = new Date(nowMs - 90 * 86_400_000).toISOString();
      assert.equal(cutoff, expectedDate);

      assert.throws(
        () => resolveColdFallbackCutoffIso(0),
        /coldFallbackDays must be a positive number/,
      );
    });

    it('planMonthlyPartitions: generates deterministic monthly partition specs', () => {
      const refDate = new Date('2026-10-15T10:00:00.000Z');
      const specs = planMonthlyPartitions({
        tableName: 'activity_log',
        schema: 'analytics',
        referenceDate: refDate,
        lookbackMonths: 1,
        premakeMonths: 1,
      });

      assert.equal(specs.length, 3);
      assert.equal(specs[0].partitionName, 'activity_log_2026_09');
      assert.equal(specs[1].partitionName, 'activity_log_2026_10');
      assert.equal(specs[2].partitionName, 'activity_log_2026_11');

      assert.equal(specs[1].rangeStartIso, '2026-10-01T00:00:00.000Z');
      assert.equal(specs[1].rangeEndIso, '2026-11-01T00:00:00.000Z');
      assert.equal(specs[1].qualifiedPartitionName, 'analytics.activity_log_2026_10');
      assert.match(
        specs[1].createSql,
        /CREATE TABLE IF NOT EXISTS analytics\.activity_log_2026_10 PARTITION OF analytics\.activity_log FOR VALUES FROM \('2026-10-01T00:00:00\.000Z'\) TO \('2026-11-01T00:00:00\.000Z'\);/,
      );
    });

    it('planWeeklyPartitions: generates deterministic UTC 7-day specs with ISO week number', () => {
      const refDate = new Date('2026-10-30T14:28:25.000Z'); // Friday of Week 44
      const specs = planWeeklyPartitions({
        tableName: 'activity_log',
        schema: 'public',
        referenceDate: refDate,
        lookbackWeeks: 0,
        premakeWeeks: 0,
      });

      assert.equal(specs.length, 1);
      assert.equal(specs[0].partitionName, 'activity_log_2026_w44');
      assert.equal(specs[0].qualifiedPartitionName, 'public.activity_log_2026_w44');
      assert.equal(specs[0].rangeStartIso, '2026-10-26T00:00:00.000Z'); // Monday
      assert.equal(specs[0].rangeEndIso, '2026-11-02T00:00:00.000Z'); // Next Monday
      assert.match(specs[0].createSql, /PARTITION OF public\.activity_log/);
    });

    it('buildDeclarativePartParentSql: builds parent table DDL and optional default partition', () => {
      const ddl = buildDeclarativePartParentSql({
        tableName: 'audit_events',
        schema: 'security',
        partitionColumn: 'recorded_at',
        columnsSql: 'id uuid PRIMARY KEY, payload jsonb, recorded_at timestamptz NOT NULL',
        createDefaultPartition: true,
      });

      assert.match(ddl, /CREATE TABLE IF NOT EXISTS security\.audit_events/);
      assert.match(ddl, /PARTITION BY RANGE \(recorded_at\);/);
      assert.match(
        ddl,
        /CREATE TABLE IF NOT EXISTS security\.audit_events_default PARTITION OF security\.audit_events DEFAULT;/,
      );

      const statements = buildDeclarativePartParentStatements({
        tableName: 'events',
        columnsSql: 'id text, created_at timestamptz',
        createDefaultPartition: false,
      });
      assert.equal(statements.length, 1);
    });

    it('assertValidPgIdentifier: prevents SQL injection in identifiers', () => {
      assert.throws(
        () => assertValidPgIdentifier('evil; DROP TABLE users;--'),
        /Invalid PostgreSQL identifier/,
      );
      assert.throws(() => assertValidPgIdentifier(''), /non-empty string/);
      assert.equal(assertValidPgIdentifier('valid_table_name_1'), 'valid_table_name_1');
    });
  });

  describe('Pattern 2: Zero-Lock Partition Detach & Cold-Tier S3/R2 Offload Engine', () => {
    it('buildDetachPartitionSql: builds CONCURRENTLY and non-concurrent detach statements', () => {
      const concurrentSql = buildDetachPartitionSql('orders', 'orders_2026_09', {
        schema: 'ecommerce',
        concurrently: true,
      });
      assert.equal(
        concurrentSql,
        'ALTER TABLE ecommerce.orders DETACH PARTITION ecommerce.orders_2026_09 CONCURRENTLY;',
      );

      const standardSql = buildDetachPartitionSql('orders', 'orders_2026_09', {
        concurrently: false,
      });
      assert.equal(
        standardSql,
        'ALTER TABLE public.orders DETACH PARTITION public.orders_2026_09;',
      );
    });

    it('compressRowsToNdjsonGzip & decompress: verifies round-trip row parity and checksum', () => {
      const sampleRows = [
        { id: '1', user: 'alice', amount: 120.5, meta: { active: true } },
        { id: '2', user: 'bob', amount: 99.0, meta: { active: false } },
      ];

      const { buffer, manifest } = compressRowsToNdjsonGzip(sampleRows, {
        tableName: 'transactions',
        partitionName: 'transactions_2026_08',
        rangeStartIso: '2026-08-01T00:00:00.000Z',
        rangeEndIso: '2026-09-01T00:00:00.000Z',
        keyPrefix: 'cold-storage',
      });

      assert.equal(manifest.rowCount, 2);
      assert.equal(manifest.tableName, 'transactions');
      assert.equal(manifest.partitionName, 'transactions_2026_08');
      assert.equal(
        manifest.objectKey,
        'cold-storage/transactions/transactions_2026_08.ndjson.gz',
      );
      assert.ok(manifest.compressedBytes > 0);
      assert.ok(manifest.sha256Checksum.length === 64);

      // Decompress and verify
      const restored = decompressNdjsonGzipToRows<typeof sampleRows[0]>(
        buffer,
        manifest.sha256Checksum,
      );
      assert.deepEqual(restored, sampleRows);

      // Checksum mismatch detection
      assert.throws(
        () => decompressNdjsonGzipToRows(buffer, '0000000000000000000000000000000000000000000000000000000000000000'),
        /SHA-256 checksum mismatch/,
      );
    });

    it('ColdTierPartitionArchiver: end-to-end archiver workflow with safe drop', async () => {
      const executedSql: string[] = [];
      const uploadedObjects: Record<string, { body: Buffer; metadata?: Record<string, string> }> = {};

      const mockSqlExecutor: PgSqlExecutor = {
        async executeRaw(sql: string) {
          executedSql.push(sql);
          return null;
        },
        async queryRaw<T>() {
          return [
            { id: 'tx-1', status: 'SETTLED', fee: 15 },
            { id: 'tx-2', status: 'REFUNDED', fee: 0 },
          ] as unknown as T[];
        },
      };

      const mockStorageAdapter: ColdStorageAdapter = {
        async putObject(params) {
          uploadedObjects[params.key] = {
            body: params.body,
            metadata: params.metadata,
          };
          return {
            uploadedBytes: params.body.byteLength,
            uploadedSha256: params.metadata?.sha256 ?? 'fake-sha',
            objectKey: params.key,
          };
        },
      };

      const archiver = new ColdTierPartitionArchiver({
        sqlExecutor: mockSqlExecutor,
        storageAdapter: mockStorageAdapter,
      });

      const result = await archiver.archivePartition({
        parentTable: 'activity_log',
        partitionName: 'activity_log_2026_07',
        schema: 'public',
        rangeStartIso: '2026-07-01T00:00:00.000Z',
        rangeEndIso: '2026-08-01T00:00:00.000Z',
        dropAfterVerify: true,
      });

      assert.equal(result.detached, true);
      assert.equal(result.dropped, true);
      assert.equal(result.manifest.rowCount, 2);

      // Verify SQL execution order
      assert.equal(
        executedSql[0],
        'ALTER TABLE public.activity_log DETACH PARTITION public.activity_log_2026_07 CONCURRENTLY;',
      );
      assert.equal(
        executedSql[1],
        'DROP TABLE IF EXISTS public.activity_log_2026_07;',
      );

      // Verify upload occurred
      assert.ok(uploadedObjects[result.manifest.objectKey]);
      assert.ok(uploadedObjects[`${result.manifest.objectKey}.manifest.json`]);
    });

    it('ColdTierPartitionArchiver: strict safety invariant prevents DROP TABLE on checksum mismatch', async () => {
      const executedSql: string[] = [];

      const mockSqlExecutor: PgSqlExecutor = {
        async executeRaw(sql: string) {
          executedSql.push(sql);
          return null;
        },
        async queryRaw<T>() {
          return [{ id: 'tx-1' }] as unknown as T[];
        },
      };

      const faultyStorageAdapter: ColdStorageAdapter = {
        async putObject(params) {
          return {
            uploadedBytes: params.body.byteLength,
            uploadedSha256: 'corrupted_or_mismatched_checksum',
            objectKey: params.key,
          };
        },
      };

      const archiver = new ColdTierPartitionArchiver({
        sqlExecutor: mockSqlExecutor,
        storageAdapter: faultyStorageAdapter,
      });

      await assert.rejects(
        () =>
          archiver.archivePartition({
            parentTable: 'activity_log',
            partitionName: 'activity_log_2026_07',
            schema: 'public',
            rangeStartIso: '2026-07-01T00:00:00.000Z',
            rangeEndIso: '2026-08-01T00:00:00.000Z',
            dropAfterVerify: true,
          }),
        /Cold archive verification failed.*Detached partition was NOT dropped/,
      );

      // CRITICAL ASSERTION: executedSql MUST NOT contain DROP TABLE
      const dropAttempt = executedSql.find((sql) => sql.includes('DROP TABLE'));
      assert.equal(dropAttempt, undefined, 'DROP TABLE must never be executed on verification failure');
    });
  });

  describe('Pattern 3: TimescaleDB Hypertable & Storage Policy Builder', () => {
    it('buildTimescaleHypertablePolicySql: generates all 5 idempotent TimescaleDB statements', () => {
      const sql = buildTimescaleHypertablePolicySql({
        tableName: 'device_telemetry',
        schema: 'iot',
        timeColumn: 'recorded_at',
        chunkInterval: '7 days',
        segmentBy: ['tenant_id', 'device_type'],
        orderBy: 'recorded_at DESC',
        compressAfter: '14 days',
        retainAfter: '90 days',
      });

      assert.match(
        sql,
        /SELECT create_hypertable\('iot\.device_telemetry', 'recorded_at', chunk_time_interval => INTERVAL '7 days', if_not_exists => TRUE\);/,
      );
      assert.match(
        sql,
        /SELECT set_chunk_time_interval\('iot\.device_telemetry', INTERVAL '7 days'\);/,
      );
      assert.match(
        sql,
        /ALTER TABLE iot\.device_telemetry SET \(timescaledb\.compress, timescaledb\.compress_segmentby = 'tenant_id, device_type', timescaledb\.compress_orderby = 'recorded_at DESC'\);/,
      );
      assert.match(
        sql,
        /SELECT add_compression_policy\('iot\.device_telemetry', INTERVAL '14 days', if_not_exists => TRUE\);/,
      );
      assert.match(
        sql,
        /SELECT add_retention_policy\('iot\.device_telemetry', INTERVAL '90 days', if_not_exists => TRUE\);/,
      );

      const statements = buildTimescaleHypertablePolicyStatements({
        tableName: 'price_ticks',
        spaceColumn: 'symbol',
        spacePartitions: 4,
        compressAfter: '7 days',
      });
      assert.equal(statements.length, 5);
      assert.equal(
        statements[2],
        "SELECT add_dimension('public.price_ticks', by_hash('symbol', 4), if_not_exists => TRUE);",
      );
    });

    it('buildTimescaleHypertablePolicySql: rejects invalid interval strings to prevent SQL injection', () => {
      assert.throws(
        () =>
          buildTimescaleHypertablePolicySql({
            tableName: 'logs',
            chunkInterval: "7 days'; DROP TABLE logs; --",
          }),
        /Invalid PostgreSQL chunkInterval/,
      );
    });
  });
});
