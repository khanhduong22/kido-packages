import {
  CreateMutationInput,
  IOutboxStorage,
  MutationStatus,
  OutboxFilter,
  OutboxMutation,
  OutboxMutationSchema,
} from './types';
import { compareUUIDv7, uuidv7 } from './uuidv7';

// ==========================================
// MEMORY OUTBOX STORAGE IMPLEMENTATION
// ==========================================

export class MemoryOutboxStorage implements IOutboxStorage {
  private items = new Map<string, OutboxMutation>();

  async add(mutation: OutboxMutation): Promise<void> {
    this.items.set(mutation.id, { ...mutation });
  }

  async get(id: string): Promise<OutboxMutation | null> {
    const item = this.items.get(id);
    return item ? { ...item } : null;
  }

  async update(id: string, updates: Partial<OutboxMutation>): Promise<void> {
    const existing = this.items.get(id);
    if (!existing) {
      throw new Error(`OutboxMutation with id "${id}" not found.`);
    }
    this.items.set(id, { ...existing, ...updates });
  }

  async delete(id: string): Promise<void> {
    this.items.delete(id);
  }

  async list(filter?: OutboxFilter): Promise<OutboxMutation[]> {
    let result = Array.from(this.items.values());

    if (filter?.status) {
      result = result.filter((item) => item.status === filter.status);
    }
    if (filter?.entityType) {
      result = result.filter((item) => item.entityType === filter.entityType);
    }

    // Sort strictly chronological by timestamp then uuidv7
    result.sort((a, b) => {
      if (a.timestamp !== b.timestamp) {
        return a.timestamp - b.timestamp;
      }
      return compareUUIDv7(a.id, b.id);
    });

    const offset = filter?.offset ?? 0;
    const limit = filter?.limit ?? result.length;
    return result.slice(offset, offset + limit).map((m) => ({ ...m }));
  }

  async getPending(limit?: number): Promise<OutboxMutation[]> {
    const list = await this.list({ status: 'PENDING' });
    return limit ? list.slice(0, limit) : list;
  }

  async count(status?: MutationStatus): Promise<number> {
    if (!status) return this.items.size;
    let count = 0;
    for (const item of this.items.values()) {
      if (item.status === status) count++;
    }
    return count;
  }

  async clear(): Promise<void> {
    this.items.clear();
  }
}

// ==========================================
// INDEXEDDB STORAGE IMPLEMENTATION (BROWSER)
// ==========================================

export class IndexedDbOutboxStorage implements IOutboxStorage {
  private dbName: string;
  private storeName: string;
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(dbName = 'kt_offline_sync_db', storeName = 'mutations') {
    this.dbName = dbName;
    this.storeName = storeName;
  }

  private async getDB(): Promise<IDBDatabase> {
    if (typeof indexedDB === 'undefined') {
      throw new Error('IndexedDB is not available in current runtime environment.');
    }
    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(this.dbName, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(this.storeName)) {
            const store = db.createObjectStore(this.storeName, { keyPath: 'id' });
            store.createIndex('status', 'status', { unique: false });
            store.createIndex('timestamp', 'timestamp', { unique: false });
            store.createIndex('entityType', 'entityType', { unique: false });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return this.dbPromise;
  }

  async add(mutation: OutboxMutation): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readwrite');
      const store = tx.objectStore(this.storeName);
      const req = store.add(mutation);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async get(id: string): Promise<OutboxMutation | null> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readonly');
      const store = tx.objectStore(this.storeName);
      const req = store.get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async update(id: string, updates: Partial<OutboxMutation>): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readwrite');
      const store = tx.objectStore(this.storeName);
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        const existing = getReq.result;
        if (!existing) {
          reject(new Error(`OutboxMutation with id "${id}" not found.`));
          return;
        }
        const updated = { ...existing, ...updates };
        const putReq = store.put(updated);
        putReq.onsuccess = () => resolve();
        putReq.onerror = () => reject(putReq.error);
      };
      getReq.onerror = () => reject(getReq.error);
    });
  }

  async delete(id: string): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readwrite');
      const store = tx.objectStore(this.storeName);
      const req = store.delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async list(filter?: OutboxFilter): Promise<OutboxMutation[]> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readonly');
      const store = tx.objectStore(this.storeName);
      const req = store.getAll();
      req.onsuccess = () => {
        let results: OutboxMutation[] = req.result || [];
        if (filter?.status) {
          results = results.filter((i) => i.status === filter.status);
        }
        if (filter?.entityType) {
          results = results.filter((i) => i.entityType === filter.entityType);
        }
        results.sort((a, b) => {
          if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
          return compareUUIDv7(a.id, b.id);
        });
        const offset = filter?.offset ?? 0;
        const limit = filter?.limit ?? results.length;
        resolve(results.slice(offset, offset + limit));
      };
      req.onerror = () => reject(req.error);
    });
  }

  async getPending(limit?: number): Promise<OutboxMutation[]> {
    return this.list({ status: 'PENDING', limit });
  }

  async count(status?: MutationStatus): Promise<number> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readonly');
      const store = tx.objectStore(this.storeName);
      if (status) {
        const index = store.index('status');
        const req = index.count(status);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      } else {
        const req = store.count();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }
    });
  }

  async clear(): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readwrite');
      const store = tx.objectStore(this.storeName);
      const req = store.clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }
}

