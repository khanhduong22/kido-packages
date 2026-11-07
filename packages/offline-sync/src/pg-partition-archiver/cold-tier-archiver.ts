/**
 * @kido/offline-sync — Zero-Lock Detach & Cold-Tier S3/R2 Offload Engine
 *
 * Implements the Uber/Stripe pattern for high-volume time-series/append-only tables:
 * 1. Detach old partitions with ALTER TABLE ... DETACH PARTITION CONCURRENTLY (zero shared table lock)
 * 2. Export and compress partition rows to NDJSON + gzip
 * 3. Calculate SHA-256 checksum and construct manifest
 * 4. Upload archive buffer + manifest to cold tier storage (AWS S3 / Cloudflare R2)
 * 5. Verify byte length & SHA-256 match before executing DROP TABLE (data-loss protection invariant)
 */

import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { assertValidPgIdentifier } from './declarative-partition';
import type {
  ArchivePartitionOptions,
  ArchivePartitionResult,
  ColdArchiveManifest,
  ColdStorageAdapter,
  CompressRowsMeta,
  CompressRowsResult,
  PgSqlExecutor,
} from './types';

/**
 * Builds the SQL command to detach a partition without blocking active reads/writes
 * using PostgreSQL's `CONCURRENTLY` modifier.
 */
export function buildDetachPartitionSql(
  parentTable: string,
  partitionName: string,
  options?: { schema?: string; concurrently?: boolean },
): string {
  const schema = assertValidPgIdentifier(options?.schema ?? 'public', 'schema');
  const safeParent = assertValidPgIdentifier(parentTable, 'parentTable');
  const safePartition = assertValidPgIdentifier(partitionName, 'partitionName');
  const concurrently = options?.concurrently ?? true;

  const concurrentlyClause = concurrently ? ' CONCURRENTLY' : '';
  return `ALTER TABLE ${schema}.${safeParent} DETACH PARTITION ${schema}.${safePartition}${concurrentlyClause};`;
}

/**
 * Compresses an array of database row objects into an NDJSON gzip buffer,
 * calculates SHA-256 checksum, and generates an audit manifest.
 */
export function compressRowsToNdjsonGzip(
  rows: Record<string, unknown>[],
  meta: CompressRowsMeta,
): CompressRowsResult {
  const safeTableName = assertValidPgIdentifier(meta.tableName, 'tableName');
  const safePartitionName = assertValidPgIdentifier(
    meta.partitionName,
    'partitionName',
  );

  const rowCount = rows.length;
  const ndjsonText =
    rowCount > 0
      ? rows.map((row) => JSON.stringify(row)).join('\n') + '\n'
      : '';

  const uncompressedBuffer = Buffer.from(ndjsonText, 'utf8');
  const uncompressedBytes = uncompressedBuffer.byteLength;

  const compressedBuffer = gzipSync(uncompressedBuffer);
  const compressedBytes = compressedBuffer.byteLength;

  const sha256Checksum = createHash('sha256')
    .update(compressedBuffer)
    .digest('hex');

  const compressionRatio =
    uncompressedBytes > 0
      ? Number((compressedBytes / uncompressedBytes).toFixed(4))
      : 1.0;

  const keyPrefix = meta.keyPrefix
    ? meta.keyPrefix.replace(/\/+$/, '')
    : 'cold-archive';
  const objectKey = `${keyPrefix}/${safeTableName}/${safePartitionName}.ndjson.gz`;
  const createdAtIso = (meta.now ?? new Date()).toISOString();

  const manifest: ColdArchiveManifest = {
    tableName: safeTableName,
    partitionName: safePartitionName,
    objectKey,
    rowCount,
    uncompressedBytes,
    compressedBytes,
    compressionRatio,
    sha256Checksum,
    rangeStartIso: meta.rangeStartIso,
    rangeEndIso: meta.rangeEndIso,
    createdAtIso,
  };

  return {
    buffer: compressedBuffer,
    manifest,
  };
}

/**
 * Verifies optional SHA-256 checksum, gunzips compressed NDJSON buffer,
 * and deserializes rows into typed records.
 */
