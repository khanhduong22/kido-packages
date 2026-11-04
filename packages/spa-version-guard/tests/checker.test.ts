import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import {
  parseSemver,
  compareSemver,
  isVersionNewer,
  isCooldownActive,
  markReloadAttempt,
  clearReloadAttempt,
  shouldBypassVersionCheck,
  cleanBrowserCaches,
  updateServiceWorkers,
  checkSpaVersion,
  DEFAULT_BYPASS_KEYS,
  viteVersionPlugin,
} from '../src/index';

// Storage Mock helper
function createStorageMock() {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = String(value);
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    },
  };
}

describe('@kido/spa-version-guard Test Suite', () => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalNavigator = globalThis.navigator;

  let mockSessionStorage: ReturnType<typeof createStorageMock>;
  let mockLocalStorage: ReturnType<typeof createStorageMock>;

  beforeEach(() => {
    mockSessionStorage = createStorageMock();
    mockLocalStorage = createStorageMock();

    // Setup global window / document mocks
    (globalThis as any).window = {
      location: { reload: mock(() => {}) },
      sessionStorage: mockSessionStorage,
      localStorage: mockLocalStorage,
      addEventListener: mock(() => {}),
      removeEventListener: mock(() => {}),
    };

    (globalThis as any).document = {
      visibilityState: 'visible',
      addEventListener: mock(() => {}),
      removeEventListener: mock(() => {}),
    };

    (globalThis as any).sessionStorage = mockSessionStorage;
    (globalThis as any).localStorage = mockLocalStorage;
  });

  afterEach(() => {
    (globalThis as any).window = originalWindow;
    (globalThis as any).document = originalDocument;
    (globalThis as any).navigator = originalNavigator;
  });

  describe('1. Semver Parsing and Comparison', () => {
    it('parses valid semver strings with or without v prefix', () => {
      expect(parseSemver('1.2.3')).toEqual([1, 2, 3]);
      expect(parseSemver('v2.10.4')).toEqual([2, 10, 4]);
      expect(parseSemver('3.0.0-beta.1')).toEqual([3, 0, 0]);
      expect(parseSemver('invalid')).toBeNull();
      expect(parseSemver('')).toBeNull();
    });

    it('accurately compares two semantic versions', () => {
      expect(compareSemver('1.0.0', '1.0.0')).toBe(0);
      expect(compareSemver('1.2.0', '1.1.9')).toBe(1);
      expect(compareSemver('1.0.1', '1.0.2')).toBe(-1);
      expect(compareSemver('v2.0.0', '1.9.9')).toBe(1);
      expect(compareSemver('2.1.0', '2.10.0')).toBe(-1);
    });

    it('identifies when server version is strictly newer', () => {
      expect(isVersionNewer('1.0.0', '1.0.1')).toBe(true);
      expect(isVersionNewer('v2.2.0', 'v2.2.1')).toBe(true);
      expect(isVersionNewer('1.5.0', '1.5.0')).toBe(false);
      expect(isVersionNewer('2.0.0', '1.9.9')).toBe(false);
    });

    it('falls back to string difference for non-semver build timestamps', () => {
      expect(isVersionNewer('2026.10.09.v1', '2026.10.10.v2')).toBe(true);
      expect(isVersionNewer('build-abc', 'build-abc')).toBe(false);
      expect(isVersionNewer('build-abc', 'build-def')).toBe(true);
      expect(isVersionNewer('1.0.0', '')).toBe(false);
    });
  });

  describe('2. Anti-Infinite-Loop Reload Cooldown Guard', () => {
    it('detects inactive cooldown when no reload timestamp is stored', () => {
      expect(isCooldownActive(300_000)).toBe(false);
    });

    it('detects active cooldown immediately after marking reload attempt', () => {
      markReloadAttempt();
      expect(isCooldownActive(300_000)).toBe(true);
    });

    it('detects expired cooldown after timeout passes', () => {
      // Set timestamp 10 minutes in the past
      mockSessionStorage.setItem(
        DEFAULT_BYPASS_KEYS.lastReloadTsKey,
        String(Date.now() - 600_000)
      );
      expect(isCooldownActive(300_000)).toBe(false);
    });

    it('clears reload attempt timestamp on demand', () => {
      markReloadAttempt();
      expect(isCooldownActive(300_000)).toBe(true);
      clearReloadAttempt();
      expect(isCooldownActive(300_000)).toBe(false);
    });
  });

  describe('3. Bypass Guards (Mock User & Login Interruption Guard)', () => {
    it('bypasses version check when mock / testing user key is set in localStorage', () => {
      mockLocalStorage.setItem(DEFAULT_BYPASS_KEYS.mockUserKey, 'true');
      const bypass = shouldBypassVersionCheck();
      expect(bypass.bypass).toBe(true);
      expect(bypass.reason).toBe('mock_user');
    });

    it('bypasses version check when user is in the middle of logging in', () => {
      mockSessionStorage.setItem(DEFAULT_BYPASS_KEYS.isLoggingInKey, 'true');
      const bypass = shouldBypassVersionCheck();
      expect(bypass.bypass).toBe(true);
      expect(bypass.reason).toBe('logging_in');
    });

    it('bypasses version check when reload cooldown is active', () => {
      markReloadAttempt();
      const bypass = shouldBypassVersionCheck();
      expect(bypass.bypass).toBe(true);
      expect(bypass.reason).toBe('cooldown');
    });

    it('does not bypass check when clean session state', () => {
      const bypass = shouldBypassVersionCheck();
      expect(bypass.bypass).toBe(false);
      expect(bypass.reason).toBeUndefined();
    });
  });

  describe('4. Headless Version Checker Logic (checkSpaVersion)', () => {
    it('skips checking when document tab is hidden', async () => {
      (globalThis as any).document.visibilityState = 'hidden';
      const result = await checkSpaVersion({
        clientVersion: '1.0.0',
        checkVisibility: true,
      });
      expect(result.hasNewVersion).toBe(false);
      expect(result.skipped).toBe(true);
      expect(result.skippedReason).toBe('not_visible');
    });

    it('skips check if cooldown is currently active', async () => {
      markReloadAttempt();
      const result = await checkSpaVersion({
        clientVersion: '1.0.0',
      });
      expect(result.hasNewVersion).toBe(false);
      expect(result.skipped).toBe(true);
      expect(result.skippedReason).toBe('cooldown');
    });

    it('handles network error or HTTP failure gracefully', async () => {
      const mockFetch = mock(() => Promise.reject(new Error('Network offline')));
      const result = await checkSpaVersion({
        clientVersion: '1.0.0',
        customFetch: mockFetch as any,
      });
      expect(result.hasNewVersion).toBe(false);
      expect(result.skipped).toBe(true);
      expect(result.skippedReason).toBe('fetch_error');
    });

    it('handles HTTP 404 or 500 response gracefully without throwing', async () => {
      const mockFetch = mock(() =>
        Promise.resolve({
          ok: false,
          status: 404,
        } as Response)
      );
      const result = await checkSpaVersion({
        clientVersion: '1.0.0',
        customFetch: mockFetch as any,
      });
      expect(result.hasNewVersion).toBe(false);
      expect(result.skipped).toBe(true);
      expect(result.skippedReason).toBe('fetch_error');
    });

    it('detects newer version when server returns higher version', async () => {
      const serverPayload = {
        version: '1.1.0',
        buildId: '2026.10.10.build-1',
        release: {
          version: '1.1.0',
          releaseDate: '10/10/2026',
          title: 'Update v1.1.0',
          changes: [],
        },
      };

      const mockFetch = mock(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(serverPayload),
        } as Response)
      );

      const result = await checkSpaVersion({
        clientVersion: '1.0.0',
        customFetch: mockFetch as any,
      });

      expect(result.hasNewVersion).toBe(true);
      expect(result.serverVersion).toBe('1.1.0');
      expect(result.serverBuildId).toBe('2026.10.10.build-1');
      expect(result.serverRelease?.title).toBe('Update v1.1.0');
    });

    it('detects newer build ID even if semantic version string is identical', async () => {
      const serverPayload = {
        version: '1.0.0',
        buildId: 'build-v2-canary',
      };

      const mockFetch = mock(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(serverPayload),
        } as Response)
      );

      const result = await checkSpaVersion({
        clientVersion: '1.0.0',
        clientBuildId: 'build-v1-canary',
        customFetch: mockFetch as any,
      });

      expect(result.hasNewVersion).toBe(true);
      expect(result.serverBuildId).toBe('build-v2-canary');
    });

    it('confirms no update when client and server versions match', async () => {
      const serverPayload = {
        version: '1.0.0',
        buildId: 'build-prod-1',
      };

      const mockFetch = mock(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(serverPayload),
        } as Response)
      );

      const result = await checkSpaVersion({
        clientVersion: '1.0.0',
        clientBuildId: 'build-prod-1',
        customFetch: mockFetch as any,
      });

      expect(result.hasNewVersion).toBe(false);
      expect(result.skipped).toBeUndefined();
    });
  });

  describe('5. Cache Purge & Service Worker Updater Helpers', () => {
    it('deletes all keys in window.caches and returns deleted count', async () => {
      const deletedKeys: string[] = [];
      (globalThis as any).window.caches = {
        keys: () => Promise.resolve(['workbox-precache-v1', 'api-cache-v1']),
        delete: (key: string) => {
          deletedKeys.push(key);
          return Promise.resolve(true);
        },
      };

      const count = await cleanBrowserCaches();
      expect(count).toBe(2);
      expect(deletedKeys).toEqual(['workbox-precache-v1', 'api-cache-v1']);
    });

    it('handles environments without window.caches safely', async () => {
      delete (globalThis as any).window.caches;
      const count = await cleanBrowserCaches();
      expect(count).toBe(0);
    });

    it('triggers update() on all service worker registrations', async () => {
      const updatedList: string[] = [];
      (globalThis as any).navigator = {
        serviceWorker: {
          getRegistrations: () =>
            Promise.resolve([
              { update: () => { updatedList.push('reg1'); return Promise.resolve(); } },
              { update: () => { updatedList.push('reg2'); return Promise.resolve(); } },
            ]),
        },
      };

      const count = await updateServiceWorkers();
      expect(count).toBe(2);
      expect(updatedList).toEqual(['reg1', 'reg2']);
    });

    it('handles environments without serviceWorker safely', async () => {
      delete (globalThis as any).navigator;
      const count = await updateServiceWorkers();
      expect(count).toBe(0);
    });
  });

  describe('6. Vite Version Plugin', () => {
    it('configures define constants for client code', () => {
      const plugin = viteVersionPlugin({
        version: '2.5.0',
        buildId: '2026.10.10.alpha',
        defineConstant: '__CUSTOM_BUILD_ID__',
      });

      const configResult = plugin.config({});
      expect(configResult).toEqual({
        define: {
          __CUSTOM_BUILD_ID__: JSON.stringify('2026.10.10.alpha'),
          __APP_VERSION__: JSON.stringify('2.5.0'),
        },
      });
    });

    it('emits version.json asset into bundle during generateBundle', () => {
      const plugin = viteVersionPlugin({
        fileName: 'version.json',
        version: '1.2.3',
        buildId: 'build-123',
        release: {
          version: '1.2.3',
          releaseDate: '10/10/2026',
          title: 'Initial Release',
          changes: [],
        },
      });

      let emittedFile: any = null;
      const mockContext = {
        emitFile: (file: any) => {
          emittedFile = file;
        },
      };

      plugin.generateBundle.call(mockContext);

      expect(emittedFile).not.toBeNull();
      expect(emittedFile.type).toBe('asset');
      expect(emittedFile.fileName).toBe('version.json');

      const parsed = JSON.parse(emittedFile.source);
      expect(parsed.version).toBe('1.2.3');
      expect(parsed.buildId).toBe('build-123');
      expect(parsed.release.title).toBe('Initial Release');
    });

    it('serves version.json in development via Vite server middleware', () => {
      const plugin = viteVersionPlugin({
        fileName: 'version.json',
        version: '1.0.0',
      });

      let registeredRoute = '';
      let middlewareHandler: any = null;

      const mockServer = {
        middlewares: {
          use: (route: string, handler: any) => {
            registeredRoute = route;
            middlewareHandler = handler;
          },
        },
      };

      plugin.configureServer(mockServer as any);
      expect(registeredRoute).toBe('/version.json');

      let responseHeaders: Record<string, string> = {};
      let responseBody = '';
      const mockRes = {
        setHeader: (k: string, v: string) => {
          responseHeaders[k] = v;
        },
        end: (body: string) => {
          responseBody = body;
        },
      };

      middlewareHandler({}, mockRes);
      expect(responseHeaders['Content-Type']).toBe('application/json');
      expect(responseHeaders['Cache-Control']).toContain('no-cache');
      const data = JSON.parse(responseBody);
      expect(data.version).toBe('1.0.0');
    });
  });

  describe('7. VersionGuardBanner Component', () => {
    it('renders null when isUpdating is false', async () => {
      const { renderToString } = await import('react-dom/server');
      const { VersionGuardBanner } = await import('../src/index');
      const React = await import('react');

      const html = renderToString(React.createElement(VersionGuardBanner, { isUpdating: false }));
      expect(html).toBe('');
    });

    it('renders accessible floating banner with role="status" when isUpdating is true', async () => {
      const { renderToString } = await import('react-dom/server');
      const { VersionGuardBanner } = await import('../src/index');
      const React = await import('react');

      const html = renderToString(React.createElement(VersionGuardBanner, { isUpdating: true }));
      expect(html).toContain('role="status"');
      expect(html).toContain('aria-live="polite"');
      expect(html).toContain('Đang cập nhật phiên bản mới nhất...');
      expect(html).toContain('<svg');
    });

    it('supports custom update message and hiding spinner', async () => {
      const { renderToString } = await import('react-dom/server');
      const { VersionGuardBanner } = await import('../src/index');
      const React = await import('react');

      const html = renderToString(
        React.createElement(VersionGuardBanner, {
          isUpdating: true,
          message: 'System upgrade in progress...',
          showSpinner: false,
        })
      );
      expect(html).toContain('System upgrade in progress...');
      expect(html).not.toContain('<svg');
    });
  });

  describe('8. WhatsNewModal Component', () => {
    const mockRelease = {
      version: 'v2.2.0',
      releaseDate: '10/10/2026',
      title: 'Winter Arc Update v2.2',
      subtitle: 'Complete Experience & Historical Lookup',
      changes: [
        {
          icon: 'edit_calendar',
          badge: 'MỚI • v2.2',
          badgeColor: 'text-amber-400 border-amber-500/30 bg-amber-500/10',
          title: 'Viết Bù & Sửa Nhật Ký 14 Ngày',
          description: 'Cho phép xem lại và viết bù nhật ký trong vòng 14 ngày.',
        },
      ],
    };

    it('renders null when not open or no release provided', async () => {
      const { renderToString } = await import('react-dom/server');
      const { WhatsNewModal } = await import('../src/index');
      const React = await import('react');

      const html = renderToString(React.createElement(WhatsNewModal, { forceOpen: false }));
      expect(html).toBe('');
    });

    it('renders full dialog with changelog items when forceOpen is true', async () => {
      const { renderToString } = await import('react-dom/server');
      const { WhatsNewModal } = await import('../src/index');
      const React = await import('react');

      const html = renderToString(
        React.createElement(WhatsNewModal, {
          forceOpen: true,
          release: mockRelease,
          actionLabel: 'KHÁM PHÁ NGAY',
        })
      );

      expect(html).toContain('role="dialog"');
      expect(html).toContain('PHIÊN BẢN');
      expect(html).toContain('v2.2.0');
      expect(html).toContain('Winter Arc Update v2.2');
      expect(html).toContain('Viết Bù &amp; Sửa Nhật Ký 14 Ngày');
      expect(html).toContain('MỚI • v2.2');
      expect(html).toContain('KHÁM PHÁ NGAY');
    });
  });

  describe('9. useAppVersionGuard Hook Initialization', () => {
    it('initializes hook state without throwing in SSR / component tree', async () => {
      const { renderToString } = await import('react-dom/server');
      const { useAppVersionGuard } = await import('../src/index');
      const React = await import('react');

      function TestHarness() {
        const { isUpdating, hasNewVersion } = useAppVersionGuard({
          clientVersion: '1.0.0',
          enabled: false,
        });
        return React.createElement('div', {
          'data-updating': String(isUpdating),
          'data-has-new': String(hasNewVersion),
        });
      }

      const html = renderToString(React.createElement(TestHarness));
      expect(html).toContain('data-updating="false"');
      expect(html).toContain('data-has-new="false"');
    });
  });
});
