import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  COOKIE_KEYS,
  COOKIE_ENV_MAP,
  REQUIRED_COOKIE_KEY,
  REQUIRED_ENV_KEY,
  COOKIE_HEADER_NAME,
  COOKIE_STORAGE_KEY,
  DEFAULT_SERVER_PORT,
  DEFAULT_SERVER_URL,
  DEFAULT_SYNC_ENDPOINT,
  DEFAULT_ACTIVE_COOKIES_ENDPOINT,
  DEFAULT_ENV_STATUS_ENDPOINT,
  DEFAULT_DOWNLOAD_EXTENSION_ENDPOINT,
  GEMINI_EVENT_TYPES,
  EXTENSION_VERSION,
  DEFAULT_AI_ENDPOINTS,
  // Server helpers
  extractCookiesFromHeader,
  validateRequiredCookies,
  mapCookiesToEnv,
  syncCookiesToEnvironment,
  computeCrc32,
  createZipBuffer,
  createExtensionZipBuffer,
  createHonoCookieSyncMiddleware,
  // Client helpers
  isAuthOrCookieExpiredError,
  getStoredCookies,
  saveStoredCookies,
  clearStoredCookies,
  isExtensionAvailable,
  getExtensionVersion,
  pingExtension,
  requestCookieSyncFromExtension,
  setupFetchInterceptor,
  teardownFetchInterceptor,
} from './index';

