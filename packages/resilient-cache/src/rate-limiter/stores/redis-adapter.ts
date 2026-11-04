import { RateLimitResult, RateLimitStore } from '../types';

export interface RedisClientLike {
  eval?(script: string, numkeys: number, ...args: (string | number)[]): Promise<any>;
  call?(command: string, ...args: any[]): Promise<any>;
  sendCommand?(command: string, args: (string | number)[]): Promise<any>;
  del?(...keys: string[]): Promise<any>;
}

export interface UpstashRestConfig {
  /** Upstash Redis REST URL (e.g. https://xxx.upstash.io) */
  url: string;
  /** Upstash Redis REST Token */
  token: string;
}

export interface RedisStoreOptions {
  /** Redis client instance (ioredis, node-redis, upstash/redis, etc.) */
  client?: RedisClientLike;
  /** Upstash REST credentials (zero-dependency native fetch) */
  upstash?: UpstashRestConfig;
  /** Custom key prefix in Redis (default: 'rl:') */
  keyPrefix?: string;
  /** Default max limit if not specified in increment (default: 60) */
  defaultMax?: number;
  /** Use simple atomic INCR/PEXPIRE instead of Sliding Window Lua script */
  useAtomicIncrFallback?: boolean;
}

/**
 * Production-grade Sliding Window Lua script using Redis Sorted Sets
 * Atomic, O(log N) complexity, zero race conditions
 */
export const SLIDING_WINDOW_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local maxLimit = tonumber(ARGV[3])
local member = ARGV[4]
local clearBefore = now - windowMs

-- 1. Evict entries outside sliding window
redis.call('ZREMRANGEBYSCORE', key, 0, clearBefore)

-- 2. Count current active requests
local currentCount = redis.call('ZCARD', key)

if currentCount < maxLimit then
  -- Allowed: insert member with score = now
  redis.call('ZADD', key, now, member)
  redis.call('PEXPIRE', key, windowMs)
  return { 1, currentCount + 1, maxLimit - currentCount - 1, 0, now + windowMs }
else
  -- Blocked: calculate reset time from oldest element in window
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local resetTime = now + windowMs
  if oldest and #oldest >= 2 then
    resetTime = tonumber(oldest[2]) + windowMs
  end
  local retryAfterMs = math.max(1000, resetTime - now)
  local retryAfterSec = math.ceil(retryAfterMs / 1000)
  return { 0, currentCount, 0, retryAfterSec, resetTime }
end
`;

/**
 * High-Performance Redis & Upstash REST Rate Limit Store
 * Compatible with ioredis, @upstash/redis, node-redis, or pure HTTP REST fetch
 */
export class RedisRestRateLimitStore implements RateLimitStore {
  private readonly client?: RedisClientLike;
  private readonly upstash?: UpstashRestConfig;
  private readonly keyPrefix: string;
  private readonly defaultMax: number;
  private readonly useFallback: boolean;

  constructor(options: RedisStoreOptions) {
    if (!options.client && !options.upstash) {
      throw new Error(
        'RedisRestRateLimitStore requires either a client instance or upstash configuration',
      );
    }
    this.client = options.client;
    this.upstash = options.upstash;
    this.keyPrefix = options.keyPrefix ?? 'rl:';
    this.defaultMax = options.defaultMax ?? 60;
    this.useFallback = options.useAtomicIncrFallback ?? false;
  }

  private getFullKey(key: string): string {
    return `${this.keyPrefix}${key}`;
  }

  /**
   * Execute arbitrary Redis command via client or Upstash REST
   */
  public async executeCommand(command: string, args: (string | number)[]): Promise<any> {
    if (this.upstash) {
      const response = await fetch(`${this.upstash.url}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.upstash.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify([command, ...args]),
      });

      if (!response.ok) {
        throw new Error(`Upstash REST error: ${response.status} ${response.statusText}`);
      }

      const json = await response.json();
      return json.result;
    }

    if (this.client) {
      if (typeof this.client.eval === 'function' && command.toUpperCase() === 'EVAL') {
        const [script, numkeys, ...rest] = args;
        return this.client.eval(String(script), Number(numkeys), ...rest);
      }

      if (typeof this.client.call === 'function') {
        return this.client.call(command, ...args);
      }

      if (typeof this.client.sendCommand === 'function') {
        return this.client.sendCommand(command, args);
      }
    }

    throw new Error('Unsupported Redis client implementation');
  }

  /**
   * Increment counter in Redis using Sliding Window Lua script
   */
  public async increment(
    key: string,
    windowMs: number,
    max?: number,
  ): Promise<RateLimitResult> {
    const fullKey = this.getFullKey(key);
    const limit = max ?? this.defaultMax;
    const now = Date.now();

    if (this.useFallback) {
      return this.incrementAtomic(fullKey, windowMs, limit, now);
    }

    const uniqueMember = `${now}-${Math.random().toString(36).substring(2, 9)}`;

    try {
      const raw = await this.executeCommand('EVAL', [
        SLIDING_WINDOW_LUA,
        1,
        fullKey,
        now,
        windowMs,
        limit,
        uniqueMember,
      ]);

      const [isAllowed, current, remaining, retryAfterSec, resetTimeMs] = raw as [
        number,
        number,
        number,
        number,
        number,
      ];

      return {
        isAllowed: isAllowed === 1,
        current: Number(current),
        limit,
        remaining: Math.max(0, Number(remaining)),
        resetTime: new Date(Number(resetTimeMs)),
        retryAfterSec: Number(retryAfterSec),
      };
    } catch {
      // If Lua eval fails (e.g. cluster or restrictive provider), fallback to atomic INCR
      return this.incrementAtomic(fullKey, windowMs, limit, now);
    }
  }

  /**
   * Fallback using atomic INCR and PEXPIRE
   */
  private async incrementAtomic(
    fullKey: string,
    windowMs: number,
    limit: number,
    now: number,
  ): Promise<RateLimitResult> {
    const current = Number(await this.executeCommand('INCR', [fullKey]));

    if (current === 1) {
      await this.executeCommand('PEXPIRE', [fullKey, windowMs]);
    }

    const isAllowed = current <= limit;
    const remaining = Math.max(0, limit - current);

    let ttlMs = windowMs;
    try {
      const pttl = Number(await this.executeCommand('PTTL', [fullKey]));
      if (pttl > 0) {
        ttlMs = pttl;
      }
    } catch {
      ttlMs = windowMs;
    }

    const retryAfterSec = isAllowed ? 0 : Math.max(1, Math.ceil(ttlMs / 1000));
    const resetTime = new Date(now + ttlMs);

    return {
      isAllowed,
      current,
      limit,
      remaining,
      resetTime,
      retryAfterSec,
    };
  }

  /**
   * Reset rate limit state in Redis for given key
   */
  public async reset(key: string): Promise<void> {
    const fullKey = this.getFullKey(key);
    await this.executeCommand('DEL', [fullKey]);
  }

  /**
   * Decrement counter (removes latest entry or decrements count)
   */
  public async decrement(key: string): Promise<void> {
    const fullKey = this.getFullKey(key);
    if (this.useFallback) {
      await this.executeCommand('DECR', [fullKey]);
    } else {
      await this.executeCommand('ZPOPMAX', [fullKey, 1]);
    }
  }
}
