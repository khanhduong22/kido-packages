import { describe, it, expect, beforeEach } from 'bun:test';
import { FlashSaleEngine, type RedisLike } from '../index';

/**
 * High-fidelity in-memory Redis simulator for evaluating Lua routines & mutex locks
 */
class InMemoryRedisMock implements RedisLike {
  private store = new Map<string, string>();
  private expiries = new Map<string, number>();

  async get(key: string): Promise<string | null> {
    const exp = this.expiries.get(key);
    if (exp && Date.now() > exp) {
      this.store.delete(key);
      this.expiries.delete(key);
      return null;
    }
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string | number, ...args: any[]): Promise<any> {
    const isNx = args.includes('NX');
    const pxIndex = args.indexOf('PX');
    const ttlMs = pxIndex !== -1 ? Number(args[pxIndex + 1]) : null;

    if (isNx) {
      const existing = await this.get(key);
      if (existing !== null) {
        return null; // Key already exists
      }
    }

    this.store.set(key, String(value));
    if (ttlMs) {
      this.expiries.set(key, Date.now() + ttlMs);
    }
    return 'OK';
  }

  async eval(script: string, numkeys: number, ...args: (string | number)[]): Promise<any> {
    const keys = args.slice(0, numkeys).map(String);
    const argv = args.slice(numkeys).map(String);

    // Reserve Stock Lua
    if (script.includes("tonumber(redis.call('GET', KEYS[1]))")) {
      const key = keys[0];
      const qty = Number(argv[0]) || 1;
      const raw = await this.get(key);
      const stock = raw !== null ? Number(raw) : null;

      if (stock === null || stock <= 0) return -1;
      if (stock < qty) return -2;

      const newStock = stock - qty;
      this.store.set(key, String(newStock));
      return newStock;
    }

    // Release Lock Lua
    if (script.includes('if redis.call("get", KEYS[1]) == ARGV[1] then')) {
      const key = keys[0];
      const token = argv[0];
      const current = await this.get(key);
      if (current === token) {
        this.store.delete(key);
        this.expiries.delete(key);
        return 1;
      }
      return 0;
    }

    // Rollback Stock Lua
    if (script.includes("redis.call('INCRBY', KEYS[1], ARGV[1])")) {
      const key = keys[0];
      const qty = Number(argv[0]) || 0;
      const raw = await this.get(key);
      const stock = raw !== null ? Number(raw) : 0;
      const updated = stock + qty;
      this.store.set(key, String(updated));
      return updated;
    }

    throw new Error('Unrecognized Lua script in mock');
  }

  async del(...keys: string[]): Promise<number> {
    let deleted = 0;
    for (const k of keys) {
      if (this.store.delete(k)) deleted++;
      this.expiries.delete(k);
    }
    return deleted;
  }
}

describe('@kido/flashsale-engine', () => {
  let redis: InMemoryRedisMock;
  let engine: FlashSaleEngine;

  beforeEach(() => {
    redis = new InMemoryRedisMock();
    engine = new FlashSaleEngine({ redis });
  });

  it('seeds and retrieves stock accurately', async () => {
    await engine.seedStock('item_phone_12', 50);
    const stock = await engine.getStock('item_phone_12');
    expect(stock).toBe(50);
  });

  it('successfully reserves single item and decrements stock', async () => {
    await engine.seedStock('item_airpods', 10);
    const res = await engine.reserve({
      itemId: 'item_airpods',
      userId: 'usr_001',
      quantity: 1,
    });

    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.itemId).toBe('item_airpods');
      expect(res.userId).toBe('usr_001');
      expect(res.remainingStock).toBe(9);
      expect(res.claimToken).toMatch(/^claim:/);
    }

    const currentStock = await engine.getStock('item_airpods');
    expect(currentStock).toBe(9);
  });

  it('enforces zero overselling when stock runs out', async () => {
    await engine.seedStock('item_macbook', 2);

    const r1 = await engine.reserve({ itemId: 'item_macbook', userId: 'usr_1', quantity: 1 });
    expect(r1.success).toBe(true);

    const r2 = await engine.reserve({ itemId: 'item_macbook', userId: 'usr_2', quantity: 1 });
    expect(r2.success).toBe(true);

    // 3rd attempt must fail with OUT_OF_STOCK
    const r3 = await engine.reserve({ itemId: 'item_macbook', userId: 'usr_3', quantity: 1 });
    expect(r3.success).toBe(false);
    if (!r3.success) {
      expect(r3.code).toBe('OUT_OF_STOCK');
    }

    const finalStock = await engine.getStock('item_macbook');
    expect(finalStock).toBe(0); // Zero negative stock!
  });

  it('rejects order with INSUFFICIENT_STOCK if requesting more than remains', async () => {
    await engine.seedStock('item_ipad', 3);

    const res = await engine.reserve({
      itemId: 'item_ipad',
      userId: 'usr_greedy',
      quantity: 5,
    });

    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.code).toBe('INSUFFICIENT_STOCK');
    }

    // Stock untouched
    expect(await engine.getStock('item_ipad')).toBe(3);
  });

  it('locks concurrent double-submissions for identical user and item', async () => {
    await engine.seedStock('item_ticket', 10);

    // Manually hold lock to simulate in-flight request
    await redis.set('flashsale:lock:user:usr_fast:item:item_ticket', 'active-token', 'PX', 5000, 'NX');

    const res = await engine.reserve({
      itemId: 'item_ticket',
      userId: 'usr_fast',
      quantity: 1,
    });

    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.code).toBe('CONCURRENT_REQUEST_LOCKED');
    }
  });

  it('restores stock accurately upon rollback', async () => {
    await engine.seedStock('item_console', 10);
    const res = await engine.reserve({ itemId: 'item_console', userId: 'usr_buyer', quantity: 2 });
    expect(res.success).toBe(true);
    expect(await engine.getStock('item_console')).toBe(8);

    // Rollback 2 items
    const restored = await engine.rollback('item_console', 2);
    expect(restored).toBe(10);
    expect(await engine.getStock('item_console')).toBe(10);
  });
});
