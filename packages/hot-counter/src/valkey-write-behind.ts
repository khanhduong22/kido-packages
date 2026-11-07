/**
 * @file valkey-write-behind.ts
 * @description Pattern #2: Valkey/Redis HINCRBY Write-Behind + Atomic Lua Drain & Bounded Stock Gate
 *
 * Problem:
 * In a distributed, multi-instance API cluster (e.g. 5x Bun/Hono containers behind Caddy), each instance
 * cannot maintain isolated in-memory counters for global view counts or flash sale inventory.
 * If 10,000 users click "View Product" or "Buy Flash Sale" simultaneously, sending 10,000 requests straight
 * to PostgreSQL destroys database connections, exhausts connection pools, and causes catastrophic lock contention.
 *
 * Solution:
 * 1. Unbounded Counters (views, likes): Instances fire ultra-fast O(1) `HINCRBY` into a shared Valkey Hash buffer.
 * 2. Atomic Lua Drain: Background worker drains and deletes the dirty hash atomically in ONE round-trip via Lua script,
 *    eliminating the classic race condition where increments arriving between HGETALL and DEL are wiped out.
 * 3. Bounded Flash Sale Inventory Gate: Lua script checks `stock >= qty`, decrements available stock, and queues
 *    the negative delta into a dirty buffer atomically. Guarantees stock NEVER drops below 0 (< 0).
 * 4. Crash-Safe Rollback: If the database write fails after draining Valkey, the deltas are restored back via HINCRBY.
 */

export const LUA_ATOMIC_DRAIN_HASH = `
local entries = redis.call('HGETALL', KEYS[1])
if #entries > 0 then
  redis.call('DEL', KEYS[1])
end
return entries
`.trim();

export const LUA_BOUNDED_STOCK_RESERVE = `
local current = tonumber(redis.call('HGET', KEYS[1], ARGV[1]) or '-1')
local qty = tonumber(ARGV[2])
if current < qty then
  return {0, current}
end
local remaining = redis.call('HINCRBY', KEYS[1], ARGV[1], -qty)
redis.call('HINCRBY', KEYS[2], ARGV[1], -qty)
return {1, remaining}
`.trim();

export interface ValkeyClientLike {
  hincrby(key: string, field: string, increment: number): Promise<number>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<any>;
  hgetall?(key: string): Promise<Record<string, string>>;
  hget?(key: string, field: string): Promise<string | null>;
  hset?(key: string, field: string, value: string | number): Promise<any>;
  del?(key: string): Promise<number>;
}

/**
 * High-speed in-memory Valkey simulator with atomic Lua script emulation.
 * Used for unit testing, offline execution, and local benchmarks without external Redis.
 */
export class InMemoryValkeySimulator implements ValkeyClientLike {
  private hashes = new Map<string, Map<string, number | string>>();

  public async hincrby(key: string, field: string, increment: number): Promise<number> {
    let hash = this.hashes.get(key);
    if (!hash) {
      hash = new Map();
      this.hashes.set(key, hash);
    }
    const current = Number(hash.get(field) ?? 0);
    const updated = current + increment;
    hash.set(field, updated);
    return updated;
  }

  public async hget(key: string, field: string): Promise<string | null> {
    const hash = this.hashes.get(key);
    if (!hash) return null;
    const val = hash.get(field);
    return val !== undefined ? String(val) : null;
  }

  public async hset(key: string, field: string, value: string | number): Promise<number> {
    let hash = this.hashes.get(key);
    if (!hash) {
      hash = new Map();
      this.hashes.set(key, hash);
    }
    const isNew = !hash.has(field);
    hash.set(field, value);
    return isNew ? 1 : 0;
  }

  public async hgetall(key: string): Promise<Record<string, string>> {
    const hash = this.hashes.get(key);
    if (!hash) return {};
    const result: Record<string, string> = {};
    for (const [k, v] of hash.entries()) {
      result[k] = String(v);
    }
    return result;
  }

  public async del(key: string): Promise<number> {
    const existed = this.hashes.has(key);
    this.hashes.delete(key);
    return existed ? 1 : 0;
  }

