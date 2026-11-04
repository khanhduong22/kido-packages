import {
  ProgressiveCooldownConfig,
  RateLimitResult,
  RateLimitStore,
} from '../types';

interface KeyRecord {
  /** Array of timestamps (in ms) when hits occurred */
  timestamps: number[];
  /** Consecutive violation count while blocked */
  violationCount: number;
  /** Timestamp until which the key is blocked under cooldown */
  blockedUntil: number;
  /** Window duration used for TTL checks */
  lastWindowMs: number;
  /** Max limit configured for this key */
  lastLimit: number;
}

export interface MemoryStoreOptions {
  /** Default maximum limit if not provided in increment() */
  defaultMax?: number;
  /** Periodic garbage collection interval in ms (default: 30000ms = 30s) */
  sweepIntervalMs?: number;
  /** Progressive cooldown configuration or flag */
  progressiveCooldown?: boolean | ProgressiveCooldownConfig;
}

/**
 * Returns current timestamp in milliseconds with sub-millisecond precision if available
 */
function getPreciseNow(): number {
  if (
    typeof performance !== 'undefined' &&
    typeof performance.now === 'function' &&
    typeof performance.timeOrigin === 'number'
  ) {
    return performance.timeOrigin + performance.now();
  }
  return Date.now();
}

/**
 * High-Performance In-Memory Sliding Window Counter Rate Limit Store
 * Sub-millisecond precision with automatic background TTL sweep and Progressive Cooldown
 */
export class MemoryRateLimitStore implements RateLimitStore {
  private readonly store = new Map<string, KeyRecord>();
  private readonly defaultMax: number;
  private readonly sweepIntervalMs: number;
  private readonly progressiveCooldown: boolean;
  private readonly cooldownConfig: Required<ProgressiveCooldownConfig>;
  private sweepTimer?: ReturnType<typeof setInterval>;

