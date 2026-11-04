import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import {
  resolveRootCookieDomain,
  readCookieValue,
  decodeJwtPayload,
  decodeJwtUid,
  isJwtUnexpired,
  createMultiLayerSessionVault,
} from '../src/pwa-swr/session-vault';

// Helper to create valid/expired mock JWT tokens
function createMockJwt(payload: Record<string, any>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.mock-signature`;
}

describe('@kido/spa-version-guard — Multi-Layer Session & CacheStorage Vault', () => {
  describe('1. JWT Utilities (decode, uid extraction, expiration)', () => {
    it('decodes unpadded and padded base64url JWT payload correctly', () => {
      const payload = { uid: 'user_123', email: 'test@example.com', role: 'admin' };
      const token = createMockJwt(payload);
      const decoded = decodeJwtPayload(token);
      expect(decoded).toEqual(payload);
    });

    it('extracts UID across uid, sub, user_id, and id keys', () => {
      expect(decodeJwtUid(createMockJwt({ uid: 'uid_1' }))).toBe('uid_1');
      expect(decodeJwtUid(createMockJwt({ sub: 'sub_2' }))).toBe('sub_2');
      expect(decodeJwtUid(createMockJwt({ user_id: 'user_3' }))).toBe('user_3');
      expect(decodeJwtUid(createMockJwt({ id: 'id_4' }))).toBe('id_4');
      expect(decodeJwtUid(null)).toBeNull();
      expect(decodeJwtUid('invalid.token')).toBeNull();
    });

    it('validates JWT expiration with tolerance skew', () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const validToken = createMockJwt({ uid: 'u1', exp: nowSec + 3600 });
      const expiredToken = createMockJwt({ uid: 'u1', exp: nowSec - 100 });
      const perpetualToken = createMockJwt({ uid: 'u1' }); // no exp

      expect(isJwtUnexpired(validToken)).toBe(true);
      expect(isJwtUnexpired(expiredToken)).toBe(false);
      expect(isJwtUnexpired(perpetualToken)).toBe(true);
      expect(isJwtUnexpired(null)).toBe(false);
      expect(isJwtUnexpired('malformed')).toBe(false);
    });
  });

  describe('2. Cookie & Domain Resolution', () => {
    it('resolves root cookie domain accurately across standard and multi-segment TLDs', () => {
      expect(resolveRootCookieDomain('app.example.com')).toBe('.app.example.com');
      expect(resolveRootCookieDomain('www.app.example.com')).toBe('.app.example.com');
      expect(resolveRootCookieDomain('api.app.app.example.com')).toBe('.app.example.com');
      expect(resolveRootCookieDomain('khanhdp.com:3000')).toBe('.khanhdp.com');

      // Second-level TLDs (.com.vn, .co.uk)
      expect(resolveRootCookieDomain('store.store.example.com')).toBe('.store.example.com');
      expect(resolveRootCookieDomain('sub.domain.co.uk')).toBe('.domain.co.uk');

      // Localhost and IP addresses should return empty string (host-only)
      expect(resolveRootCookieDomain('localhost')).toBe('');
      expect(resolveRootCookieDomain('127.0.0.1')).toBe('');
      expect(resolveRootCookieDomain('192.168.1.10')).toBe('');
    });

    it('supports custom resolver function or static override string', () => {
      expect(resolveRootCookieDomain('internal.corp', '.custom.root')).toBe('.custom.root');
      expect(
        resolveRootCookieDomain('staging.api.net', (h) => (h.includes('staging') ? '.staging.net' : ''))
      ).toBe('.staging.net');
    });

    it('reads and decodes cookie values from cookie header string', () => {
      const cookieStr = 'kt_session=abc123xyz; other_cookie=hello%20world; empty_val=';
      expect(readCookieValue('kt_session', cookieStr)).toBe('abc123xyz');
      expect(readCookieValue('other_cookie', cookieStr)).toBe('hello world');
      expect(readCookieValue('missing_cookie', cookieStr)).toBeNull();
    });
  });

  describe('3. MultiLayerSessionVault Lifecycle & Self-Healing', () => {
    let mockLocalStorage: Record<string, string>;
    let mockCookies: string[];
    let mockCacheStorage: Map<string, Response>;

    beforeEach(() => {
      mockLocalStorage = {};
      mockCookies = [];
      mockCacheStorage = new Map();

      // Mock localStorage
      (globalThis as any).localStorage = {
        getItem: (key: string) => mockLocalStorage[key] ?? null,
        setItem: (key: string, val: string) => {
          mockLocalStorage[key] = String(val);
        },
        removeItem: (key: string) => {
          delete mockLocalStorage[key];
        },
        clear: () => {
          mockLocalStorage = {};
        },
      };

      // Mock document.cookie
      (globalThis as any).document = {
        get cookie() {
          return mockCookies.join('; ');
        },
        set cookie(val: string) {
          const parts = val.split(';');
          const keyVal = parts[0].trim();
          const sep = keyVal.indexOf('=');
          if (sep !== -1) {
            const key = keyVal.slice(0, sep);
            const value = keyVal.slice(sep + 1);
            if (val.includes('max-age=0') || val.includes('Thu, 01 Jan 1970')) {
              mockCookies = mockCookies.filter((c) => !c.startsWith(`${key}=`));
            } else {
              mockCookies = mockCookies.filter((c) => !c.startsWith(`${key}=`));
              mockCookies.push(`${key}=${value}`);
            }
          }
        },
      };

      // Mock window
      (globalThis as any).window = {
        location: {
          hostname: 'www.app.example.com',
          protocol: 'https:',
        },
        caches: {
          open: async (_name: string) => ({
            put: async (path: string, response: Response) => {
              mockCacheStorage.set(path, response);
            },
            match: async (path: string) => {
              return mockCacheStorage.get(path) ?? null;
            },
            delete: async (path: string) => {
              return mockCacheStorage.delete(path);
            },
          }),
        },
      };
    });

    afterEach(() => {
      delete (globalThis as any).localStorage;
      delete (globalThis as any).document;
      delete (globalThis as any).window;
    });

    it('instant self-healing: retrieves token from cookie and heals localStorage when localStorage is empty', () => {
      const vault = createMultiLayerSessionVault({
        sessionTokenKey: 'test_token',
        userIdKey: 'test_uid',
        cookieNames: ['test_client_token'],
      });

      const validToken = createMockJwt({ uid: 'user_khánh', exp: Math.floor(Date.now() / 1000) + 3600 });
      // Put token in cookie only, simulate iOS Safari localStorage wipe
      document.cookie = `test_client_token=${encodeURIComponent(validToken)}`;

      expect(localStorage.getItem('test_token')).toBeNull();

      const resolved = vault.getStoredSessionTokenSync();
      expect(resolved).toBe(validToken);

      // Verify localStorage was immediately healed
      expect(localStorage.getItem('test_token')).toBe(validToken);
      expect(localStorage.getItem('test_uid')).toBe('user_khánh');
    });

    it('persists session across localStorage, cookies, and CacheStorage', async () => {
      const vault = createMultiLayerSessionVault({
        sessionTokenKey: 'app_token',
        userIdKey: 'app_uid',
        userCacheKey: 'app_user',
        cookieNames: ['app_session'],
        cacheVaultName: 'test-vault',
        cacheVaultPath: '/__auth_vault__',
      });

      const token = createMockJwt({ uid: 'u_100', exp: Math.floor(Date.now() / 1000) + 7200 });
      const user = { uid: 'u_100', name: 'Khánh Dương', role: 'architect' };

      vault.persistSessionTokenMultiLayer(token, user);

      // 1. localStorage verified
      expect(localStorage.getItem('app_token')).toBe(token);
      expect(localStorage.getItem('app_uid')).toBe('u_100');
      expect(JSON.parse(localStorage.getItem('app_user')!)).toEqual(user);

      // 2. Cookie verified
      expect(readCookieValue('app_session')).toBe(token);

      // 3. CacheStorage verified (async microtask yield)
      await new Promise((r) => setTimeout(r, 20));
      const cacheResponse = mockCacheStorage.get('/__auth_vault__');
      expect(cacheResponse).toBeDefined();
      const cachedData = await cacheResponse!.json();
      expect(cachedData.token).toBe(token);
      expect(cachedData.userCache).toEqual(user);
    });

    it('recovers session from CacheStorage when both localStorage and cookies are wiped', async () => {
      const vault = createMultiLayerSessionVault({
        sessionTokenKey: 'rec_token',
        cacheVaultPath: '/__backup__',
      });

      const token = createMockJwt({ uid: 'u_rec', exp: Math.floor(Date.now() / 1000) + 3600 });
      mockCacheStorage.set(
        '/__backup__',
        new Response(JSON.stringify({ token, userCache: { uid: 'u_rec' } }))
      );

      expect(vault.getStoredSessionTokenSync()).toBeNull();

      const recovered = await vault.recoverSessionFromCacheVault();
      expect(recovered).not.toBeNull();
      expect(recovered?.token).toBe(token);
      expect(recovered?.userCache?.uid).toBe('u_rec');

      // Check auto-healing after recovery
      expect(localStorage.getItem('rec_token')).toBe(token);
    });

    it('clears session cleanly across all tiers', () => {
      const vault = createMultiLayerSessionVault({
        sessionTokenKey: 'clean_token',
        cookieNames: ['clean_cookie'],
      });

      const token = createMockJwt({ uid: 'u_clean', exp: Math.floor(Date.now() / 1000) + 3600 });
      vault.persistSessionTokenMultiLayer(token);
      expect(localStorage.getItem('clean_token')).toBe(token);

      vault.clearSessionTokenMultiLayer();

      expect(localStorage.getItem('clean_token')).toBeNull();
      expect(readCookieValue('clean_cookie')).toBeNull();
    });

    it('persists and recovers active progress checkpoints across tab eviction', () => {
      const vault = createMultiLayerSessionVault({
        checkpointCookieName: 'active_workout_timer',
      });

      const checkpoint = { exercise: 'muscle-up', elapsedSeconds: 1420, startedAt: Date.now() };
      vault.persistActiveCheckpoint(checkpoint);

      const recovered = vault.recoverActiveCheckpoint<typeof checkpoint>();
      expect(recovered).toEqual(checkpoint);

      vault.clearActiveCheckpoint();
      expect(vault.recoverActiveCheckpoint()).toBeNull();
    });
  });
});
