# Package Directives: @kido/db-sharding

> **Scope**: Tier-1 Distributed Database Sharding, Consistent Hash Ring & Compound Sub-Partitioning Core Package.  
> **Standards Reference**: Designing Data-Intensive Applications (DDIA Chapter 6: Partitioning).

## 1. Core Invariants & Boundaries
1. **Zero External Runtime Dependencies**: Pure TypeScript. All hashing uses deterministic 32-bit/64-bit MurmurHash3 with `Math.imul` and `TextEncoder`.
2. **Single-Shard Routing First**: When queries carry partition keys (`customerPhone`, `shop_id`, `buyer_id`, `user_id`), route strictly to a single shard ($O(1)$) to eliminate cross-shard network scatter-gather.
3. **Scatter-Gather Audit Warning**: Queries omitting the partition key must return explicit audit warning telemetry (`isScatterGather: true`) to prevent silent performance regressions.
4. **Minimal Ring Rebalancing Invariant**: In `ConsistentHashRing`, when adding/removing 1 node in an $N$-node cluster, verify that $\approx 1/N$ keys move (never naive modulo's $\approx (N-1)/N$ shuffle).
5. **PostgreSQL Native 2-Level Sub-Partitioning**: Enforce `PARTITION BY HASH(hashKey)` at Level 1, and `PARTITION BY RANGE(createdAt)` at Level 2. Primary keys must contain all partition keys (`(hashKey, rangeKey, id)`).
6. **Zero-Lock Concurrent Detach**: Historical cold months must be detached using `ALTER TABLE ... DETACH PARTITION ... CONCURRENTLY` to avoid blocking hot transaction writes.

## 2. Directory Layout
```
packages/db-sharding/
├── src/
│   ├── index.ts                 # Unified re-exports
│   ├── murmurhash.ts            # MurmurHash3 32-bit x86, 64-bit BigInt, getShardId
│   ├── hash-router.ts           # HashShardRouter (Single-shard vs scatter-gather)
│   ├── consistent-hash-ring.ts  # ConsistentHashRing (150 vnodes, Discord bucket key, RF=3)
│   └── compound-partition.ts   # CompoundPartitionManager (Postgres 2-level DDL & pruning)
├── tests/
│   └── db-sharding.test.ts      # 20 comprehensive unit tests & distribution benchmarks
├── tsup.config.ts               # Dual CJS/ESM + DTS bundler
└── package.json                 # Zero runtime dependencies
```

## 3. Verification Commands
```bash
bun test packages/db-sharding
pnpm --filter @kido/db-sharding build
```
