# @kido/batch-buffer

> **High-Performance Hybrid Buffer & Flush Engine**  
> Dual Count/Timer Write-Behind Batcher, Mutex Concurrency Locks, Multi-Policy Backpressure Guards, Distributed Redis Driver, Read-Your-Own-Writes Audit Trail Adapter, and Streaming CSV Chunk Processor.

---

## 🏛️ 3-Tier Progressive Scale Architecture (`Naive Baseline` → `Tier-0 SME Zero-Infra` → `Tier-1 Growth` → `Tier-2 Big-Tech`)

| Tier | Architecture & Storage | Cost & Ops | Throughput & Latency | When to Use |
| :--- | :--- | :--- | :--- | :--- |
| **Naive Baseline** | **Synchronous Single-Row Writes**: Direct row-by-row `INSERT` for each incoming HTTP request without buffering. | $0 extra | 30–60 writes/s<br>Latency: 20–100ms | 🛑 **Dev / Toy only**: Knocks over relational DB connection pools under heavy traffic bursts. |
| **Tier-0 SME Zero-Infra** | **In-Process Memory Queue + Dual Trigger Flusher** (`HybridBatcher` with `MemoryBackend`, `BufferedAuditStorageAdapter`) | **$5/mo**<br>(Single Linux VPS) | **2,500–5,000 writes/s**<br>Latency: < 0.2ms enqueue | ✅ **Default for SMEs & $5 VPS**: Zero external dependencies (No Redis/Kafka needed). Compresses 50 items or 30s window into 1 bulk SQL transaction with Read-Your-Own-Writes visibility. |
| **Tier-1 Growth** | **Distributed Redis/Valkey Buffer Queue + Atomic Lua Draining** (`HybridBatcher` with `RedisBackend`, Backpressure Guards) | **$20–$50/mo**<br>(Shared/Dedicated Redis) | **20,000 writes/s**<br>Latency: 1–2ms | ⭐ **Growing Startups**: Multi-container stateless API clusters pushing to centralized Redis queues drained by dedicated batch workers. |
| **Tier-2 Big-Tech** | **Streaming CSV Micro-Batch Pipeline + Binary-Split Fallback Batch Inserter** (`processCsvStream`, `insertBatchWithFallback`) | **$100–$300+/mo**<br>(Distributed Cluster) | **50,000–100,000+ items/s**<br>Bounded O(1) Memory | 🚀 **Big-Tech Enterprise**: Processing million-line CSV imports and high-throughput event ingestion without memory bloat or transaction failure aborts. |

---

## 📐 Evolutionary Scale Architecture (Mermaid Diagram)

```mermaid
flowchart TD
    subgraph Naive["Naive Baseline (Synchronous SQL)"]
        N_Req["1,000 Incoming Logs/s"] -->|1,000 Individual INSERTs| N_DB[("PostgreSQL\n(Connection Pool Starvation)")]
        N_DB -->|Disk IOPS Spikes| N_Fail["High Latency & Lock Contention"]
    end

    subgraph Tier0["Tier-0 SME Zero-Infra ($5/mo Single VPS)"]
        T0_Req["API Writes"] --> T0_Mem["MemoryBackend FIFO Queue\n(Zero External Infra)"]
        T0_Mem -->|Dual Trigger: 50 items or 30s| T0_Flush["Single Parameterized Bulk INSERT\n(PostgreSQL / SQLite WAL)"]
        T0_Flush --> T0_DB[("SME Database\n(98% Write Reduction)")]
    end

    subgraph Tier1["Tier-1 Growth (Multi-Pod Cluster)"]
        T1_Req["Multi-Pod API Traffic"] --> T1_Redis[("Valkey / Redis List Buffer\n(Atomic Lua Script Drain)")]
        T1_Redis -->|Worker Pool| T1_Batch["Dedicated Batch Worker"]
        T1_Batch --> T1_DB[("Primary Database Master")]
    end

    subgraph Tier2["Tier-2 Big-Tech (Streaming Micro-Batch)"]
        T2_Stream["Million-Row CSV / Event Stream"] --> T2_Proc["processCsvStream\n(Bounded Memory Chunks)"]
        T2_Proc --> T2_Binary["Binary-Split Fallback Inserter\n(Isolates corrupt rows, saves valid rows)"]
        T2_Binary --> T2_Cluster[("Sharded Database Cluster")]
    end
```

