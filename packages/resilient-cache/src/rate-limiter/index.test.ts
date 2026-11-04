import { describe, expect, it } from 'bun:test';
import {
  createExpressRateLimiter,
  createHonoRateLimiter,
  getRateLimitHeaders,
  MemoryRateLimitStore,
  RedisRestRateLimitStore,
  TokenBucketLimiter,
} from './index';

describe('@kido/rate-limiter Test Suite', () => {
  describe('1. MemoryRateLimitStore (Sliding Window Counter)', () => {
    it('should allow requests within limit and block when exceeded', async () => {
      const store = new MemoryRateLimitStore({ defaultMax: 3 });
      const key = 'test-client-1';
      const windowMs = 500;

      // 1st request
      const res1 = await store.increment(key, windowMs, 3);
      expect(res1.isAllowed).toBe(true);
      expect(res1.current).toBe(1);
      expect(res1.remaining).toBe(2);
      expect(res1.limit).toBe(3);
      expect(res1.retryAfterSec).toBe(0);

      // 2nd request
      const res2 = await store.increment(key, windowMs, 3);
      expect(res2.isAllowed).toBe(true);
      expect(res2.current).toBe(2);
      expect(res2.remaining).toBe(1);

      // 3rd request
      const res3 = await store.increment(key, windowMs, 3);
      expect(res3.isAllowed).toBe(true);
      expect(res3.current).toBe(3);
      expect(res3.remaining).toBe(0);

      // 4th request (limit reached)
      const res4 = await store.increment(key, windowMs, 3);
      expect(res4.isAllowed).toBe(false);
      expect(res4.current).toBe(3);
      expect(res4.remaining).toBe(0);
      expect(res4.retryAfterSec).toBeGreaterThanOrEqual(1);

      store.close();
    });

    it('should slide the window and permit requests after window expires', async () => {
      const store = new MemoryRateLimitStore({ defaultMax: 2 });
      const key = 'test-client-slide';
      const windowMs = 60; // 60ms window

      expect((await store.increment(key, windowMs, 2)).isAllowed).toBe(true);
      expect((await store.increment(key, windowMs, 2)).isAllowed).toBe(true);
      expect((await store.increment(key, windowMs, 2)).isAllowed).toBe(false);

      // Wait for window to slide past
      await new Promise((r) => setTimeout(r, 70));

      const resAfter = await store.increment(key, windowMs, 2);
      expect(resAfter.isAllowed).toBe(true);
      expect(resAfter.current).toBe(1);
      expect(resAfter.remaining).toBe(1);

      store.close();
    });

    it('should support manual reset and decrement', async () => {
      const store = new MemoryRateLimitStore({ defaultMax: 2 });
      const key = 'test-client-reset';

      await store.increment(key, 1000, 2);
      await store.increment(key, 1000, 2);
      expect((await store.increment(key, 1000, 2)).isAllowed).toBe(false);

      // Decrement one hit
      await store.decrement(key);
      const resAfterDecr = await store.increment(key, 1000, 2);
      expect(resAfterDecr.isAllowed).toBe(true);

      // Reset entire key
      await store.reset(key);
      const resAfterReset = await store.increment(key, 1000, 2);
      expect(resAfterReset.isAllowed).toBe(true);
      expect(resAfterReset.current).toBe(1);

      store.close();
    });
  });

  describe('2. Progressive Cooldown (Exponential Backoff)', () => {
    it('should double retryAfterSec on consecutive blocked attempts', async () => {
      const store = new MemoryRateLimitStore({
        defaultMax: 2,
        progressiveCooldown: {
          multiplier: 2,
          maxMultiplier: 16,
          basePenaltyMs: 1000, // 1 second base penalty
        },
      });

      const key = 'spammer-ip';
      const windowMs = 500;

      // 2 hits to consume limit
      await store.increment(key, windowMs, 2);
      await store.increment(key, windowMs, 2);

      // 1st blocked request -> violation 1 (basePenalty = 1000ms -> retryAfter 1s)
      const block1 = await store.increment(key, windowMs, 2);
      expect(block1.isAllowed).toBe(false);
      expect(block1.retryAfterSec).toBe(1);
      expect(block1.cooldownMultiplier).toBe(1);

      // 2nd blocked request -> violation 2 (penalty = 1000 * 2 = 2000ms -> retryAfter 2s)
      const block2 = await store.increment(key, windowMs, 2);
      expect(block2.isAllowed).toBe(false);
      expect(block2.cooldownMultiplier).toBe(2);
      expect(block2.retryAfterSec).toBeGreaterThanOrEqual(2);

      // 3rd blocked request -> violation 3 (penalty = 1000 * 4 = 4000ms -> retryAfter ~4s)
      const block3 = await store.increment(key, windowMs, 2);
      expect(block3.isAllowed).toBe(false);
      expect(block3.cooldownMultiplier).toBe(4);
      expect(block3.retryAfterSec).toBeGreaterThanOrEqual(4);

      store.close();
    });
  });

  describe('3. TokenBucketLimiter (Burst Traffic Control)', () => {
    it('should allow burst up to capacity and block once empty', async () => {
      const limiter = new TokenBucketLimiter({
        capacity: 3, // burst of 3
        refillRate: 1, // 1 token per 500ms
        intervalMs: 500,
        cost: 1,
      });

      const key = 'burst-user';

      // 3 bursts allowed immediately
      const r1 = await limiter.consume(key);
      const r2 = await limiter.consume(key);
      const r3 = await limiter.consume(key);

      expect(r1.isAllowed).toBe(true);
      expect(r1.remaining).toBe(2);
      expect(r2.isAllowed).toBe(true);
      expect(r2.remaining).toBe(1);
      expect(r3.isAllowed).toBe(true);
      expect(r3.remaining).toBe(0);

      // 4th request depleted
      const r4 = await limiter.consume(key);
      expect(r4.isAllowed).toBe(false);
      expect(r4.remaining).toBe(0);
      expect(r4.retryAfterSec).toBeGreaterThanOrEqual(1);

      limiter.close();
    });

    it('should refill tokens continuously over time', async () => {
      const limiter = new TokenBucketLimiter({
        capacity: 2,
        refillRate: 20, // 20 tokens per second (1 token per 50ms)
        intervalMs: 1000,
      });

      const key = 'refill-user';

      // Deplete bucket
      await limiter.consume(key);
      await limiter.consume(key);
      expect((await limiter.consume(key)).isAllowed).toBe(false);

      // Wait 60ms for at least 1 token to refill
      await new Promise((r) => setTimeout(r, 65));

      const rAfter = await limiter.consume(key);
      expect(rAfter.isAllowed).toBe(true);

      limiter.close();
    });

    it('should implement RateLimitStore interface seamlessly', async () => {
      const limiter = new TokenBucketLimiter({
        capacity: 5,
        refillRate: 5,
      });

      const res = await limiter.increment('api-key-1');
      expect(res.isAllowed).toBe(true);
      expect(res.limit).toBe(5);

      await limiter.decrement('api-key-1');
      await limiter.reset('api-key-1');
      limiter.close();
    });
  });

  describe('4. Memory Eviction & TTL Sweep', () => {
    it('should evict expired keys and prevent memory leaks', async () => {
      const store = new MemoryRateLimitStore({
        defaultMax: 5,
        sweepIntervalMs: 0, // manual sweep
      });

      const key1 = 'client-expired';
      const key2 = 'client-active';

      // Record with short 30ms window
      await store.increment(key1, 30, 5);

      // Record with long 1000ms window
      await store.increment(key2, 1000, 5);

      expect(store.size).toBe(2);

      // Wait 40ms so key1 expires but key2 stays active
      await new Promise((r) => setTimeout(r, 45));

      const evicted = store.sweep();
      expect(evicted).toBe(1);
      expect(store.has(key1)).toBe(false);
      expect(store.has(key2)).toBe(true);
      expect(store.size).toBe(1);

      store.close();
    });

    it('should evict idle full token buckets in TokenBucketLimiter', async () => {
      const limiter = new TokenBucketLimiter({
        capacity: 2,
        refillRate: 50, // 50 tokens / sec
        intervalMs: 1000,
        sweepIntervalMs: 0,
      });

      await limiter.consume('idle-client');
      expect(limiter.size).toBe(1);

      // Wait 50ms for tokens to refill back to capacity
      await new Promise((r) => setTimeout(r, 55));

      const evicted = limiter.sweep();
      expect(evicted).toBe(1);
      expect(limiter.size).toBe(0);

      limiter.close();
    });
  });

  describe('5. HTTP RateLimit Headers (RFC 6585 & IETF)', () => {
    it('should generate compliant headers for allowed request', () => {
      const now = new Date(Date.now() + 30000);
      const headers = getRateLimitHeaders({
        isAllowed: true,
        current: 10,
        limit: 100,
        remaining: 90,
        resetTime: now,
        retryAfterSec: 0,
      });

      expect(headers['RateLimit-Limit']).toBe('100');
      expect(headers['RateLimit-Remaining']).toBe('90');
      expect(headers['Retry-After']).toBeUndefined();
      expect(headers['X-RateLimit-Limit']).toBe('100');
      expect(headers['X-RateLimit-Remaining']).toBe('90');
    });

    it('should include Retry-After on 429 blocked request', () => {
      const now = new Date(Date.now() + 5000);
      const headers = getRateLimitHeaders({
        isAllowed: false,
        current: 100,
        limit: 100,
        remaining: 0,
        resetTime: now,
        retryAfterSec: 5,
      });

      expect(headers['RateLimit-Limit']).toBe('100');
      expect(headers['RateLimit-Remaining']).toBe('0');
      expect(headers['Retry-After']).toBe('5');
    });
  });

  describe('6. Web Framework Middleware: Hono v4', () => {
    function createMockHonoContext(ip = '1.2.3.4', headers: Record<string, string> = {}) {
      const reqHeaders = new Map<string, string>([
        ['x-forwarded-for', ip],
        ...Object.entries(headers),
      ]);
      const resHeaders = new Map<string, string>();
      const contextData = new Map<string, any>();

      const c: any = {
        req: {
          header: (name: string) => reqHeaders.get(name.toLowerCase()),
        },
        header: (name: string, value: string) => {
          resHeaders.set(name, value);
        },
        set: (key: string, value: any) => {
          contextData.set(key, value);
        },
        get: (key: string) => contextData.get(key),
        res: {
          status: 200,
          headers: resHeaders,
        },
        json: (payload: any, status = 200, extraHeaders: Record<string, string> = {}) => {
          c.res.status = status;
          for (const [k, v] of Object.entries(extraHeaders)) {
            resHeaders.set(k, v);
          }
          return { status, payload, headers: resHeaders };
        },
      };

      return c;
    }

    it('should allow within limit and set rate limit headers', async () => {
      const limiter = createHonoRateLimiter({
        windowMs: 1000,
        max: 2,
      });

      const c1 = createMockHonoContext('10.0.0.1');
      let nextCalled = false;
      await limiter(c1, async () => {
        nextCalled = true;
      });

      expect(nextCalled).toBe(true);
      expect(c1.res.headers.get('RateLimit-Limit')).toBe('2');
      expect(c1.res.headers.get('RateLimit-Remaining')).toBe('1');
    });

    it('should return 429 when limit exceeded and skip next handler', async () => {
      const limiter = createHonoRateLimiter({
        windowMs: 1000,
        max: 1,
        message: 'Too many hits',
      });

      const c1 = createMockHonoContext('10.0.0.2');
      await limiter(c1, async () => {});

      const c2 = createMockHonoContext('10.0.0.2');
      let nextCalled2 = false;
      const res = await limiter(c2, async () => {
        nextCalled2 = true;
      });

      expect(nextCalled2).toBe(false);
      expect(res.status).toBe(429);
      expect(res.payload.message).toBe('Too many hits');
      expect(c2.res.headers.get('Retry-After')).toBeDefined();
    });

    it('should decrement hit count on skipFailedRequests when downstream fails', async () => {
      const store = new MemoryRateLimitStore({ defaultMax: 1 });
      const limiter = createHonoRateLimiter({
        store,
        windowMs: 1000,
        max: 1,
        skipFailedRequests: true,
      });

      const c1 = createMockHonoContext('10.0.0.3');
      // Downstream sets 500 error
      await limiter(c1, async () => {
        c1.res.status = 500;
      });

      // Because skipFailedRequests is true, next request should still be allowed
      const c2 = createMockHonoContext('10.0.0.3');
      let nextCalled = false;
      await limiter(c2, async () => {
        nextCalled = true;
      });

      expect(nextCalled).toBe(true);
      store.close();
    });

    it('should support conditional skip predicate', async () => {
      const limiter = createHonoRateLimiter({
        windowMs: 1000,
        max: 1,
        skip: (c) => c.req.header('x-bypass') === 'true',
      });

      const c = createMockHonoContext('10.0.0.4', { 'x-bypass': 'true' });
      let nextCalled = false;
      await limiter(c, async () => {
        nextCalled = true;
      });
      expect(nextCalled).toBe(true);
    });
  });

  describe('7. Web Framework Middleware: Express/Connect', () => {
    function createMockExpress() {
      const headers = new Map<string, string>();
      const req: any = {
        ip: '192.168.1.100',
        headers: {},
      };

      const res: any = {
        statusCode: 200,
        headers,
        setHeader: (k: string, v: string) => headers.set(k, v),
        status: (code: number) => {
          res.statusCode = code;
          return res;
        },
        json: (data: any) => {
          res.body = data;
          return res;
        },
        listeners: {} as Record<string, Function[]>,
        on: (event: string, fn: Function) => {
          res.listeners[event] = res.listeners[event] || [];
          res.listeners[event].push(fn);
        },
      };

      return { req, res };
    }

    it('should allow Express requests and set headers', async () => {
      const limiter = createExpressRateLimiter({
        windowMs: 1000,
        max: 3,
      });

      const { req, res } = createMockExpress();
      let nextCalled = false;

      await limiter(req, res, () => {
        nextCalled = true;
      });

      expect(nextCalled).toBe(true);
      expect(req.rateLimit.isAllowed).toBe(true);
      expect(res.headers.get('RateLimit-Limit')).toBe('3');
      expect(res.headers.get('RateLimit-Remaining')).toBe('2');
    });

    it('should block and return 429 when Express limit exceeded', async () => {
      const limiter = createExpressRateLimiter({
        windowMs: 1000,
        max: 1,
      });

      const { req: r1, res: s1 } = createMockExpress();
      await limiter(r1, s1, () => {});

      const { req: r2, res: s2 } = createMockExpress();
      let nextCalled = false;
      await limiter(r2, s2, () => {
        nextCalled = true;
      });

      expect(nextCalled).toBe(false);
      expect(s2.statusCode).toBe(429);
      expect(s2.body.error).toBe('Too Many Requests');
      expect(s2.headers.get('Retry-After')).toBeDefined();
    });
  });

  describe('8. RedisRestRateLimitStore', () => {
    it('should work with mock Redis client eval method', async () => {
      const mockClient = {
        eval: async (_script: string, _numkeys: number, ...args: any[]) => {
          const limit = Number(args[3]);
          // Simulate 1st hit
          return [1, 1, limit - 1, 0, Date.now() + 60000];
        },
      };

      const store = new RedisRestRateLimitStore({
        client: mockClient,
        keyPrefix: 'test-rl:',
      });

      const result = await store.increment('tenant-42', 60000, 10);
      expect(result.isAllowed).toBe(true);
      expect(result.current).toBe(1);
      expect(result.limit).toBe(10);
      expect(result.remaining).toBe(9);
      expect(result.retryAfterSec).toBe(0);
    });

    it('should support atomic increment fallback', async () => {
      let count = 0;
      const mockClient = {
        call: async (cmd: string) => {
          if (cmd === 'INCR') {
            count++;
            return count;
          }
          if (cmd === 'PEXPIRE') return 1;
          if (cmd === 'PTTL') return 50000;
          if (cmd === 'DEL') {
            count = 0;
            return 1;
          }
          return null;
        },
      };

      const store = new RedisRestRateLimitStore({
        client: mockClient,
        useAtomicIncrFallback: true,
      });

      const r1 = await store.increment('usr-1', 60000, 2);
      expect(r1.isAllowed).toBe(true);
      expect(r1.current).toBe(1);

      const r2 = await store.increment('usr-1', 60000, 2);
      expect(r2.isAllowed).toBe(true);
      expect(r2.current).toBe(2);

      const r3 = await store.increment('usr-1', 60000, 2);
      expect(r3.isAllowed).toBe(false);
      expect(r3.current).toBe(3);

      await store.reset('usr-1');
      expect(count).toBe(0);
    });

    it('should throw error when neither client nor upstash is configured', () => {
      expect(() => new RedisRestRateLimitStore({} as any)).toThrow();
    });
  });
});
