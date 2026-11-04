/**
 * Rate Limiter Core Types and Interfaces
 * RFC 6585 & IETF draft-ietf-httpapi-ratelimit-headers compliant
 */

/**
 * Result returned by a rate limiter check or increment operation
 */
export interface RateLimitResult {
  /** Whether the request is permitted */
  isAllowed: boolean;
  /** Number of hits recorded within current window (inclusive of current hit if allowed) */
  current: number;
  /** Maximum number of hits allowed within the window */
  limit: number;
  /** Number of remaining hits allowed within the window */
  remaining: number;
  /** Timestamp when the current rate limit window completely resets */
  resetTime: Date;
  /** Seconds client must wait before retrying (0 if allowed, >= 1 if blocked) */
  retryAfterSec: number;
  /** Current progressive cooldown multiplier applied (if progressive cooldown is active) */
  cooldownMultiplier?: number;
}

/**
 * Configuration options for Progressive Cooldown (Exponential Backoff on repeated violations)
 */
export interface ProgressiveCooldownConfig {
  /**
   * Multiplier applied to cooldown on consecutive spam attempts while blocked (default: 2)
   */
  multiplier?: number;
  /**
   * Maximum multiplier cap to prevent infinite lockouts (default: 16)
   */
  maxMultiplier?: number;
  /**
   * Base penalty duration in ms. If omitted, uses the config's windowMs.
   */
  basePenaltyMs?: number;
}

/**
 * Abstract storage interface for rate limiter backends
 */
export interface RateLimitStore {
  /**
   * Increment counter for given key within the time window.
   * @param key Unique identifier (IP, user ID, API token)
   * @param windowMs Time window in milliseconds
   * @param max Optional limit threshold override
   */
  increment(key: string, windowMs: number, max?: number): Promise<RateLimitResult>;

  /**
   * Reset/clear counters and cooldown state for given key.
   */
  reset(key: string): Promise<void>;

  /**
   * Decrement counter for given key (useful for skipFailedRequests).
   */
  decrement?(key: string): Promise<void>;

  /**
   * Clean up background sweeps or disconnect active connections.
   */
  close?(): void | Promise<void>;
}

/**
 * Rate limit configuration passed to middlewares or limiter instances
 */
export interface RateLimitConfig {
  /**
   * Time window in milliseconds for rate limiting
   */
  windowMs: number;

  /**
   * Maximum number of allowed requests per windowMs
   */
  max: number;

  /**
   * Custom key generator function (e.g. by IP, Authorization token, Tenant ID)
   */
  keyGenerator?: (req: any) => string | Promise<string>;

  /**
   * When true, failed requests (status >= 400 or exceptions) do not count towards rate limit
   */
  skipFailedRequests?: boolean;

  /**
   * Custom response message or payload when rate limit is exceeded
   */
  message?: string | Record<string, any> | ((result: RateLimitResult) => any);

  /**
   * HTTP status code when blocked (default: 429 Too Many Requests)
   */
  statusCode?: number;

  /**
   * Whether to send RFC 6585 / IETF standard headers (default: true)
   */
  headers?: boolean;

  /**
   * Optional custom storage backend. Defaults to in-memory sliding window store if omitted.
   */
  store?: RateLimitStore;

  /**
   * Progressive Cooldown (Exponential Backoff) configuration or toggle.
   * When enabled, repeated spam requests while blocked will double the retryAfterSec penalty.
   */
  progressiveCooldown?: boolean | ProgressiveCooldownConfig;

  /**
   * Custom function to conditionally skip rate limiting (e.g. health checks, webhooks)
   */
  skip?: (req: any) => boolean | Promise<boolean>;

  /**
   * Callback invoked whenever a client exceeds the rate limit
   */
  onLimitReached?: (result: RateLimitResult, key: string, req: any) => void | Promise<void>;

  /**
   * Custom handler to render the blocked response
   */
  handler?: (req: any, res: any, next?: any) => any;
}

/**
 * Configuration options for Token Bucket Limiter
 */
export interface TokenBucketConfig {
  /**
   * Burst capacity (maximum tokens bucket can hold)
   */
  capacity: number;

  /**
   * Number of tokens refilled per interval (e.g. 1 token per second)
   */
  refillRate: number;

  /**
   * Interval duration in milliseconds for refillRate (default: 1000ms = 1s)
   */
  intervalMs?: number;

  /**
   * Cost in tokens per request (default: 1)
   */
  cost?: number;

  /**
   * Progressive Cooldown settings on burst depletion spam
   */
  progressiveCooldown?: boolean | ProgressiveCooldownConfig;

  /**
   * Periodic garbage collection interval in ms (default: 30000ms)
   */
  sweepIntervalMs?: number;
}

/**
 * Standard HTTP Rate Limit Headers
 */
export interface RateLimitHeaders {
  'RateLimit-Limit': string;
  'RateLimit-Remaining': string;
  'RateLimit-Reset': string;
  'Retry-After': string;
  [key: string]: string;
}
