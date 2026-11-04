# @kido/resilient-cache

Bộ Cache 3 tầng chịu lỗi cao (High-Resilience) với Circuit Breaker (CLOSED / OPEN / HALF_OPEN), In-Flight Request Deduplication và cơ chế Fail-Open tự phục hồi cho hệ thống microservice & high-load API.

## Kiến Trúc 3 Tầng (3-Tier Architecture)

```
Incoming Requests (e.g. 100 concurrent)
       │
       ▼
┌──────────────────────────────────────────────┐
│  Tier 1: L1 Memory Cache (Local RAM, TTL)    │ ───► HIT (sub-millisecond)
└──────────────────────────────────────────────┘
       │ Miss
       ▼
┌──────────────────────────────────────────────┐
│  Tier 2: L2 Remote Cache (Redis/Memcached)   │ ───► HIT (1-2ms)
│  (Guarded by Circuit Breaker)                │
└──────────────────────────────────────────────┘
       │ Miss OR L2 Down (Fail-Open)
       ▼
┌──────────────────────────────────────────────┐
│  Tier 3: Origin Fetcher (DB / Slow 3rd Party)│
│  (Guarded by In-Flight Deduplication)        │ ───► 1 Single Query (99 collapsed)
└──────────────────────────────────────────────┘
```

## Tính Năng Cốt Lõi

1. **In-Flight Request Deduplication**:
   - Khi 50 request cùng lúc đòi dữ liệu cho cùng 1 key chưa có trong cache, chỉ đúng **1 query fetcher** được thực thi.
   - 49 request còn lại chờ chung một Promise và nhận cùng kết quả, triệt tiêu hoàn toàn thảm họa sập DB (Thundering Herd / Cache Stampede).

2. **Circuit Breaker Tích Hợp (Fail-Open)**:
   - Trạng thái: `CLOSED` -> `OPEN` -> `HALF_OPEN`.
   - Khi L2 (Redis / Memcached) gặp lỗi liên tiếp vượt ngưỡng (`failureThreshold`), circuit breaker chuyển sang `OPEN`.
   - Ở trạng thái `OPEN`, cache tự động bypass L2 và gọi thẳng origin fetcher mà **không làm sập ứng dụng**.
   - Hết thời gian chờ (`resetTimeoutMs`), tự chuyển sang `HALF_OPEN` để thăm dò probe. Khi L2 phục hồi, tự động chuyển về `CLOSED`.

3. **L1 Memory Cache với TTL**:
   - Lưu trữ trực tiếp trong bộ nhớ tiến trình Node/Bun để phục vụ phản hồi cực nhanh.
   - Tự động backfill từ L2 sang L1 khi L2 hit.

## Cài Đặt

```bash
pnpm add @kido/resilient-cache
```

## Hướng Dẫn Sử Dụng

### Cơ Bản: In-Memory Cache với In-Flight Deduplication

```ts
import { ResilientCache } from '@kido/resilient-cache';

const cache = new ResilientCache<{ id: string; name: string }>({
  l1TtlMs: 60_000, // 1 phút
});

// Sử dụng getOrSet
const user = await cache.getOrSet('user:101', async () => {
  return await db.users.findUnique({ where: { id: 101 } });
});
```

### Nâng Cao: Tích Hợp Redis L2 với Circuit Breaker

```ts
import { ResilientCache, type CacheAdapter } from '@kido/resilient-cache';
import Redis from 'ioredis';

const redis = new Redis('redis://localhost:6379');

const redisAdapter: CacheAdapter<any> = {
  get: async (key) => {
    const raw = await redis.get(key);
    return raw ? JSON.parse(raw) : null;
  },
  set: async (key, val, ttlMs) => {
    const str = JSON.stringify(val);
    if (ttlMs) {
      await redis.set(key, str, 'PX', ttlMs);
    } else {
      await redis.set(key, str);
    }
  },
  delete: async (key) => {
    await redis.del(key);
  },
};

const productCache = new ResilientCache({
  name: 'ProductCatalog',
  l1TtlMs: 15_000,   // L1: 15s trong RAM
  l2TtlMs: 300_000,  // L2: 5m trong Redis
  l2Adapter: redisAdapter,
  circuitBreaker: {
    failureThreshold: 3,     // Lỗi 3 lần -> OPEN
    resetTimeoutMs: 10_000,  // Chờ 10s -> HALF_OPEN
    successThreshold: 2,     // 2 lần probe thành công -> CLOSED
  },
  onError: (err, op, key) => {
    console.error(`[Cache Error] Op=${op} Key=${key}:`, err);
  },
});
```

### Kiểm Tra Thống Kê (Telemetry & Stats)

```ts
const stats = productCache.getStats();
console.log(stats);
// {
//   l1Hits: 1250,
//   l2Hits: 340,
//   misses: 45,
//   fetches: 45,
//   inFlightSaves: 210,
//   circuitState: 'CLOSED'
// }
```
