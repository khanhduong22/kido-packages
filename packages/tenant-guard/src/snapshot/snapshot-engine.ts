import { computeSnapshotChecksum, verifySnapshotIntegrity } from './checksum';
import {
  CrossTenantImportForbiddenError,
  ImportTenantSnapshotOptions,
  ImportTenantSnapshotResult,
  InvalidSnapshotPayloadError,
  SnapshotCollectionConfig,
  SnapshotScope,
  SnapshotStorageAdapter,
  SnapshotTamperError,
  TenantSnapshotData,
  TenantSnapshotPayload,
} from './types';

// ============================================================================
// SurgicalSnapshotEngine - Scoped Export, SHA-256 Verification & Reverse-FK Restore
// ============================================================================

export const DEFAULT_SNAPSHOT_COLLECTIONS: readonly SnapshotCollectionConfig[] = [
  {
    name: 'users',
    scope: 'core',
    dependencyOrder: 10,
    alwaysIncludeOnExport: true,
  },
  {
    name: 'holidays',
    scope: 'holidays',
    dependencyOrder: 15,
  },
  {
    name: 'allowedIps',
    scope: 'holidays',
    dependencyOrder: 16,
    numericId: true,
  },
  {
    name: 'documents',
    scope: 'documents',
    dependencyOrder: 20,
  },
  {
    name: 'announcements',
    scope: 'documents',
    dependencyOrder: 21,
  },
  {
    name: 'taskDefinitions',
    scope: 'tasks',
    dependencyOrder: 30,
  },
  {
    name: 'taskItems',
    scope: 'tasks',
    dependencyOrder: 35,
  },
  {
    name: 'managerChecklistTasks',
    scope: 'tasks',
    dependencyOrder: 36,
  },
  {
    name: 'managerWeeklyTasks',
    scope: 'tasks',
    dependencyOrder: 37,
  },
  {
    name: 'workShifts',
    scope: 'schedule',
    dependencyOrder: 40,
    numericId: true,
  },
  {
    name: 'shiftDuties',
    scope: 'schedule',
    dependencyOrder: 45,
  },
] as const;

export interface SurgicalSnapshotEngineOptions {
  /**
   * Custom collection definitions (merged with or overriding defaults).
   */
  collections?: readonly SnapshotCollectionConfig[];
  /**
   * Custom scope mapping from scope name to an array of collection names.
   */
  customScopeMap?: Record<string, string[]>;
  /**
   * Default tenant ID fallback when an empty tenantId is supplied.
   */
  defaultTenantId?: string;
}

export class SurgicalSnapshotEngine {
  private readonly adapter: SnapshotStorageAdapter;
  private readonly collections: SnapshotCollectionConfig[];
  private readonly customScopeMap: Record<string, string[]>;
  private readonly defaultTenantId: string;

  constructor(
    adapter: SnapshotStorageAdapter,
    options?: SurgicalSnapshotEngineOptions
  ) {
    this.adapter = adapter;
    this.collections = options?.collections
      ? [...options.collections]
      : [...DEFAULT_SNAPSHOT_COLLECTIONS];
    this.customScopeMap = options?.customScopeMap ?? {};
    this.defaultTenantId = options?.defaultTenantId ?? 'acme-retail';
  }

  private normalizeTenantId(rawTenantId?: string): string {
    const trimmed = (rawTenantId ?? this.defaultTenantId).trim().toLowerCase();
    return trimmed.length > 0 ? trimmed : this.defaultTenantId;
  }

  /**
   * Resolves the collections belonging to one or more scopes.
   */
  public resolveScopedCollections(
    scopes: readonly string[],
    options?: { includeAlwaysExport?: boolean }
  ): SnapshotCollectionConfig[] {
    const isAll = scopes.includes('all');
    const customNames = new Set<string>();
    for (const s of scopes) {
      const mapped = this.customScopeMap[s];
      if (Array.isArray(mapped)) {
        for (const name of mapped) {
          customNames.add(name);
        }
      }
    }

    return this.collections.filter((col) => {
      if (options?.includeAlwaysExport && col.alwaysIncludeOnExport) {
        return true;
      }
      if (isAll) {
        return true;
      }
      if (scopes.includes(col.scope) || scopes.includes(col.name)) {
        return true;
      }
      if (customNames.has(col.name)) {
        return true;
      }
      return false;
    });
  }

  /**
   * Exports tenant metadata and scoped table collections with record counts and SHA-256 tamper seal.
   */
  async exportTenantSnapshot(
    rawTenantId?: string,
    scope: SnapshotScope = 'all'
  ): Promise<TenantSnapshotPayload> {
    const tenantId = this.normalizeTenantId(rawTenantId);
    const normalizedScope = (scope || 'all').trim() || 'all';

    let tenantMeta = await this.adapter.getTenantMetadata(tenantId);
    if (!tenantMeta) {
      tenantMeta = {
        id: tenantId,
        slug: tenantId,
        name: `Tenant ${tenantId}`,
        isActive: true,
      };
    }

    const activeCollections = this.resolveScopedCollections([normalizedScope], {
      includeAlwaysExport: true,
    });

    const data: TenantSnapshotData = {
      tenant: tenantMeta,
    };
    const counts: Record<string, number> = {};

    // Sort by dependencyOrder ascending for deterministic export structure
    const sortedForExport = [...activeCollections].sort(
      (a, b) => a.dependencyOrder - b.dependencyOrder
    );

    for (const col of sortedForExport) {
      const records = await this.adapter.findCollectionRecords(col.name, tenantId);
      const normalizedRecords = records.map((row) => ({
        ...row,
        tenantId: row.tenantId || tenantId,
      }));
      data[col.name] = normalizedRecords;
      counts[col.name] = normalizedRecords.length;
    }

    const checksum = computeSnapshotChecksum(data);

    return {
      version: '1.0',
      exportedAt: new Date().toISOString(),
      tenantId,
      scope: normalizedScope,
      counts,
      checksum,
      data,
    };
  }

