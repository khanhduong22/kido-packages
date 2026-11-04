import { describe, expect, it } from 'bun:test';
import {
  type CacheAdapter,
  CircuitBreaker,
  CircuitBreakerOpenError,
  InFlightManager,
  MemoryL1Cache,
  ResilientCache,
  SingleFlightSwr,
  getGlobalSingleFlight,
} from './index';

describe('@kido/resilient-cache', () => {
  describe('MemoryL1Cache', () => {
    it('sets, gets and deletes values', () => {
      const cache = new MemoryL1Cache<string>();
      cache.set('user:1', 'Alice', 1000);
      expect(cache.get('user:1')).toBe('Alice');
      expect(cache.size()).toBe(1);

      cache.delete('user:1');
      expect(cache.get('user:1')).toBeNull();
      expect(cache.size()).toBe(0);
    });

    it('expires entries after TTL', async () => {
      const cache = new MemoryL1Cache<number>();
      cache.set('temp', 42, 20); // 20ms TTL

      expect(cache.get('temp')).toBe(42);
      await new Promise((r) => setTimeout(r, 35));
      expect(cache.get('temp')).toBeNull();
    });

    it('cleans up expired entries', async () => {
      const cache = new MemoryL1Cache<number>();
      cache.set('a', 1, 10);
      cache.set('b', 2, 500);

      await new Promise((r) => setTimeout(r, 25));
      const removed = cache.cleanupExpired();
      expect(removed).toBe(1);
      expect(cache.get('a')).toBeNull();
      expect(cache.get('b')).toBe(2);
    });
  });

  describe('CircuitBreaker', () => {
    it('starts in CLOSED state and trips to OPEN after threshold', async () => {
      const cb = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 50 });
      expect(cb.getState()).toBe('CLOSED');

      const failAction = async () => {
        throw new Error('Remote down');
      };

      // 1st failure
      await expect(cb.execute(failAction)).rejects.toThrow('Remote down');
      expect(cb.getState()).toBe('CLOSED');

      // 2nd failure -> should trip to OPEN
      await expect(cb.execute(failAction)).rejects.toThrow('Remote down');
      expect(cb.getState()).toBe('OPEN');

      // In OPEN state, should throw CircuitBreakerOpenError without calling action
      let actionCalled = false;
      const probeAction = async () => {
        actionCalled = true;
        return 'ok';
      };
      await expect(cb.execute(probeAction)).rejects.toThrow(CircuitBreakerOpenError);
      expect(actionCalled).toBe(false);
    });

    it('uses fallback in OPEN state', async () => {
      const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 50 });
      await expect(cb.execute(async () => { throw new Error('fail'); })).rejects.toThrow();
      expect(cb.getState()).toBe('OPEN');

      const res = await cb.execute(
        async () => 'from-source',
        async () => 'from-fallback'
      );
      expect(res).toBe('from-fallback');
    });

    it('transitions to HALF_OPEN after resetTimeout and resets to CLOSED on success', async () => {
      const cb = new CircuitBreaker({
        failureThreshold: 1,
        resetTimeoutMs: 30,
        successThreshold: 2,
      });

      // Trip to OPEN
      await expect(cb.execute(async () => { throw new Error('fail'); })).rejects.toThrow();
      expect(cb.getState()).toBe('OPEN');

      // Wait for resetTimeoutMs
      await new Promise((r) => setTimeout(r, 40));
      expect(cb.getState()).toBe('HALF_OPEN');

      // 1st success in HALF_OPEN
      const s1 = await cb.execute(async () => 'probe1');
      expect(s1).toBe('probe1');
      expect(cb.getState()).toBe('HALF_OPEN');

      // 2nd success -> reaches successThreshold, transitions to CLOSED
      const s2 = await cb.execute(async () => 'probe2');
      expect(s2).toBe('probe2');
      expect(cb.getState()).toBe('CLOSED');
    });

    it('transitions from HALF_OPEN back to OPEN on probe failure', async () => {
      const cb = new CircuitBreaker({
        failureThreshold: 1,
        resetTimeoutMs: 30,
        successThreshold: 2,
      });

      cb.trip();
      expect(cb.getState()).toBe('OPEN');

      await new Promise((r) => setTimeout(r, 40));
      expect(cb.getState()).toBe('HALF_OPEN');

      // Probe fails
      await expect(cb.execute(async () => { throw new Error('probe fail'); })).rejects.toThrow();
      expect(cb.getState()).toBe('OPEN');
    });
  });

  describe('InFlightManager', () => {
    it('collapses multiple concurrent executions of the same key into 1', async () => {
      const inFlight = new InFlightManager();
      let fetchCount = 0;

      const slowFetcher = async () => {
        fetchCount++;
        await new Promise((r) => setTimeout(r, 25));
        return { data: 'payload', count: fetchCount };
      };

      // Fire 5 concurrent requests
      const promises = [
        inFlight.dedupe('key:heavy', slowFetcher),
        inFlight.dedupe('key:heavy', slowFetcher),
        inFlight.dedupe('key:heavy', slowFetcher),
        inFlight.dedupe('key:heavy', slowFetcher),
        inFlight.dedupe('key:heavy', slowFetcher),
      ];

      expect(inFlight.isInFlight('key:heavy')).toBe(true);
      const results = await Promise.all(promises);

      expect(fetchCount).toBe(1);
      expect(inFlight.getCollapsedCount()).toBe(4);
      expect(inFlight.isInFlight('key:heavy')).toBe(false);

      for (const res of results) {
        expect(res).toEqual({ data: 'payload', count: 1 });
      }

      // Next call after resolution executes a new fetcher
      const nextRes = await inFlight.dedupe('key:heavy', slowFetcher);
      expect(fetchCount).toBe(2);
      expect(nextRes.count).toBe(2);
    });

    it('invalidates single keys and glob patterns while bumping mutation epoch', () => {
      const inFlight = new InFlightManager();
      const neverEndingFetcher = () => new Promise(() => {});

      inFlight.dedupe('stats:daily:2026-10-17', neverEndingFetcher);
      inFlight.dedupe('stats:monthly:2026-10', neverEndingFetcher);
      inFlight.dedupe('staff:home:user1', neverEndingFetcher);

      expect(inFlight.getActiveCount()).toBe(3);
      expect(inFlight.getMutationEpoch()).toBe(0);

      // Invalidate single key
      const deleted = inFlight.invalidateKey('staff:home:user1');
      expect(deleted).toBe(true);
      expect(inFlight.getActiveCount()).toBe(2);

      // Invalidate pattern
      const cleared = inFlight.invalidatePattern('stats:*');
      expect(cleared).toBe(2);
      expect(inFlight.getActiveCount()).toBe(0);
      expect(inFlight.getMutationEpoch()).toBe(1);
    });

    it('detects stale in-flight results when epoch changes via dedupeWithEpoch', async () => {
      const inFlight = new InFlightManager();
      let staleIntercepted = false;

      const slowFetcher = async () => {
        await new Promise((r) => setTimeout(r, 20));
        return { value: 'stale-data' };
      };

      const promise = inFlight.dedupeWithEpoch('feed:trending', slowFetcher, {
        onStaleDiscard: (val, startEpoch, currentEpoch) => {
          staleIntercepted = true;
          expect(val).toEqual({ value: 'stale-data' });
          expect(startEpoch).toBe(0);
          expect(currentEpoch).toBe(1);
        },
      });

      // While fetcher is running, a mutation occurs
      inFlight.bumpMutationEpoch();

      const result = await promise;
      expect(result).toEqual({ value: 'stale-data' });
      expect(staleIntercepted).toBe(true);
    });
  });

  describe('SingleFlightSwr', () => {
    it('collapses concurrent executions into 1 in-flight promise and records stats', async () => {
      const sf = new SingleFlightSwr();
      let callCount = 0;

      const slowProducer = async () => {
        callCount++;
        await new Promise((r) => setTimeout(r, 30));
        return { rates: [1.2, 1.5] };
      };

      const [r1, r2, r3] = await Promise.all([
        sf.execute('rates:usd', slowProducer),
        sf.execute('rates:usd', slowProducer),
        sf.execute('rates:usd', slowProducer),
      ]);

      expect(r1).toEqual({ rates: [1.2, 1.5] });
      expect(r2).toEqual({ rates: [1.2, 1.5] });
      expect(r3).toEqual({ rates: [1.2, 1.5] });
      expect(callCount).toBe(1);

      const stats = sf.getStats();
      expect(stats.misses).toBe(1);
      expect(stats.collapsedCount).toBe(2);
    });

    it('serves fresh micro-cache without invoking producer when ttlMs > 0', async () => {
      const sf = new SingleFlightSwr();
      let callCount = 0;
      const producer = async () => {
        callCount++;
        return `val-${callCount}`;
      };

      const first = await sf.execute('k1', producer, { ttlMs: 100 });
      expect(first).toBe('val-1');
      expect(callCount).toBe(1);

      const second = await sf.execute('k1', producer, { ttlMs: 100 });
      expect(second).toBe('val-1');
      expect(callCount).toBe(1);

      const stats = sf.getStats();
      expect(stats.hits).toBe(1);
    });

    it('returns stale cache immediately and triggers background revalidation within staleTtlMs window', async () => {
      const sf = new SingleFlightSwr();
      let callCount = 0;
      const producer = async () => {
        callCount++;
        return `version-${callCount}`;
      };

      // 1st call: fresh with TTL 20ms and stale window 80ms
      const v1 = await sf.execute('tab:gold', producer, { ttlMs: 20, staleTtlMs: 80 });
      expect(v1).toBe('version-1');
      expect(callCount).toBe(1);

      // Wait 30ms -> past fresh TTL (20ms), but inside stale window (20ms + 80ms = 100ms)
      await new Promise((r) => setTimeout(r, 30));

      const v2 = await sf.execute('tab:gold', producer, { ttlMs: 20, staleTtlMs: 80 });
      // Returns stale v1 immediately without waiting
      expect(v2).toBe('version-1');
      expect(sf.getStats().staleHits).toBe(1);

      // Wait 15ms for background revalidation to settle
      await new Promise((r) => setTimeout(r, 15));
      expect(callCount).toBe(2);

      // 3rd call: fresh v2
      const v3 = await sf.execute('tab:gold', producer, { ttlMs: 20, staleTtlMs: 80 });
      expect(v3).toBe('version-2');
    });

    it('handles background revalidation rejection cleanly without crashing', async () => {
      const sf = new SingleFlightSwr();
      let callCount = 0;
      const producer = async () => {
        callCount++;
        if (callCount > 1) {
          throw new Error('Database temporary connection failure');
        }
        return 'initial-ok';
      };

      const ok = await sf.execute('flaky:key', producer, { ttlMs: 15, staleTtlMs: 50 });
      expect(ok).toBe('initial-ok');

      await new Promise((r) => setTimeout(r, 20));

      // This call hits stale and triggers revalidation in background which throws
      const stale = await sf.execute('flaky:key', producer, { ttlMs: 15, staleTtlMs: 50 });
      expect(stale).toBe('initial-ok');

      // Wait for background error to settle safely without crashing process
      await new Promise((r) => setTimeout(r, 20));
      expect(callCount).toBe(2);
    });

    it('prewarms multiple loaders in parallel and invalidates by pattern', async () => {
      const sf = new SingleFlightSwr();
      const results = await sf.prewarm([
        { key: 'tab:gold', fetcher: async () => 'gold-data', options: { ttlMs: 500 } },
        { key: 'tab:usdt', fetcher: async () => 'usdt-data', options: { ttlMs: 500 } },
        { key: 'tab:fuel', fetcher: async () => 'fuel-data', options: { ttlMs: 500 } },
        { key: 'user:123', fetcher: async () => 'user-data', options: { ttlMs: 500 } },
      ]);

      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
      expect(sf.getCacheSize()).toBe(4);

      // Invalidate tab:* pattern
      const cleared = sf.invalidatePattern('tab:*');
      expect(cleared).toBe(3);
      expect(sf.getCacheSize()).toBe(1);

      // Invalidate single key
      expect(sf.invalidate('user:123')).toBe(true);
      expect(sf.getCacheSize()).toBe(0);
    });

    it('maintains global singleton across getGlobalSingleFlight calls', () => {
      const inst1 = getGlobalSingleFlight('market');
      const inst2 = getGlobalSingleFlight('market');
      expect(inst1).toBe(inst2);

      const instOther = getGlobalSingleFlight('auth');
      expect(inst1).not.toBe(instOther);
    });
  });

  describe('ResilientCache', () => {
    it('manages 3-tier caching with L1 hit on second access', async () => {
      const cache = new ResilientCache<{ id: number; name: string }>({
        l1TtlMs: 1000,
      });

      let dbQueries = 0;
      const fetcher = async () => {
        dbQueries++;
        return { id: 1, name: 'Product A' };
      };

      // 1st request -> Miss -> Fetch from DB
      const res1 = await cache.getOrSet('product:1', fetcher);
      expect(res1).toEqual({ id: 1, name: 'Product A' });
      expect(dbQueries).toBe(1);

      // 2nd request -> Hit L1 Memory Cache
      const res2 = await cache.getOrSet('product:1', fetcher);
      expect(res2).toEqual({ id: 1, name: 'Product A' });
      expect(dbQueries).toBe(1); // Not called!

      const stats = cache.getStats();
      expect(stats.l1Hits).toBe(1);
      expect(stats.fetches).toBe(1);
    });

    it('reads from L2 remote cache and backfills L1', async () => {
      const mockL2Store = new Map<string, unknown>();
      mockL2Store.set('key:remote', { role: 'admin' });

      const l2Adapter: CacheAdapter<{ role: string }> = {
        get: async (k) => (mockL2Store.get(k) as { role: string }) ?? null,
        set: async (k, v) => { mockL2Store.set(k, v); },
        delete: async (k) => { mockL2Store.delete(k); },
      };

      const cache = new ResilientCache<{ role: string }>({
        l1TtlMs: 500,
        l2Adapter,
      });

      let fetchCount = 0;
      const fetcher = async () => {
        fetchCount++;
        return { role: 'user' };
      };

      // L1 miss, L2 hit
      const res = await cache.getOrSet('key:remote', fetcher);
      expect(res).toEqual({ role: 'admin' });
      expect(fetchCount).toBe(0);

      // Verify backfill into L1
      const l1Val = cache.getL1Cache().get('key:remote');
      expect(l1Val).toEqual({ role: 'admin' });
    });

    it('fails-open when L2 crashes and trips circuit breaker without failing app', async () => {
      const errorLog: string[] = [];
      const faultyL2: CacheAdapter<string> = {
        get: async () => {
          throw new Error('Connection refused: Redis ECONNREFUSED 6379');
        },
        set: async () => {
          throw new Error('Redis out of memory');
        },
        delete: async () => {},
      };

      const cache = new ResilientCache<string>({
        l2Adapter: faultyL2,
        circuitBreaker: {
          failureThreshold: 2,
          resetTimeoutMs: 100,
        },
        onError: (err, op) => {
          errorLog.push(`${op}: ${(err as Error).message}`);
        },
      });

      let fetcherCalls = 0;
      const fetcher = async () => {
        fetcherCalls++;
        return `fresh-data-${fetcherCalls}`;
      };

      // Call 1: L2 throws, fail-open to fetcher
      const r1 = await cache.getOrSet('faulty:1', fetcher, { skipL1: true });
      expect(r1).toBe('fresh-data-1');

      // Call 2: L2 throws, failureThreshold reached -> trips to OPEN
      const r2 = await cache.getOrSet('faulty:2', fetcher, { skipL1: true });
      expect(r2).toBe('fresh-data-2');

      expect(cache.getCircuitBreaker().getState()).toBe('OPEN');

      // Call 3: Circuit is OPEN, skips L2 entirely and smoothly calls fetcher
      const r3 = await cache.getOrSet('faulty:3', fetcher, { skipL1: true });
      expect(r3).toBe('fresh-data-3');

      expect(errorLog.length).toBeGreaterThanOrEqual(2);
      expect(errorLog[0]).toContain('ECONNREFUSED');
    });

    it('collapses concurrent requests in ResilientCache', async () => {
      const cache = new ResilientCache<{ price: number }>({ l1TtlMs: 2000 });
      let fetchCount = 0;

      const fetcher = async () => {
        fetchCount++;
        await new Promise((r) => setTimeout(r, 20));
        return { price: 99.99 };
      };

      const results = await Promise.all([
        cache.getOrSet('item:bitcoin', fetcher),
        cache.getOrSet('item:bitcoin', fetcher),
        cache.getOrSet('item:bitcoin', fetcher),
      ]);

      expect(fetchCount).toBe(1);
      expect(results[0].price).toBe(99.99);
      expect(results[1].price).toBe(99.99);
      expect(results[2].price).toBe(99.99);
      expect(cache.getStats().inFlightSaves).toBe(2);
    });

    it('supports direct set, get, delete, and clear', async () => {
      const cache = new ResilientCache<string>();
      await cache.set('profile:100', 'John Doe');

      const found = await cache.get('profile:100');
      expect(found).toBe('John Doe');

      await cache.delete('profile:100');
      const deleted = await cache.get('profile:100');
      expect(deleted).toBeNull();

      await cache.set('temp:1', 'v1');
      await cache.clear();
      expect(await cache.get('temp:1')).toBeNull();
    });
  });
});
