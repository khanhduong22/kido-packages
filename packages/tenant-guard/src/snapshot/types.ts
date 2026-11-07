// ============================================================================
// @kido/tenant-snapshot - Types & Domain Contracts
// ============================================================================

export type BuiltInSnapshotScope =
  | 'all'
  | 'schedule'
  | 'documents'
  | 'tasks'
  | 'holidays';

export type SnapshotScope = BuiltInSnapshotScope | (string & {});

export interface SnapshotCollectionConfig {
  /**
   * Key in `snapshot.data` and storage collection name (e.g. 'workShifts', 'shiftDuties').
   */
  name: string;
  /**
   * Logical scope group (e.g. 'core', 'schedule', 'documents', 'tasks', 'holidays').
   */
  scope: string;
  /**
   * Foreign-key dependency order priority:
   * - Lower numbers are parent tables (inserted FIRST, deleted LAST).
   * - Higher numbers are child tables (deleted FIRST in reverse-FK order, inserted LAST).
   */
  dependencyOrder: number;
  /**
   * Whether the primary key `id` is a numeric auto-increment column.
   */
  numericId?: boolean;
  /**
   * Optional always-include flag (e.g. 'users' included across scopes or only when scope matches).
   */
  alwaysIncludeOnExport?: boolean;
}

export interface TenantSnapshotData {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tenant: Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [collectionName: string]: any;
}

export interface TenantSnapshotPayload {
  version: '1.0';
  exportedAt: string;
  tenantId: string;
  scope: string;
  counts: Record<string, number>;
  checksum: string;
  data: TenantSnapshotData;
}

export interface SnapshotIntegrityResult {
  valid: boolean;
  expected: string;
  actual: string;
}

export interface ImportTenantSnapshotOptions {
  /**
   * When true, validates integrity and computes deletion/insertion counts without mutating storage.
   */
  dryRun?: boolean;
  /**
   * Must be true when importing a snapshot from `sourceTenantId` into a different `targetTenantId`.
   */
  allowCrossTenantImport?: boolean;
  /**
   * Optional subset of scopes to restore from the snapshot. Defaults to `[snapshot.scope || 'all']`.
   */
  scopes?: string[];
  /**
   * Optional hook invoked after a successful non-dry-run restore to purge Valkey/Redis tenant cache keys.
   */
  invalidateCache?: (pattern: string) => Promise<void> | void;
}

export interface ImportTenantSnapshotResult {
  restoredTenantId: string;
  sourceTenantId: string;
  scope: string;
  dryRun: boolean;
  deletedCounts: Record<string, number>;
  restoredCounts: Record<string, number>;
  deletionOrder: string[];
  insertionOrder: string[];
}

export interface SnapshotStorageAdapter {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getTenantMetadata(tenantId: string): Promise<Record<string, any> | null>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  upsertTenantMetadata(tenantId: string, metadata: Record<string, any>): Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  findCollectionRecords(collectionName: string, tenantId: string): Promise<Record<string, any>[]>;
  deleteCollectionRecords(collectionName: string, tenantId: string): Promise<number>;
  insertCollectionRecords(
    collectionName: string,
    tenantId: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    records: Record<string, any>[],
    options?: { isCrossTenant?: boolean; numericId?: boolean }
  ): Promise<number>;
  runInTransaction<T>(fn: (txAdapter: SnapshotStorageAdapter) => Promise<T>): Promise<T>;
}

export class SnapshotTamperError extends Error {
  public readonly code = 'SNAPSHOT_CHECKSUM_MISMATCH';
  public readonly expected: string;
  public readonly actual: string;

  constructor(expected: string, actual: string, message?: string) {
    super(
      message ||
        `Snapshot SHA-256 checksum mismatch: expected ${expected}, received ${actual}`
    );
    this.name = 'SnapshotTamperError';
    this.expected = expected;
    this.actual = actual;
  }
}

export class CrossTenantImportForbiddenError extends Error {
  public readonly code = 'CROSS_TENANT_IMPORT_FORBIDDEN';
  public readonly sourceTenantId: string;
  public readonly targetTenantId: string;

  constructor(sourceTenantId: string, targetTenantId: string, message?: string) {
    super(
      message ||
        `Cross-tenant snapshot import from "${sourceTenantId}" into "${targetTenantId}" is forbidden unless allowCrossTenantImport is true`
    );
    this.name = 'CrossTenantImportForbiddenError';
    this.sourceTenantId = sourceTenantId;
    this.targetTenantId = targetTenantId;
  }
}

export class InvalidSnapshotPayloadError extends Error {
  public readonly code = 'INVALID_SNAPSHOT_PAYLOAD';

  constructor(message = 'Invalid tenant snapshot payload format (requires version 1.0)') {
    super(message);
    this.name = 'InvalidSnapshotPayloadError';
  }
}
