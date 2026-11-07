# Package Directives: @kido/hot-counter

> **Scope**: Tier-1 High-Concurrency Hot-Key Counter, Write Coalescing & Slotted Sharded Counter Architecture.  
> **Standards Reference**: Designing Data-Intensive Applications (DDIA Chapter 6 & High-Concurrency Write Architectures).

## 1. Core Invariants & Boundaries
1. **Zero External Runtime Dependencies**: Pure TypeScript. Works with standard `Map`, `Array`, `TextEncoder`, `Math.imul`, and standard Redis/Valkey client interface or built-in in-memory atomic simulator.
2. **Zero Lost Updates Invariant**:
   - In `MicroBatchCoalescer`: If a database flush executor throws an error, extracted batch deltas MUST be merged back into the pending Map so no client increments are ever lost.
   - In `ValkeyWriteBehindCounter`: If database write fails after Lua drain, deltas MUST be restored back into Valkey via `HINCRBY`.
3. **Atomic Lua Drain**: Never perform naive `HGETALL` followed by `DEL` across two separate network round-trips. Always execute `LUA_ATOMIC_DRAIN_HASH` atomically on Valkey's single thread.
4. **Zero Overselling Invariant**: Flash sale bounded reservations must execute atomic compare-and-decrement checks in Lua (`LUA_BOUNDED_STOCK_RESERVE`) or PostgreSQL CTE with `FOR UPDATE SKIP LOCKED`. Stock MUST NEVER drop below 0 (`< 0`).
5. **16-Slot Lock Distribution**: `SlottedCounter` distributes physical row locks across 16 child rows, reducing PostgreSQL tuple lock contention by 16x.
6. **SQL Injection Safety**: All table names, column names, and values are strictly quoted or parameterized ($1, $2, ...).

## 2. Directory Layout
```
packages/hot-counter/
├── src/
│   ├── index.ts                  # Unified public exports
│   ├── micro-batch-coalescer.ts  # Pattern #1: RAM Map<string, number> Coalescer + Single SQL VALUES (...) Batch UPDATE
│   ├── valkey-write-behind.ts    # Pattern #2: Valkey/Redis HINCRBY Write-Behind + Atomic Lua Drain & Bounded Stock Gate
│   └── slotted-counter.ts        # Pattern #3: 16-Slot Sharded Counter (Unbounded + Bounded Anti-Oversell Inventory Fallback)
├── tests/
│   └── hot-counter.test.ts       # 15 comprehensive unit tests + 10,000-op concurrency & SQL compression benchmarks
├── tsup.config.ts
├── tsconfig.json
├── package.json
├── README.md
└── AGENTS.md
```

## 3. Verification Commands
```bash
bun test packages/hot-counter
node --test packages/hot-counter/tests/hot-counter.test.ts
```