  public async eval(
    script: string,
    numKeys: number,
    ...args: (string | number)[]
  ): Promise<any> {
    const keys = args.slice(0, numKeys).map(String);
    const argv = args.slice(numKeys).map(String);

    // Emulate LUA_ATOMIC_DRAIN_HASH
    if (script.includes("HGETALL") && script.includes("DEL")) {
      const targetKey = keys[0];
      const hash = this.hashes.get(targetKey);
      if (!hash || hash.size === 0) {
        return [];
      }
      const flatList: string[] = [];
      for (const [field, val] of hash.entries()) {
        flatList.push(field, String(val));
      }
      this.hashes.delete(targetKey);
      return flatList;
    }

    // Emulate LUA_BOUNDED_STOCK_RESERVE
    if (script.includes("HGET") && script.includes("ARGV[1]") && script.includes("ARGV[2]")) {
      const stockKey = keys[0];
      const dirtyKey = keys[1];
      const skuId = argv[0];
      const qty = Number(argv[1]);

      let stockHash = this.hashes.get(stockKey);
      if (!stockHash) {
        stockHash = new Map();
        this.hashes.set(stockKey, stockHash);
      }
      const current = Number(stockHash.get(skuId) ?? -1);

      if (current < qty) {
        return [0, current];
      }

      const remaining = current - qty;
      stockHash.set(skuId, remaining);

      // Record negative delta into dirty buffer
      let dirtyHash = this.hashes.get(dirtyKey);
      if (!dirtyHash) {
        dirtyHash = new Map();
        this.hashes.set(dirtyKey, dirtyHash);
      }
      const dirtyCurrent = Number(dirtyHash.get(skuId) ?? 0);
      dirtyHash.set(skuId, dirtyCurrent - qty);

      return [1, remaining];
    }

    throw new Error(`Unsupported Lua script in InMemoryValkeySimulator`);
  }

  /**
   * Clears all simulated Valkey keys.
   */
  public clear(): void {
    this.hashes.clear();
  }
}

export interface ValkeyWriteBehindOptions {
  client?: ValkeyClientLike;
  dirtyHashKey?: string;
  stockKey?: string;
  stockDirtyKey?: string;
}

export interface FlushToDbResult {
  flushedFields: number;
  sqlStatementsSaved: number;
  deltas: Record<string, number>;
  executionTimeMs: number;
}

export interface ValkeyWriteBehindStats {
  totalIncrements: number;
  totalStockReservations: number;
  totalStockRejections: number;
  totalDrainedBatches: number;
  totalFlushedDeltas: number;
}

export class ValkeyWriteBehindCounter {
  private client: ValkeyClientLike;
  private dirtyHashKey: string;
  private stockKey: string;
  private stockDirtyKey: string;

  private totalIncrements = 0;
  private totalStockReservations = 0;
  private totalStockRejections = 0;
  private totalDrainedBatches = 0;
  private totalFlushedDeltas = 0;

  constructor(options: ValkeyWriteBehindOptions = {}) {
    this.client = options.client ?? new InMemoryValkeySimulator();
    this.dirtyHashKey = options.dirtyHashKey ?? "kido:counter:dirty";
    this.stockKey = options.stockKey ?? "kido:stock:available";
    this.stockDirtyKey = options.stockDirtyKey ?? "kido:stock:dirty";
  }

  /**
   * Sets initial available stock in Valkey for a Flash Sale SKU.
   */
  public async setStock(skuId: string, quantity: number): Promise<void> {
    if (this.client.hset) {
      await this.client.hset(this.stockKey, skuId, quantity);
    } else {
      // Fallback via eval or hincrby
      await this.client.hincrby(this.stockKey, skuId, quantity);
    }
  }

  /**
   * Reads current available stock for a Flash Sale SKU.
   */
  public async getStock(skuId: string): Promise<number> {
    if (this.client.hget) {
      const raw = await this.client.hget(this.stockKey, skuId);
      return raw !== null ? Number(raw) : 0;
    }
    return 0;
  }

  /**
   * Increments an unbounded counter (views, likes, clicks) in Valkey O(1).
   */
  public async increment(
    field: string,
    delta: number = 1,
    customDirtyKey?: string
  ): Promise<number> {
    const key = customDirtyKey ?? this.dirtyHashKey;
    const updated = await this.client.hincrby(key, field, delta);
    this.totalIncrements++;
    return updated;
  }

