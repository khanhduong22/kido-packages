/**
 * @file index.ts
 * @description Unified Public Exports for @kido/hot-counter
 *
 * Màn 07: Write Coalescing / Micro-Batching Counter & Slotted Hot-Key Counter
 * Màn 24: GonnaCrash counter_at_scale (YouTube Hybrid View Engine & Cloud Datastore Adaptive Slot Sizer)
 * 1. MicroBatchCoalescer: In-Memory Map<string, number> + Single SQL VALUES (...) Batch UPDATE
 * 2. ValkeyWriteBehindCounter: Shared Valkey HINCRBY + Atomic Lua Drain & Bounded Flash Sale Stock Gate
 * 3. SlottedCounter: 16-Slot Sharded Counter (16x lock distribution) + Bounded SKIP LOCKED Inventory Fallback
 * 4. ProgressiveTier: Tier-0 SME Zero-Infra, Tier-1 Growth & Tier-2 Big-Tech Counter Advisors
 * 5. YouTubeHybridViewEngine: Sharded Counter + HyperLogLog Anti-F5 Spam Audit & Datastore Adaptive Slot Sizer
 */

export * from "./micro-batch-coalescer";
export * from "./valkey-write-behind";
export * from "./slotted-counter";
export * from "./progressive-tier";
export * from "./youtube-view-engine";
