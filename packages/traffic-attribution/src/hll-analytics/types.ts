/**
 * Interface compatible with Redis client containing HyperLogLog methods (ioredis, redis, etc.)
 */
export interface RedisHllClient {
  pfadd(key: string, ...elements: (string | number)[]): Promise<number>;
  pfcount(...keys: string[]): Promise<number>;
  pfmerge(destKey: string, ...sourceKeys: string[]): Promise<string | number | 'OK'>;
  del?(...keys: string[]): Promise<number>;
  expire?(key: string, seconds: number): Promise<number>;
}

export interface HllAnalyticsOptions {
  /** Redis client instance. If omitted, uses high-speed In-Memory mock store */
  redis?: RedisHllClient;
  /** Redis key prefix. Default: 'hll' */
  keyPrefix?: string;
  /** Temporary key TTL in seconds for merged keys. Default: 300 (5 minutes) */
  tempKeyTtlSeconds?: number;
}

export interface BufferedViewCounterOptions {
  /** Time window in ms during which duplicate views by the same visitor are ignored. Default: 15 minutes (900,000ms) */
  dedupWindowMs?: number;
  /** Interval in ms to automatically flush batched views. Default: 10,000ms */
  flushIntervalMs?: number;
  /** Maximum number of aggregated views before auto-triggering an immediate flush. Default: 500 */
  maxBatchSize?: number;
  /** Async or sync callback executed when views are flushed */
  onFlush: (batch: Map<string, number>) => Promise<void> | void;
  /** Error handler for flush execution failures */
  onError?: (error: unknown) => void;
}

export interface FlushResult {
  flushedItems: number;
  totalViews: number;
  timestamp: number;
}
