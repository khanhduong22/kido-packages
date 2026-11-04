/**
 * Confirmed Mutation Ledger (Client-Side Optimistic Reconciliation).
 * Prevents stale background SWR revalidation, HTTP 304 Not Modified cache overwrites,
 * or legacy Service Worker caches from wiping out locally confirmed user actions.
 */

import { StorageLike } from './types';

export interface ConfirmedRecord {
  id: string | number;
  timestamp: string | number;
  userId?: string | number;
  [key: string]: unknown;
}

export interface ConfirmedLedgerOptions {
  /**
   * LocalStorage key to persist confirmed records.
   * Defaults to 'kt_confirmed_mutation_ledger'.
   */
  storageKey?: string;
  /**
   * Custom Storage implementation (defaults to globalThis.localStorage if available).
   */
  storage?: StorageLike;
  /**
   * Maximum time-to-live for a confirmed record in milliseconds.
   * Older records are automatically evicted.
   * Defaults to 24 hours (24 * 60 * 60 * 1000).
   */
  ttlMs?: number;
  /**
   * Maximum time-to-live for reconciliation against incoming payloads in milliseconds.
   * Records older than this threshold will not be merged into fresh responses.
   * Defaults to 12 hours (12 * 60 * 60 * 1000).
   */
  reconciliationWindowMs?: number;
}

function resolveStorage(storage?: StorageLike): StorageLike | null {
  if (storage) return storage;
  if (
    typeof globalThis !== 'undefined' &&
    'localStorage' in globalThis &&
    globalThis.localStorage
  ) {
    return globalThis.localStorage as StorageLike;
  }
  return null;
}

export class ConfirmedMutationLedger<T extends ConfirmedRecord = ConfirmedRecord> {
  private storageKey: string;
  private storage?: StorageLike;
  private ttlMs: number;
  private reconciliationWindowMs: number;

  constructor(options?: ConfirmedLedgerOptions) {
    this.storageKey = options?.storageKey ?? 'kt_confirmed_mutation_ledger';
    this.storage = options?.storage;
    this.ttlMs = options?.ttlMs ?? 24 * 60 * 60 * 1000;
    this.reconciliationWindowMs = options?.reconciliationWindowMs ?? 12 * 60 * 60 * 1000;
  }

  private getStore(): StorageLike | null {
    return resolveStorage(this.storage);
  }

  /**
   * Read raw ledger from storage safely.
   */
  public getRecords(): T[] {
    const store = this.getStore();
    if (!store) return [];
    try {
      const raw = store.getItem(this.storageKey);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  /**
   * Record a locally confirmed mutation into the ledger and prune expired records.
   */
  public record(record: T): void {
    if (!record || typeof record !== 'object' || record.id === undefined || record.id === null) {
      return;
    }
    const store = this.getStore();
    if (!store || !store.setItem) return;

    try {
      const now = Date.now();
      const existing = this.getRecords();

      // Prune records exceeding TTL
      const pruned = existing.filter((item) => {
        if (!item || !item.timestamp) return false;
        const ts = typeof item.timestamp === 'number' ? item.timestamp : new Date(item.timestamp).getTime();
        return !isNaN(ts) && now - ts < this.ttlMs;
      });

      // Avoid duplicates or update existing
      const index = pruned.findIndex((item) => String(item.id) === String(record.id));
      if (index >= 0) {
        pruned[index] = { ...pruned[index], ...record };
      } else {
        pruned.push(record);
      }

      store.setItem(this.storageKey, JSON.stringify(pruned));
    } catch (err) {
      console.warn('[ConfirmedMutationLedger] Failed to record confirmed mutation:', err);
    }
  }

  /**
   * Deterministically merge active confirmed records into incoming array data.
   * If incoming array is missing records that were confirmed locally within the reconciliation window,
   * they are preserved and merged back in.
   */
  public reconcileList(
    serverList: T[],
    options?: {
      userId?: string | number;
      sortByTimestamp?: boolean;
    }
  ): { list: T[]; mergedCount: number } {
    const list: T[] = Array.isArray(serverList) ? [...serverList] : [];
    const ledger = this.getRecords();
    if (ledger.length === 0) return { list, mergedCount: 0 };

    const now = Date.now();
    let mergedCount = 0;

    for (const record of ledger) {
      if (!record || record.id === undefined || !record.timestamp) continue;
      const recordTime = typeof record.timestamp === 'number' ? record.timestamp : new Date(record.timestamp).getTime();
      if (isNaN(recordTime) || now - recordTime > this.reconciliationWindowMs) continue;

      if (options?.userId && record.userId && String(record.userId) !== String(options.userId)) {
        continue;
      }

      const exists = list.some((item) => String(item.id) === String(record.id));
      if (!exists) {
        list.push(record);
        mergedCount++;
      }
    }

    if (options?.sortByTimestamp && mergedCount > 0) {
      list.sort((a, b) => {
        const timeA = typeof a.timestamp === 'number' ? a.timestamp : new Date(a.timestamp).getTime();
        const timeB = typeof b.timestamp === 'number' ? b.timestamp : new Date(b.timestamp).getTime();
        return timeA - timeB;
      });
    }

    return { list, mergedCount };
  }

  /**
   * Clear the ledger from storage.
   */
  public clear(): void {
    const store = this.getStore();
    if (!store) return;
    try {
      store.removeItem(this.storageKey);
    } catch {}
  }
}

/**
 * Factory to create a scoped ConfirmedMutationLedger instance.
 */
export function createConfirmedLedger<T extends ConfirmedRecord = ConfirmedRecord>(
  options?: ConfirmedLedgerOptions
): ConfirmedMutationLedger<T> {
  return new ConfirmedMutationLedger<T>(options);
}

/**
 * Deterministically resolve the latest entity from an array by timestamp.
 */
export function getLatestEntityByTimestamp<T extends { timestamp?: string | number }>(items: T[]): T | null {
  if (!Array.isArray(items) || items.length === 0) return null;
  return items.reduce((latest, current) => {
    const currentTs = typeof current.timestamp === 'number' ? current.timestamp : new Date(current.timestamp || 0).getTime();
    const latestTs = typeof latest.timestamp === 'number' ? latest.timestamp : new Date(latest.timestamp || 0).getTime();
    return currentTs >= latestTs ? current : latest;
  });
}

/**
 * Purge legacy service worker cache buckets safely.
 */
export async function purgeLegacyCacheStorage(cacheNames: string[]): Promise<string[]> {
  if (typeof globalThis === 'undefined' || !('caches' in globalThis) || !globalThis.caches) {
    return [];
  }
  const purged: string[] = [];
  try {
    const existing = await globalThis.caches.keys();
    for (const name of cacheNames) {
      if (existing.includes(name)) {
        await globalThis.caches.delete(name);
        purged.push(name);
      }
    }
  } catch (err) {
    console.warn('[ConfirmedMutationLedger] Failed to purge legacy cache storage:', err);
  }
  return purged;
}
