import * as path from 'node:path';
import * as fs from 'node:fs';
import { LitestreamPitrEngine } from './litestream-engine';
import { RestorationReport } from './types';

export * from './types';
export * from './litestream-engine';

export interface DemoResult {
  t1Timestamp: string;
  t2Timestamp: string;
  t1OrdersCount: number;
  postDisasterOrdersCount: number | 'TABLE_DROPPED';
  restoredOrdersCount: number;
  report: RestorationReport;
  verified: boolean;
}

/**
 * Executes an end-to-end Litestream Time-Travel PITR Demonstration:
 * 1. Initialize SQLite database with WAL mode.
 * 2. Create tables & insert initial valid orders at timestamp T1.
 * 3. Capture generational snapshot & replicate WAL frames.
 * 4. Trigger disaster at timestamp T2 (DROP TABLE or corrupted DELETE).
 * 5. Time-Travel restore to timestamp T1.
 * 6. Verify 100% data recovery matching T1 state.
 */
export async function runLitestreamPitrDemo(baseDir?: string): Promise<DemoResult> {
  const rootDir = baseDir || path.join(process.cwd(), '.litestream_demo_runtime');
  const dbPath = path.join(rootDir, 'production.db');
  const replicaDir = path.join(rootDir, 'cloudflare_r2_replica');
  const restoredDbPath = path.join(rootDir, 'restored_point_in_time.db');

  // Clean runtime directory if it exists
  if (fs.existsSync(rootDir)) {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
  fs.mkdirSync(rootDir, { recursive: true });

  const engine = new LitestreamPitrEngine({
    dbPath,
    replicaDir,
    generationId: 'gen_2026_demo_01',
  });

  // Step 1: Initialize Database in WAL mode
  const db = engine.initDatabase();
  db.exec(`
    CREATE TABLE customers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE orders (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      amount INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (customer_id) REFERENCES customers(id)
    );
  `);

  // Step 2: Insert initial valid transactions (Timestamp T1)
  const t1Date = new Date(Date.now() - 60000); // 1 minute ago
  const t1Timestamp = t1Date.toISOString();

  // Create base snapshot right after schema setup
  engine.createSnapshot('schema_init', new Date(t1Date.getTime() - 10000));

  engine.executeMutation(
    `INSERT INTO customers (id, name, phone, created_at) VALUES (?, ?, ?, ?)`,
    ['CUST-001', 'Nguyễn Văn An', '0912345678', t1Timestamp],
    'Add customer An',
    t1Date
  );

  engine.executeMutation(
    `INSERT INTO customers (id, name, phone, created_at) VALUES (?, ?, ?, ?)`,
    ['CUST-002', 'Trần Thị Bình', '0987654321', t1Timestamp],
    'Add customer Binh',
    t1Date
  );

  engine.executeMutation(
    `INSERT INTO orders (id, customer_id, amount, status, created_at) VALUES (?, ?, ?, ?, ?)`,
    ['ORD-2026-001', 'CUST-001', 1250000, 'PAID', t1Timestamp],
    'Order 001 - 1,250,000 VND',
    t1Date
  );

  engine.executeMutation(
    `INSERT INTO orders (id, customer_id, amount, status, created_at) VALUES (?, ?, ?, ?, ?)`,
    ['ORD-2026-002', 'CUST-002', 850000, 'PAID', t1Timestamp],
    'Order 002 - 850,000 VND',
    t1Date
  );

  engine.executeMutation(
    `INSERT INTO orders (id, customer_id, amount, status, created_at) VALUES (?, ?, ?, ?, ?)`,
    ['ORD-2026-003', 'CUST-001', 450000, 'DELIVERED', t1Timestamp],
    'Order 003 - 450,000 VND',
    t1Date
  );

  const t1Orders = db.prepare('SELECT COUNT(*) as cnt FROM orders;').all() as Array<{ cnt: number }>;
  const t1OrdersCount = Number(t1Orders[0].cnt);

  // Step 3: Disaster occurs at Time T2 (Accidental DROP TABLE orders or rogue DELETE)
  const t2Date = new Date(Date.now() + 30000); // 30 seconds into the future
  const t2Timestamp = t2Date.toISOString();

  // Rogue operations at T2
  engine.executeMutation(
    `DELETE FROM orders WHERE status = 'PAID';`,
    [],
    'DISASTER: Accidental massive DELETE of all paid orders',
    t2Date
  );

  engine.executeMutation(
    `INSERT INTO orders (id, customer_id, amount, status, created_at) VALUES (?, ?, ?, ?, ?)`,
    ['CORRUPT-BAD-999', 'CUST-001', -99999999, 'HACKED', t2Timestamp],
    'DISASTER: Corrupted injection data',
    t2Date
  );

  const postDisasterOrders = db.prepare("SELECT COUNT(*) as cnt FROM orders WHERE status = 'PAID';").all() as Array<{ cnt: number }>;
  const postDisasterOrdersCount = Number(postDisasterOrders[0].cnt);

  // Close live db before restore
  engine.close();

  // Step 4: Execute Litestream Point-in-Time Recovery to timestamp T1!
  const { report, db: restoredDb } = engine.restoreToTimestamp(t1Timestamp, restoredDbPath);

  // Step 5: Verify restored database matches T1 exactly
  const restoredOrders = restoredDb.prepare('SELECT * FROM orders ORDER BY id ASC;').all() as Array<{
    id: string;
    amount: number;
    status: string;
  }>;

  const restoredOrdersCount = restoredOrders.length;
  const hasCorruptRecord = restoredOrders.some((o) => o.id === 'CORRUPT-BAD-999');

  const verified =
    restoredOrdersCount === 3 &&
    !hasCorruptRecord &&
    restoredOrders[0].id === 'ORD-2026-001' &&
    restoredOrders[1].id === 'ORD-2026-002' &&
    restoredOrders[2].id === 'ORD-2026-003' &&
    report.success === true &&
    report.skippedFramesCount === 2;

  restoredDb.close();

  return {
    t1Timestamp,
    t2Timestamp,
    t1OrdersCount,
    postDisasterOrdersCount,
    restoredOrdersCount,
    report,
    verified,
  };
}

// Standalone execution helper
if (
  typeof require !== 'undefined' &&
  require.main === module &&
  typeof process !== 'undefined' &&
  process.argv[1]?.endsWith('litestream-pitr/index.ts')
) {
  (async () => {
    console.log('================================================================');
    console.log('🚀 LITESTREAM TIME-TRAVEL PITR DEMO (SQLite + Cloudflare R2)');
    console.log('================================================================');
    const result = await runLitestreamPitrDemo();
    console.log(`⏱️  Timestamp T1 (Valid State):   ${result.t1Timestamp}`);
    console.log(`   - Valid Orders at T1:         ${result.t1OrdersCount}`);
    console.log(`⏱️  Timestamp T2 (Disaster):      ${result.t2Timestamp}`);
    console.log(`   - Paid Orders Post-Disaster:  ${result.postDisasterOrdersCount} (Data Lost!)`);
    console.log(`🔄 Restoring to T1 via Litestream Time-Travel Engine...`);
    console.log(`   - Base Snapshot:              ${path.basename(result.report.baseSnapshotPath)}`);
    console.log(`   - WAL Frames Replayed:        ${result.report.replayedFramesCount}`);
    console.log(`   - WAL Frames Skipped (T2):    ${result.report.skippedFramesCount}`);
    console.log(`   - SQLite Integrity Status:    ${result.report.integrityCheck}`);
    console.log(`✅ Verification Passed 100%:     ${result.verified}`);
    console.log(`   - Restored Orders Count:      ${result.restoredOrdersCount} / 3`);
    console.log('================================================================');
  })().catch((err) => {
    console.error('Demo failed:', err);
    process.exit(1);
  });
}