  /**
   * Validates SHA-256 checksum, blocks unauthorized cross-tenant overwrites unless allowed,
   * deletes existing scoped records in reverse Foreign-Key dependency order, and batch-inserts
   * restored records with `tenantId` rewritten to `targetTenantId` inside an atomic transaction.
   */
  async importTenantSnapshot(
    rawTargetTenantId: string,
    snapshot: TenantSnapshotPayload,
    options?: ImportTenantSnapshotOptions
  ): Promise<ImportTenantSnapshotResult> {
    if (
      !snapshot ||
      typeof snapshot !== 'object' ||
      snapshot.version !== '1.0' ||
      !snapshot.data ||
      typeof snapshot.data !== 'object'
    ) {
      throw new InvalidSnapshotPayloadError();
    }

    const integrity = verifySnapshotIntegrity(snapshot);
    if (!integrity.valid) {
      throw new SnapshotTamperError(integrity.expected, integrity.actual);
    }

    const sourceTenantId = this.normalizeTenantId(snapshot.tenantId);
    const targetTenantId = this.normalizeTenantId(
      rawTargetTenantId || sourceTenantId
    );
    const isCrossTenant = sourceTenantId !== targetTenantId;

    if (isCrossTenant && !options?.allowCrossTenantImport) {
      throw new CrossTenantImportForbiddenError(sourceTenantId, targetTenantId);
    }

    const activeScopes =
      options?.scopes && options.scopes.length > 0
        ? options.scopes
        : [snapshot.scope || 'all'];

    // Determine collections to restore: must be in activeScopes AND present in snapshot.data
    const scopedConfigs = this.resolveScopedCollections(activeScopes, {
      includeAlwaysExport: activeScopes.includes('all'),
    }).filter((col) => Array.isArray(snapshot.data[col.name]));

    // Forward FK dependency order (parents first -> children last) for INSERT
    const forwardOrder = [...scopedConfigs].sort(
      (a, b) => a.dependencyOrder - b.dependencyOrder
    );
    // Reverse FK dependency order (children first -> parents last) for DELETE
    const reverseOrder = [...scopedConfigs].sort(
      (a, b) => b.dependencyOrder - a.dependencyOrder
    );

    const deletionOrder = reverseOrder.map((c) => c.name);
    const insertionOrder = forwardOrder.map((c) => c.name);
    const deletedCounts: Record<string, number> = {};
    const restoredCounts: Record<string, number> = {};
    const dryRun = options?.dryRun === true;

    if (dryRun) {
      for (const col of reverseOrder) {
        const existing = await this.adapter.findCollectionRecords(
          col.name,
          targetTenantId
        );
        deletedCounts[col.name] = existing.length;
      }
      for (const col of forwardOrder) {
        const records = snapshot.data[col.name];
        restoredCounts[col.name] = Array.isArray(records) ? records.length : 0;
      }

      return {
        restoredTenantId: targetTenantId,
        sourceTenantId,
        scope: activeScopes.join(','),
        dryRun: true,
        deletedCounts,
        restoredCounts,
        deletionOrder,
        insertionOrder,
      };
    }

    await this.adapter.runInTransaction(async (tx) => {
      // 1. Delete existing scoped records in reverse Foreign-Key dependency order
      for (const col of reverseOrder) {
        deletedCounts[col.name] = await tx.deleteCollectionRecords(
          col.name,
          targetTenantId
        );
      }

      // 2. Upsert target tenant metadata
      const sourceTenantMeta = snapshot.data.tenant ?? {};
      await tx.upsertTenantMetadata(targetTenantId, {
        ...sourceTenantMeta,
        id: targetTenantId,
        slug: targetTenantId,
        name: isCrossTenant
          ? `${sourceTenantMeta.name || sourceTenantId} (${targetTenantId})`
          : sourceTenantMeta.name || `Tenant ${targetTenantId}`,
      });

      // 3. Batch-insert restored records in forward Foreign-Key dependency order
      for (const col of forwardOrder) {
        const rawRecords = snapshot.data[col.name];
        const records = Array.isArray(rawRecords)
          ? rawRecords.map((item) => ({
              ...item,
              tenantId: targetTenantId,
            }))
          : [];

        restoredCounts[col.name] = await tx.insertCollectionRecords(
          col.name,
          targetTenantId,
          records,
          {
            isCrossTenant,
            numericId: col.numericId,
          }
        );
      }
    });

    if (options?.invalidateCache) {
      await options.invalidateCache(`tenant:${targetTenantId}:*`);
    }

    return {
      restoredTenantId: targetTenantId,
      sourceTenantId,
      scope: activeScopes.join(','),
      dryRun: false,
      deletedCounts,
      restoredCounts,
      deletionOrder,
      insertionOrder,
    };
  }
}
