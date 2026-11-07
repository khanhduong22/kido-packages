import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PgRangePartitionManager,
  withPartitionPruningBounds,
  extractPruningBounds,
  ColdTierArchiver,
  createAuditEntry,
  GENESIS_HASH,
  type AuditEntry,
} from './index';

describe('PgRangePartitionManager (Declarative Range Partitioning)', () => {
  it('1.1 should compute monthly partition spec with UTC-safe boundaries', () => {
    const octDate = new Date('2026-10-15T12:00:00.000Z');
    const spec = PgRangePartitionManager.getMonthlyPartitionSpec(octDate, 'AuditLog');

    assert.equal(spec.partitionName, 'AuditLog_y2026m10');
    assert.equal(spec.year, 2026);
    assert.equal(spec.month, 10);
    assert.equal(spec.rangeStartIso, '2026-10-01T00:00:00.000Z');
    assert.equal(spec.rangeEndIso, '2026-11-01T00:00:00.000Z');
    assert.equal(spec.baseTable, 'AuditLog');
  });

  it('1.2 should cleanly handle December to January rollover in UTC', () => {
    const decDate = new Date('2026-12-31T23:59:59.999Z');
    const spec = PgRangePartitionManager.getMonthlyPartitionSpec(decDate, 'SessionAuditLog');

    assert.equal(spec.partitionName, 'SessionAuditLog_y2026m12');
    assert.equal(spec.year, 2026);
    assert.equal(spec.month, 12);
    assert.equal(spec.rangeStartIso, '2026-12-01T00:00:00.000Z');
    assert.equal(spec.rangeEndIso, '2027-01-01T00:00:00.000Z');
  });

  it('1.3 should format PostgreSQL timestamp literals properly', () => {
    const formatted = PgRangePartitionManager.formatPgTimestampLiteral('2026-10-01T00:00:00.000Z');
    assert.equal(formatted, '2026-10-01 00:00:00+00');
  });

  it('1.4 should generate PostgreSQL declarative partition DDL with BRIN index', () => {
    const spec = PgRangePartitionManager.getMonthlyPartitionSpec(new Date('2026-10-15T00:00:00.000Z'));
    const ddl = PgRangePartitionManager.buildPartitionDDL(spec, {
      timestampColumn: 'timestamp',
      brinPagesPerRange: 32,
    });

    assert.ok(ddl.includes('CREATE TABLE IF NOT EXISTS "AuditLog_y2026m10" PARTITION OF "AuditLog"'));
    assert.ok(ddl.includes("FOR VALUES FROM ('2026-10-01 00:00:00+00') TO ('2026-11-01 00:00:00+00')"));
    assert.ok(ddl.includes('USING BRIN ("timestamp") WITH (pages_per_range = 32)'));
  });

  it('1.5 should support parent table DDL and additional local indexes', () => {
    const spec = PgRangePartitionManager.getMonthlyPartitionSpec(new Date('2026-10-01T00:00:00.000Z'), 'SessionAuditLog');
    const ddl = PgRangePartitionManager.buildPartitionDDL(spec, {
      timestampColumn: 'createdAt',
      includeParentDDL: true,
      additionalIndexes: [
        { columns: ['userId', 'createdAt'], using: 'btree' },
        { columns: ['action', 'createdAt'] },
      ],
    });

    assert.ok(ddl.includes('PARTITION BY RANGE ("createdAt")'));
    assert.ok(ddl.includes('CREATE TABLE IF NOT EXISTS "SessionAuditLog_default"'));
    assert.ok(ddl.includes('USING BRIN ("createdAt")'));
    assert.ok(ddl.includes('INDEX IF NOT EXISTS "idx_SessionAuditLog_y2026m10_userId_createdAt"'));
  });

  it('1.6 should generate zero-lock concurrent detach SQL', () => {
    const sql = PgRangePartitionManager.buildDetachPartitionConcurrentlySQL('AuditLog_y2025m06', 'AuditLog');
    assert.equal(sql, 'ALTER TABLE "AuditLog" DETACH PARTITION "AuditLog_y2025m06" CONCURRENTLY;');
  });

  it('1.7 should plan maintenance with premakeMonths and cold partitions', () => {
    const now = new Date('2026-10-15T00:00:00.000Z');
    const plan = PgRangePartitionManager.planPartitionMaintenance(now, {
      premakeMonths: 2,
      hotRetentionMonths: 3,
      lookbackMonthsForDetach: 2,
    });

    assert.equal(plan.currentPartition.partitionName, 'AuditLog_y2026m10');
    // Hot partitions: month 0 (Oct), month 1 (Nov), month 2 (Dec)
    assert.equal(plan.hotPartitionsToEnsure.length, 3);
    assert.equal(plan.hotPartitionsToEnsure[0].partitionName, 'AuditLog_y2026m10');
    assert.equal(plan.hotPartitionsToEnsure[1].partitionName, 'AuditLog_y2026m11');
    assert.equal(plan.hotPartitionsToEnsure[2].partitionName, 'AuditLog_y2026m12');

    // Cold partitions: older than 3 months
    assert.ok(plan.coldPartitionsToDetach.length > 0);
    assert.ok(plan.generatedSql.detachPartitionsSql.length > 0);
    assert.ok(plan.generatedSql.detachPartitionsSql[0].includes('DETACH PARTITION'));
  });
});