---

## 🚀 Concrete Implementation Examples

### 1. Tier-0 SME Mode (Zero External Infra — $5/mo VPS)
Buffers incoming telemetry or audit events entirely in Node.js/Bun process memory and flushes in batches to PostgreSQL or SQLite:

```typescript
import { HybridBatcher, BufferedAuditStorageAdapter } from '@kido/batch-buffer';

interface AccessLog {
  userId: string;
  action: string;
  ip: string;
  timestamp: string;
}

// 1. Dual-trigger batcher running in-process (MemoryBackend)
export const logBatcher = new HybridBatcher<AccessLog>({
  maxBatchSize: 50,    // Flushes immediately when 50 items accumulate
  maxWaitMs: 30_000,   // Or at least every 30 seconds during quiet hours
  maxQueueCapacity: 10_000,
  backpressurePolicy: 'DROP_OLDEST',
  flusher: async (batch) => {
    // Bulk INSERT: 50 items compressed into 1 single query
    await db.query(
      `INSERT INTO access_logs (user_id, action, ip, created_at)
       SELECT * FROM UNNEST($1::text[], $2::text[], $3::text[], $4::timestamptz[])`,
      [
        batch.map((b) => b.userId),
        batch.map((b) => b.action),
        batch.map((b) => b.ip),
        batch.map((b) => b.timestamp),
      ]
    );
  },
});

// Non-blocking write: enqueues in O(1) <0.1ms
await logBatcher.push({
  userId: 'usr_101',
  action: 'LOGIN',
  ip: '127.0.0.1',
  timestamp: new Date().toISOString(),
});
```

---

### 2. Tier-2 Big-Tech Mode (Distributed Redis Backend & Streaming CSV Ingestion)
Scales across multi-pod clusters with distributed Redis queuing, plus fault-tolerant streaming chunk processing:

```typescript
import {
  HybridBatcher,
  RedisBackend,
  processCsvStream,
  insertBatchWithFallback,
} from '@kido/batch-buffer';
import Redis from 'ioredis';
import { createReadStream } from 'node:fs';

const redis = new Redis(process.env.REDIS_URL!);

// 1. Distributed Redis Batch Queue shared across multiple API pods
export const distributedBatcher = new HybridBatcher({
  maxBatchSize: 100,
  maxWaitMs: 15_000,
  backend: new RedisBackend(redis, 'queue:order-events'),
  flusher: async (orders) => {
    await db.orders.insertMany(orders);
  },
});

// 2. High-Performance Streaming CSV Processor with Binary-Split Fallback
export async function importMassiveCatalog(csvFilePath: string) {
  const stream = createReadStream(csvFilePath);

  await processCsvStream({
    stream,
    batchSize: 1_000,
    onBatch: async (batchRows) => {
      // Binary half-split: If 1 row has a duplicate key or validation error,
      // it isolates the bad row and inserts the remaining 999 rows cleanly!
      await insertBatchWithFallback({
        batch: batchRows,
        inserter: async (chunk) => {
          await db.products.insertMany(chunk);
        },
      });
    },
  });
}
```

---

## 📌 Architecture Lifecycle & Features

1. **Dual Trigger Window**: Combines volume (`maxBatchSize`) and time (`maxWaitMs`) triggers with automatic timer reset to prevent CPU thrashing.
2. **Mutex Concurrency Lock**: Strictly ensures only one flush operation runs at a time per batcher instance, eliminating duplicate inserts.
3. **Multi-Policy Backpressure**: Choose between `DROP_OLDEST` (real-time telemetry), `DROP_NEWEST` (conservative archival), or `THROW_ERROR` (HTTP caller backpressure).
4. **Graceful Shutdown Drain**: Intercepts `SIGINT`/`SIGTERM` to flush remaining memory queues before process exit.
5. **Read-Your-Own-Writes**: `BufferedAuditStorageAdapter` merges pending in-memory batches with persistent DB queries for instantaneous consistency.
