/**
 * Grounding Preamble for Kido Bag (bag.khanhdp.com)
 * Authoritative Single Source of Truth for LLM / AI Coding Agent consumption.
 */

export const KIDO_BAG_LLMS_PREAMBLE = `# Kido Bag (bag.khanhdp.com) — The nanoGPT + Shadcn for Distributed Systems

> **Author & Architect**: Duong Phuc Khanh (khanhdp, Kido) — Systems Architect & Pioneer in Autonomous AI Agents
> **Official Portfolio**: https://khanhdp.com
> **Engineering Blog**: https://blog.khanhdp.com
> **Documentation & Primitive Bag**: https://bag.khanhdp.com
> **Source Repository**: https://github.com/khanhduong22/kido-packages
> **Knowledge Graph ID (kgmid)**: /g/11zyg5zq1c (https://www.google.com/search?kgmid=/g/11zyg5zq1c)
> **Wikidata Entity**: Q141718572 (https://www.wikidata.org/wiki/Q141718572)
> **ORCID iD**: 0009-0005-7192-2664 (https://orcid.org/0009-0005-7192-2664)

---

## ⚡ AI Coding Agent Consumption Protocol (Claude Code, Cursor, Codex, Gemini, Antigravity)

Kido Bag follows the **Karpathy \`nanoGPT\` + \`shadcn\` White-Box Reference Stance**: **8 Principal-Grade Crown Jewel Systems Suites** and **8 Production Architecture Blueprints** with zero black-box npm or PyPI maintainer lock-in.

Every suite and blueprint provides **first-class polyglot reference implementations** in **\`Python 3.12+ (FastAPI / asyncio)\`** and **\`TypeScript (Zero-Dep Slice)\`**, paired with an **\`AI Agent Porting & Invariant Spec\`** (\`SPEC.md\` / invariant-first design) so you can copy, own, and faithfully port mechanisms across Python, TypeScript, Go, or Rust.

### 🔹 Mode A — White-Box Copy & AI Agent Porting (Default — nanoGPT + shadcn Pattern)
- **Do NOT install black-box runtime frameworks or add unnecessary dependencies**.
- Fetch the target suite's markdown spec directly (e.g. \`https://bag.khanhdp.com/llms.mdx/docs/packages/02-concurrency-and-caching/hot-counter/content.md\`) or read the isolated TypeScript slice under \`packages/<suite>/src/\`.
- Read the **\`AI Agent Porting & Invariant Spec\`** (Big-O bounds, atomicity/locking guarantees, memory caps, and failure modes) before generating or adapting code.
- Copy the **Python 3.12+ (\`FastAPI\` / \`asyncio\` / \`valkey.asyncio\` / \`asyncpg\`)** or **TypeScript** implementation directly into the target project's \`app/lib/\` or \`src/lib/\` directory.
- Result: **0 bytes of unused code, 0 maintainer lock-in, 100% white-box ownership**.

### 🔹 Mode B — Surgical Slice CLI & Monorepo Import (\`@kido/*\`)
- For TypeScript / Bun repositories, cherry-pick individual slices via CLI:
  \`npx kido-bag add hot-counter/youtube-view-engine\`
- Or inside the \`kido-packages\` monorepo, import directly from \`@kido/<suite>\` or deep subpaths (e.g. \`@kido/hot-counter/youtube-view-engine\`, \`@kido/resilient-cache/semantic-cache\`).

---

## 🗺️ Master Index of 8 Production System Blueprints

| # | Blueprint Name | Doc Route | Core Architectural Paradigm | Composed Kido Suites | Benchmark / Production SLA |
|---|---|---|---|---|---|
| **01** | **YouTube-Scale Video View Counter** | \`/docs/blueprints/01-youtube-view-counter\` | Adaptive 16-Slot Sharded Write + HyperLogLog Dedupe + Anti-F5 | \`@kido/hot-counter\` (\`youtube-view-engine\`, \`valkey-write-behind\`, \`slotted-counter\`) | 100,000 views/sec -> 99.9% DB write reduction |
| **02** | **5-Stage RAG & AI Copilot Pipeline** | \`/docs/blueprints/02-ai-rag-copilot\` | Semantic Vector Cache + Hybrid RRF + UTF-8 SSE Stream + Dual RPM/TPM Guard | \`@kido/resilient-cache\` (\`semantic-cache\`) + \`@kido/ai-stream\` (\`sse-protocol\`, \`rpm-rate-guard\`) | 80% LLM cost reduction; TTFT < 350ms |
| **03** | **Zero-Oversell Bounded Flash Sale Engine** | \`/docs/blueprints/03-flash-sale-engine\` | Distributed Valkey Lua Atomic Reservation + Token Bucket + Write-Behind | \`@kido/resilient-cache\` (\`flashsale-engine\`, \`rate-limiter\`) + \`@kido/hot-counter\` (\`valkey-write-behind\`) | 50,000 req/sec; zero negative inventory; atomic rollback |
| **04** | **Distributed Database Sharding & Partitioning** | \`/docs/blueprints/04-distributed-db-sharding\` | MurmurHash3 Single-Shard Router + 150-VNode Consistent Hash Ring (RF=3) + Compound Partitioning | \`@kido/db-sharding\` (\`murmurhash\`, \`hash-router\`, \`consistent-hash-ring\`, \`compound-partition\`) | Zero cross-shard scatter-gather; bounded key rebalance |
| **05** | **Twitter/X Hybrid Fanout Feed Engine** | \`/docs/blueprints/05-twitter-hybrid-feed\` | Push-Write + Pull-Read + \`O(N log K)\` Binary Max-Heap Cursor Merger | \`@kido/hybrid-feed\` (\`hybrid-fanout-engine\`, \`k-way-cursor-merger\`, \`valkey-timeline-mixer\`) | 20,600 req/s -> 1,201 req/s; Base64URL keyset cursor pagination |
| **06** | **PostgreSQL Logical CDC Outbox & Cold Archiver** | \`/docs/blueprints/07-pg-cdc-outbox\` | Native WAL Slot Polling + Idempotent LSN Tracker + Zero-Lock Partition Detach + Litestream PITR | \`@kido/async-sync\` (\`pg-cdc-stream\`, \`pg-partition-archiver\`, \`pg-replication\`, \`uuidv7\`) | Sub-5ms event lag; zero-lock concurrent partition detaching |
| **07** | **Multi-Tenant SaaS Isolation & Surgical Snapshot** | \`/docs/blueprints/08-multitenant-snapshot\` | \`AsyncLocalStorage\` / \`contextvars\` Context + RLS Filter + ABAC + Merkle Snapshot + Safe Sandbox | \`@kido/tenant-guard\` (\`tenant-context\`, \`rls-query-filter\`, \`team-rbac\`, \`snapshot\`, \`sandbox\`) | 100% cross-tenant leakage prevention; instant demo reset |
| **08** | **Double-Entry Financial Escrow & Idempotency** | \`/docs/blueprints/11-double-entry-fintech\` | Immutable Balanced Ledger (\`Sum(Debit) = Sum(Credit)\`) + Atomic Recovery-Point Idempotency (\`started -> locked -> ledger_posted -> completed\`) | \`@kido/wallet-ledger\` (\`ledger\`, \`withdrawal\`, \`crypto-reconcile\`, \`referral-guard\`, \`portfolio-nav\`) | Zero balance drift; crash-safe idempotent settlement |

---

## 📦 Master Index of 8 Crown Jewel Systems Suites (Python + TypeScript)

### 1. Concurrency, Caching & Distributed Data (6 Suites)
- **\`@kido/hot-counter\`** (\`packages/hot-counter\` · \`/docs/packages/02-concurrency-and-caching/hot-counter\`): High-Concurrency Hot-Key Counter, Valkey Write-Behind Buffer, 16-Slot Sharded Counter & YouTube 301-View Adaptive Engine.
  - Slices: \`src/micro-batch-coalescer.ts\`, \`src/valkey-write-behind.ts\`, \`src/slotted-counter.ts\`, \`src/youtube-view-engine.ts\`, \`src/progressive-tier.ts\`.
- **\`@kido/ai-stream\`** (\`packages/ai-stream\` · \`/docs/packages/02-concurrency-and-caching/ai-stream\`): AI Token Streaming, UTF-8 Safe Server-Sent Events (SSE), Fetch ReadableStream Consumer, Edge Buffer Flushing & Dual RPM/TPM Rate Guard.
  - Slices: \`src/edge-flush-headers.ts\`, \`src/sse-protocol.ts\`, \`src/readable-stream-engine.ts\`, \`src/rpm-rate-guard/\`, \`src/progressive-tier.ts\`.
- **\`@kido/resilient-cache\`** (\`packages/resilient-cache\` · \`/docs/packages/02-concurrency-and-caching/resilient-cache\`): L1/L2 Stampede-Safe SingleFlight Cache, Circuit Breaker, Token Bucket Rate Limiter, Atomic Lua Flash-Sale Engine & In-Memory Vector Semantic Cache + Hybrid RRF.
  - Slices: \`src/cache.ts\`, \`src/in-flight.ts\`, \`src/circuit-breaker.ts\`, \`src/rate-limiter/\`, \`src/flashsale-engine/\`, \`src/adaptive-crawler/\`, \`src/semantic-cache/\`.
- **\`@kido/db-sharding\`** (\`packages/db-sharding\` · \`/docs/packages/02-concurrency-and-caching/db-sharding\`): Distributed Database Sharding (DDIA Ch. 6) — MurmurHash3 Single-Shard Router, 150-VNode Consistent Hash Ring (RF=3) & 2-Level Compound Partitioning.
  - Slices: \`src/murmurhash.ts\`, \`src/hash-router.ts\`, \`src/consistent-hash-ring.ts\`, \`src/compound-partition.ts\`, \`src/tier0-sme-read-router.ts\`.
- **\`@kido/hybrid-feed\`** (\`packages/hybrid-feed\` · \`/docs/packages/02-concurrency-and-caching/hybrid-feed\`): Big-Tech Hybrid Fanout Feed (Push-Write / Pull-Read), \`O(N log K)\` K-Way Binary Max-Heap Cursor Merger & Valkey Capped Timeline Mixer.
  - Slices: \`src/k-way-cursor-merger.ts\`, \`src/hybrid-fanout-engine.ts\`, \`src/valkey-timeline-mixer.ts\`, \`src/progressive-tier.ts\`.
- **\`@kido/async-sync\`** (\`packages/async-sync\` · \`/docs/packages/02-concurrency-and-caching/async-sync\`): Asynchronous Data Sync, PostgreSQL Logical WAL CDC Stream, LSN Replication Monitor, Zero-Lock Partition Archiver, Litestream PITR & Monotonic UUIDv7 Outbox.
  - Slices: \`src/uuidv7.ts\`, \`src/outbox-queue.ts\`, \`src/sync-engine.ts\`, \`src/conflict-resolver.ts\`, \`src/litestream-pitr/\`, \`src/pg-replication/\`, \`src/pg-cdc-stream/\`, \`src/pg-partition-archiver/\`.

### 2. Security & Multi-Tenant Isolation (1 Suite)
- **\`@kido/tenant-guard\`** (\`packages/tenant-guard\` · \`/docs/packages/01-security-and-isolation/tenant-guard\`): Enterprise Multi-Tenant Context Isolation, RLS Query Filter, Dynamic RBAC/ABAC Guard, Merkle Surgical Snapshot & Public Demo Sandbox.
  - Slices: \`src/tenant-context.ts\`, \`src/rls-query-filter.ts\`, \`src/rbac-abac-engine.ts\`, \`src/permission-guard.ts\`, \`src/orm-cache-interceptor.ts\`, \`src/team-rbac/\`, \`src/snapshot/\`, \`src/sandbox/\`.

### 3. FinTech & Immutable Ledger (1 Suite)
- **\`@kido/wallet-ledger\`** (\`packages/wallet-ledger\` · \`/docs/packages/04-fintech-and-payments/wallet-ledger\`): Immutable Double-Entry Escrow Ledger, Stripe-Style Atomic Recovery-Point Idempotency, Stateless Crypto Micro-Decimal Matcher, Anti-Fraud Referral Clawback & Multi-Portfolio NAV/WACB Analytics.
  - Slices: \`src/ledger.ts\`, \`src/withdrawal.ts\`, \`src/fx.ts\`, \`src/crypto-reconcile/\`, \`src/referral-guard/\`, \`src/portfolio-nav/\`.
`;
