import type {
  CheckSpaVersionOptions,
  VersionCheckResult,
  VersionFileInfo,
  VersionGuardBypassKeys,
} from './types';

export const DEFAULT_ENDPOINT = '/version.json';
export const DEFAULT_POLL_INTERVAL_MS = 180_000; // 3 minutes
export const DEFAULT_INITIAL_DELAY_MS = 3_000;
export const DEFAULT_RELOAD_DELAY_MS = 1_500;
export const DEFAULT_COOLDOWN_MS = 300_000; // 5 minutes
export const DEFAULT_FETCH_TIMEOUT_MS = 5_000;

export const DEFAULT_BYPASS_KEYS: Required<VersionGuardBypassKeys> = {
  mockUserKey: 'winter_arc_mock_user',
  isLoggingInKey: 'is_logging_in',
  lastReloadTsKey: 'last_version_reload_ts',
};

/**
 * Parses semver string (e.g. 'v1.2.3' or '2.0.1') into [major, minor, patch]
 */
export function parseSemver(version: string): [number, number, number] | null {
  if (!version || typeof version !== 'string') return null;
  const match = version.trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10)];
}

/**
 * Compares two semantic version strings.
 * Returns:
 *   1 if a > b
 *  -1 if a < b
 *   0 if a === b
 */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (pa && pb) {
    for (let i = 0; i < 3; i++) {
      if (pa[i] > pb[i]) return 1;
      if (pa[i] < pb[i]) return -1;
    }
    return 0;
  }
  return a.localeCompare(b);
}

/**
 * Determines whether server version is strictly newer than client version
 */
export function isVersionNewer(client: string, server: string): boolean {
  if (!server || !client) return false;
  if (client === server) return false;
  const pa = parseSemver(client);
  const pb = parseSemver(server);
  if (pa && pb) {
    return compareSemver(server, client) > 0;
  }
  // Non-semver fallback: if different string and non-empty, consider it newer
  return true;
}

/**
 * Checks if anti-infinite-loop reload cooldown is currently active in sessionStorage
 */
export function isCooldownActive(
  cooldownMs: number = DEFAULT_COOLDOWN_MS,
  key: string = DEFAULT_BYPASS_KEYS.lastReloadTsKey
): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const lastReload = sessionStorage.getItem(key);
    if (!lastReload) return false;
    const elapsed = Date.now() - Number(lastReload);
    return elapsed >= 0 && elapsed < cooldownMs;
  } catch {
    return false;
  }
}

/**
 * Writes current timestamp into sessionStorage to start anti-infinite-loop cooldown
 */
export function markReloadAttempt(
  key: string = DEFAULT_BYPASS_KEYS.lastReloadTsKey
): void {
  if (typeof window === 'undefined') return;
  try {
    sessionStorage.setItem(key, String(Date.now()));
  } catch {
    // Ignore storage quota / restricted access errors
  }
}

/**
 * Resets the reload attempt cooldown from sessionStorage
 */
export function clearReloadAttempt(
  key: string = DEFAULT_BYPASS_KEYS.lastReloadTsKey
): void {
  if (typeof window === 'undefined') return;
  try {
    sessionStorage.removeItem(key);
  } catch {
    // Ignore storage quota / restricted access errors
  }
}

/**
 * Evaluates whether version checking and auto-reload should be bypassed
 */
export function shouldBypassVersionCheck(
  bypassKeys?: VersionGuardBypassKeys,
  cooldownMs: number = DEFAULT_COOLDOWN_MS
): { bypass: boolean; reason?: VersionCheckResult['skippedReason'] } {
  if (typeof window === 'undefined') {
    return { bypass: false };
  }

  const keys = { ...DEFAULT_BYPASS_KEYS, ...bypassKeys };

  try {
    // 1. Check if mock/testing user flag is set in localStorage
    if (keys.mockUserKey && localStorage.getItem(keys.mockUserKey)) {
      return { bypass: true, reason: 'mock_user' };
    }

    // 2. Check if user is in an active login / authorization flow
    if (keys.isLoggingInKey && sessionStorage.getItem(keys.isLoggingInKey) === 'true') {
      return { bypass: true, reason: 'logging_in' };
    }

    // 3. Check anti-infinite-reload cooldown in sessionStorage
    if (isCooldownActive(cooldownMs, keys.lastReloadTsKey)) {
      return { bypass: true, reason: 'cooldown' };
    }
  } catch {
    // Ignore storage access exceptions (e.g. security sandboxes)
  }

  return { bypass: false };
}

