import { SnapshotStorageAdapter } from './types';

// ============================================================================
// Storage Adapters: InMemorySnapshotAdapter & PrismaSnapshotAdapter
// ============================================================================

export interface InMemoryOperationEntry {
  type: 'upsertTenant' | 'delete' | 'insert';
  collection: string;
  tenantId: string;
  count: number;
}

export class InMemorySnapshotAdapter implements SnapshotStorageAdapter {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private tenants = new Map<string, Record<string, any>>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private collections = new Map<string, Record<string, any>[]>();
  public readonly operationLog: InMemoryOperationEntry[] = [];

  constructor(initialData?: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tenants?: Record<string, Record<string, any>>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    collections?: Record<string, Record<string, any>[]>;
  }) {
    if (initialData?.tenants) {
      for (const [k, v] of Object.entries(initialData.tenants)) {
        this.tenants.set(k, structuredClone(v));
      }
    }
    if (initialData?.collections) {
      for (const [k, v] of Object.entries(initialData.collections)) {
        this.collections.set(k, structuredClone(v));
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public seedCollection(collectionName: string, records: Record<string, any>[]): void {
    const existing = this.collections.get(collectionName) ?? [];
    this.collections.set(collectionName, [
      ...existing,
      ...structuredClone(records),
    ]);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public setTenant(tenantId: string, metadata: Record<string, any>): void {
    this.tenants.set(tenantId, structuredClone(metadata));
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public getAllCollectionRecords(collectionName: string): Record<string, any>[] {
    return structuredClone(this.collections.get(collectionName) ?? []);
  }

  public clearOperationLog(): void {
    this.operationLog.length = 0;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getTenantMetadata(tenantId: string): Promise<Record<string, any> | null> {
    const found = this.tenants.get(tenantId);
    return found ? structuredClone(found) : null;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async upsertTenantMetadata(tenantId: string, metadata: Record<string, any>): Promise<void> {
    const existing = this.tenants.get(tenantId) ?? {};
    this.tenants.set(tenantId, {
      ...existing,
      ...structuredClone(metadata),
      id: tenantId,
    });
    this.operationLog.push({
      type: 'upsertTenant',
      collection: 'tenant',
      tenantId,
      count: 1,
    });
  }

  async findCollectionRecords(
    collectionName: string,
    tenantId: string
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<Record<string, any>[]> {
    const rows = this.collections.get(collectionName) ?? [];
    return structuredClone(rows.filter((r) => r.tenantId === tenantId));
  }

  async deleteCollectionRecords(
    collectionName: string,
    tenantId: string
  ): Promise<number> {
    const rows = this.collections.get(collectionName) ?? [];
    const remaining = rows.filter((r) => r.tenantId !== tenantId);
    const deletedCount = rows.length - remaining.length;
    this.collections.set(collectionName, remaining);
    this.operationLog.push({
      type: 'delete',
      collection: collectionName,
      tenantId,
      count: deletedCount,
    });
    return deletedCount;
  }

  async insertCollectionRecords(
    collectionName: string,
    tenantId: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    records: Record<string, any>[],
    options?: { isCrossTenant?: boolean; numericId?: boolean }
  ): Promise<number> {
    if (!Array.isArray(records) || records.length === 0) {
      this.operationLog.push({
        type: 'insert',
        collection: collectionName,
        tenantId,
        count: 0,
      });
      return 0;
    }

    const existing = this.collections.get(collectionName) ?? [];
    let autoIdCounter =
      existing.reduce(
        (max, item) => (typeof item.id === 'number' && item.id > max ? item.id : max),
        0
      ) + 1;

    const prepared = records.map((raw) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const item: Record<string, any> = { ...structuredClone(raw), tenantId };
      if (options?.numericId && options?.isCrossTenant) {
        item.id = autoIdCounter++;
      } else if (
        options?.isCrossTenant &&
        typeof item.id === 'string' &&
        !item.id.startsWith(`${tenantId}_`)
      ) {
        item.id = `${tenantId}_${item.id}`;
      }
      return item;
    });

    this.collections.set(collectionName, [...existing, ...prepared]);
    this.operationLog.push({
      type: 'insert',
      collection: collectionName,
      tenantId,
      count: prepared.length,
    });
    return prepared.length;
  }

  async runInTransaction<T>(
    fn: (txAdapter: SnapshotStorageAdapter) => Promise<T>
  ): Promise<T> {
    // Snapshot state prior to transaction for atomic rollback on failure
    const tenantsBackup = structuredClone(this.tenants);
    const collectionsBackup = structuredClone(this.collections);
    const logLengthBackup = this.operationLog.length;

    try {
      return await fn(this);
    } catch (error) {
      this.tenants = tenantsBackup;
      this.collections = collectionsBackup;
      this.operationLog.length = logLengthBackup;
      throw error;
    }
  }
}

export interface PrismaSnapshotAdapterOptions {
  /**
   * Optional mapping from collection name in snapshot to Prisma delegate property name
   * (e.g. `{ allowedIps: 'allowedIP', workShifts: 'workShift' }`).
   */
  collectionModelMap?: Record<string, string>;
  /**
   * Default tenant ID fallback for legacy records without explicit tenantId.
   */
  defaultTenantId?: string;
}

const DEFAULT_PRISMA_MODEL_MAP: Record<string, string> = {
  users: 'user',
  workShifts: 'workShift',
  shiftDuties: 'shiftDuty',
  documents: 'document',
  announcements: 'announcement',
  taskDefinitions: 'taskDefinition',
  taskItems: 'taskItem',
  managerChecklistTasks: 'managerChecklistTask',
  managerWeeklyTasks: 'managerWeeklyTask',
  holidays: 'holiday',
  allowedIps: 'allowedIP',
};

export class PrismaSnapshotAdapter implements SnapshotStorageAdapter {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly db: Record<string, any>;
  private readonly modelMap: Record<string, string>;
  private readonly defaultTenantId: string;

  constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prismaClient: Record<string, any>,
    options?: PrismaSnapshotAdapterOptions
  ) {
    this.db = prismaClient;
    this.modelMap = {
      ...DEFAULT_PRISMA_MODEL_MAP,
      ...(options?.collectionModelMap ?? {}),
    };
    this.defaultTenantId = options?.defaultTenantId ?? 'acme-retail';
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private resolveModel(collectionName: string): any {
    const mappedName = this.modelMap[collectionName] ?? collectionName;
    if (this.db[mappedName]) {
      return this.db[mappedName];
    }
    if (this.db[collectionName]) {
      return this.db[collectionName];
    }
    // Singular fallback (strip trailing 's')
    if (collectionName.endsWith('s')) {
      const singular = collectionName.slice(0, -1);
      if (this.db[singular]) {
        return this.db[singular];
      }
    }
    return undefined;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getTenantMetadata(tenantId: string): Promise<Record<string, any> | null> {
    if (this.db.tenant && typeof this.db.tenant.findUnique === 'function') {
      try {
        return await this.db.tenant.findUnique({ where: { id: tenantId } });
      } catch {
        return null;
      }
    }
    return null;
  }

  async upsertTenantMetadata(
    tenantId: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    metadata: Record<string, any>
  ): Promise<void> {
    if (this.db.tenant && typeof this.db.tenant.upsert === 'function') {
      const name = metadata?.name || `Tenant ${tenantId}`;
      const isActive = metadata?.isActive ?? true;
      await this.db.tenant.upsert({
        where: { id: tenantId },
        update: { name, isActive },
        create: {
          id: tenantId,
          slug: metadata?.slug || tenantId,
          name,
          isActive,
        },
      });
    }
  }

  async findCollectionRecords(
    collectionName: string,
    tenantId: string
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<Record<string, any>[]> {
    const model = this.resolveModel(collectionName);
    if (!model || typeof model.findMany !== 'function') {
      return [];
    }
    try {
      const rows = await model.findMany({ where: { tenantId } });
      return Array.isArray(rows) ? rows : [];
    } catch {
      try {
        const fallbackRows = await model.findMany();
        if (!Array.isArray(fallbackRows)) return [];
        return fallbackRows.filter(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (r: any) =>
            r?.tenantId === tenantId ||
            (tenantId === this.defaultTenantId && !r?.tenantId)
        );
      } catch {
        return [];
      }
    }
  }

  async deleteCollectionRecords(
    collectionName: string,
    tenantId: string
  ): Promise<number> {
    const model = this.resolveModel(collectionName);
    if (!model || typeof model.deleteMany !== 'function') {
      return 0;
    }
    const res = await model.deleteMany({ where: { tenantId } });
    return typeof res?.count === 'number' ? res.count : 0;
  }

  async insertCollectionRecords(
    collectionName: string,
    tenantId: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    records: Record<string, any>[],
    options?: { isCrossTenant?: boolean; numericId?: boolean }
  ): Promise<number> {
    if (!Array.isArray(records) || records.length === 0) {
      return 0;
    }
    const model = this.resolveModel(collectionName);
    if (!model) {
      return 0;
    }

    const prepared = records.map((raw) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const item: Record<string, any> = { ...raw, tenantId };
      if (options?.numericId && options?.isCrossTenant) {
        delete item.id;
      } else if (
        options?.isCrossTenant &&
        typeof item.id === 'string' &&
        !item.id.startsWith(`${tenantId}_`)
      ) {
        item.id = `${tenantId}_${item.id}`;
      }
      return item;
    });

    if (typeof model.createMany === 'function') {
      const res = await model.createMany({ data: prepared });
      return typeof res?.count === 'number' ? res.count : prepared.length;
    }

    let count = 0;
    for (const item of prepared) {
      if (item.id !== undefined && typeof model.upsert === 'function') {
        await model.upsert({
          where: { id: item.id },
          update: item,
          create: item,
        });
        count++;
      } else if (typeof model.create === 'function') {
        await model.create({ data: item });
        count++;
      }
    }
    return count;
  }

  async runInTransaction<T>(
    fn: (txAdapter: SnapshotStorageAdapter) => Promise<T>
  ): Promise<T> {
    if (typeof this.db.$transaction === 'function') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return this.db.$transaction(async (tx: Record<string, any>) => {
        const txAdapter = new PrismaSnapshotAdapter(tx || this.db, {
          collectionModelMap: this.modelMap,
          defaultTenantId: this.defaultTenantId,
        });
        return fn(txAdapter);
      });
    }
    return fn(this);
  }
}
