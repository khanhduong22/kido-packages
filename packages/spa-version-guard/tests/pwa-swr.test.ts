import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isApiOrRscRequest,
  isStaticChunkAsset,
  shouldTrigger404SelfHeal,
  generateSwrServiceWorkerCode,
  createPreloadableLoader,
  FONT_METRIC_PRESETS,
  VIETNAMESE_UNICODE_RANGE,
  LATIN_UNICODE_RANGE,
  generateFontFallbackCss,
  purgeZombieAuthStorage,
  healZombieAuthSession,
  ConfirmedMutationLedger,
  createConfirmedLedger,
  getLatestEntityByTimestamp,
  purgeLegacyCacheStorage,
  type StorageLike,
} from '../src/index';

class MemoryStorage implements StorageLike {
  private store = new Map<string, string>();

  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }
}

describe('@kido/pwa-swr-guard — Service Worker SWR & 404 Self-Heal Engine', () => {
  it('detects API routes, Next.js RSC requests, and analytics domains via isApiOrRscRequest', () => {
    assert.equal(
      isApiOrRscRequest(new URL('https://app.example.com/api/auth/me')),
      true
    );
    assert.equal(
      isApiOrRscRequest(
        new URL('https://app.example.com/winter-arc/today?_rsc=1a2b3c')
      ),
      true
    );
    assert.equal(
      isApiOrRscRequest(new URL('https://app.example.com/winter-arc/today'), {
        RSC: '1',
      }),
      true
    );
    assert.equal(
      isApiOrRscRequest(new URL('https://app.example.com/winter-arc/today'), {
        Accept: 'text/x-component, */*',
      }),
      true
    );
    assert.equal(
      isApiOrRscRequest(new URL('https://www.clarity.ms/tag/yp6igzldno')),
      true
    );
    assert.equal(
      isApiOrRscRequest(new URL('https://app.example.com/winter-arc/today'), {
        Accept: 'text/html',
      }),
      false
    );
  });

  it('detects static chunk assets via isStaticChunkAsset', () => {
    assert.equal(isStaticChunkAsset('/_next/static/chunks/main-abc.js'), true);
    assert.equal(isStaticChunkAsset('/assets/bundle.css'), true);
    assert.equal(isStaticChunkAsset('/fonts/inter-vietnamese.woff2'), true);
    assert.equal(isStaticChunkAsset('/hero.webp'), true);
    assert.equal(isStaticChunkAsset('/winter-arc/today', 'script'), true);
    assert.equal(isStaticChunkAsset('/winter-arc/today', 'document'), false);
  });

  it('triggers 404 self-heal only when hashed static chunks return HTTP 404', () => {
    assert.equal(
      shouldTrigger404SelfHeal(404, '/_next/static/chunks/app/page-9f8e7d.js'),
      true
    );
    assert.equal(
      shouldTrigger404SelfHeal(404, '/assets/index-12345.css'),
      true
    );
    assert.equal(
      shouldTrigger404SelfHeal(200, '/_next/static/chunks/app/page-9f8e7d.js'),
      false
    );
    assert.equal(
      shouldTrigger404SelfHeal(404, '/winter-arc/unknown-route'),
      false
    );
  });

  it('generates production-ready SWR Service Worker code with NavigationPreload and 404 self-healing', () => {
    const code = generateSwrServiceWorkerCode({
      cacheName: 'winter-arc-v13',
      offlineFallbackUrl: '/offline.html',
      precacheAssets: ['/offline.html', '/fonts/inter-latin.woff2'],
      warmShellRoutes: ['/winter-arc', '/winter-arc/today'],
      canonicalPathPrefixes: ['/winter-arc'],
    });

    assert.match(code, /const CACHE_NAME = "winter-arc-v13";/);
    assert.match(code, /self\.registration\.navigationPreload\.enable\(\)/);
    assert.match(code, /WARM_SHELL_ROUTES/);
    assert.match(code, /event\.preloadResponse/);
    assert.match(
      code,
      /networkResponse\.status === 404 && isImmutableChunk\(url\.pathname\)/
    );
  });
});

