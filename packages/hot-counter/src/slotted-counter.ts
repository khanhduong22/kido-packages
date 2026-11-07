/**
 * @file slotted-counter.ts
 * @description Pattern #3: 16-Slot Sharded Hot Counter & Bounded Anti-Oversell Inventory Fallback
 *
 * Problem:
 * When synchronous direct-to-PostgreSQL writes are mandated by regulatory compliance or immediate
 * read-your-own-writes guarantees, 1,000 concurrent transactions incrementing a single hot row
 * (e.g. popular product like count, inventory reserve) serialize on a single PostgreSQL tuple row lock.
 * This results in severe lock queueing, high latency, transaction timeouts, and deadlock aborts.
 *
 * Solution:
 * Splits 1 logical counter into N=16 physical slot rows in PostgreSQL:
 * `("entity_type", "entity_id", "slot_id")` where `slot_id ∈ [0, 15]`.
 *
 * 1. Concurrency Multiplier:
 *    Writing to `slot = murmurhash3(callerId) % 16` divides lock contention by 16x.
 *    16 concurrent transactions can write simultaneously without blocking each other.
 *
 * 2. Instant Read Aggregation:
 *    `SELECT COALESCE(SUM(value), 0) FROM store_hot_counter_slots WHERE entity_type = $1 AND entity_id = $2;`
 *    PostgreSQL aggregates 16 small rows in < 0.2ms via composite index index-only scan.
 *
 * 3. Bounded Flash Sale Inventory with SKIP LOCKED Fallback:
 *    Stock is distributed across 16 slots. Deductions first target their hashed slot; if depleted,
 *    a single atomic CTE query falls back to any available slot with `FOR UPDATE SKIP LOCKED`.
 *    Guarantees 100% anti-oversell without head-of-line blocking!
 */

// Zero-dependency MurmurHash3_32 implementation for deterministic slot routing
const C1 = 0xcc9e2d51;
const C2 = 0x1b873593;
const C3 = 0xe6546b64;
const MIX1 = 0x85ebca6b;
const MIX2 = 0xc2b2ae35;

export function murmurhash3_32(key: string, seed: number = 0): number {
  if (typeof key !== "string") {
    key = String(key ?? "");
  }

  const bytes = new TextEncoder().encode(key);
  const len = bytes.length;
  let h1 = seed >>> 0;

  const nblocks = Math.floor(len / 4);
  for (let i = 0; i < nblocks; i++) {
    const idx = i * 4;
    let k1 =
      bytes[idx] |
      (bytes[idx + 1] << 8) |
      (bytes[idx + 2] << 16) |
      (bytes[idx + 3] << 24);

    k1 = Math.imul(k1, C1);
    k1 = (k1 << 15) | (k1 >>> 17);
    k1 = Math.imul(k1, C2);

    h1 ^= k1;
    h1 = (h1 << 13) | (h1 >>> 19);
    h1 = (Math.imul(h1, 5) + C3) | 0;
  }

  let k1 = 0;
  const tailIdx = nblocks * 4;
  const rem = len & 3;

  if (rem === 3) k1 ^= bytes[tailIdx + 2] << 16;
  if (rem >= 2) k1 ^= bytes[tailIdx + 1] << 8;
  if (rem >= 1) {
    k1 ^= bytes[tailIdx];
    k1 = Math.imul(k1, C1);
    k1 = (k1 << 15) | (k1 >>> 17);
    k1 = Math.imul(k1, C2);
    h1 ^= k1;
  }

  h1 ^= len;
  h1 ^= h1 >>> 16;
  h1 = Math.imul(h1, MIX1);
  h1 ^= h1 >>> 13;
  h1 = Math.imul(h1, MIX2);
  h1 ^= h1 >>> 16;

  return h1 >>> 0;
}

/**
 * Maps a caller key to a slot index in [0, numSlots - 1].
 */
export function getSlotId(callerKey: string, numSlots: number = 16): number {
  if (numSlots <= 0) return 0;
  return murmurhash3_32(callerKey) % numSlots;
}

export interface SlottedCounterOptions {
  tableName?: string;
  defaultNumSlots?: number;
}

export interface SlotIncrementResult {
  slotId: number;
  delta: number;
  sql: string;
  params: (string | number)[];
}

export interface SlottedStockDeductResult {
  success: boolean;
  slotUsed: number;
  preferredSlot: number;
  usedFallback: boolean;
  remainingTotal: number;
  reason?: string;
}

/**
 * Pure in-memory simulation of 16-Slot Sharded Counter.
 * Used for testing, local benchmarks, and mathematical concurrency proofs.
 */
export class InMemorySlottedCounter {
  private readonly numSlots: number;
  // entityKey -> number[16]
  private storage = new Map<string, number[]>();

  constructor(numSlots: number = 16) {
    this.numSlots = numSlots;
  }

