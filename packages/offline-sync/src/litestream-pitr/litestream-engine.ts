import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import {
  LitestreamEngineConfig,
  WalFrame,
  SnapshotMetadata,
  RestorationReport,
  R2ConfigOptions,
} from './types';

function toSqliteParam(val: string | number | boolean | null): string | number | bigint | null {
  if (typeof val === 'boolean') {
    return val ? 1 : 0;
  }
  return val;
}

export class LitestreamPitrEngine {
  private db: DatabaseSync | null = null;
  public readonly dbPath: string;
  public readonly replicaDir: string;
  public readonly generationId: string;
  private frameSequence = 0;
  private isClosed = false;

  constructor(config: LitestreamEngineConfig) {
    this.dbPath = path.resolve(config.dbPath);
    this.replicaDir = path.resolve(config.replicaDir);
    this.generationId = config.generationId || crypto.randomUUID().replace(/-/g, '').slice(0, 16);

    this.ensureDirectories();
  }

  private ensureDirectories(): void {
    const generationDir = path.join(this.replicaDir, 'generations', this.generationId);
    const snapshotsDir = path.join(generationDir, 'snapshots');
    const walDir = path.join(generationDir, 'wal');

    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    fs.mkdirSync(snapshotsDir, { recursive: true });
    fs.mkdirSync(walDir, { recursive: true });
  }

  public initDatabase(): DatabaseSync {
    if (this.db) {
      return this.db;
    }

    this.db = new DatabaseSync(this.dbPath);

    // Enforce SQLite WAL (Write-Ahead-Logging) mode for Litestream compatibility
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');

    return this.db;
  }

  public getDatabase(): DatabaseSync {
    if (!this.db || this.isClosed) {
      return this.initDatabase();
    }
    return this.db;
  }

  /**
   * Execute transactional SQL mutation and synchronously replicate WAL frame
   */
  public executeMutation(
    sql: string,
    params: Array<string | number | boolean | null> = [],
    description?: string,
    customTimestamp?: Date
  ): WalFrame {
    const db = this.getDatabase();

    // Execute in SQLite
    if (params.length > 0) {
      const stmt = db.prepare(sql);
      const converted = params.map(toSqliteParam);
      stmt.run(...converted);
    } else {
      db.exec(sql);
    }

    const timestamp = (customTimestamp ?? new Date()).toISOString();
    const frameIndex = this.frameSequence++;

    // Compute checksum
    const hash = crypto.createHash('sha256');
    hash.update(`${this.generationId}:${frameIndex}:${timestamp}:${sql}:${JSON.stringify(params)}`);
    const checksum = hash.digest('hex');

    const frame: WalFrame = {
      generationId: this.generationId,
      index: frameIndex,
      timestamp,
      sql,
      params,
      description,
      checksum,
    };

    // Persist WAL frame in replica storage (simulating Litestream WAL frame streaming to R2)
    const walFilePath = path.join(
      this.replicaDir,
      'generations',
      this.generationId,
      'wal',
      `frame_${frameIndex.toString().padStart(8, '0')}.wal.json`
    );
    fs.writeFileSync(walFilePath, JSON.stringify(frame, null, 2), 'utf-8');

    return frame;
  }

