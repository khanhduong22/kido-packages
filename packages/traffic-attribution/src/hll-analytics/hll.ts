import type { HllAnalyticsOptions, RedisHllClient } from './types';

/**
 * Standalone In-Memory Mock of Redis HyperLogLog for local dev and testing.
 * Implements PFADD, PFCOUNT, PFMERGE semantics using high-performance HashSets.
 */
export class InMemoryHllStore implements RedisHllClient {
  private store = new Map<string, Set<string>>();

  public async pfadd(
    key: string,
    ...elements: (string | number)[]
  ): Promise<number> {
    let set = this.store.get(key);
    if (!set) {
      set = new Set<string>();
      this.store.set(key, set);
    }

    let modified = 0;
    for (const el of elements) {
      const str = String(el);
      if (!set.has(str)) {
        set.add(str);
        modified = 1;
      }
    }
    return modified;
  }

  public async pfcount(...keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    if (keys.length === 1) {
      const set = this.store.get(keys[0]);
      return set ? set.size : 0;
    }

    const union = new Set<string>();
    for (const key of keys) {
      const set = this.store.get(key);
      if (set) {
        for (const item of set) {
          union.add(item);
        }
      }
    }
    return union.size;
  }

  public async pfmerge(
    destKey: string,
    ...sourceKeys: string[]
  ): Promise<'OK'> {
    let destSet = this.store.get(destKey);
    if (!destSet) {
      destSet = new Set<string>();
      this.store.set(destKey, destSet);
    }

    for (const srcKey of sourceKeys) {
      const srcSet = this.store.get(srcKey);
      if (srcSet) {
        for (const val of srcSet) {
          destSet.add(val);
        }
      }
    }
    return 'OK';
  }

  public async del(...keys: string[]): Promise<number> {
    let count = 0;
    for (const k of keys) {
      if (this.store.delete(k)) count++;
    }
    return count;
  }

  public async expire(_key: string, _seconds: number): Promise<number> {
    return 1;
  }

  public clear(): void {
    this.store.clear();
  }

  public getAllKeys(): string[] {
    return Array.from(this.store.keys());
  }
}

/**
 * Format a Date or date string to YYYY-MM-DD.
 */
export function formatDate(input: Date | string): string {
  if (typeof input === 'string') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(input)) return input;
    const d = new Date(input);
    return d.toISOString().slice(0, 10);
  }
  return input.toISOString().slice(0, 10);
}

/**
 * Generate a list of YYYY-MM-DD date strings from start to end inclusive.
 */
export function getDateRange(
  startInput: Date | string,
  endInput: Date | string
): string[] {
  const startDate = new Date(formatDate(startInput) + 'T00:00:00.000Z');
  const endDate = new Date(formatDate(endInput) + 'T00:00:00.000Z');

  if (startDate.getTime() > endDate.getTime()) {
    return [];
  }

  const result: string[] = [];
  const current = new Date(startDate.getTime());

  while (current.getTime() <= endDate.getTime()) {
    result.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }

  return result;
}

/**
 * High-Efficiency DAU / WAU / MAU Analytics using Redis HyperLogLog.
 * Tracks millions of unique user interactions using only ~12KB RAM per day.
 */
export class HllAnalytics {
  private redis: RedisHllClient;
  private keyPrefix: string;
  private tempKeyTtlSeconds: number;

  constructor(options: HllAnalyticsOptions = {}) {
    this.redis = options.redis ?? new InMemoryHllStore();
    this.keyPrefix = options.keyPrefix ?? 'hll';
    this.tempKeyTtlSeconds = options.tempKeyTtlSeconds ?? 300;
  }

  /**
   * Build Redis key for a metric and day.
   */
  public buildKey(metric: string, dateInput: Date | string): string {
    const day = formatDate(dateInput);
    return `${this.keyPrefix}:${metric}:${day}`;
  }

  /**
   * Record a unique visitor/event into the metric's daily HyperLogLog.
   * Returns true if the identifier was likely new, or false if already counted.
   */
  public async recordEvent(
    metric: string,
    identifier: string | number,
    date: Date | string = new Date()
  ): Promise<boolean> {
    const key = this.buildKey(metric, date);
    const added = await this.redis.pfadd(key, identifier);
    return added === 1;
  }

  /**
   * Record multiple identifiers at once in a single pipeline/call.
   */
  public async recordBatch(
    metric: string,
    identifiers: (string | number)[],
    date: Date | string = new Date()
  ): Promise<number> {
    if (identifiers.length === 0) return 0;
    const key = this.buildKey(metric, date);
    return await this.redis.pfadd(key, ...identifiers);
  }

  /**
   * Get unique visitor count for a single day (DAU).
   */
  public async getDailyUnique(
    metric: string,
    date: Date | string = new Date()
  ): Promise<number> {
    const key = this.buildKey(metric, date);
    return await this.redis.pfcount(key);
  }

  /**
   * Get Daily Active Users (DAU) - alias for getDailyUnique.
   */
  public async getDAU(
    metric: string,
    date: Date | string = new Date()
  ): Promise<number> {
    return this.getDailyUnique(metric, date);
  }

  /**
   * Get unique visitor count across a date range (merging daily keys).
   */
  public async getRangeUnique(
    metric: string,
    startDate: Date | string,
    endDate: Date | string
  ): Promise<number> {
    const days = getDateRange(startDate, endDate);
    if (days.length === 0) return 0;

    const keys = days.map((day) => `${this.keyPrefix}:${metric}:${day}`);

    if (keys.length === 1) {
      return await this.redis.pfcount(keys[0]);
    }

    // Redis PFCOUNT with multiple keys returns the approximated cardinality of the union
    return await this.redis.pfcount(...keys);
  }

  /**
   * Get Weekly Active Users (WAU) - 7-day rolling window up to reference date.
   */
  public async getWAU(
    metric: string,
    refDate: Date | string = new Date()
  ): Promise<number> {
    const end = new Date(formatDate(refDate) + 'T00:00:00.000Z');
    const start = new Date(end.getTime());
    start.setUTCDate(start.getUTCDate() - 6); // 7 days total including refDate

    return this.getRangeUnique(metric, start, end);
  }

  /**
   * Get Monthly Active Users (MAU) - 30-day rolling window up to reference date.
   */
  public async getMAU(
    metric: string,
    refDate: Date | string = new Date()
  ): Promise<number> {
    const end = new Date(formatDate(refDate) + 'T00:00:00.000Z');
    const start = new Date(end.getTime());
    start.setUTCDate(start.getUTCDate() - 29); // 30 days total including refDate

    return this.getRangeUnique(metric, start, end);
  }

  /**
   * Merge multiple source keys into a target key using PFMERGE.
   */
  public async mergeKeys(
    destKey: string,
    sourceKeys: string[]
  ): Promise<void> {
    if (sourceKeys.length === 0) return;
    await this.redis.pfmerge(destKey, ...sourceKeys);
    if (this.redis.expire) {
      await this.redis.expire(destKey, this.tempKeyTtlSeconds);
    }
  }

  public getClient(): RedisHllClient {
    return this.redis;
  }
}
