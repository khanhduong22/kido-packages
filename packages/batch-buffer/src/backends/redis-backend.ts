import { BufferBackend } from '../types';

/**
 * Minimal structural interface compatible with ioredis, @redis/client (node-redis), or Valkey clients.
 */
export interface RedisClientLike {
  rpush(key: string, ...elements: string[]): Promise<number>;
  lpop(key: string, count?: number): Promise<string[] | string | null>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  ltrim(key: string, start: number, stop: number): Promise<unknown>;
  llen(key: string): Promise<number>;
  del(key: string): Promise<number>;
  eval?(script: string, numkeys: number, ...args: (string | number)[]): Promise<unknown>;
}

export interface RedisBackendOptions<T> {
  /**
   * Redis / Valkey client instance.
   */
  client: RedisClientLike;

  /**
   * Redis key name where the list queue is stored.
   */
  queueKey: string;

  /**
   * Custom serializer function (defaults to JSON.stringify).
   */
  serialize?: (item: T) => string;

  /**
   * Custom deserializer function (defaults to JSON.parse).
   */
  deserialize?: (raw: string) => T;

  /**
   * Whether to use atomic Lua script for popBatch (prevents race conditions across distributed workers).
   * Default: true if client.eval is available.
   */
  useLuaScript?: boolean;
}

/**
 * Lua script for atomic batch dequeue from Redis List.
 * Extracts items 0 to count-1 and immediately trims the list in a single atomic transaction.
 */
const ATOMIC_POP_BATCH_LUA = `
local items = redis.call('LRANGE', KEYS[1], 0, tonumber(ARGV[1]) - 1)
if #items > 0 then
  redis.call('LTRIM', KEYS[1], #items, -1)
end
return items
`;

/**
 * Redis/Valkey List driver for distributed queue architectures.
 * Allows multiple application instances or workers to enqueue and dequeue micro-batches
 * without data loss or race conditions.
 */
export class RedisBackend<T> implements BufferBackend<T> {
  private readonly client: RedisClientLike;
  private readonly queueKey: string;
  private readonly serialize: (item: T) => string;
  private readonly deserialize: (raw: string) => T;
  private readonly useLua: boolean;

  constructor(options: RedisBackendOptions<T>) {
    this.client = options.client;
    this.queueKey = options.queueKey;
    this.serialize = options.serialize ?? ((item: T) => JSON.stringify(item));
    this.deserialize = options.deserialize ?? ((raw: string) => JSON.parse(raw) as T);
    this.useLua = options.useLuaScript ?? (typeof this.client.eval === 'function');
  }

  public async push(item: T | T[]): Promise<number> {
    const items = Array.isArray(item) ? item : [item];
    if (items.length === 0) {
      return this.size();
    }

    const payload = items.map((i) => this.serialize(i));
    return this.client.rpush(this.queueKey, ...payload);
  }

  public async popBatch(maxCount: number): Promise<T[]> {
    if (maxCount <= 0) return [];

    if (this.useLua && typeof this.client.eval === 'function') {
      const rawItems = (await this.client.eval(
        ATOMIC_POP_BATCH_LUA,
        1,
        this.queueKey,
        maxCount
      )) as string[];

      if (!rawItems || rawItems.length === 0) return [];
      return rawItems.map((raw) => this.deserialize(raw));
    }

    // Fallback: lrange + ltrim
    const rawItems = await this.client.lrange(this.queueKey, 0, maxCount - 1);
    if (!rawItems || rawItems.length === 0) return [];

    await this.client.ltrim(this.queueKey, rawItems.length, -1);
    return rawItems.map((raw) => this.deserialize(raw));
  }

  public async peek(maxCount?: number): Promise<T[]> {
    const stop = maxCount !== undefined && maxCount > 0 ? maxCount - 1 : -1;
    const rawItems = await this.client.lrange(this.queueKey, 0, stop);
    if (!rawItems || rawItems.length === 0) return [];
    return rawItems.map((raw) => this.deserialize(raw));
  }

  public async size(): Promise<number> {
    return this.client.llen(this.queueKey);
  }

  public async dropOldest(count: number): Promise<number> {
    if (count <= 0) return 0;
    const currentSize = await this.size();
    if (currentSize === 0) return 0;

    const toDrop = Math.min(count, currentSize);
    await this.client.ltrim(this.queueKey, toDrop, -1);
    return toDrop;
  }

  public async dropNewest(count: number): Promise<number> {
    if (count <= 0) return 0;
    const currentSize = await this.size();
    if (currentSize === 0) return 0;

    const toDrop = Math.min(count, currentSize);
    await this.client.ltrim(this.queueKey, 0, -1 - toDrop);
    return toDrop;
  }

  public async clear(): Promise<void> {
    await this.client.del(this.queueKey);
  }
}

/**
 * Built-in In-Memory Mock of RedisClientLike for standalone execution, testing, and CI environments.
 */
export class MockRedisClient implements RedisClientLike {
  private readonly storage: Map<string, string[]> = new Map();

  public async rpush(key: string, ...elements: string[]): Promise<number> {
    let list = this.storage.get(key);
    if (!list) {
      list = [];
      this.storage.set(key, list);
    }
    list.push(...elements);
    return list.length;
  }

  public async lpop(key: string, count?: number): Promise<string[] | string | null> {
    const list = this.storage.get(key);
    if (!list || list.length === 0) return count !== undefined ? [] : null;

    if (count === undefined) {
      return list.shift() ?? null;
    }

    const popped = list.splice(0, count);
    return popped;
  }

  public async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const list = this.storage.get(key);
    if (!list || list.length === 0) return [];

    const len = list.length;
    let actualStart = start < 0 ? Math.max(0, len + start) : start;
    let actualStop = stop < 0 ? len + stop : stop;

    if (actualStart >= len) return [];
    if (actualStop >= len) actualStop = len - 1;
    if (actualStart > actualStop) return [];

    return list.slice(actualStart, actualStop + 1);
  }

  public async ltrim(key: string, start: number, stop: number): Promise<string> {
    const list = this.storage.get(key);
    if (!list) return 'OK';

    const len = list.length;
    let actualStart = start < 0 ? Math.max(0, len + start) : start;
    let actualStop = stop < 0 ? len + stop : stop;

    if (actualStart >= len || actualStart > actualStop) {
      this.storage.set(key, []);
      return 'OK';
    }

    if (actualStop >= len) actualStop = len - 1;
    this.storage.set(key, list.slice(actualStart, actualStop + 1));
    return 'OK';
  }

  public async llen(key: string): Promise<number> {
    const list = this.storage.get(key);
    return list ? list.length : 0;
  }

  public async del(key: string): Promise<number> {
    const existed = this.storage.delete(key);
    return existed ? 1 : 0;
  }

  public async eval(
    script: string,
    _numkeys: number,
    ...args: (string | number)[]
  ): Promise<unknown> {
    const key = String(args[0]);
    const maxCount = Number(args[1]);

    const list = this.storage.get(key);
    if (!list || list.length === 0) return [];

    const countToPop = Math.min(maxCount, list.length);
    const popped = list.splice(0, countToPop);
    return popped;
  }
}
