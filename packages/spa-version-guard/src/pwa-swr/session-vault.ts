/**
 * Multi-Layer First-Party Session & CacheStorage Vault
 *
 * Survives iOS 18+ WebKit ITP (7-day script-writable cookie/storage cap,
 * cross-subdomain partitioning between root and www/subdomains, and aggressive
 * tab memory/localStorage eviction).
 *
 * Synchronizes session credentials across 4 resilient layers:
 * 1. Synchronous localStorage (instant 0ms read)
 * 2. First-Party Root Cookies (.domain.com for cross-subdomain survival)
 * 3. Service Worker CacheStorage (Cache API vault immune to simple storage sweeps)
 * 4. Optional Server HTTP Set-Cookie hydration
 */

export interface SessionVaultConfig {
  /** Key used for session token in localStorage */
  sessionTokenKey: string;
  /** Key used for user ID in localStorage */
  userIdKey: string;
  /** Key used for cached user JSON in localStorage */
  userCacheKey: string;
  /** Primary and fallback cookie names to inspect */
  cookieNames: string[];
  /** Name of the CacheStorage cache bucket */
  cacheVaultName: string;
  /** Internal request path used as the CacheStorage key */
  cacheVaultPath: string;
  /** Cookie max-age in seconds (default: 30 days = 2,592,000s) */
  cookieMaxAgeSeconds: number;
  /** Optional static root domain or custom resolver function */
  rootCookieDomain?: string | ((hostname: string) => string);
  /** Optional server endpoint to set real HTTP Set-Cookie headers */
  httpEndpoint?: string;
  /** Cookie name for active checkpoint / in-flight timer persistence */
  checkpointCookieName?: string;
}

export const DEFAULT_SESSION_VAULT_CONFIG: SessionVaultConfig = {
  sessionTokenKey: 'kt_session_token',
  userIdKey: 'kt_user_id',
  userCacheKey: 'kt_user_cache',
  cookieNames: ['kt_client_token', 'kt_session', 'session_token'],
  cacheVaultName: 'kt-session-vault-v1',
  cacheVaultPath: '/__kt_session_backup__',
  cookieMaxAgeSeconds: 2592000,
  checkpointCookieName: 'kt_active_checkpoint',
};

/**
 * Automatically extracts the root cookie domain (e.g. '.example.com' from 'www.example.com'
 * or 'app.example.com'). Returns empty string for localhost, IP addresses, or single-segment hosts.
 */
export function resolveRootCookieDomain(
  hostname?: string,
  customResolver?: string | ((host: string) => string)
): string {
  if (typeof customResolver === 'string') {
    return customResolver;
  }
  const host = (
    hostname ||
    (typeof window !== 'undefined' && window.location ? window.location.hostname : '')
  )
    .toLowerCase()
    .split(':')[0]
    .trim();

  if (!host || host === 'localhost' || host === '127.0.0.1' || /^(\d{1,3}\.){3}\d{1,3}$/.test(host)) {
    return '';
  }

  if (typeof customResolver === 'function') {
    return customResolver(host);
  }

  const parts = host.split('.');
  if (parts.length < 2) return '';

  // Common second-level TLDs (e.g. .com.vn, .co.uk)
  const isSecondLevelTld =
    parts.length >= 3 &&
    ['com', 'co', 'gov', 'edu', 'org', 'net'].includes(parts[parts.length - 2]) &&
    parts[parts.length - 1].length <= 3;

  if (isSecondLevelTld) {
    if (parts.length >= 3) {
      return `.${parts.slice(-3).join('.')}`;
    }
    return `.${host}`;
  }

  return `.${parts.slice(-2).join('.')}`;
}

/**
 * Safely reads and decodes a cookie value by name from document.cookie or a raw cookie string.
 */
export function readCookieValue(name: string, rawCookieHeader?: string): string | null {
  const cookieStr =
    rawCookieHeader !== undefined
      ? rawCookieHeader
      : typeof document !== 'undefined'
      ? document.cookie
      : '';

  if (!cookieStr) return null;

  try {
    const cookies = cookieStr.split('; ');
    for (const cookie of cookies) {
      const sep = cookie.indexOf('=');
      if (sep === -1) continue;
      const key = cookie.slice(0, sep).trim();
      if (key === name) {
        const val = cookie.slice(sep + 1);
        try {
          return decodeURIComponent(val);
        } catch {
          return val;
        }
      }
    }
  } catch {}
  return null;
}

/**
 * Decodes the JSON payload from a JWT token without verifying its cryptographic signature (client-side only).
 */