describe('withPartitionPruningBounds (Partition Pruning Query Enforcer)', () => {
  it('2.1 should inject default 30-day hot window when no date filter exists', () => {
    const now = new Date('2026-10-30T12:00:00.000Z');
    const rawWhere = { userId: 'usr_abc123', action: 'LOGIN' };
    const bounded = withPartitionPruningBounds(rawWhere, {
      now,
      defaultHotDays: 30,
      timestampField: 'createdAt',
    });

    assert.equal(bounded.userId, 'usr_abc123');
    assert.equal(bounded.action, 'LOGIN');
    assert.ok(bounded.createdAt);
    assert.ok(bounded.createdAt.gte instanceof Date);
    assert.ok(bounded.createdAt.lte instanceof Date);

    const diffDays = (bounded.createdAt.lte.getTime() - bounded.createdAt.gte.getTime()) / (1000 * 60 * 60 * 24);
    assert.equal(Math.round(diffDays), 30);
  });

  it('2.2 should respect explicit startDate and endDate', () => {
    const rawWhere = { status: 'SUCCESS' };
    const bounded = withPartitionPruningBounds(rawWhere, {
      startDate: '2026-10-01',
      endDate: '2026-10-15',
      timestampField: 'timestamp',
    });

    assert.equal(bounded.status, 'SUCCESS');
    assert.equal(bounded.timestamp.gte.toISOString().slice(0, 10), '2026-10-01');
    assert.ok(bounded.timestamp.lte.toISOString().includes('2026-10-15T23:59:59.999Z'));
  });

  it('2.3 should preserve existing where range without overwriting', () => {
    const customGte = new Date('2026-09-01T00:00:00.000Z');
    const customLte = new Date('2026-09-10T00:00:00.000Z');
    const rawWhere = {
      action: 'CHECKIN',
      createdAt: { gte: customGte, lte: customLte },
    };

    const bounded = withPartitionPruningBounds(rawWhere, { timestampField: 'createdAt' });
    assert.equal(bounded.createdAt.gte.getTime(), customGte.getTime());
    assert.equal(bounded.createdAt.lte.getTime(), customLte.getTime());
  });

  it('2.4 should extract diagnostic pruning bounds info', () => {
    const where = {
      createdAt: {
        gte: new Date('2026-10-01T00:00:00.000Z'),
        lte: new Date('2026-10-11T00:00:00.000Z'),
      },
    };

    const info = extractPruningBounds(where, 'createdAt');
    assert.ok(info !== null);
    assert.equal(info?.field, 'createdAt');
    assert.equal(info?.durationDays, 10);
    assert.equal(info?.isCustomRange, true);
  });
});

