import crypto from 'node:crypto';
import { RESERVE_STOCK_LUA, RELEASE_LOCK_LUA, ROLLBACK_STOCK_LUA } from './scripts';

export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string | number, ...args: any[]): Promise<any>;
  eval(script: string, numkeys: number, ...args: (string | number)[]): Promise<any>;
  del(...keys: string[]): Promise<number>;
}

export interface FlashSaleEngineOptions {
  redis: RedisLike;
  keyPrefix?: string;
  defaultLockTtlMs?: number;
}

export interface ReserveRequest {
  itemId: string;
  userId: string;
  quantity?: number;
  lockTtlMs?: number;
}

export type ReserveErrorCode =
  | 'CONCURRENT_REQUEST_LOCKED'
  | 'OUT_OF_STOCK'
  | 'INSUFFICIENT_STOCK'
  | 'INVALID_PARAMETERS';

export interface ReserveSuccess {
  success: true;
  claimToken: string;
  itemId: string;
  userId: string;
  reservedQuantity: number;
  remainingStock: number;
}

export interface ReserveFailure {
  success: false;
  code: ReserveErrorCode;
  message: string;
}

export type ReserveResult = ReserveSuccess | ReserveFailure;

/**
 * FlashSaleEngine — High-concurrency zero-overselling inventory reservation engine
 * using Redis Mutex locks (SET NX PX) and atomic Lua script evaluations.
 */
export class FlashSaleEngine {
  private redis: RedisLike;
  private prefix: string;
  private defaultLockTtlMs: number;

  constructor(options: FlashSaleEngineOptions) {
    this.redis = options.redis;
    this.prefix = options.keyPrefix ? `${options.keyPrefix}:` : 'flashsale:';
    this.defaultLockTtlMs = options.defaultLockTtlMs ?? 3000;
  }

  private getStockKey(itemId: string): string {
    return `${this.prefix}item:${itemId}:stock`;
  }

  private getLockKey(userId: string, itemId: string): string {
    return `${this.prefix}lock:user:${userId}:item:${itemId}`;
  }

  /**
   * Seed or reset available inventory for a flash sale item.
   */
  async seedStock(itemId: string, stock: number): Promise<void> {
    if (stock < 0) throw new Error('Stock count must be greater than or equal to 0');
    const key = this.getStockKey(itemId);
    await this.redis.set(key, stock);
  }

  /**
   * Get current real-time stock remaining in memory.
   */
  async getStock(itemId: string): Promise<number | null> {
    const raw = await this.redis.get(this.getStockKey(itemId));
    if (raw === null) return null;
    return Number(raw);
  }

  /**
   * Reserve an item atomically under high concurrency.
   * Enforces user-item lock contention guard and zero-overselling constraint.
   */
  async reserve(req: ReserveRequest): Promise<ReserveResult> {
    const { itemId, userId, quantity = 1, lockTtlMs = this.defaultLockTtlMs } = req;

    if (!itemId || !userId || quantity <= 0) {
      return {
        success: false,
        code: 'INVALID_PARAMETERS',
        message: 'itemId and userId are required, quantity must be > 0.',
      };
    }

    const lockKey = this.getLockKey(userId, itemId);
    const lockToken = crypto.randomUUID();

    // 1. Acquire Distributed Mutex Lock (SET NX PX)
    const lockAcquired = await this.redis.set(lockKey, lockToken, 'PX', lockTtlMs, 'NX');

    if (!lockAcquired) {
      return {
        success: false,
        code: 'CONCURRENT_REQUEST_LOCKED',
        message: 'A transaction is already in progress for this user & item.',
      };
    }

    try {
      const stockKey = this.getStockKey(itemId);

      // 2. Execute Atomic Lua Stock Reservation
      const evalResult = await this.redis.eval(RESERVE_STOCK_LUA, 1, stockKey, quantity);
      const remainingStock = Number(evalResult);

      if (remainingStock === -1) {
        return {
          success: false,
          code: 'OUT_OF_STOCK',
          message: 'Flash sale item is completely sold out.',
        };
      }

      if (remainingStock === -2) {
        return {
          success: false,
          code: 'INSUFFICIENT_STOCK',
          message: 'Insufficient inventory remaining to fulfill requested quantity.',
        };
      }

      // 3. Stock Claim Confirmed
      const claimToken = `claim:${crypto.randomUUID()}`;
      return {
        success: true,
        claimToken,
        itemId,
        userId,
        reservedQuantity: quantity,
        remainingStock,
      };
    } finally {
      // 4. Safely Release Distributed Lock via CAS Token Match
      try {
        await this.redis.eval(RELEASE_LOCK_LUA, 1, lockKey, lockToken);
      } catch {
        // Suppress lock release errors to avoid masking reservation result
      }
    }
  }

  /**
   * Rollback reserved stock (e.g. order cancelled, checkout expired, payment failed).
   */
  async rollback(itemId: string, quantity: number): Promise<number> {
    if (quantity <= 0) return 0;
    const stockKey = this.getStockKey(itemId);
    const res = await this.redis.eval(ROLLBACK_STOCK_LUA, 1, stockKey, quantity);
    return Number(res);
  }
}

export * from './scripts';
export default FlashSaleEngine;
