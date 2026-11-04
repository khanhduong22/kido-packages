import { useEffect, useState, useRef, useCallback } from 'react';
import type {
  UseAppVersionGuardOptions,
  UseAppVersionGuardReturn,
  VersionCheckResult,
  VersionRelease,
} from '../types';
import {
  checkSpaVersion,
  cleanBrowserCaches,
  updateServiceWorkers,
  markReloadAttempt,
  DEFAULT_ENDPOINT,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_INITIAL_DELAY_MS,
  DEFAULT_RELOAD_DELAY_MS,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_BYPASS_KEYS,
} from '../checker';

/**
 * Resolves default client version from global defines or fallback
 */
function resolveClientVersion(explicitVersion?: string): string {
  if (explicitVersion) return explicitVersion;
  if (typeof window !== 'undefined') {
    const w = window as unknown as Record<string, unknown>;
    if (typeof w.__APP_VERSION__ === 'string') return w.__APP_VERSION__;
    if (typeof w.__APP_BUILD_ID__ === 'string') return w.__APP_BUILD_ID__;
  }
  return '1.0.0';
}

function resolveClientBuildId(explicitBuildId?: string): string | undefined {
  if (explicitBuildId) return explicitBuildId;
  if (typeof window !== 'undefined') {
    const w = window as unknown as Record<string, unknown>;
    if (typeof w.__APP_BUILD_ID__ === 'string') return w.__APP_BUILD_ID__;
  }
  return undefined;
}

/**
 * React Hook for automatic SPA Version Guard:
 * - Listens for new deployments via periodic polling, visibilitychange, and focus events.
 * - Anti-infinite reload loop guard with sessionStorage cooldown.
 * - CacheStorage purging and ServiceWorker update triggers.
 * - Smooth banner state with reload timeout.
 */
export function useAppVersionGuard(
  options: UseAppVersionGuardOptions = {}
): UseAppVersionGuardReturn {
  const {
    clientVersion: propClientVersion,
    clientBuildId: propClientBuildId,
    endpoint = DEFAULT_ENDPOINT,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    initialDelayMs = DEFAULT_INITIAL_DELAY_MS,
    reloadDelayMs = DEFAULT_RELOAD_DELAY_MS,
    cooldownMs = DEFAULT_COOLDOWN_MS,
    enabled = true,
    autoReload = true,
    cleanCachesOnUpdate = true,
    updateServiceWorkerOnUpdate = true,
    bypassKeys,
    onNewVersionDetected,
    onBeforeReload,
    customFetch,
  } = options;

  const [isUpdating, setIsUpdating] = useState(false);
  const [hasNewVersion, setHasNewVersion] = useState(false);
  const [serverVersion, setServerVersion] = useState<string | null>(null);
  const [serverBuildId, setServerBuildId] = useState<string | null>(null);
  const [serverRelease, setServerRelease] = useState<VersionRelease | null>(null);

  const isReloadingRef = useRef(false);
  const isExecutingCheckRef = useRef(false);

  const clientVersion = resolveClientVersion(propClientVersion);
  const clientBuildId = resolveClientBuildId(propClientBuildId);

  /**
   * Performs cache cleanup, service worker refresh, and reloads window
   */
  const triggerReload = useCallback(async () => {
    isReloadingRef.current = true;
    setIsUpdating(true);

    markReloadAttempt(bypassKeys?.lastReloadTsKey || DEFAULT_BYPASS_KEYS.lastReloadTsKey);

    try {
      if (cleanCachesOnUpdate) {
        await cleanBrowserCaches();
      }
      if (updateServiceWorkerOnUpdate) {
        await updateServiceWorkers();
      }
      if (onBeforeReload) {
        await onBeforeReload();
      }
    } catch (err) {
      console.warn('[@kido/spa-version-guard] Error in pre-reload tasks:', err);
    }

    setTimeout(() => {
      if (typeof window !== 'undefined') {
        window.location.reload();
      }
    }, reloadDelayMs);
  }, [
    bypassKeys?.lastReloadTsKey,
    cleanCachesOnUpdate,
    updateServiceWorkerOnUpdate,
    onBeforeReload,
    reloadDelayMs,
  ]);

  /**
   * Trigger immediate version check
   */
  const checkNow = useCallback(async (): Promise<VersionCheckResult> => {
    if (!enabled) {
      return {
        hasNewVersion: false,
        skipped: true,
        skippedReason: 'disabled',
        clientVersion,
        clientBuildId,
      };
    }

    if (isReloadingRef.current) {
      return {
        hasNewVersion: false,
        skipped: true,
        skippedReason: 'already_reloading',
        clientVersion,
        clientBuildId,
      };
    }

    if (isExecutingCheckRef.current) {
      return {
        hasNewVersion: false,
        skipped: true,
        skippedReason: 'already_reloading',
        clientVersion,
        clientBuildId,
      };
    }

    isExecutingCheckRef.current = true;

    try {
      const result = await checkSpaVersion({
        endpoint,
        clientVersion,
        clientBuildId,
        cooldownMs,
        bypassKeys,
        customFetch,
      });

      if (result.hasNewVersion) {
        setHasNewVersion(true);
        if (result.serverVersion) setServerVersion(result.serverVersion);
        if (result.serverBuildId) setServerBuildId(result.serverBuildId);
        if (result.serverRelease) setServerRelease(result.serverRelease);

        onNewVersionDetected?.(result);

        if (autoReload && !isReloadingRef.current) {
          await triggerReload();
        }
      }

      return result;
    } finally {
      isExecutingCheckRef.current = false;
    }
  }, [
    enabled,
    clientVersion,
    clientBuildId,
    endpoint,
    cooldownMs,
    bypassKeys,
    customFetch,
    onNewVersionDetected,
    autoReload,
    triggerReload,
  ]);

  /**
   * Manual reload trigger
   */
  const reloadNow = useCallback(async (): Promise<void> => {
    await triggerReload();
  }, [triggerReload]);

  useEffect(() => {
    if (!enabled) return;

    // 1. Initial check delayed to yield frame 1 bandwidth to critical path
    const initialTimer = setTimeout(() => {
      checkNow();
    }, initialDelayMs);

    // 2. Visibility change handler (check when user returns to tab)
    const handleVisibility = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        checkNow();
      }
    };

    // 3. Window focus handler
    const handleFocus = () => {
      checkNow();
    };

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibility);
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', handleFocus);
    }

    // 4. Periodic background polling interval
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    if (pollIntervalMs && pollIntervalMs > 0) {
      pollTimer = setInterval(() => {
        checkNow();
      }, pollIntervalMs);
    }

    return () => {
      clearTimeout(initialTimer);
      if (pollTimer) clearInterval(pollTimer);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibility);
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener('focus', handleFocus);
      }
    };
  }, [enabled, initialDelayMs, pollIntervalMs, checkNow]);

  return {
    isUpdating,
    hasNewVersion,
    serverVersion,
    serverBuildId,
    serverRelease,
    checkNow,
    reloadNow,
  };
}

export default useAppVersionGuard;