  constructor(options: MemoryStoreOptions = {}) {
    this.defaultMax = options.defaultMax ?? 60;
    this.sweepIntervalMs = options.sweepIntervalMs ?? 30_000;

    if (typeof options.progressiveCooldown === 'object') {
      this.progressiveCooldown = true;
      this.cooldownConfig = {
        multiplier: options.progressiveCooldown.multiplier ?? 2,
        maxMultiplier: options.progressiveCooldown.maxMultiplier ?? 16,
        basePenaltyMs: options.progressiveCooldown.basePenaltyMs ?? 0,
      };
    } else {
      this.progressiveCooldown = Boolean(options.progressiveCooldown);
      this.cooldownConfig = {
        multiplier: 2,
        maxMultiplier: 16,
        basePenaltyMs: 0,
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

    // Unref timer so it does not prevent process termination in Node/Bun
    if (this.sweepTimer && typeof (this.sweepTimer as any).unref === 'function') {
      (this.sweepTimer as any).unref();
    }
  }

  /**
   * Run active TTL sweep: clean up expired timestamps and delete idle keys
   * @returns number of evicted keys
   */
  public sweep(): number {
    const now = getPreciseNow();
    let evictedCount = 0;

    for (const [key, record] of this.store.entries()) {
      const windowCutoff = now - record.lastWindowMs;

      // Filter out timestamps older than the sliding window
      record.timestamps = record.timestamps.filter((ts) => ts > windowCutoff);

      // Key can be evicted if no active timestamps and no active cooldown block
      const isCooldownActive = record.blockedUntil > now;
      if (record.timestamps.length === 0 && !isCooldownActive) {
        this.store.delete(key);
        evictedCount++;
      }
    }

    return evictedCount;
  }

  /**
   * Number of keys currently tracked in memory
   */
  public get size(): number {
    return this.store.size;
  }

  /**
   * Check if a specific key is currently tracked
   */
  public has(key: string): boolean {
    return this.store.has(key);
  }

  /**
   * Increment counter for given key within sliding window
   */
  public async increment(
    key: string,
    windowMs: number,
    max?: number,
  ): Promise<RateLimitResult> {
    const limit = max ?? this.defaultMax;
    const now = getPreciseNow();

    let record = this.store.get(key);
    if (!record) {
      record = {
        timestamps: [],
        violationCount: 0,
        blockedUntil: 0,
        lastWindowMs: windowMs,
        lastLimit: limit,
      };
      this.store.set(key, record);
    } else {
      record.lastWindowMs = windowMs;
      record.lastLimit = limit;
    }

    // 1. Progressive Cooldown Check: Client is still within penalty block
    if (this.progressiveCooldown && record.blockedUntil > now) {
      record.violationCount++;
      const factor = Math.min(
        this.cooldownConfig.maxMultiplier,
        Math.pow(this.cooldownConfig.multiplier, record.violationCount - 1),
      );
      const basePenalty = this.cooldownConfig.basePenaltyMs > 0
        ? this.cooldownConfig.basePenaltyMs
        : windowMs;

      const penaltyMs = basePenalty * factor;
      record.blockedUntil = Math.max(record.blockedUntil, now + penaltyMs);

      const retryAfterSec = Math.max(1, Math.ceil((record.blockedUntil - now) / 1000));
      return {
        isAllowed: false,
        current: limit + record.violationCount,
        limit,
        remaining: 0,
        resetTime: new Date(Math.ceil(record.blockedUntil)),
        retryAfterSec,
        cooldownMultiplier: factor,
      };
    }

    // Cooldown has expired, reset violation count
    if (record.blockedUntil <= now && record.violationCount > 0) {
      record.violationCount = 0;
      record.blockedUntil = 0;
    }

    // 2. Sliding Window: Prune timestamps older than (now - windowMs)
    const windowCutoff = now - windowMs;
    record.timestamps = record.timestamps.filter((ts) => ts > windowCutoff);

    const currentCount = record.timestamps.length;

    // 3. Under Limit: Allow request
    if (currentCount < limit) {
      record.timestamps.push(now);
      const remaining = limit - (currentCount + 1);

      const oldestTimestamp = record.timestamps[0] ?? now;
      const resetTimeMs = oldestTimestamp + windowMs;

      return {
        isAllowed: true,
        current: currentCount + 1,
        limit,
        remaining,
        resetTime: new Date(Math.ceil(resetTimeMs)),
        retryAfterSec: 0,
      };
    }

    // 4. Over Limit: Block request
    const oldestTimestamp = record.timestamps[0] ?? (now - windowMs);
    const standardResetMs = oldestTimestamp + windowMs;
    const msUntilReset = Math.max(1, standardResetMs - now);

    if (this.progressiveCooldown) {
      record.violationCount = 1;
      const basePenalty = this.cooldownConfig.basePenaltyMs > 0
        ? this.cooldownConfig.basePenaltyMs
        : Math.max(msUntilReset, windowMs);

      record.blockedUntil = now + basePenalty;
      const retryAfterSec = Math.max(1, Math.ceil(basePenalty / 1000));

      return {
        isAllowed: false,
        current: currentCount,
        limit,
        remaining: 0,
        resetTime: new Date(Math.ceil(record.blockedUntil)),
        retryAfterSec,
        cooldownMultiplier: 1,
      };
    }

    const retryAfterSec = Math.max(1, Math.ceil(msUntilReset / 1000));
    return {
      isAllowed: false,
      current: currentCount,
      limit,
      remaining: 0,
      resetTime: new Date(Math.ceil(standardResetMs)),
      retryAfterSec,
    };
  }

  /**
   * Reset rate limit state for a key
   */
  public async reset(key: string): Promise<void> {
    this.store.delete(key);
  }

  /**
   * Decrement most recent hit for a key (useful for skipFailedRequests)
   */
  public async decrement(key: string): Promise<void> {
    const record = this.store.get(key);
    if (!record) return;

    record.timestamps.pop();
    if (record.timestamps.length === 0 && record.blockedUntil <= getPreciseNow()) {
      this.store.delete(key);
    }
  }

  /**
   * Stop background sweep timer and clear all records
   */
  public close(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
    this.store.clear();
  }
}
