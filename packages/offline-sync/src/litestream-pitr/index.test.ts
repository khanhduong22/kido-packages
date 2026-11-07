import { test, describe, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { LitestreamPitrEngine } from './litestream-engine';
import { runLitestreamPitrDemo } from './index';

describe('Litestream PITR (Point-In-Time-Recovery) Engine Test Suite', () => {
  const testDir = path.join(process.cwd(), '.tmp_litestream_test');
  const dbPath = path.join(testDir, 'test_app.db');
  const replicaDir = path.join(testDir, 'test_replica');
  const restoredDbPath = path.join(testDir, 'test_restored.db');

  beforeEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  test('1. Should initialize SQLite with WAL mode and verify journal_mode', () => {
    const engine = new LitestreamPitrEngine({ dbPath, replicaDir });
    const db = engine.initDatabase();

    const journalModeRow = db.prepare('PRAGMA journal_mode;').all() as Array<{ journal_mode?: string; [k: string]: unknown }>;
    const mode = String(Object.values(journalModeRow[0])[0]).toLowerCase();
    assert.equal(mode, 'wal', 'SQLite must be running in WAL (Write-Ahead-Logging) mode');

    engine.close();
  });

  test('2. Should record WAL frames with SHA-256 checksums and sequence indexing', () => {
    const engine = new LitestreamPitrEngine({ dbPath, replicaDir, generationId: 'test_gen_01' });
    const db = engine.initDatabase();

    db.exec('CREATE TABLE products (id TEXT PRIMARY KEY, price INT);');
    const frame1 = engine.executeMutation(
      'INSERT INTO products (id, price) VALUES (?, ?);',
      ['PROD-01', 50000],
      'Insert product 1'
    );

    const frame2 = engine.executeMutation(
      'INSERT INTO products (id, price) VALUES (?, ?);',
      ['PROD-02', 120000],
      'Insert product 2'
    );

    assert.equal(frame1.index, 0);
    assert.equal(frame2.index, 1);
    assert.equal(typeof frame1.checksum, 'string');
    assert.equal(frame1.checksum.length, 64, 'SHA-256 checksum must be 64 characters hex');

    const frames = engine.listWalFrames();
    assert.equal(frames.length, 2);
    assert.equal(frames[0].sql, 'INSERT INTO products (id, price) VALUES (?, ?);');

    engine.close();
  });

  test('3. Should create online snapshot using VACUUM INTO and verify metadata', () => {
    const engine = new LitestreamPitrEngine({ dbPath, replicaDir, generationId: 'test_gen_02' });
    const db = engine.initDatabase();

    db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, val TEXT);');
    db.exec("INSERT INTO settings VALUES ('store_name', 'KT Store 2026');");

    const snapshot = engine.createSnapshot('base_v1');
    assert.ok(fs.existsSync(snapshot.snapshotPath), 'Snapshot file must exist on disk');
    assert.equal(snapshot.tag, 'base_v1');

    const snapshots = engine.listSnapshots();
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0].tag, 'base_v1');

    engine.close();
  });

  test('4. End-to-End PITR: Rollback accidental DROP / DELETE to exact T1 timestamp', async () => {
    const result = await runLitestreamPitrDemo(path.join(testDir, 'demo_e2e'));

    assert.equal(result.verified, true, 'PITR verification must be 100% successful');
    assert.equal(result.t1OrdersCount, 3, 'Must have 3 orders at T1');
    assert.equal(result.postDisasterOrdersCount, 0, 'Paid orders must be wiped out after disaster at T2');
    assert.equal(result.restoredOrdersCount, 3, 'Restored database must have all 3 orders recovered');
    assert.equal(result.report.success, true);
    assert.equal(result.report.integrityCheck, 'ok');
    assert.equal(result.report.skippedFramesCount, 2, 'Must skip the 2 disaster mutations from T2');
  });

  test('5. Granular PITR: Restore to intermediate point-in-time between mutations', () => {
    const granularDir = path.join(testDir, 'granular');
    const gDbPath = path.join(granularDir, 'store.db');
    const gReplicaDir = path.join(granularDir, 'replica');
    const gRestoredPath = path.join(granularDir, 'restored.db');

    const engine = new LitestreamPitrEngine({ dbPath: gDbPath, replicaDir: gReplicaDir });
    const db = engine.initDatabase();
    db.exec('CREATE TABLE inventory (sku TEXT PRIMARY KEY, qty INT);');

    // Base snapshot at T0
    const t0 = new Date('2026-09-30T10:00:00.000Z');
    engine.createSnapshot('t0_snapshot', t0);

    // Mutation 1 at 10:05:00
    const t1 = new Date('2026-09-30T10:05:00.000Z');
    engine.executeMutation('INSERT INTO inventory VALUES (?, ?);', ['SKU-A', 10], 'Item A', t1);

    // Mutation 2 at 10:10:00
    const t2 = new Date('2026-09-30T10:10:00.000Z');
    engine.executeMutation('INSERT INTO inventory VALUES (?, ?);', ['SKU-B', 20], 'Item B', t2);

    // Mutation 3 at 10:15:00 (accidental inventory wipeout)
    const t3 = new Date('2026-09-30T10:15:00.000Z');
    engine.executeMutation('DELETE FROM inventory;', [], 'Accidental wipeout', t3);

    engine.close();

    // Time-travel restore to 10:07:00 (Between Mutation 1 and Mutation 2: SKU-A exists, SKU-B does not yet exist)
    const targetBetweenT1AndT2 = new Date('2026-09-30T10:07:00.000Z');
    const { report: rep1, db: rDb1 } = engine.restoreToTimestamp(targetBetweenT1AndT2, gRestoredPath);

    assert.equal(rep1.replayedFramesCount, 1, 'Only Mutation 1 should be replayed');
    assert.equal(rep1.skippedFramesCount, 2, 'Mutation 2 and Mutation 3 should be skipped');

    const items1 = rDb1.prepare('SELECT sku FROM inventory;').all() as Array<{ sku: string }>;
    assert.equal(items1.length, 1);
    assert.equal(items1[0].sku, 'SKU-A');
    rDb1.close();

    // Time-travel restore to 10:12:00 (Between Mutation 2 and Mutation 3: both SKU-A and SKU-B exist)
    const gRestoredPath2 = path.join(granularDir, 'restored2.db');
    const targetBetweenT2AndT3 = new Date('2026-09-30T10:12:00.000Z');
    const { report: rep2, db: rDb2 } = engine.restoreToTimestamp(targetBetweenT2AndT3, gRestoredPath2);

    assert.equal(rep2.replayedFramesCount, 2, 'Both Mutation 1 and Mutation 2 should be replayed');
    assert.equal(rep2.skippedFramesCount, 1, 'Only disaster Mutation 3 should be skipped');

    const items2 = rDb2.prepare('SELECT sku FROM inventory ORDER BY sku ASC;').all() as Array<{ sku: string }>;
    assert.equal(items2.length, 2);
    assert.equal(items2[0].sku, 'SKU-A');
    assert.equal(items2[1].sku, 'SKU-B');
    rDb2.close();
  });

  test('6. Should generate valid Cloudflare R2 litestream.yml configuration', () => {
    const yamlConfig = LitestreamPitrEngine.generateCloudflareR2Config({
      accountId: 'cf_account_12345',
      bucketName: 'kt-db-backups',
      dbPath: '/var/lib/app/production.db',
      replicaSubPath: 'app-db',
      retentionHours: 720,
    });

    assert.ok(yamlConfig.includes('https://cf_account_12345.r2.cloudflarestorage.com'));
    assert.ok(yamlConfig.includes('bucket: kt-db-backups'));
    assert.ok(yamlConfig.includes('path: /var/lib/app/production.db'));
    assert.ok(yamlConfig.includes('retention: 720h'));
  });
});
