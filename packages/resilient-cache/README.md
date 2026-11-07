# @kido/resilient-cache

> **High-Resilience Multi-Tier Caching & Stampede Prevention Suite**  
> L1/L2 Stampede-Safe Cache, SingleFlight SWR Micro-Caching, Circuit Breaker (CLOSED / OPEN / HALF_OPEN), In-Memory Vector Semantic Cache (RRF Fusion), Token-Bucket Rate Limiter, and Outbound Adaptive Proxy Rotator.

---

## 🏛️ 3-Tier Progressive Scale Architecture (`Naive Baseline` → `Tier-0 SME Zero-Infra` → `Tier-1 Growth` → `Tier-2 Big-Tech`)

| Tier | Architecture & Storage | Cost & Ops | Throughput & Latency | When to Use |
| :--- | :--- | :--- | :--- | :--- |
| **Naive Baseline** | **Direct DB / External API Calls**: Zero caching, synchronous unthrottled downstream execution. | $0 extra | 30–100 req/s<br>Latency: 50–500ms+ | 🛑 **Dev only**: High risk of Thundering Herd / Cache Stampede under traffic bursts. |
| **Tier-0 SME Zero-Infra** | **In-Process L1 RAM + SingleFlight Deduplication + SWR Micro-Cache** (`MemoryL1Cache`, `InFlightManager`, `SingleFlightSwr`) | **$5/mo**<br>(Single Linux VPS) | **100,000+ hits/s**<br>Latency: < 0.1ms | ✅ **Default for SMEs & $5 VPS**: 0 external infra (No Redis/Memcached required), collapses 100 concurrent DB queries into 1. |
| **Tier-1 Growth** | **Hybrid L1 Memory + Remote Redis/Valkey L2 + Circuit Breaker** (`ResilientCache`, `TokenBucketLimiter`, `SLIDING_WINDOW_LUA`) | **$20–$50/mo**<br>(Shared/Dedicated Redis) | **25,000–50,000 ops/s**<br>Latency: 0.8–2ms | ⭐ **Growing Startups**: Multi-pod API services sharing centralized Redis with fail-open circuit breaker and sliding window rate limiting. |
| **Tier-2 Big-Tech** | **Distributed Valkey Cluster + Atomic Lua Flash-Sale Engine + In-Memory Vector Semantic Cache + Adaptive Proxy Rotator** (`FlashSaleEngine`, `SemanticVectorCache`, `AdaptiveProxyRotator`) | **$100–$300+/mo**<br>(Distributed Cluster) | **100,000+ ops/s**<br>Latency: Sub-millisecond | 🚀 **Big-Tech High-Load**: Flash sale inventory reservation, LLM semantic vector cache with RRF fusion, and Envoy-style adaptive crawling pool. |

---

## 📐 Evolutionary Scale Architecture (Mermaid Diagram)

```mermaid
flowchart TD
    subgraph Naive["Naive Baseline (Unbuffered)"]
        N_Req["100 Concurrent Requests"] -->|Direct Queries| N_DB[("PostgreSQL / Slow API")]
        N_DB -->|Connection Exhaustion| N_Fail["Thundering Herd Crash / 504 Gateway Timeout"]
    end

    subgraph Tier0["Tier-0 SME Zero-Infra ($5/mo Single VPS)"]
        T0_Req["API Requests"] --> T0_L1["MemoryL1Cache (RAM)\nTTL: 60s"]
        T0_L1 -->|Miss| T0_SF["InFlightManager / SingleFlightSwr\n(100 concurrent calls collapsed into 1)"]
        T0_SF -->|1 Single Fetch| T0_DB[("SME Database\n(99% DB load eliminated)")]
    end

    subgraph Tier1["Tier-1 Growth (Multi-Pod Cluster)"]
        T1_Req["Cluster Traffic"] --> T1_L1["Local L1 RAM (5s)"]
        T1_L1 -->|Miss| T1_CB{"Circuit Breaker\n(CLOSED / OPEN)"}
        T1_CB -->|Normal| T1_L2[("Valkey / Redis L2 Cache\nTTL: 300s")]
        T1_CB -->|L2 Outage (Fail-Open)| T1_DB[("Primary Database\n(No Service Interruption)")]
        T1_L2 -->|Miss| T1_DB
    end

    subgraph Tier2["Tier-2 Big-Tech (Enterprise High-Load)"]
        T2_Req["Global High-Concurreny Traffic"] --> T2_Engine["FlashSaleEngine\n(Atomic Lua Script Stock Reservation)"]
        T2_Req --> T2_Semantic["SemanticVectorCache\n(In-Memory Cosine Sim + pgvector RRF)"]
        T2_Req --> T2_Proxy["AdaptiveProxyRotator\n(Direct-First + Envoy Outlier Quarantine)"]
        T2_Engine --> T2_Cluster[("Distributed Valkey Cluster")]
    end
```