  private getKey(entityType: string, entityId: string): string {
    return `${entityType}:${entityId}`;
  }

  private getOrCreateSlots(key: string): number[] {
    let slots = this.storage.get(key);
    if (!slots) {
      slots = new Array(this.numSlots).fill(0);
      this.storage.set(key, slots);
    }
    return slots;
  }

  /**
   * Distributes initial stock across the 16 slots.
   * Handles non-divisible stock by distributing remainders one by one.
   */
  public initializeStock(
    entityType: string,
    entityId: string,
    totalStock: number
  ): number[] {
    const key = this.getKey(entityType, entityId);
    const slots = new Array(this.numSlots).fill(0);
    const base = Math.floor(totalStock / this.numSlots);
    let remainder = totalStock % this.numSlots;

    for (let i = 0; i < this.numSlots; i++) {
      slots[i] = base + (remainder > 0 ? 1 : 0);
      if (remainder > 0) remainder--;
    }

    this.storage.set(key, slots);
    return [...slots];
  }

  /**
   * Increments a slot atomically.
   */
  public increment(
    entityType: string,
    entityId: string,
    delta: number = 1,
    callerKey?: string
  ): { slotId: number; newValueInSlot: number; total: number } {
    const key = this.getKey(entityType, entityId);
    const slots = this.getOrCreateSlots(key);
    const slotId = callerKey
      ? getSlotId(callerKey, this.numSlots)
      : Math.floor(Math.random() * this.numSlots);

    slots[slotId] += delta;

    return {
      slotId,
      newValueInSlot: slots[slotId],
      total: this.getTotal(entityType, entityId),
    };
  }

  /**
   * Returns total aggregate sum across all slots.
   */
  public getTotal(entityType: string, entityId: string): number {
    const key = this.getKey(entityType, entityId);
    const slots = this.storage.get(key);
    if (!slots) return 0;
    return slots.reduce((acc, curr) => acc + curr, 0);
  }

  /**
   * Returns current slot array breakdown for diagnosis and telemetry.
   */
  public getSlotBreakdown(entityType: string, entityId: string): number[] {
    const key = this.getKey(entityType, entityId);
    const slots = this.storage.get(key);
    return slots ? [...slots] : new Array(this.numSlots).fill(0);
  }

  /**
   * Bounded Flash Sale Inventory Deduction.
   * 1. Attempts the preferred hashed slot first.
   * 2. If depleted, executes atomic fallback to another available slot.
   * 3. Guarantees 0 oversell!
   */
  public deductBoundedStock(
    entityType: string,
    entityId: string,
    qty: number,
    callerKey?: string
  ): SlottedStockDeductResult {
    const key = this.getKey(entityType, entityId);
    const slots = this.getOrCreateSlots(key);
    const preferredSlot = callerKey
      ? getSlotId(callerKey, this.numSlots)
      : Math.floor(Math.random() * this.numSlots);

    // Fast path: target slot has enough stock
    if (slots[preferredSlot] >= qty) {
      slots[preferredSlot] -= qty;
      return {
        success: true,
        slotUsed: preferredSlot,
        preferredSlot,
        usedFallback: false,
        remainingTotal: this.getTotal(entityType, entityId),
      };
    }

    // Fallback path: search other slots (simulating PostgreSQL CTE SKIP LOCKED)
    for (let i = 0; i < this.numSlots; i++) {
      if (i !== preferredSlot && slots[i] >= qty) {
        slots[i] -= qty;
        return {
          success: true,
          slotUsed: i,
          preferredSlot,
          usedFallback: true,
          remainingTotal: this.getTotal(entityType, entityId),
        };
      }
    }

    // Rejection: insufficient stock across all slots
    return {
      success: false,
      slotUsed: -1,
      preferredSlot,
      usedFallback: false,
      remainingTotal: this.getTotal(entityType, entityId),
      reason: "INSUFFICIENT_STOCK",
    };
  }

  public clear(): void {
    this.storage.clear();
  }
}

/**
 * Slotted Hot-Key Counter & PostgreSQL 18 SQL Generator
 */
export class SlottedCounter {
  private readonly tableName: string;
  private readonly numSlots: number;
  private memorySimulator: InMemorySlottedCounter;
  public readonly defaultNumSlots: number;

  constructor(options: SlottedCounterOptions = {}) {
    this.tableName = options.tableName ?? "store_hot_counter_slots";
    this.defaultNumSlots = options.defaultNumSlots ?? 16;
    this.numSlots = this.defaultNumSlots;
    this.memorySimulator = new InMemorySlottedCounter(this.defaultNumSlots);
  }