describe('@kido/pwa-swr-guard — 0ms Synchronous Preloadable Tab/Modal Cache', () => {
  it('deduplicates concurrent preload() calls and resolves getSync() in 0ms', async () => {
    let loadCount = 0;
    const loader = createPreloadableLoader(async () => {
      loadCount += 1;
      await new Promise((r) => setTimeout(r, 10));
      return { default: { componentName: 'LeaderboardTab' } };
    });

    assert.equal(loader.getSync(), null);
    assert.equal(loader.isLoaded(), false);

    // Trigger via hover/touch handlers and explicit preload concurrently
    loader.onPointerEnter();
    loader.onTouchStart();
    const [r1, r2] = await Promise.all([loader.preload(), loader.preload()]);

    assert.equal(loadCount, 1);
    assert.deepEqual(r1, { componentName: 'LeaderboardTab' });
    assert.deepEqual(r2, { componentName: 'LeaderboardTab' });
    assert.equal(loader.isLoaded(), true);
    assert.deepEqual(loader.getSync(), { componentName: 'LeaderboardTab' });
  });

  it('recovers and retries cleanly after a transient network chunk error', async () => {
    let attempts = 0;
    const loader = createPreloadableLoader(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error('Network chunk load failed');
      }
      return { default: 'RecoveredModalComponent' };
    });

    await assert.rejects(() => loader.preload(), /Network chunk load failed/);
    assert.equal(loader.getSync(), null);
    assert.equal(loader.isLoaded(), false);

    const recovered = await loader.preload();
    assert.equal(recovered, 'RecoveredModalComponent');
    assert.equal(loader.getSync(), 'RecoveredModalComponent');
    assert.equal(attempts, 2);
  });
});

describe('@kido/pwa-swr-guard — Zero-CLS Font Metric Override Generator', () => {
  it('generates calibrated @font-face CSS with INTER_ARIAL_FALLBACK metrics (90.44%, 22.52%, 107.12%)', () => {
    const css = generateFontFallbackCss({
      ...FONT_METRIC_PRESETS.INTER_ARIAL_FALLBACK,
      cssVariableName: '--font-inter',
      subsets: [
        {
          name: 'vietnamese',
          srcUrl: '/fonts/inter-vietnamese.woff2',
          unicodeRange: VIETNAMESE_UNICODE_RANGE,
        },
        {
          name: 'latin',
          srcUrl: '/fonts/inter-latin.woff2',
          unicodeRange: LATIN_UNICODE_RANGE,
        },
      ],
    });

    assert.match(css, /font-family: 'Inter Fallback';/);
    assert.match(css, /font-display: optional;/);
    assert.match(css, /ascent-override: 90\.44%;/);
    assert.match(css, /descent-override: 22\.52%;/);
    assert.match(css, /line-gap-override: 0\.00%;/);
    assert.match(css, /size-adjust: 107\.12%;/);
    assert.match(css, /\/fonts\/inter-vietnamese\.woff2/);
    assert.match(css, /--font-inter: 'Inter', 'Inter Fallback', sans-serif;/);
  });
});

describe('@kido/pwa-swr-guard — Zombie Auth Storage Auto-Heal Guard', () => {
  it('purges stale optimistic auth keys via purgeZombieAuthStorage and healZombieAuthSession', () => {
    const storage = new MemoryStorage();
    storage.setItem('winter_arc_session_token', 'expired-jwt');
    storage.setItem('winter_arc_user_cache', '{"uid":"u1"}');
    storage.setItem('unrelated_preference', 'dark');

    const keysToPurge = [
      'winter_arc_session_token',
      'winter_arc_user_cache',
      'winter_arc_user_id',
    ];

    // Should not purge when status is 200 and authenticated is true
    const healthyResult = healZombieAuthSession({
      storageKeys: keysToPurge,
      storage,
      status: 200,
      isAuthenticated: true,
    });
    assert.equal(healthyResult.healed, false);
    assert.equal(storage.getItem('winter_arc_session_token'), 'expired-jwt');

    // Should purge immediately on HTTP 401
    const healResult = healZombieAuthSession({
      storageKeys: keysToPurge,
      storage,
      status: 401,
    });
    assert.equal(healResult.healed, true);
    assert.deepEqual(healResult.purgedKeys, [
      'winter_arc_session_token',
      'winter_arc_user_cache',
    ]);
    assert.equal(storage.getItem('winter_arc_session_token'), null);
    assert.equal(storage.getItem('winter_arc_user_cache'), null);
    assert.equal(storage.getItem('unrelated_preference'), 'dark');

    // Direct call to purgeZombieAuthStorage
    storage.setItem('winter_arc_user_id', 'zombie-uid');
    const directPurged = purgeZombieAuthStorage(keysToPurge, storage);
    assert.deepEqual(directPurged, ['winter_arc_user_id']);
    assert.equal(storage.getItem('winter_arc_user_id'), null);
  });
});