// ==========================================
// OUTBOX QUEUE HIGH-LEVEL MANAGER
// ==========================================

export class OutboxQueue {
  private storage: IOutboxStorage;

  constructor(storage?: IOutboxStorage) {
    if (storage) {
      this.storage = storage;
    } else if (typeof indexedDB !== 'undefined') {
      this.storage = new IndexedDbOutboxStorage();
    } else {
      this.storage = new MemoryOutboxStorage();
    }
  }

  getStorage(): IOutboxStorage {
    return this.storage;
  }

  /**
   * Enqueues a new mutation into the outbox with an RFC 9562 UUIDv7 ID.
   */
  async enqueue(input: CreateMutationInput): Promise<OutboxMutation> {
    const id = input.id ?? uuidv7();
    const timestamp = input.timestamp ?? Date.now();
    const mutation: OutboxMutation = OutboxMutationSchema.parse({
      ...input,
      id,
      timestamp,
      status: input.status ?? 'PENDING',
      retryCount: input.retryCount ?? 0,
    });

    await this.storage.add(mutation);
    return mutation;
  }

  /**
   * Fetches pending mutations in chronological order.
   */
  async getPending(limit?: number): Promise<OutboxMutation[]> {
    return this.storage.getPending(limit);
  }

  /**
   * Marks given mutations as SYNCING to avoid race conditions.
   */
  async markSyncing(ids: string[]): Promise<void> {
    const now = Date.now();
    await Promise.all(
      ids.map((id) =>
        this.storage.update(id, {
          status: 'SYNCING',
          lastAttemptAt: now,
        })
      )
    );
  }

  /**
   * Marks a mutation as successfully SYNCED.
   */
  async markSynced(id: string, serverVersion?: number): Promise<void> {
    await this.storage.update(id, {
      status: 'SYNCED',
      error: undefined,
      version: serverVersion,
    });
  }

  /**
   * Marks a mutation as FAILED, updating retryCount and error details.
   */
  async markFailed(id: string, error: string, terminal = false): Promise<void> {
    const existing = await this.storage.get(id);
    if (!existing) return;

    const nextRetry = existing.retryCount + 1;
    await this.storage.update(id, {
      status: terminal ? 'FAILED' : 'PENDING',
      retryCount: nextRetry,
      error,
    });
  }

  async getById(id: string): Promise<OutboxMutation | null> {
    return this.storage.get(id);
  }

  async list(filter?: OutboxFilter): Promise<OutboxMutation[]> {
    return this.storage.list(filter);
  }

  /**
   * Purges synced mutations older than a given duration.
   */
  async purgeSynced(olderThanMs = 24 * 60 * 60 * 1000): Promise<number> {
    const threshold = Date.now() - olderThanMs;
    const synced = await this.storage.list({ status: 'SYNCED' });
    let purged = 0;
    for (const item of synced) {
      if (item.timestamp < threshold) {
        await this.storage.delete(item.id);
        purged++;
      }
    }
    return purged;
  }

  /**
   * Retrieves summary counts for monitoring and UI badges.
   */
  async getStats(): Promise<{
    pending: number;
    syncing: number;
    synced: number;
    failed: number;
    total: number;
  }> {
    const [pending, syncing, synced, failed, total] = await Promise.all([
      this.storage.count('PENDING'),
      this.storage.count('SYNCING'),
      this.storage.count('SYNCED'),
      this.storage.count('FAILED'),
      this.storage.count(),
    ]);

    return { pending, syncing, synced, failed, total };
  }

  async clear(): Promise<void> {
    return this.storage.clear();
  }
}
