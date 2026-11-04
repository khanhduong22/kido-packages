import {
  ProgressiveCooldownConfig,
  RateLimitResult,
  RateLimitStore,
  TokenBucketConfig,
} from '../types';

interface BucketRecord {
  /** Floating-point tokens currently in bucket */
  tokens: number;
  /** Timestamp (ms) when bucket was last refilled */
  lastRefillTime: number;
  /** Consecutive violation count while blocked */
  violationCount: number;
  /** Timestamp until which client is blocked under cooldown */
  blockedUntil: number;
}

/**
 * Token Bucket Rate Limiter
 * Controls burst traffic (e.g. burst up to 5 requests, refilling 1 token/sec)
 * Implements RateLimitStore interface for seamless drop-in usage
 */
export class TokenBucketLimiter implements RateLimitStore {
  private readonly buckets = new Map<string, BucketRecord>();
  private readonly capacity: number;
  private readonly refillRate: number;
  private readonly intervalMs: number;
  private readonly defaultCost: number;
  private readonly progressiveCooldown: boolean;
  private readonly cooldownConfig: Required<ProgressiveCooldownConfig>;
  private readonly sweepIntervalMs: number;
  private sweepTimer?: ReturnType<typeof setInterval>;

  constructor(config: TokenBucketConfig) {
    this.capacity = Math.max(1, config.capacity);
    this.refillRate = Math.max(0.001, config.refillRate);
    this.intervalMs = Math.max(1, config.intervalMs ?? 1000);
    this.defaultCost = Math.max(1, config.cost ?? 1);
    this.sweepIntervalMs = config.sweepIntervalMs ?? 30_000;

    if (typeof config.progressiveCooldown === 'object') {
      this.progressiveCooldown = true;
      this.cooldownConfig = {
        multiplier: config.progressiveCooldown.multiplier ?? 2,
        maxMultiplier: config.progressiveCooldown.maxMultiplier ?? 16,
        basePenaltyMs: config.progressiveCooldown.basePenaltyMs ?? this.intervalMs,
      };
    } else {
      this.progressiveCooldown = Boolean(config.progressiveCooldown);
      this.cooldownConfig = {
        multiplier: 2,
        maxMultiplier: 16,
        basePenaltyMs: this.intervalMs,
      };
    }

    if (this.sweepIntervalMs > 0) {
      this.startSweepTimer();
    }
  }

  private startSweepTimer(): void {
    this.sweepTimer = setInterval(() => {
      this.sweep();
    }, this.sweepIntervalMs);

    if (this.sweepTimer && typeof (this.sweepTimer as any).unref === 'function') {
      (this.sweepTimer as any).unref();
    }
  }

  /**
   * Tokens per millisecond
   */
  private get tokensPerMs(): number {
    return this.refillRate / this.intervalMs;
  }

  /**
   * Refill tokens in bucket based on elapsed time
   */
  private refill(record: BucketRecord, now: number): void {
    const elapsedMs = Math.max(0, now - record.lastRefillTime);
    if (elapsedMs > 0) {
      const addedTokens = elapsedMs * this.tokensPerMs;
      record.tokens = Math.min(this.capacity, record.tokens + addedTokens);
      record.lastRefillTime = now;
    }
  }

  /**
   * Evict idle buckets that have reached full capacity and have no active cooldown
   */
  public sweep(): number {
    const now = Date.now();
    let evicted = 0;

    for (const [key, record] of this.buckets.entries()) {
      this.refill(record, now);
      const isCooldownActive = record.blockedUntil > now;
      if (record.tokens >= this.capacity && !isCooldownActive) {
        this.buckets.delete(key);
        evicted++;
      }
    }

    return evicted;
  }

  /**
   * Consume a specific number of tokens for given key
   */
  public async consume(key: string, cost = this.defaultCost): Promise<RateLimitResult> {
    const now = Date.now();
    let record = this.buckets.get(key);

    if (!record) {
      record = {
        tokens: this.capacity,
        lastRefillTime: now,
        violationCount: 0,
        blockedUntil: 0,
      };
      this.buckets.set(key, record);
    } else {
      this.refill(record, now);
    }

    // 1. Progressive Cooldown check
    if (this.progressiveCooldown && record.blockedUntil > now) {
      record.violationCount++;
      const factor = Math.min(
        this.cooldownConfig.maxMultiplier,
        Math.pow(this.cooldownConfig.multiplier, record.violationCount - 1),
      );
      const basePenalty = this.cooldownConfig.basePenaltyMs;
      const penaltyMs = basePenalty * factor;
      record.blockedUntil = Math.max(record.blockedUntil, now + penaltyMs);

      const retryAfterSec = Math.max(1, Math.ceil((record.blockedUntil - now) / 1000));
      return {
        isAllowed: false,
        current: this.capacity + record.violationCount,
        limit: this.capacity,
        remaining: 0,
        resetTime: new Date(Math.ceil(record.blockedUntil)),
        retryAfterSec,
        cooldownMultiplier: factor,
      };
    }

    // Cooldown expired
    if (record.blockedUntil <= now && record.violationCount > 0) {
      record.violationCount = 0;
      record.blockedUntil = 0;
    }

    // 2. Check if sufficient tokens are available
    if (record.tokens >= cost) {
      record.tokens -= cost;
      const remaining = Math.max(0, Math.floor(record.tokens));
      const current = this.capacity - remaining;

      const msToFull = (this.capacity - record.tokens) / this.tokensPerMs;
      const resetTime = new Date(Math.ceil(now + msToFull));

      return {
        isAllowed: true,
        current,
        limit: this.capacity,
        remaining,
        resetTime,
        retryAfterSec: 0,
      };
    }

    // 3. Bucket depleted (Burst exceeded)
    const deficit = cost - record.tokens;
    const msToWait = deficit / this.tokensPerMs;
    const standardResetTime = new Date(Math.ceil(now + msToWait));

    if (this.progressiveCooldown) {
      record.violationCount = 1;
      const basePenalty = Math.max(msToWait, this.cooldownConfig.basePenaltyMs);
      record.blockedUntil = now + basePenalty;
      const retryAfterSec = Math.max(1, Math.ceil(basePenalty / 1000));

      return {
        isAllowed: false,
        current: this.capacity,
        limit: this.capacity,
        remaining: 0,
        resetTime: new Date(Math.ceil(record.blockedUntil)),
        retryAfterSec,
        cooldownMultiplier: 1,
      };
    }

    const retryAfterSec = Math.max(1, Math.ceil(msToWait / 1000));
    return {
      isAllowed: false,
      current: this.capacity,
      limit: this.capacity,
      remaining: 0,
      resetTime: standardResetTime,
      retryAfterSec,
    };
  }

  /**
   * Implements RateLimitStore.increment
   */
  public async increment(
    key: string,
    _windowMs?: number,
    _max?: number,
  ): Promise<RateLimitResult> {
    return this.consume(key, this.defaultCost);
  }

  /**
   * Implements RateLimitStore.reset
   */
  public async reset(key: string): Promise<void> {
    this.buckets.delete(key);
  }

  /**
   * Implements RateLimitStore.decrement: return token to bucket
   */
  public async decrement(key: string, amount = this.defaultCost): Promise<void> {
    const record = this.buckets.get(key);
    if (!record) return;

    this.refill(record, Date.now());
    record.tokens = Math.min(this.capacity, record.tokens + amount);
  }

  /**
   * Clean up background timer and clear storage
   */
  public close(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
    this.buckets.clear();
  }

  /**
   * Number of buckets currently in memory
   */
  public get size(): number {
    return this.buckets.size;
  }
}
