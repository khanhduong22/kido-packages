import { StorageLike, ZombieAuthHealOptions } from './types';

function resolveDefaultStorage(storage?: StorageLike): StorageLike | null {
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

/**
 * Clears stale optimistic local auth keys when a session check returns `401`/`403`
 * or `authenticated: false`, preventing infinite skeleton or hydration loops.
 *
 * @returns The array of keys that existed in storage and were purged.
 */
export function purgeZombieAuthStorage(
  storageKeys: string[],
  storage?: StorageLike
): string[] {
  const targetStorage = resolveDefaultStorage(storage);
  if (!targetStorage || !Array.isArray(storageKeys)) {
    return [];
  }

  const purgedKeys: string[] = [];
  for (const key of storageKeys) {
    try {
      const existing = targetStorage.getItem(key);
      if (existing !== null) {
        purgedKeys.push(key);
      }
      targetStorage.removeItem(key);
    } catch {
      // Ignore quota / security errors in restricted WebViews
    }
  }

  return purgedKeys;
}

/**
 * Evaluates a session verification response (`status` / `isAuthenticated`) and
 * automatically purges zombie optimistic auth keys if the session is invalid
 * (`status === 401`, `status === 403`, or `isAuthenticated === false`).
 */
export function healZombieAuthSession(options: ZombieAuthHealOptions): {
  healed: boolean;
  purgedKeys: string[];
} {
  const isUnauthorizedStatus =
    options.status === 401 || options.status === 403;
  const isExplicitlyUnauthenticated = options.isAuthenticated === false;

  if (!isUnauthorizedStatus && !isExplicitlyUnauthenticated) {
    return { healed: false, purgedKeys: [] };
  }

  const purgedKeys = purgeZombieAuthStorage(
    options.storageKeys,
    options.storage
  );

  if (options.onPurged && purgedKeys.length > 0) {
    options.onPurged(purgedKeys);
  }

  return {
    healed: true,
    purgedKeys,
  };
}