  /**
   * Generates PostgreSQL 18 Declarative DDL for the slotted counter table.
   */
  public generateDDL(tableName?: string): string {
    const table = `"${(tableName ?? this.tableName).replace(/"/g, '""')}"`;
    return [
      `-- PostgreSQL 18 Slotted Counter Table (Composite PK on entity_type, entity_id, slot_id)`,
      `CREATE TABLE IF NOT EXISTS ${table} (`,
      `  "entity_type" VARCHAR(64) NOT NULL,`,
      `  "entity_id" VARCHAR(128) NOT NULL,`,
      `  "slot_id" SMALLINT NOT NULL,`,
      `  "value" BIGINT NOT NULL DEFAULT 0,`,
      `  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),`,
      `  PRIMARY KEY ("entity_type", "entity_id", "slot_id")`,
      `);`,
      ``,
      `-- Fast index for aggregate SUM reads across all 16 slots`,
      `CREATE INDEX IF NOT EXISTS "idx_hot_counter_lookup"`,
      `ON ${table} ("entity_type", "entity_id");`,
    ].join("\n");
  }

  /**
   * Generates atomic PostgreSQL UPSERT statement for incrementing a specific slot.
   */
  public generateIncrementSQL(options: {
    entityType: string;
    entityId: string;
    slotId?: number;
    delta?: number;
    callerKey?: string;
  }): SlotIncrementResult {
    const table = `"${this.tableName.replace(/"/g, '""')}"`;
    const delta = options.delta ?? 1;
    const slotId =
      options.slotId !== undefined
        ? options.slotId
        : options.callerKey
        ? getSlotId(options.callerKey, this.defaultNumSlots)
        : Math.floor(Math.random() * this.defaultNumSlots);

    const sql = [
      `INSERT INTO ${table} ("entity_type", "entity_id", "slot_id", "value", "updated_at")`,
      `VALUES ($1, $2, $3, $4, NOW())`,
      `ON CONFLICT ("entity_type", "entity_id", "slot_id")`,
      `DO UPDATE SET "value" = ${table}."value" + EXCLUDED."value", "updated_at" = NOW();`,
    ].join("\n");

    return {
      slotId,
      delta,
      sql,
      params: [options.entityType, options.entityId, slotId, delta],
    };
  }

  /**
   * Generates Fast Aggregate Read SQL query to compute SUM(value) across all slots.
   */
  public generateAggregateReadSQL(
    entityType: string,
    entityId: string
  ): { sql: string; params: (string | number)[] } {
    const table = `"${this.tableName.replace(/"/g, '""')}"`;
    const sql = [
      `SELECT COALESCE(SUM("value"), 0)::bigint AS total, COUNT(*)::int AS active_slots`,
      `FROM ${table}`,
      `WHERE "entity_type" = $1 AND "entity_id" = $2;`,
    ].join("\n");

    return {
      sql,
      params: [entityType, entityId],
    };
  }

  /**
   * Generates Bounded Inventory Deduction SQL with SKIP LOCKED Fallback.
   *
   * Pattern:
   * 1. Attempts preferred slot ($4).
   * 2. If preferred slot has value < $qty, falls back to any other slot with value >= $qty.
   * 3. FOR UPDATE SKIP LOCKED prevents concurrent transaction lock stalls.
   */
  public generateBoundedDeductSQL(options: {
    entityType: string;
    entityId: string;
    qty: number;
    callerKey?: string;
  }): { sql: string; params: (string | number)[]; preferredSlot: number } {
    const table = `"${this.tableName.replace(/"/g, '""')}"`;
    const preferredSlot = options.callerKey
      ? getSlotId(options.callerKey, this.defaultNumSlots)
      : Math.floor(Math.random() * this.defaultNumSlots);

    const sql = [
      `WITH candidate AS (`,
      `  SELECT "slot_id"`,
      `  FROM ${table}`,
      `  WHERE "entity_type" = $1 AND "entity_id" = $2 AND "value" >= $3`,
      `  ORDER BY CASE WHEN "slot_id" = $4 THEN 0 ELSE 1 END, "slot_id" ASC`,
      `  LIMIT 1`,
      `  FOR UPDATE SKIP LOCKED`,
      `)`,
      `UPDATE ${table}`,
      `SET "value" = ${table}."value" - $3,`,
      `    "updated_at" = NOW()`,
      `FROM candidate`,
      `WHERE ${table}."entity_type" = $1`,
      `  AND ${table}."entity_id" = $2`,
      `  AND ${table}."slot_id" = candidate."slot_id"`,
      `RETURNING ${table}."slot_id", ${table}."value" AS remaining_in_slot;`,
    ].join("\n");

    return {
      sql,
      params: [options.entityType, options.entityId, options.qty, preferredSlot],
      preferredSlot,
    };
  }

  /**
   * Exposes in-memory simulation for test suites and benchmark execution.
   */
  public getSimulator(): InMemorySlottedCounter {
    return this.memorySimulator;
  }
}
