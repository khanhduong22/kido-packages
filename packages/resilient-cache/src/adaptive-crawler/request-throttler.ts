export interface OutboundThrottleConfig {
  /** Maximum number of requests allowed per window */
  maxRequests: number;
  /** Time window in milliseconds */
  windowMs: number;
  /** Minimum delay between consecutive requests in milliseconds. Default: 0 */
  minRequestIntervalMs?: number;
  /** Adaptive mode: automatically adjust rate based on rate limit headers. Default: true */
  adaptive?: boolean;
  /**
   * Safety margin: fraction of maxRequests kept as safety buffer (0 to <1).
   * Default: 0.1 (uses 90% of maxRequests).
   */
  safetyMargin?: number;
}

export type ThrottleConfig = OutboundThrottleConfig;

interface TokenBucketState {
  tokens: number;
  lastRefill: number;
  maxTokens: number;
  refillRate: number;
}

interface RateLimitCooldownState {
  blockedAt: number;
  blockedUntil: number;
  reason: string;
}

export interface CooldownInfo {
  isActive: boolean;
  remainingMs: number;
  remainingSec: number;
  reason: string;
  blockedAt: number;
  blockedUntil: number;
}

export interface OutboundThrottleStatus {
  tokens: number;
  maxTokens: number;
  refillRate: number;
  cooldown: CooldownInfo | null;
}

export interface OutboundRequestThrottlerOptions {
  /** Default IP-level cooldown duration in ms when 429 occurs. Default: 180,000ms (3 minutes) */
  defaultCooldownMs?: number;
  /** Minimum debounce window in ms between duplicate cooldown triggers. Default: 5,000ms */
  debounceWindowMs?: number;
}

export class RateLimitCooldownError extends Error {
  public readonly key: string;
  public readonly remainingSec: number;
  public readonly reason: string;

  constructor(key: string, remainingSec: number, reason: string) {
    super(
      `[${key}] Circuit breaker: API is in rate limit cooldown. ` +
        `Remaining: ${remainingSec}s. ` +
        `Reason: ${reason}. ` +
        `Please retry after cooldown expires.`,
    );
    this.name = 'RateLimitCooldownError';
    this.key = key;
    this.remainingSec = remainingSec;
    this.reason = reason;
  }
}

/**
 * Proactive Token Bucket rate controller with safety margin, minimum interval spacing,
 * dynamic rate limit header adaptation, and debounced IP-Level Cooldown Circuit Breaker.
 */
export class OutboundRequestThrottler {
  private readonly buckets = new Map<string, TokenBucketState>();
  private readonly lastRequestTime = new Map<string, number>();
  private readonly rateLimitCooldowns = new Map<
    string,
    RateLimitCooldownState
  >();

  private readonly defaultCooldownMs: number;
  private readonly debounceWindowMs: number;

  constructor(options: OutboundRequestThrottlerOptions = {}) {
    this.defaultCooldownMs = Math.max(1, options.defaultCooldownMs ?? 180_000);
    this.debounceWindowMs = Math.max(0, options.debounceWindowMs ?? 5_000);
  }