describe('@kido/gemini-cookie-sync Suite', () => {
  describe('Constants & Specifications', () => {
    test('COOKIE_KEYS includes essential Google Gemini auth cookies', () => {
      assert.ok(COOKIE_KEYS.includes('__Secure-1PSID'));
      assert.ok(COOKIE_KEYS.includes('__Secure-1PSIDTS'));
      assert.ok(COOKIE_KEYS.includes('__Secure-1PSIDCC'));
      assert.ok(COOKIE_KEYS.includes('__Secure-1PAPISID'));
      assert.ok(COOKIE_KEYS.includes('SID'));
      assert.equal(COOKIE_KEYS.length, 13);
    });

    test('COOKIE_ENV_MAP correctly maps all 4 primary cookies', () => {
      assert.equal(COOKIE_ENV_MAP['__Secure-1PSID'], 'SECURE_1PSID');
      assert.equal(COOKIE_ENV_MAP['__Secure-1PSIDTS'], 'SECURE_1PSIDTS');
      assert.equal(COOKIE_ENV_MAP['__Secure-1PSIDCC'], 'SECURE_1PSIDCC');
      assert.equal(COOKIE_ENV_MAP['__Secure-1PAPISID'], 'SECURE_1PAPISID');
    });

    test('Required keys and standard endpoints are defined', () => {
      assert.equal(REQUIRED_COOKIE_KEY, '__Secure-1PSID');
      assert.equal(REQUIRED_ENV_KEY, 'SECURE_1PSID');
      assert.equal(COOKIE_HEADER_NAME, 'X-Gemini-Cookies');
      assert.equal(COOKIE_STORAGE_KEY, 'kido_gemini_cookies');
      assert.equal(DEFAULT_SERVER_PORT, 8000);
      assert.equal(DEFAULT_SERVER_URL, 'http://localhost:8000');
      assert.equal(DEFAULT_SYNC_ENDPOINT, '/api/v1/settings/sync-cookies');
      assert.equal(DEFAULT_ACTIVE_COOKIES_ENDPOINT, '/api/v1/settings/active-cookies');
      assert.equal(DEFAULT_ENV_STATUS_ENDPOINT, '/api/v1/settings/env-status');
      assert.equal(DEFAULT_DOWNLOAD_EXTENSION_ENDPOINT, '/api/v1/settings/download-extension');
      assert.equal(EXTENSION_VERSION, '1.2.4');
      assert.equal(GEMINI_EVENT_TYPES.SYNC_REQUEST, 'GEMINI_SYNC_REQUEST');
      assert.equal(GEMINI_EVENT_TYPES.SYNC_RESPONSE, 'GEMINI_SYNC_RESPONSE');
      assert.ok(DEFAULT_AI_ENDPOINTS.includes('/api/v1/posts'));
    });
  });

  describe('Server Helper Functions', () => {
    test('extractCookiesFromHeader handles URL-encoded JSON', () => {
      const payload = {
        '__Secure-1PSID': 'psid-test-123',
        '__Secure-1PSIDTS': 'psidts-test-456',
      };
      const headerVal = encodeURIComponent(JSON.stringify(payload));
      const extracted = extractCookiesFromHeader(headerVal);

      assert.deepEqual(extracted, payload);
    });

    test('extractCookiesFromHeader handles raw JSON strings', () => {
      const payload = {
        '__Secure-1PSID': 'raw-psid-789',
      };
      const headerVal = JSON.stringify(payload);
      const extracted = extractCookiesFromHeader(headerVal);

      assert.deepEqual(extracted, payload);
    });

    test('extractCookiesFromHeader returns null for invalid inputs', () => {
      assert.equal(extractCookiesFromHeader(null), null);
      assert.equal(extractCookiesFromHeader(undefined), null);
      assert.equal(extractCookiesFromHeader(''), null);
      assert.equal(extractCookiesFromHeader('   '), null);
      assert.equal(extractCookiesFromHeader('not-json'), null);
      assert.equal(extractCookiesFromHeader('[1, 2, 3]'), null);
      assert.equal(extractCookiesFromHeader('12345'), null);
    });

    test('validateRequiredCookies validates primary cookie requirement', () => {
      const validCookies = {
        '__Secure-1PSID': 'psid-val-123',
        '__Secure-1PSIDTS': 'ts-val',
      };
      const resValid = validateRequiredCookies(validCookies);
      assert.equal(resValid.valid, true);
      assert.equal(resValid.hasRequiredCookie, true);
      assert.equal(resValid.missingKey, undefined);
      assert.equal(resValid.cookieCount, 2);

      const invalidCookies = {
        '__Secure-1PSIDTS': 'only-ts',
      };
      const resInvalid = validateRequiredCookies(invalidCookies);
      assert.equal(resInvalid.valid, false);
      assert.equal(resInvalid.hasRequiredCookie, false);
      assert.equal(resInvalid.missingKey, '__Secure-1PSID');

      const emptyValCookies = {
        '__Secure-1PSID': '   ',
      };
      const resEmpty = validateRequiredCookies(emptyValCookies);
      assert.equal(resEmpty.valid, false);

      assert.equal(validateRequiredCookies(null).valid, false);
      assert.equal(validateRequiredCookies(undefined).valid, false);
    });

    test('mapCookiesToEnv maps cookies to uppercase environment keys', () => {
      const raw = {
        '__Secure-1PSID': 'psid-value',
        '__Secure-1PSIDTS': 'psidts-value',
        '__Secure-1PAPISID': 'papisid-value',
        unrelated_cookie: 'ignore-me',
      };
      const mapped = mapCookiesToEnv(raw);

      assert.equal(mapped.SECURE_1PSID, 'psid-value');
      assert.equal(mapped.SECURE_1PSIDTS, 'psidts-value');
      assert.equal(mapped.SECURE_1PAPISID, 'papisid-value');
      assert.equal(mapped.SECURE_1PSIDCC, undefined);
      assert.equal(mapped.unrelated_cookie, undefined);
    });

    test('syncCookiesToEnvironment updates target env dictionary', () => {
      const targetEnv: Record<string, string | undefined> = {};
      const cookies = {
        '__Secure-1PSID': 'env-psid-test',
        '__Secure-1PSIDCC': 'env-psidcc-test',
      };

      const result = syncCookiesToEnvironment(cookies, targetEnv);
      assert.equal(result.count, 2);
      assert.ok(result.updatedKeys.includes('SECURE_1PSID'));
      assert.ok(result.updatedKeys.includes('SECURE_1PSIDCC'));
      assert.equal(targetEnv.SECURE_1PSID, 'env-psid-test');
      assert.equal(targetEnv.SECURE_1PSIDCC, 'env-psidcc-test');
    });

    test('computeCrc32 matches standard IEEE 802.3 CRC-32 test vector', () => {
      // Test vector "123456789" => 0xcbf43926 (3421780262)
      const testBuf = Buffer.from('123456789', 'utf8');
      const crc = computeCrc32(testBuf);
      assert.equal(crc, 0xcbf43926);
    });

    test('createZipBuffer packages entries into valid ZIP format', () => {
      const entries = [
        { name: 'hello.txt', data: 'Hello World!' },
        { name: 'sub/test.json', data: JSON.stringify({ ok: true }) },
      ];

      const zipBuf = createZipBuffer(entries);
      assert.ok(Buffer.isBuffer(zipBuf));
      assert.ok(zipBuf.length > 50);

      // Check ZIP Local Header signature PK\x03\x04
      assert.equal(zipBuf[0], 0x50);
      assert.equal(zipBuf[1], 0x4b);
      assert.equal(zipBuf[2], 0x03);
      assert.equal(zipBuf[3], 0x04);
    });

    test('createExtensionZipBuffer packages extension files from disk', () => {
      const extDir = path.resolve(__dirname, 'extension');
      assert.ok(fs.existsSync(extDir), 'src/extension directory must exist');

      const zipBuffer = createExtensionZipBuffer(extDir);
      assert.ok(Buffer.isBuffer(zipBuffer));
      assert.ok(zipBuffer.length > 1000, 'Zip buffer must contain all extension files');

      // Check ZIP End of Central Directory signature PK\x05\x06 near end of buffer
      const eocdIndex = zipBuffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
      assert.ok(eocdIndex > 0, 'Must have valid EOCD marker');
    });

    test('createHonoCookieSyncMiddleware extracts cookies and sets context', async () => {
      const middleware = createHonoCookieSyncMiddleware({ autoSyncEnv: false });
      const store: Record<string, unknown> = {};
      const mockContext = {
        req: {
          header: (name: string) => {
            if (name === COOKIE_HEADER_NAME) {
              return encodeURIComponent(JSON.stringify({ '__Secure-1PSID': 'hono-psid' }));
            }
            return undefined;
          },
        },
        set: (key: string, value: unknown) => {
          store[key] = value;
        },
      };

      let nextCalled = false;
      await middleware(mockContext, async () => {
        nextCalled = true;
      });

      assert.equal(nextCalled, true);
      assert.deepEqual(store.geminiCookies, { '__Secure-1PSID': 'hono-psid' });
    });
  });

  describe('Client Helper Functions & Error Detection', () => {
    test('isAuthOrCookieExpiredError identifies HTTP 401 and 403 as auth errors', () => {
      assert.equal(isAuthOrCookieExpiredError(401), true);
      assert.equal(isAuthOrCookieExpiredError(403), true);
    });

    test('isAuthOrCookieExpiredError detects Vietnamese and English cookie error patterns', () => {
      assert.equal(isAuthOrCookieExpiredError(500, 'Lỗi cookie hết hạn phiên làm việc'), true);
      assert.equal(isAuthOrCookieExpiredError(500, { detail: 'SNlM0e token extraction failed' }), true);
      assert.equal(isAuthOrCookieExpiredError(400, { detail: 'Thiếu cookie __Secure-1PSID từ Extension' }), true);
      assert.equal(isAuthOrCookieExpiredError(500, { message: 'User unauthenticated' }), true);
      assert.equal(isAuthOrCookieExpiredError(502, 'Bad Gateway: token expired'), true);
      assert.equal(isAuthOrCookieExpiredError(500, 'Yêu cầu phải có cookie Google hợp lệ'), true);

      // Non-cookie errors return false
      assert.equal(isAuthOrCookieExpiredError(200, 'Success'), false);
      assert.equal(isAuthOrCookieExpiredError(500, 'Internal Server Error: database connection timeout'), false);
      assert.equal(isAuthOrCookieExpiredError(404, 'Not Found'), false);
    });

    describe('Browser Storage & Interceptor in Simulated Environment', () => {
      let storageMock: Record<string, string> = {};
      let messageListeners: Array<(event: MessageEvent) => void> = [];

      beforeEach(() => {
        storageMock = {};
        messageListeners = [];

        // Global mocks for Node test runtime
        (globalThis as unknown as { localStorage: Storage }).localStorage = {
          getItem: (key: string) => storageMock[key] ?? null,
          setItem: (key: string, value: string) => {
            storageMock[key] = String(value);
          },
          removeItem: (key: string) => {
            delete storageMock[key];
          },
          clear: () => {
            storageMock = {};
          },
          length: 0,
          key: () => null,
        };

        const globalWin = {
          localStorage: (globalThis as unknown as { localStorage: Storage }).localStorage,
          postMessage: (data: unknown) => {
            for (const listener of [...messageListeners]) {
              listener({ source: globalWin, data } as unknown as MessageEvent);
            }
          },
          addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
            if (type === 'message' && typeof listener === 'function') {
              messageListeners.push(listener as (event: MessageEvent) => void);
            }
          },
          removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
            if (type === 'message') {
              messageListeners = messageListeners.filter((l) => l !== listener);
            }
          },
          fetch: async () => new Response('ok', { status: 200 }),
        };

        (globalThis as unknown as { window: typeof globalWin }).window = globalWin;

        (globalThis as unknown as { document: { documentElement: { dataset: Record<string, string> } } }).document = {
          documentElement: {
            dataset: {},
          },
        };
      });

      afterEach(() => {
        teardownFetchInterceptor();
        delete (globalThis as unknown as { window?: unknown }).window;
        delete (globalThis as unknown as { localStorage?: unknown }).localStorage;
        delete (globalThis as unknown as { document?: unknown }).document;
      });

      test('getStoredCookies, saveStoredCookies, and clearStoredCookies operate correctly', () => {
        assert.equal(getStoredCookies(), null);

        const sample = {
          '__Secure-1PSID': 'storage-psid-abc',
          '__Secure-1PSIDTS': 'storage-ts-xyz',
        };

        saveStoredCookies(sample);
        assert.deepEqual(getStoredCookies(), sample);

        clearStoredCookies();
        assert.equal(getStoredCookies(), null);
      });

      test('isExtensionAvailable detects window flag and document dataset', () => {
        assert.equal(isExtensionAvailable(), false);

        (globalThis as unknown as { window: { __GEMINI_EXTENSION_INSTALLED__?: boolean } }).window.__GEMINI_EXTENSION_INSTALLED__ = true;
        assert.equal(isExtensionAvailable(), true);

        delete (globalThis as unknown as { window: { __GEMINI_EXTENSION_INSTALLED__?: boolean } }).window.__GEMINI_EXTENSION_INSTALLED__;
        (globalThis as unknown as { document: { documentElement: { dataset: Record<string, string> } } }).document.documentElement.dataset.geminiExtensionInstalled = 'true';
        assert.equal(isExtensionAvailable(), true);
      });

      test('pingExtension resolves when extension replies', async () => {
        // Mock extension background replying to ping
        window.addEventListener('message', (event) => {
          if (event.data?.type === GEMINI_EVENT_TYPES.PING_REQUEST) {
            window.postMessage({
              type: GEMINI_EVENT_TYPES.PING_RESPONSE,
              requestId: event.data.requestId,
              installed: true,
              version: '1.2.4',
            });
          }
        });

        const result = await pingExtension({ timeoutMs: 500 });
        assert.equal(result.installed, true);
        assert.equal(result.version, '1.2.4');
        assert.equal(getExtensionVersion(), '1.2.4');
      });

      test('requestCookieSyncFromExtension resolves with cookies on extension response', async () => {
        const mockCookies = {
          '__Secure-1PSID': 'fresh-extension-psid',
          '__Secure-1PSIDTS': 'fresh-extension-ts',
        };

        let capturedTargetUrl: string | undefined;

        // Mock extension background responding to sync
        window.addEventListener('message', (event) => {
          if (event.data?.type === GEMINI_EVENT_TYPES.SYNC_REQUEST) {
            capturedTargetUrl = event.data.targetUrl;
            window.postMessage({
              type: GEMINI_EVENT_TYPES.SYNC_RESPONSE,
              requestId: event.data.requestId,
              payload: {
                ok: true,
                cookies: mockCookies,
                message: 'Đồng bộ thành công!',
              },
            });
          }
        });

        const synced = await requestCookieSyncFromExtension({
          timeoutMs: 500,
          targetUrl: 'https://staging-app.example.com',
        });
        assert.deepEqual(synced, mockCookies);
        assert.deepEqual(getStoredCookies(), mockCookies);
        assert.equal(isExtensionAvailable(), true);
        assert.equal(capturedTargetUrl, 'https://staging-app.example.com');
      });

      test('setupFetchInterceptor injects X-Gemini-Cookies header on requests', async () => {
        saveStoredCookies({
          '__Secure-1PSID': 'interceptor-psid',
        });

        let capturedHeaders: Headers | null = null;
        window.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
          capturedHeaders = new Headers(init?.headers);
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        };

        const teardown = setupFetchInterceptor();

        await window.fetch('/api/v1/posts/generate', { method: 'POST' });

        assert.ok(capturedHeaders);
        const headerVal = (capturedHeaders as Headers).get(COOKIE_HEADER_NAME);
        assert.ok(headerVal);
        assert.deepEqual(extractCookiesFromHeader(headerVal), {
          '__Secure-1PSID': 'interceptor-psid',
        });

        teardown();
      });

      test('setupFetchInterceptor recovers seamlessly on 401 AI endpoint error', async () => {
        saveStoredCookies({
          '__Secure-1PSID': 'old-expired-psid',
        });

        const freshCookies = {
          '__Secure-1PSID': 'brand-new-fresh-psid',
        };

        // Simulate extension answering sync request
        window.addEventListener('message', (event) => {
          if (event.data?.type === GEMINI_EVENT_TYPES.SYNC_REQUEST) {
            window.postMessage({
              type: GEMINI_EVENT_TYPES.SYNC_RESPONSE,
              requestId: event.data.requestId,
              payload: {
                ok: true,
                cookies: freshCookies,
              },
            });
          }
        });

        let attemptCount = 0;
        let lastHeader: string | null = null;

        window.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
          attemptCount++;
          lastHeader = new Headers(init?.headers).get(COOKIE_HEADER_NAME);

          if (attemptCount === 1) {
            return new Response(JSON.stringify({ detail: 'Token expired / Cookie hết hạn' }), {
              status: 401,
            });
          }

          return new Response(JSON.stringify({ status: 'generated_image_success' }), {
            status: 200,
          });
        };

        let syncSuccessCookies: Record<string, string> | null = null;
        const teardown = setupFetchInterceptor({
          aiEndpoints: ['/api/v1/posts'],
          onSyncSuccess: (cookies) => {
            syncSuccessCookies = cookies;
          },
        });

        const res = await window.fetch('/api/v1/posts', { method: 'POST' });
        assert.equal(res.status, 200);
        assert.equal(attemptCount, 2, 'Should have retried the request after refreshing cookies');
        assert.deepEqual(syncSuccessCookies, freshCookies);

        // Header on second attempt should be updated with new cookie
        assert.ok(lastHeader);
        assert.deepEqual(extractCookiesFromHeader(lastHeader), freshCookies);

        teardown();
      });
    });
  });
});