export function decodeJwtPayload(token: string | null): Record<string, any> | null {
  if (!token || typeof token !== 'string') return null;
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
    let json: string;
    if (typeof Buffer !== 'undefined') {
      json = Buffer.from(padded, 'base64').toString('utf-8');
    } else if (typeof atob === 'function') {
      const binary = atob(padded);
      try {
        json = decodeURIComponent(
          binary
            .split('')
            .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
            .join('')
        );
      } catch {
        json = binary;
      }
    } else {
      return null;
    }
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * Extracts UID from decoded JWT payload ('uid' | 'sub' | 'user_id' | 'id').
 */
export function decodeJwtUid(token: string | null): string | null {
  const payload = decodeJwtPayload(token);
  return payload?.uid || payload?.sub || payload?.user_id || payload?.id || null;
}

/**
 * Checks if a JWT token has not expired.
 * If token does not specify an `exp` field, it is considered unexpired.
 */
export function isJwtUnexpired(token: string | null, clockSkewMs = 5000): boolean {
  if (!token) return false;
  const payload = decodeJwtPayload(token);
  if (!payload) return false;
  if (!payload.exp) return true;
  return payload.exp * 1000 > Date.now() - clockSkewMs;
}

/**
 * Creates an isolated, multi-layer resilient session vault instance.
 */
export function createMultiLayerSessionVault(options?: Partial<SessionVaultConfig>) {
  const config: SessionVaultConfig = { ...DEFAULT_SESSION_VAULT_CONFIG, ...options };

  /**
   * Synchronously retrieves a valid session token:
   * 1. Checks localStorage.
   * 2. If missing or invalid, falls back to cross-subdomain first-party cookies.
   * 3. If found in cookie, immediately heals localStorage for 0ms subsequent reads.
   */
  function getStoredSessionTokenSync(): string | null {
    if (typeof window === 'undefined') return null;
    try {
      if (typeof localStorage !== 'undefined') {
        const localToken = localStorage.getItem(config.sessionTokenKey);
        if (localToken && isJwtUnexpired(localToken)) {
          return localToken;
        }
      }

      // Check configured cookie names in order
      for (const cookieName of config.cookieNames) {
        const cookieToken = readCookieValue(cookieName);
        if (cookieToken && isJwtUnexpired(cookieToken)) {
          // Instant self-heal
          if (typeof localStorage !== 'undefined') {
            try {
              localStorage.setItem(config.sessionTokenKey, cookieToken);
              const uid = decodeJwtUid(cookieToken);
              if (uid) {
                localStorage.setItem(config.userIdKey, uid);
              }
            } catch {}
          }
          return cookieToken;
        }
      }
    } catch (err) {
      // In restricted environments / iframe sandboxes, fail gracefully
    }
    return null;
  }

  /**
   * Persists session token across multiple resilient storage tiers.
   */
  function persistSessionTokenMultiLayer(
    token: string,
    userObj?: Record<string, any>
  ): void {
    if (typeof window === 'undefined' || !token) return;
    try {
      const uid = userObj?.uid || userObj?.id || decodeJwtUid(token);

      // 1. Synchronous localStorage
      if (typeof localStorage !== 'undefined') {
        try {
          localStorage.setItem(config.sessionTokenKey, token);
          if (uid) {
            localStorage.setItem(config.userIdKey, String(uid));
          }
          if (userObj) {
            localStorage.setItem(config.userCacheKey, JSON.stringify(userObj));
          }
        } catch {}
      }

      // 2. First-Party Cookies (Host-only + Root domain)
      if (typeof document !== 'undefined') {
        const rootDomain = resolveRootCookieDomain(undefined, config.rootCookieDomain);
        const isSecure =
          typeof window !== 'undefined' &&
          window.location &&
          window.location.protocol === 'https:';
        const secureFlag = isSecure ? '; Secure' : '';
        const encodedToken = encodeURIComponent(token);
        const primaryCookieName = config.cookieNames[0] || 'kt_session';

        // Host-only cookie
        document.cookie = `${primaryCookieName}=${encodedToken}; path=/; max-age=${config.cookieMaxAgeSeconds}; SameSite=Lax${secureFlag}`;

        // Root-domain cookie (for cross-subdomain sharing e.g. .example.com)
        if (rootDomain) {
          document.cookie = `${primaryCookieName}=${encodedToken}; path=/; domain=${rootDomain}; max-age=${config.cookieMaxAgeSeconds}; SameSite=Lax${secureFlag}`;
        }
      }

      // 3. Service Worker CacheStorage Vault
      if (typeof window !== 'undefined' && 'caches' in window) {
        window.caches
          .open(config.cacheVaultName)
          .then((cache) => {
            const payload = JSON.stringify({
              token,
              userCache: userObj,
              savedAt: Date.now(),
            });
            cache.put(
              config.cacheVaultPath,
              new Response(payload, {
                headers: { 'Content-Type': 'application/json' },
              })
            );
          })
          .catch(() => {});
      }

      // 4. Optional Server HTTP Set-Cookie hydration
      if (config.httpEndpoint && typeof fetch === 'function') {
        fetch(config.httpEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, userCache: userObj }),
        }).catch(() => {});
      }
    } catch {}
  }

  /**
   * Recovers session from Service Worker Cache Storage when localStorage was evicted by iOS WebKit.
   * Automatically heals localStorage and cookies if a valid token is found.
   */
  async function recoverSessionFromCacheVault(): Promise<{
    token: string;
    userCache?: any;
  } | null> {
    if (typeof window === 'undefined' || !('caches' in window)) return null;
    try {
      const cache = await window.caches.open(config.cacheVaultName);
      const response = await cache.match(config.cacheVaultPath);
      if (!response) return null;

      const data = await response.json();
      if (!data?.token) return null;

      if (isJwtUnexpired(data.token)) {
        persistSessionTokenMultiLayer(data.token, data.userCache);
        return { token: data.token, userCache: data.userCache };
      }
    } catch {}
    return null;
  }

  /**
   * Clears multi-layer session tokens across all storage tiers.
   */
  function clearSessionTokenMultiLayer(): void {
    if (typeof window === 'undefined') return;
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem(config.sessionTokenKey);
        localStorage.removeItem(config.userIdKey);
        localStorage.removeItem(config.userCacheKey);
      }

      if (typeof document !== 'undefined') {
        const expired = 'expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; max-age=0';
        const rootDomain = resolveRootCookieDomain(undefined, config.rootCookieDomain);

        for (const cookieName of config.cookieNames) {
          document.cookie = `${cookieName}=; ${expired}`;
          if (rootDomain) {
            document.cookie = `${cookieName}=; domain=${rootDomain}; ${expired}`;
          }
        }
      }

      if (typeof window !== 'undefined' && 'caches' in window) {
        window.caches
          .open(config.cacheVaultName)
          .then((cache) => cache.delete(config.cacheVaultPath))
          .catch(() => {});
      }
    } catch {}
  }

  /**
   * Persists an active progress checkpoint (e.g. running timer, form draft)
   * into both localStorage and first-party cookies to survive tab memory eviction.
   */
  function persistActiveCheckpoint<T = Record<string, any>>(data: T): void {
    if (typeof window === 'undefined' || !config.checkpointCookieName) return;
    try {
      const serialized = JSON.stringify(data);
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(config.checkpointCookieName, serialized);
      }
      if (typeof document !== 'undefined') {
        const rootDomain = resolveRootCookieDomain(undefined, config.rootCookieDomain);
        const encoded = encodeURIComponent(serialized);
        const maxAge = 86400; // 24 hours
        document.cookie = `${config.checkpointCookieName}=${encoded}; path=/; max-age=${maxAge}; SameSite=Lax`;
        if (rootDomain) {
          document.cookie = `${config.checkpointCookieName}=${encoded}; path=/; domain=${rootDomain}; max-age=${maxAge}; SameSite=Lax`;
        }
      }
    } catch {}
  }

  /**
   * Recovers active progress checkpoint from localStorage or cookies.
   */
  function recoverActiveCheckpoint<T = Record<string, any>>(): T | null {
    if (typeof window === 'undefined' || !config.checkpointCookieName) return null;
    try {
      if (typeof localStorage !== 'undefined') {
        const rawLocal = localStorage.getItem(config.checkpointCookieName);
        if (rawLocal) {
          return JSON.parse(rawLocal);
        }
      }
      const rawCookie = readCookieValue(config.checkpointCookieName);
      if (rawCookie) {
        const parsed = JSON.parse(rawCookie);
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem(config.checkpointCookieName, rawCookie);
        }
        return parsed;
      }
    } catch {}
    return null;
  }

  /**
   * Clears the active progress checkpoint across all tiers.
   */
  function clearActiveCheckpoint(): void {
    if (typeof window === 'undefined' || !config.checkpointCookieName) return;
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem(config.checkpointCookieName);
      }
      if (typeof document !== 'undefined') {
        const expired = 'expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; max-age=0';
        const rootDomain = resolveRootCookieDomain(undefined, config.rootCookieDomain);
        document.cookie = `${config.checkpointCookieName}=; ${expired}`;
        if (rootDomain) {
          document.cookie = `${config.checkpointCookieName}=; domain=${rootDomain}; ${expired}`;
        }
      }
    } catch {}
  }

  return {
    config,
    getStoredSessionTokenSync,
    persistSessionTokenMultiLayer,
    recoverSessionFromCacheVault,
    clearSessionTokenMultiLayer,
    persistActiveCheckpoint,
    recoverActiveCheckpoint,
    clearActiveCheckpoint,
  };
}