  private getBucket(
    key: string,
    config: OutboundThrottleConfig,
  ): TokenBucketState {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      const safetyMargin = Math.min(
        0.99,
        Math.max(0, config.safetyMargin ?? 0.1),
      );
      const effectiveMaxRequests = Math.max(
        1,
        Math.floor(config.maxRequests * (1 - safetyMargin)),
      );
      const windowMs = Math.max(1, config.windowMs);

      bucket = {
        tokens: effectiveMaxRequests,
        lastRefill: Date.now(),
        maxTokens: effectiveMaxRequests,
        refillRate: effectiveMaxRequests / windowMs,
      };
      this.buckets.set(key, bucket);
    }
    return bucket;
  }

  private refillTokens(bucket: TokenBucketState): void {
    const now = Date.now();
    const timePassed = Math.max(0, now - bucket.lastRefill);
    if (timePassed > 0) {
      const tokensToAdd = timePassed * bucket.refillRate;
      bucket.tokens = Math.min(bucket.maxTokens, bucket.tokens + tokensToAdd);
      bucket.lastRefill = now;
    }
  }

  private async checkAndWaitForCooldown(key: string): Promise<number> {
    const cooldown = this.rateLimitCooldowns.get(key);
    if (!cooldown) {
      return 0;
    }

    const now = Date.now();
    if (now >= cooldown.blockedUntil) {
      this.rateLimitCooldowns.delete(key);
      return 0;
    }

    const remainingMs = cooldown.blockedUntil - now;
    await this.sleep(remainingMs);
    this.rateLimitCooldowns.delete(key);
    return remainingMs;
  }

  /**
   * Trigger IP-level rate limit cooldown for a given provider/bucket key.
   * Debounced: ignores duplicate triggers while cooldown is active or within debounce window.
   *
   * @returns `true` if a new cooldown was activated, `false` if debounced.
   */
  public triggerRateLimitCooldown(
    key: string,
    reason = 'API returned 429',
    cooldownMs = this.defaultCooldownMs,
  ): boolean {
    const now = Date.now();
    const existing = this.rateLimitCooldowns.get(key);

    if (existing && now < existing.blockedUntil) {
      return false;
    }

    if (existing && now - existing.blockedAt < this.debounceWindowMs) {
      return false;
    }

    const duration = Math.max(1, cooldownMs);
    this.rateLimitCooldowns.set(key, {
      blockedAt: now,
      blockedUntil: now + duration,
      reason,
    });

    return true;
  }

  /**
   * Acquire a token for `key`, waiting for any active cooldown, `minRequestIntervalMs`,
   * and token refill. Returns total wait time in milliseconds.
   */
  public async acquireToken(
    key: string,
    config: OutboundThrottleConfig,
  ): Promise<number> {
    let totalWaitTime = await this.checkAndWaitForCooldown(key);

    const bucket = this.getBucket(key, config);
    this.refillTokens(bucket);

    const minInterval = config.minRequestIntervalMs ?? 0;
    if (minInterval > 0) {
      const lastRequest = this.lastRequestTime.get(key) ?? 0;
      const timeSinceLastRequest = Date.now() - lastRequest;
      if (lastRequest > 0 && timeSinceLastRequest < minInterval) {
        const waitTime = minInterval - timeSinceLastRequest;
        await this.sleep(waitTime);
        totalWaitTime += waitTime;
        this.refillTokens(bucket);
      }
    }

    while (bucket.tokens < 1) {
      const timeToNextToken = (1 - bucket.tokens) / bucket.refillRate;
      const waitTime = Math.max(1, Math.min(Math.ceil(timeToNextToken), 1000));
      await this.sleep(waitTime);
      totalWaitTime += waitTime;
      this.refillTokens(bucket);
    }

    bucket.tokens -= 1;
    this.lastRequestTime.set(key, Date.now());

    return totalWaitTime;
  }

  /**
   * Execute an async function with proactive token-bucket rate control.
   */
  public async throttle<T>(
    key: string,
    fn: () => Promise<T>,
    config: OutboundThrottleConfig,
  ): Promise<T> {
    await this.acquireToken(key, config);
    return fn();
  }

  /**
   * Dynamically adapt rate limit capacity and refill rate based on upstream response headers.
   */
  public updateRateLimit(
    key: string,
    maxRequests: number,
    windowMs: number,
  ): void {
    const bucket = this.buckets.get(key);
    const validMax = Math.max(1, maxRequests);
    const validWindow = Math.max(1, windowMs);

    if (!bucket) {
      this.buckets.set(key, {
        tokens: validMax,
        lastRefill: Date.now(),
        maxTokens: validMax,
        refillRate: validMax / validWindow,
      });
      return;
    }

    const oldMaxTokens = bucket.maxTokens;
    bucket.maxTokens = validMax;
    bucket.refillRate = validMax / validWindow;
    bucket.tokens = Math.min(
      validMax,
      bucket.tokens,
      oldMaxTokens > 0 ? (bucket.tokens / oldMaxTokens) * validMax : validMax,
    );
  }

  /**
   * Return a consumed token back to the bucket (e.g. when a request is aborted before hitting upstream).
   */
  public returnToken(key: string): void {
    const bucket = this.buckets.get(key);
    if (bucket) {
      bucket.tokens = Math.min(bucket.maxTokens, bucket.tokens + 1);
    }
  }

  /**
   * Non-blocking check whether `key` is currently in IP-level rate limit cooldown.
   */
  public isInCooldown(key: string): boolean {
    const cooldown = this.rateLimitCooldowns.get(key);
    if (!cooldown) {
      return false;
    }

    if (Date.now() >= cooldown.blockedUntil) {
      this.rateLimitCooldowns.delete(key);
      return false;
    }

    return true;
  }

  /**
   * Fail-fast circuit breaker guard: throws `RateLimitCooldownError` if `key` is in cooldown.
   */
  public assertNotInCooldown(key: string): void {
    const info = this.getCooldownInfo(key);
    if (info?.isActive) {
      throw new RateLimitCooldownError(key, info.remainingSec, info.reason);
    }
  }

  /**
   * Get detailed cooldown status for `key`, or `null` if not in cooldown.
   */
  public getCooldownInfo(key: string): CooldownInfo | null {
    const cooldown = this.rateLimitCooldowns.get(key);
    if (!cooldown) {
      return null;
    }

    const now = Date.now();
    const remainingMs = Math.max(0, cooldown.blockedUntil - now);

    if (remainingMs === 0) {
      this.rateLimitCooldowns.delete(key);
      return null;
    }

    return {
      isActive: true,
      remainingMs,
      remainingSec: Math.ceil(remainingMs / 1000),
      reason: cooldown.reason,
      blockedAt: cooldown.blockedAt,
      blockedUntil: cooldown.blockedUntil,
    };
  }

  /**
   * Get current bucket and cooldown status for monitoring.
   */
  public getStatus(key: string): OutboundThrottleStatus | null {
    const bucket = this.buckets.get(key);
    if (!bucket) {
      return null;
    }

    this.refillTokens(bucket);

    return {
      tokens: bucket.tokens,
      maxTokens: bucket.maxTokens,
      refillRate: bucket.refillRate,
      cooldown: this.getCooldownInfo(key),
    };
  }

  public reset(key: string): void {
    this.buckets.delete(key);
    this.lastRequestTime.delete(key);
    this.rateLimitCooldowns.delete(key);
  }

  public resetAll(): void {
    this.buckets.clear();
    this.lastRequestTime.clear();
    this.rateLimitCooldowns.clear();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