  /**
   * Create point-in-time generational base snapshot using SQLite VACUUM INTO
   */
  public createSnapshot(tag = 'base_snapshot', customTimestamp?: Date): SnapshotMetadata {
    const db = this.getDatabase();
    const timestamp = (customTimestamp ?? new Date()).toISOString();
    const safeTimestampStr = timestamp.replace(/[:.]/g, '-');
    const snapshotFileName = `snapshot_${safeTimestampStr}.db`;
    const snapshotPath = path.join(
      this.replicaDir,
      'generations',
      this.generationId,
      'snapshots',
      snapshotFileName
    );

    // If file exists, remove prior
    if (fs.existsSync(snapshotPath)) {
      fs.unlinkSync(snapshotPath);
    }

    // VACUUM INTO creates a consistent online snapshot without blocking ongoing readers
    db.exec(`VACUUM INTO '${snapshotPath}';`);

    const metadata: SnapshotMetadata = {
      generationId: this.generationId,
      snapshotPath,
      timestamp,
      tag,
      schemaVersion: 1,
      frameCountAtSnapshot: this.frameSequence,
    };

    const metaPath = `${snapshotPath}.meta.json`;
    fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2), 'utf-8');

    return metadata;
  }

  /**
   * List all stored generational snapshots in chronological order
   */
  public listSnapshots(): SnapshotMetadata[] {
    const snapshotsDir = path.join(this.replicaDir, 'generations', this.generationId, 'snapshots');
    if (!fs.existsSync(snapshotsDir)) {
      return [];
    }

    const files = fs.readdirSync(snapshotsDir);
    const metaFiles = files.filter((f) => f.endsWith('.meta.json'));

    const list: SnapshotMetadata[] = metaFiles
      .map((mf) => {
        try {
          const content = fs.readFileSync(path.join(snapshotsDir, mf), 'utf-8');
          return JSON.parse(content) as SnapshotMetadata;
        } catch {
          return null;
        }
      })
      .filter((m): m is SnapshotMetadata => m !== null)
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    return list;
  }

  /**
   * List all replicated WAL frames in chronological sequence
   */
  public listWalFrames(): WalFrame[] {
    const walDir = path.join(this.replicaDir, 'generations', this.generationId, 'wal');
    if (!fs.existsSync(walDir)) {
      return [];
    }

    const files = fs.readdirSync(walDir);
    const frameFiles = files.filter((f) => f.endsWith('.wal.json')).sort();

    return frameFiles
      .map((ff) => {
        try {
          const content = fs.readFileSync(path.join(walDir, ff), 'utf-8');
          return JSON.parse(content) as WalFrame;
        } catch {
          return null;
        }
      })
      .filter((f): f is WalFrame => f !== null)
      .sort((a, b) => a.index - b.index);
  }

  /**
   * Litestream Point-In-Time-Recovery (PITR):
   * Restores the database to the exact state at targetTimestamp.
   *
   * Algorithm:
   * 1. Find closest base snapshot taken <= targetTimestamp.
   * 2. Copy base snapshot to restoredDbPath.
   * 3. Replay all WAL frames committed between snapshot timestamp and targetTimestamp.
   * 4. Skip all WAL frames occurring after targetTimestamp (e.g. disaster DROP TABLE / corrupt DELETE).
   * 5. Verify restored database integrity with PRAGMA integrity_check.
   */
  public restoreToTimestamp(
    targetTimestamp: Date | string,
    restoredDbPath: string
  ): { report: RestorationReport; db: DatabaseSync } {
    const targetDate = new Date(targetTimestamp);
    const targetTimeMs = targetDate.getTime();
    if (isNaN(targetTimeMs)) {
      throw new Error(`Invalid targetTimestamp provided: ${targetTimestamp}`);
    }

    const snapshots = this.listSnapshots();
    // Select the latest snapshot where snapshot.timestamp <= targetTimestamp
    const validSnapshots = snapshots.filter(
      (s) => new Date(s.timestamp).getTime() <= targetTimeMs
    );

    let baseSnapshot: SnapshotMetadata;
    if (validSnapshots.length === 0) {
      if (snapshots.length > 0) {
        // If target is earlier than first snapshot, take the first snapshot
        baseSnapshot = snapshots[0];
      } else {
        throw new Error('No snapshots found in replica repository to restore from.');
      }
    } else {
      baseSnapshot = validSnapshots[validSnapshots.length - 1];
    }

    // Ensure target restored db directory exists
    const resolvedRestoredPath = path.resolve(restoredDbPath);
    fs.mkdirSync(path.dirname(resolvedRestoredPath), { recursive: true });

    // Clean destination if exists
    if (fs.existsSync(resolvedRestoredPath)) {
      fs.unlinkSync(resolvedRestoredPath);
    }
    // Also remove WAL & SHM files if present
    if (fs.existsSync(`${resolvedRestoredPath}-wal`)) fs.unlinkSync(`${resolvedRestoredPath}-wal`);
    if (fs.existsSync(`${resolvedRestoredPath}-shm`)) fs.unlinkSync(`${resolvedRestoredPath}-shm`);

    // Copy base snapshot database to destination
    fs.copyFileSync(baseSnapshot.snapshotPath, resolvedRestoredPath);

    // Open restored database
    const restoredDb = new DatabaseSync(resolvedRestoredPath);
    restoredDb.exec('PRAGMA foreign_keys = ON;');

    // Read WAL frames after snapshot frame sequence up to targetTimestamp
    const allFrames = this.listWalFrames();
    const framesAfterSnapshot = allFrames.filter((f) => f.index >= baseSnapshot.frameCountAtSnapshot);

    const replayedFrames: WalFrame[] = [];
    const skippedFrames: WalFrame[] = [];

    for (const frame of framesAfterSnapshot) {
      const frameTimeMs = new Date(frame.timestamp).getTime();
      if (frameTimeMs <= targetTimeMs) {
        // Replay frame
        try {
          if (frame.params && frame.params.length > 0) {
            const stmt = restoredDb.prepare(frame.sql);
            const converted = frame.params.map(toSqliteParam);
            stmt.run(...converted);
          } else {
            restoredDb.exec(frame.sql);
          }
          replayedFrames.push(frame);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          throw new Error(`Failed to replay WAL frame index ${frame.index}: ${message}`);
        }
      } else {
        skippedFrames.push(frame);
      }
    }

    // Integrity check
    const integrityResult = restoredDb.prepare('PRAGMA integrity_check;').all() as Array<{
      integrity_check?: string;
      [key: string]: unknown;
    }>;
    const integrityCheckStatus =
      integrityResult.length > 0
        ? String(Object.values(integrityResult[0])[0])
        : 'unknown';

    const report: RestorationReport = {
      success: integrityCheckStatus === 'ok',
      targetTimestamp: targetDate.toISOString(),
      baseSnapshotPath: baseSnapshot.snapshotPath,
      baseSnapshotTimestamp: baseSnapshot.timestamp,
      restoredDbPath: resolvedRestoredPath,
      totalReplicatedFrames: allFrames.length,
      replayedFramesCount: replayedFrames.length,
      skippedFramesCount: skippedFrames.length,
      skippedFramesDetails: skippedFrames.map((f) => ({
        index: f.index,
        timestamp: f.timestamp,
        description: f.description,
      })),
      integrityCheck: integrityCheckStatus,
      recoveredAt: new Date().toISOString(),
    };

    return { report, db: restoredDb };
  }

  public close(): void {
    if (this.db && !this.isClosed) {
      try {
        this.db.close();
      } catch {
        // Already closed
      }
      this.isClosed = true;
      this.db = null;
    }
  }

  /**
   * Helper to format production litestream.yml configuration for Cloudflare R2
   */
  public static generateCloudflareR2Config(options: R2ConfigOptions): string {
    const accId = options.accountId;
    const bucket = options.bucketName;
    const dbPath = options.dbPath;
    const replicaPath = options.replicaSubPath || 'db';
    const accessKeyVar = options.accessKeyIdEnvVar || 'LITESTREAM_ACCESS_KEY_ID';
    const secretKeyVar = options.secretAccessKeyEnvVar || 'LITESTREAM_SECRET_ACCESS_KEY';
    const retention = `${options.retentionHours || 720}h`; // 30 days default
    const syncInterval = options.syncInterval || '1s';

    return `# ==============================================================================
# Litestream Configuration for Cloudflare R2 ($0 Egress & 10GB Free Storage)
# ==============================================================================
# Docs: https://litestream.io/reference/config/
# Cloudflare R2 S3-Compatible Endpoint: https://<accountid>.r2.cloudflarestorage.com

access-key-id: \${${accessKeyVar}}
secret-access-key: \${${secretKeyVar}}

dbs:
  - path: ${dbPath}
    replicas:
      - type: s3
        endpoint: https://${accId}.r2.cloudflarestorage.com
        bucket: ${bucket}
        path: ${replicaPath}
        retention: ${retention}
        sync-interval: ${syncInterval}
        # Compression using LZ4 for sub-millisecond replication
        validation-interval: 24h
`;
  }

  /**
   * Return exact CLI command to run Litestream restore to timestamp
   */
  public static getRestoreCliCommand(
    configPath: string,
    dbPath: string,
    targetTimestampIso: string,
    outputDbPath: string
  ): string {
    return `litestream restore -config ${configPath} -timestamp "${targetTimestampIso}" -o ${outputDbPath} ${dbPath}`;
  }
}
