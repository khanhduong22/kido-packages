# Package Directives: @kido/hybrid-feed

> **Scope**: Tier-1 Big-Tech Hybrid Fanout Feed, K-Way Binary Max-Heap Cursor Merger & Valkey Capped Timeline Mixer.  
> **Standards Reference**: Twitter/X Feed Architecture, GonnaCrash Level 22 (System Design Game), DDIA Ch. 1 & 11.

## 1. Core Invariants & Boundaries

1. **Zero External Runtime Dependencies**: Pure TypeScript. Works with native `Map`, `Array`, `TextEncoder`, standard `Buffer` / Base64URL, and Valkey/Redis interfaces or built-in in-memory simulator.
2. **Asymmetric Fanout Boundary**:
   - Authors with followers below `celebrityThreshold` (default 500, or 20,000 for GonnaCrash Level 22) execute **fanout-on-write** (push to follower inboxes in batches of `inboxMaxBatchSize`).
   - Authors with followers above `celebrityThreshold` and system broadcast announcements MUST execute **pull bypass** (fanout-on-read) — writing ONLY 1 row to `celebrity_outbox` / `broadcast_outbox` (1x write amplification).
3. **Deterministic Keyset Cursor Pagination & Deduplication**:
   - Timeline ordering is strictly `createdAtMs DESC, id DESC` (deterministic tie-breaker).
   - Cursor condition: `(createdAtMs < cursor.createdAtMs) || (createdAtMs === cursor.createdAtMs && id < cursor.id)`.
   - Idempotency guard: Must deduplicate by `item.id` so mid-flight promotion/demotion between normal and celebrity status never yields duplicate posts.
4. **Atomic Lua ZSET Capping (Twitter/X Standard)**:
   - When pushing to Valkey/Redis inboxes, always execute `LUA_ZADD_CAPPED_TIMELINE` atomically on Valkey's single thread.
   - Capped at `maxInboxSize` (default 800 items) and refreshed with TTL expiration in a single round-trip.
5. **L1 RAM Cache for Celebrities**:
   - Celebrity outboxes MUST be cached in memory with a short TTL (default 5,000ms), compressing 600 read req/s at GonnaCrash Level 22 scale down to `< 1 read/s` (> 99.8% cache hit rate).
6. **SQL Injection Safety Invariant**:
   - All table and column names MUST pass `assertValidIdentifier` matching `/^[a-zA-Z_][a-zA-Z0-9_]*$/` before quoting.

## 2. Directory Layout

```
packages/hybrid-feed/
├── src/
│   ├── index.ts                  # Unified public exports
│   ├── k-way-cursor-merger.ts    # Module 1: Binary Max-Heap O(N log K) Merger & Keyset Cursor
│   ├── hybrid-fanout-engine.ts   # Module 2: Push/Pull Fanout Engine & GonnaCrash Level 22 Math
│   ├── valkey-timeline-mixer.ts  # Module 3: Valkey Capped ZSET Lua & L1 RAM Cache
│   └── progressive-tier.ts       # Module 4: 3-Tier Progressive Architecture (SME -> Growth -> BigTech)
├── tests/
│   ├── hybrid-feed.test.ts       # 14 core unit tests (Merger, Engine, Lua Capping, L1 Cache)
│   └── progressive-tier.test.ts  # 10 progressive architecture tests & 5-tier benchmark
├── tsup.config.ts
├── tsconfig.json
├── package.json
├── README.md
└── AGENTS.md
```

## 3. Verification Commands

```bash
cd packages/hybrid-feed
bun test
bun run typecheck
```