describe('ColdTierArchiver (Uber/Stripe Zero-Lock Detach & Hash Chain Boundary Anchor)', () => {
  function generateTestChain(count: number, initialHash: string = GENESIS_HASH): AuditEntry[] {
    const entries: AuditEntry[] = [];
    let prev = initialHash;

    for (let i = 0; i < count; i++) {
      const entry = createAuditEntry(
        {
          id: `entry_${i + 1}`,
          timestamp: 1761800000000 + i * 1000,
          actor: {
            userId: `user_${i}`,
            role: 'staff',
            ipAddress: '127.0.0.1',
            userAgent: 'TestAgent/1.0',
            branchId: 'branch_01',
          },
          action: 'CHECKIN',
          entityId: `shift_${i}`,
          payload: { shiftIdx: i },
        },
        prev
      );
      entries.push(entry);
      prev = entry.currentHash;
    }

    return entries;
  }

  it('3.1 should seal cold partition archive and produce immutable ColdPartitionManifest', () => {
    const records = generateTestChain(10);
    const sealed = ColdTierArchiver.sealColdPartitionArchive({
      partitionName: 'AuditLog_y2026m06',
      rangeStartIso: '2026-06-01T00:00:00.000Z',
      rangeEndIso: '2026-07-01T00:00:00.000Z',
      records,
      storageUri: 's3://acme-cold-archive/audit-log/AuditLog_y2026m06.ndjson.gz',
    });

    assert.equal(sealed.isValid, true);
    assert.equal(sealed.manifest.rowCount, 10);
    assert.equal(sealed.manifest.firstRecordId, 'entry_1');
    assert.equal(sealed.manifest.lastRecordId, 'entry_10');
    assert.equal(sealed.manifest.firstHash, records[0].currentHash);
    assert.equal(sealed.manifest.lastHash, records[9].currentHash);
    assert.equal(sealed.manifest.merkleRoot.length, 64);
    assert.equal(sealed.manifest.payloadSha256.length, 64);
    assert.ok(sealed.ndjsonPayload.includes('entry_1'));
    assert.ok(sealed.ndjsonPayload.includes('entry_10'));
  });

  it('3.2 should handle empty cold partition gracefully', () => {
    const sealed = ColdTierArchiver.sealColdPartitionArchive({
      partitionName: 'AuditLog_y2026m01',
      rangeStartIso: '2026-01-01T00:00:00.000Z',
      rangeEndIso: '2026-02-01T00:00:00.000Z',
      records: [],
    });

    assert.equal(sealed.isValid, true);
    assert.equal(sealed.manifest.rowCount, 0);
    assert.equal(sealed.manifest.firstHash, GENESIS_HASH);
    assert.equal(sealed.manifest.lastHash, GENESIS_HASH);
  });

  it('3.3 should detect tampering when sealing a corrupted cold partition', () => {
    const records = generateTestChain(5);
    // Tamper with record 2 payload
    records[2].payload = { shiftIdx: 999999 };

    const sealed = ColdTierArchiver.sealColdPartitionArchive({
      partitionName: 'AuditLog_y2026m06',
      rangeStartIso: '2026-06-01T00:00:00.000Z',
      rangeEndIso: '2026-07-01T00:00:00.000Z',
      records,
    });

    assert.equal(sealed.isValid, false);
    assert.equal(sealed.chainVerification.tamperedIndex, 2);
  });

  it('3.4 should solve the Partition Detach Paradox: verify boundary continuity from cold manifest to hot partition', () => {
    // 1. Month M-1 (Cold partition)
    const coldRecords = generateTestChain(5, GENESIS_HASH);
    const coldArchive = ColdTierArchiver.sealColdPartitionArchive({
      partitionName: 'AuditLog_y2026m05',
      rangeStartIso: '2026-05-01T00:00:00.000Z',
      rangeEndIso: '2026-06-01T00:00:00.000Z',
      records: coldRecords,
    });

    // 2. Month M (Hot partition) starts chaining directly from cold partition's lastHash
    const hotRecords = generateTestChain(5, coldArchive.manifest.lastHash);

    // 3. Verify boundary continuity
    const boundaryCheck = ColdTierArchiver.verifyChainWithColdManifest(hotRecords, coldArchive.manifest);
    assert.equal(boundaryCheck.isValid, true);
    assert.equal(boundaryCheck.coldAnchorValid, true);
    assert.equal(boundaryCheck.boundaryHash, coldArchive.manifest.lastHash);
    assert.equal(boundaryCheck.totalRecords, 5);
  });

  it('3.5 should instantly catch boundary tampering if a record is inserted or deleted at partition detach boundary', () => {
    const coldRecords = generateTestChain(5, GENESIS_HASH);
    const coldArchive = ColdTierArchiver.sealColdPartitionArchive({
      partitionName: 'AuditLog_y2026m05',
      rangeStartIso: '2026-05-01T00:00:00.000Z',
      rangeEndIso: '2026-06-01T00:00:00.000Z',
      records: coldRecords,
    });

    // Fake hot records starting from wrong previousHash (e.g. attacker deleted boundary record or fabricated genesis)
    const fakeHotRecords = generateTestChain(5, GENESIS_HASH);

    const boundaryCheck = ColdTierArchiver.verifyChainWithColdManifest(fakeHotRecords, coldArchive.manifest);
    assert.equal(boundaryCheck.isValid, false);
    assert.equal(boundaryCheck.coldAnchorValid, false);
    assert.ok(boundaryCheck.reason?.includes('Partition boundary tamper detected'));
  });

  it('3.6 should catch internal hot partition tampering even when boundary hash matches', () => {
    const coldRecords = generateTestChain(5, GENESIS_HASH);
    const coldArchive = ColdTierArchiver.sealColdPartitionArchive({
      partitionName: 'AuditLog_y2026m05',
      rangeStartIso: '2026-05-01T00:00:00.000Z',
      rangeEndIso: '2026-06-01T00:00:00.000Z',
      records: coldRecords,
    });

    const hotRecords = generateTestChain(5, coldArchive.manifest.lastHash);
    // Tamper with 3rd hot record
    hotRecords[2].payload = { hacked: true };

    const boundaryCheck = ColdTierArchiver.verifyChainWithColdManifest(hotRecords, coldArchive.manifest);
    assert.equal(boundaryCheck.isValid, false);
    assert.equal(boundaryCheck.coldAnchorValid, true); // Boundary itself was correct!
    assert.equal(boundaryCheck.tamperedIndex, 2);
  });
});
