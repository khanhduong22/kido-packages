export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  /** Number of consecutive failures before opening circuit. Default: 3 */
  failureThreshold?: number;
  /** Milliseconds before an OPEN circuit transitions to HALF_OPEN to probe. Default: 10,000ms */
  resetTimeoutMs?: number;
  /** Consecutive successful probes in HALF_OPEN before fully closing circuit. Default: 2 */
  successThreshold?: number;
  /** Callback fired whenever the circuit breaker transitions state */
  onStateChange?: (from: CircuitState, to: CircuitState) => void;
}

export interface CircuitBreakerStats {
  state: CircuitState;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  lastFailureTime: number | null;
  totalExecutions: number;
  totalFailures: number;
  totalTrips: number;
}

export interface CacheAdapter<T = unknown> {
  get(key: string): Promise<T | null | undefined>;
  set(key: string, value: T, ttlMs?: number): Promise<void>;
  delete(key: string): Promise<boolean | void>;
  clear?(): Promise<void>;
}

export interface ResilientCacheOptions<T = unknown> {
  /** Optional cache instance identifier for logging and metrics */
  name?: string;
  /** L1 in-memory cache TTL in milliseconds. Default: 30,000ms (30s) */
  l1TtlMs?: number;
  /** L2 remote cache TTL in milliseconds. Default: 300,000ms (5m) */
  l2TtlMs?: number;
  /** Optional L2 remote cache adapter (e.g. Redis, Memcached) */
  l2Adapter?: CacheAdapter<T>;
  /** Circuit breaker options for guarding L2 remote cache calls */
  circuitBreaker?: CircuitBreakerOptions;
  /** Whether to coalesce concurrent fetch requests for the same key. Default: true */
  enableInFlightDeduplication?: boolean;
  /** Error handler hook when L1 or L2 encounters an issue */
  onError?: (error: unknown, operation: string, key?: string) => void;
}

export interface CacheGetOptions {
  /** Skip reading from L1 cache */
  skipL1?: boolean;
  /** Skip reading from L2 cache */
  skipL2?: boolean;
  /** Custom TTL in milliseconds for this specific write */
  ttlMs?: number;
}

export interface CacheStats {
  l1Hits: number;
  l2Hits: number;
  misses: number;
  fetches: number;
  inFlightSaves: number;
  circuitState: CircuitState;
}