/**
 * Deletes all cache entries across all CacheStorage caches
 */
export async function cleanBrowserCaches(): Promise<number> {
  if (typeof window === 'undefined' || !('caches' in window)) {
    return 0;
  }
  try {
    const cacheStorage = (window as unknown as { caches: CacheStorage }).caches;
    const keys = await cacheStorage.keys();
    if (keys.length === 0) return 0;
    await Promise.all(keys.map((k) => cacheStorage.delete(k)));
    return keys.length;
  } catch (err) {
    console.warn('[@kido/spa-version-guard] Cache cleanup error:', err);
    return 0;
  }
}

/**
 * Triggers background update check on all registered service workers
 */
export async function updateServiceWorkers(): Promise<number> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return 0;
  }
  try {
    const registrations = await navigator.serviceWorker.getRegistrations();
    if (registrations.length === 0) return 0;
    await Promise.all(registrations.map((reg) => reg.update()));
    return registrations.length;
  } catch (err) {
    console.warn('[@kido/spa-version-guard] Service worker update error:', err);
    return 0;
  }
}

/**
 * Headless version check logic:
 * Performs an HTTP request with no-cache headers, checks visibility, storage cooldowns,
 * and compares client version vs server version.
 */
export async function checkSpaVersion(
  options: CheckSpaVersionOptions
): Promise<VersionCheckResult> {
  const {
    endpoint = DEFAULT_ENDPOINT,
    clientVersion,
    clientBuildId,
    cooldownMs = DEFAULT_COOLDOWN_MS,
    signal,
    fetchTimeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
    checkVisibility = true,
    bypassKeys,
    customFetch = typeof fetch !== 'undefined' ? fetch : undefined,
  } = options;

  // 1. Verify visibility (do not waste network bandwidth if tab is hidden)
  if (
    checkVisibility &&
    typeof document !== 'undefined' &&
    document.visibilityState !== 'visible'
  ) {
    return {
      hasNewVersion: false,
      skipped: true,
      skippedReason: 'not_visible',
      clientVersion,
      clientBuildId,
    };
  }

  // 2. Anti-infinite loop & test user bypass guards
  const bypass = shouldBypassVersionCheck(bypassKeys, cooldownMs);
  if (bypass.bypass) {
    return {
      hasNewVersion: false,
      skipped: true,
      skippedReason: bypass.reason,
      clientVersion,
      clientBuildId,
    };
  }

  if (!customFetch) {
    return {
      hasNewVersion: false,
      skipped: true,
      skippedReason: 'fetch_error',
      clientVersion,
      clientBuildId,
    };
  }

  // 3. Construct abort controller with timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), fetchTimeoutMs);

  let combinedSignal = controller.signal;
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timeoutId);
      return {
        hasNewVersion: false,
        skipped: true,
        skippedReason: 'fetch_error',
        clientVersion,
        clientBuildId,
      };
    }
    signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  // 4. Construct cache-busted endpoint URL
  const separator = endpoint.includes('?') ? '&' : '?';
  const url = `${endpoint}${separator}t=${Date.now()}`;

  try {
    const res = await customFetch(url, {
      signal: combinedSignal,
      cache: 'no-store',
      headers: {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        Pragma: 'no-cache',
      },
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      return {
        hasNewVersion: false,
        skipped: true,
        skippedReason: 'fetch_error',
        clientVersion,
        clientBuildId,
      };
    }

    const data = (await res.json()) as VersionFileInfo;
    const serverVersion = data?.version;
    const serverBuildId = data?.buildId;

    // Detect if server is newer or different
    let hasNewVersion = false;

    if (serverVersion && serverVersion !== clientVersion) {
      hasNewVersion = true;
    } else if (
      clientBuildId &&
      serverBuildId &&
      serverBuildId !== clientBuildId
    ) {
      hasNewVersion = true;
    }

    return {
      hasNewVersion,
      clientVersion,
      clientBuildId,
      serverVersion,
      serverBuildId,
      serverRelease: data?.release,
      data,
    };
  } catch {
    clearTimeout(timeoutId);
    return {
      hasNewVersion: false,
      skipped: true,
      skippedReason: 'fetch_error',
      clientVersion,
      clientBuildId,
    };
  }
}
