/**
 * @file index.ts
 * @description Unified Public Exports for @kido/hot-counter
 *
 * Màn 07: Write Coalescing / Micro-Batching Counter & Slotted Hot-Key Counter
 * 1. MicroBatchCoalescer: In-Memory Map<string, number> + Single SQL VALUES (...) Batch UPDATE
 * 2. ValkeyWriteBehindCounter: Shared Valkey HINCRBY + Atomic Lua Drain & Bounded Flash Sale Stock Gate
 * 3. SlottedCounter: 16-Slot Sharded Counter (16x lock distribution) + Bounded SKIP LOCKED Inventory Fallback
 */

export * from "./micro-batch-coalescer";
export * from "./valkey-write-behind";
export * from "./slotted-counter";
export * from "./progressive-tier";