  /**
   * Bounded Flash Sale Inventory Gate.
   * Atomically checks `stock >= qty`, decrements stock, and buffers the delta.
   * Guarantees 0 overselling!
   */
  public async reserveStock(
    skuId: string,
    qty: number
  ): Promise<{ success: boolean; remaining: number; requestedQty: number }> {
    const result = await this.client.eval(
      LUA_BOUNDED_STOCK_RESERVE,
      2,
      this.stockKey,
      this.stockDirtyKey,
      skuId,
      qty
    );

    const success = Array.isArray(result) && Number(result[0]) === 1;
    const remaining = Array.isArray(result) ? Number(result[1]) : -1;

    if (success) {
      this.totalStockReservations++;
      return { success: true, remaining, requestedQty: qty };
    } else {
      this.totalStockRejections++;
      return { success: false, remaining, requestedQty: qty };
    }
  }

  /**
   * Drains the dirty hash atomically using Lua script.
   * Eliminates the race condition of separate HGETALL followed by DEL.
   */
  public async drainDirty(customDirtyKey?: string): Promise<Record<string, number>> {
    const key = customDirtyKey ?? this.dirtyHashKey;
    const rawResult = await this.client.eval(LUA_ATOMIC_DRAIN_HASH, 1, key);

    const deltas: Record<string, number> = {};

    if (Array.isArray(rawResult)) {
      for (let i = 0; i < rawResult.length; i += 2) {
        const field = String(rawResult[i]);
        const delta = Number(rawResult[i + 1]);
        if (!isNaN(delta) && delta !== 0) {
          deltas[field] = delta;
        }
      }
    } else if (rawResult && typeof rawResult === "object") {
      for (const [field, val] of Object.entries(rawResult)) {
        const delta = Number(val);
        if (!isNaN(delta) && delta !== 0) {
          deltas[field] = delta;
        }
      }
    }

    if (Object.keys(deltas).length > 0) {
      this.totalDrainedBatches++;
    }

    return deltas;
  }

  /**
   * Rollback helper: re-applies extracted deltas back to Valkey if DB write fails.
   */
  public async rollbackDirty(
    deltas: Record<string, number>,
    customDirtyKey?: string
  ): Promise<void> {
    const key = customDirtyKey ?? this.dirtyHashKey;
    for (const [field, delta] of Object.entries(deltas)) {
      await this.client.hincrby(key, field, delta);
    }
  }

  /**
   * Drains dirty buffer and flushes to database with crash rollback safety.
   */
  public async flushToDatabase(
    executor: (deltas: Record<string, number>) => Promise<void>,
    customDirtyKey?: string
  ): Promise<FlushToDbResult> {
    const startMs = Date.now();
    const key = customDirtyKey ?? this.dirtyHashKey;
    const deltas = await this.drainDirty(key);
    const fieldCount = Object.keys(deltas).length;

    if (fieldCount === 0) {
      return {
        flushedFields: 0,
        sqlStatementsSaved: 0,
        deltas: {},
        executionTimeMs: 0,
      };
    }

    try {
      await executor(deltas);
    } catch (error) {
      // Re-merge deltas back to Valkey to prevent ANY lost data
      await this.rollbackDirty(deltas, key);
      throw error;
    }

    let totalEventsInBatch = 0;
    for (const d of Object.values(deltas)) {
      totalEventsInBatch += Math.abs(d);
    }
    const sqlStatementsSaved = Math.max(0, totalEventsInBatch - 1);

    this.totalFlushedDeltas += fieldCount;

    return {
      flushedFields: fieldCount,
      sqlStatementsSaved,
      deltas,
      executionTimeMs: Date.now() - startMs,
    };
  }

  /**
   * Returns lifetime metrics.
   */
  public getStats(): ValkeyWriteBehindStats {
    return {
      totalIncrements: this.totalIncrements,
      totalStockReservations: this.totalStockReservations,
      totalStockRejections: this.totalStockRejections,
      totalDrainedBatches: this.totalDrainedBatches,
      totalFlushedDeltas: this.totalFlushedDeltas,
    };
  }

  /**
   * Resets all lifetime metrics.
   */
  public resetStats(): void {
    this.totalIncrements = 0;
    this.totalStockReservations = 0;
    this.totalStockRejections = 0;
    this.totalDrainedBatches = 0;
    this.totalFlushedDeltas = 0;
  }
}