describe('@kido/pwa-swr-guard — Confirmed Mutation Ledger (Client-Side Optimistic Reconciliation)', () => {
  it('records confirmed mutations, prunes expired entries, and updates existing records', () => {
    const storage = new MemoryStorage();
    const ledger = createConfirmedLedger({
      storage,
      storageKey: 'test_checkin_ledger',
      ttlMs: 1000 * 60, // 1 minute
    });

    const now = Date.now();
    ledger.record({ id: 'c1', timestamp: now - 1000, type: 'checkin', note: 'Morning' });
    ledger.record({ id: 'c2', timestamp: now - 500, type: 'checkin', note: 'Afternoon' });

    let records = ledger.getRecords();
    assert.equal(records.length, 2);
    assert.equal(records[0].id, 'c1');
    assert.equal(records[1].id, 'c2');

    // Update c1 note
    ledger.record({ id: 'c1', timestamp: now, type: 'checkin', note: 'Morning Updated' });
    records = ledger.getRecords();
    assert.equal(records.length, 2);
    assert.equal(records[0].note, 'Morning Updated');

    // Prunes expired record
    const expiredLedger = createConfirmedLedger({
      storage,
      storageKey: 'test_checkin_ledger',
      ttlMs: 50, // 50ms TTL
    });
    // Add expired item directly
    storage.setItem(
      'test_checkin_ledger',
      JSON.stringify([{ id: 'c_old', timestamp: now - 10000 }])
    );
    expiredLedger.record({ id: 'c_new', timestamp: now, type: 'checkin' });
    const freshRecords = expiredLedger.getRecords();
    assert.equal(freshRecords.length, 1);
    assert.equal(freshRecords[0].id, 'c_new');
  });

  it('reconciles server response with locally confirmed records, preventing stale 304 overwrite', () => {
    const storage = new MemoryStorage();
    const ledger = new ConfirmedMutationLedger({
      storage,
      reconciliationWindowMs: 1000 * 60 * 60, // 1 hour
    });

    const now = Date.now();
    ledger.record({
      id: 'chk_local_confirmed',
      timestamp: now,
      userId: 'u123',
      type: 'checkin',
    });

    // Stale server list returned by 304 / SWR cache lacks chk_local_confirmed
    const staleServerList = [
      { id: 'chk_server_1', timestamp: now - 3600000, userId: 'u123', type: 'checkout' },
    ];

    const result = ledger.reconcileList(staleServerList, {
      userId: 'u123',
      sortByTimestamp: true,
    });

    assert.equal(result.mergedCount, 1);
    assert.equal(result.list.length, 2);
    assert.equal(result.list[0].id, 'chk_server_1');
    assert.equal(result.list[1].id, 'chk_local_confirmed');

    // Does not merge if userId does not match
    const diffUserResult = ledger.reconcileList(staleServerList, {
      userId: 'other_user',
    });
    assert.equal(diffUserResult.mergedCount, 0);
    assert.equal(diffUserResult.list.length, 1);
  });

  it('deterministically resolves latest entity by timestamp', () => {
    const items = [
      { id: '1', timestamp: '2026-10-17T08:00:00.000Z', val: 'first' },
      { id: '2', timestamp: '2026-10-17T12:00:00.000Z', val: 'latest' },
      { id: '3', timestamp: '2026-10-17T10:00:00.000Z', val: 'middle' },
    ];

    const latest = getLatestEntityByTimestamp(items);
    assert.equal(latest?.id, '2');
    assert.equal(latest?.val, 'latest');

    assert.equal(getLatestEntityByTimestamp([]), null);
  });

  it('safely handles legacy cache storage purge in environments without caches', async () => {
    const purged = await purgeLegacyCacheStorage(['app-v2-api-cache', 'old-cache']);
    assert.deepEqual(purged, []);
  });
});