export function decompressNdjsonGzipToRows<T = Record<string, unknown>>(
  buffer: Buffer,
  expectedSha256?: string,
): T[] {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error('buffer must be a valid Buffer instance');
  }

  if (expectedSha256) {
    const actualSha256 = createHash('sha256').update(buffer).digest('hex');
    if (actualSha256.toLowerCase() !== expectedSha256.toLowerCase()) {
      throw new Error(
        `SHA-256 checksum mismatch: expected ${expectedSha256}, got ${actualSha256}`,
      );
    }
  }

  const uncompressed = gunzipSync(buffer);
  const text = uncompressed.toString('utf8').trim();

  if (text.length === 0) {
    return [];
  }

  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  return lines.map((line, index) => {
    try {
      return JSON.parse(line) as T;
    } catch (err) {
      throw new Error(
        `Failed to parse NDJSON line ${index + 1}: ${(err as Error).message}`,
      );
    }
  });
}

/**
 * Coordinates end-to-end zero-lock partition detach, cold-tier offload to S3/R2,
 * verification, and optional safe drop.
 */
export class ColdTierPartitionArchiver {
  constructor(
    private readonly deps: {
      sqlExecutor: PgSqlExecutor;
      storageAdapter: ColdStorageAdapter;
    },
  ) {}

  /**
   * Orchestrates the 5-step cold-tier partition offload workflow:
   * 1. Runs `DETACH PARTITION ... CONCURRENTLY`
   * 2. Queries all rows from the detached partition
   * 3. Compresses to `.ndjson.gz` + generates SHA-256 `ColdArchiveManifest`
   * 4. Uploads archive buffer + manifest via `storageAdapter.putObject(...)`
   * 5. Strict Safety Invariant: Verifies uploaded bytes and SHA-256 checksum
   *    before dropping the detached table.
   */
  async archivePartition(
    options: ArchivePartitionOptions,
  ): Promise<ArchivePartitionResult> {
    const schema = assertValidPgIdentifier(options.schema ?? 'public', 'schema');
    const parentTable = assertValidPgIdentifier(options.parentTable, 'parentTable');
    const partitionName = assertValidPgIdentifier(
      options.partitionName,
      'partitionName',
    );

    // 1. Zero-lock detach partition
    const detachSql = buildDetachPartitionSql(parentTable, partitionName, {
      schema,
      concurrently: options.concurrently ?? true,
    });
    await this.deps.sqlExecutor.executeRaw(detachSql);

    // 2. Query rows from detached partition
    const querySql = `SELECT * FROM ${schema}.${partitionName};`;
    const rows = await this.deps.sqlExecutor.queryRaw<Record<string, unknown>>(
      querySql,
    );

    // 3. Compress rows to NDJSON gzip + generate manifest
    const { buffer, manifest } = compressRowsToNdjsonGzip(rows, {
      tableName: parentTable,
      partitionName,
      rangeStartIso: options.rangeStartIso,
      rangeEndIso: options.rangeEndIso,
      keyPrefix: options.keyPrefix,
    });

    // 4. Upload archive buffer + manifest
    const archiveUploadResult = await this.deps.storageAdapter.putObject({
      key: manifest.objectKey,
      body: buffer,
      contentType: 'application/x-ndjson-gzip',
      metadata: {
        sha256: manifest.sha256Checksum,
        rowCount: String(manifest.rowCount),
        tableName: manifest.tableName,
        partitionName: manifest.partitionName,
      },
    });

    const manifestKey = `${manifest.objectKey}.manifest.json`;
    const manifestBuffer = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');
    const manifestUploadResult = await this.deps.storageAdapter.putObject({
      key: manifestKey,
      body: manifestBuffer,
      contentType: 'application/json',
      metadata: {
        sha256: manifest.sha256Checksum,
      },
    });

    // 5. Strict Safety Invariant: byte count and checksum verification
    const bytesMatch =
      archiveUploadResult.uploadedBytes === manifest.compressedBytes;
    const sha256Match =
      archiveUploadResult.uploadedSha256.toLowerCase() ===
      manifest.sha256Checksum.toLowerCase();

    if (!bytesMatch || !sha256Match) {
      throw new Error(
        `Cold archive verification failed for ${schema}.${partitionName}: ` +
          `bytes (${archiveUploadResult.uploadedBytes} vs expected ${manifest.compressedBytes}) or ` +
          `sha256 (${archiveUploadResult.uploadedSha256} vs expected ${manifest.sha256Checksum}). ` +
          `Detached partition was NOT dropped.`,
      );
    }

    let dropped = false;
    if (options.dropAfterVerify === true) {
      const dropSql = `DROP TABLE IF EXISTS ${schema}.${partitionName};`;
      await this.deps.sqlExecutor.executeRaw(dropSql);
      dropped = true;
    }

    return {
      detached: true,
      manifest,
      buffer,
      dropped,
      archiveUploadResult,
      manifestUploadResult,
    };
  }
}