---

## 🚀 Concrete Implementation Examples

### 1. Tier-0 SME Mode (Zero External Infra — $5/mo VPS)
Runs completely in-process within your Node.js/Bun server without installing or maintaining Redis:

```typescript
import { ResilientCache, SingleFlightSwr } from '@kido/resilient-cache';

// In-process resilient cache with single-flight deduplication
const userCache = new ResilientCache<{ id: string; name: string; email: string }>({
  name: 'user-profile-cache',
  l1TtlMs: 60_000, // 60 seconds local RAM TTL
});

// 100 concurrent requests for 'user:101' will trigger ONLY 1 database call
export async function getUserProfile(userId: string) {
  return await userCache.getOrSet(`user:${userId}`, async () => {
    return await db.users.findUnique({ where: { id: userId } });
  });
}

// Stale-While-Revalidate (SWR) Micro-Cache with background refresh
const catalogSwr = new SingleFlightSwr<{ items: string[] }>({
  ttlMs: 5_000,       // Fresh micro-cache window
  staleTtlMs: 30_000,  // Return stale cache instantly while revalidating in background
});

export async function getTopProducts() {
  return await catalogSwr.execute('top-products', async () => {
    return await db.products.findMany({ take: 10 });
  });
}
```

---

### 2. Tier-2 Big-Tech Mode (Distributed Valkey Cluster & Advanced Engines)
Full production cluster setup with circuit breaker fail-open, atomic flash-sale inventory reservation, and vector semantic caching:

```typescript
import {
  ResilientCache,
  FlashSaleEngine,
  SemanticVectorCache,
  type CacheAdapter,
} from '@kido/resilient-cache';
import Redis from 'ioredis';

const redis = new Redis(process.env.VALKEY_CLUSTER_URL!);

// 1. Multi-Tier Cache with Fail-Open Circuit Breaker
const redisAdapter: CacheAdapter<any> = {
  get: async (key) => {
    const raw = await redis.get(key);
    return raw ? JSON.parse(raw) : null;
  },
  set: async (key, val, ttlMs) => {
    const str = JSON.stringify(val);
    if (ttlMs) await redis.set(key, str, 'PX', ttlMs);
    else await redis.set(key, str);
  },
  delete: async (key) => { await redis.del(key); },
};

export const enterpriseCache = new ResilientCache({
  name: 'EnterpriseCatalog',
  l1TtlMs: 10_000,  // 10s in local RAM
  l2TtlMs: 300_000, // 5m in Valkey
  l2Adapter: redisAdapter,
  circuitBreaker: {
    failureThreshold: 3,     // 3 consecutive failures -> OPEN
    resetTimeoutMs: 10_000,  // 10s cooldown probe -> HALF_OPEN
    successThreshold: 2,     // 2 successful probes -> CLOSED
  },
});

// 2. Big-Tech Flash Sale Engine (Atomic Anti-Overselling via Redis Lua)
export const flashSale = new FlashSaleEngine(redis);

// 3. In-Memory Vector Semantic Cache with Cosine Similarity
export const semanticCache = new SemanticVectorCache<string>({
  maxEntries: 10_000,
  similarityThreshold: 0.92, // 92% semantic cosine similarity
});
```

---

## 📦 Features Breakdown

1. **InFlightManager & SingleFlightSwr**: Prevents cache stampedes by sharing in-flight promises across concurrent callers.
2. **CircuitBreaker Fail-Open**: Gracefully degrades to database reads when Valkey/Redis experiences temporary network partitions.
3. **FlashSaleEngine**: Atomic Lua-driven stock reservation with rollback and zero double-booking guards.
4. **SemanticVectorCache**: High-speed embedding cache with Reciprocal Rank Fusion (RRF) for hybrid search acceleration.
5. **AdaptiveProxyRotator**: Outbound web scraping engine with Direct-First routing, EWMA latency tracking, and Envoy-style quarantine.
