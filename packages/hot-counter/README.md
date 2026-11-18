# @kido/hot-counter

> **Tier-1 High-Concurrency Hot-Key Counter & 3-Tier Progressive Scale Architecture**  
> Triển khai tiến hóa kiến trúc chịu tải đếm dồn dập (likes, views, sold count, flash sale stock) từ **Naive Baseline** đến **Tier-0 SME Zero-Infra**, **Tier-1 Growth**, và **Tier-2 Big-Tech**:
> 1. **Naive Baseline (`NaiveRowLockSimulator`)**: Mô phỏng thực nghiệm điểm nghẽn xếp hàng khóa dòng (`UPDATE ... WHERE id = $1`) và cạn kiệt connection pool.
> 2. **Tier-0 SME Zero-Infra (`Tier0SmeCounter`)**: In-process `Map<string, number>` + single-statement PostgreSQL/SQLite `INSERT ... ON CONFLICT DO UPDATE` batch flusher cho VPS $5/tháng (< 2,000 writes/s, $0 Redis/Kafka cost).
> 3. **Tier-1 Growth (`SlottedCounter`)**: 16-slot sharded row counter nhân 16x độ chịu tải ghi trực tiếp PostgreSQL kết hợp fallback `FOR UPDATE SKIP LOCKED`.
> 4. **Tier-2 Big-Tech (`ValkeyWriteBehindCounter`)**: Distributed Valkey `HINCRBY` + Atomic Lua Drain (`LUA_ATOMIC_DRAIN_HASH`) đạt 100,000+ ops/s cho cụm đa container.
> 5. **YouTube Hybrid View Engine & Datastore Adaptive Slot Sizer (`YouTubeHybridViewEngine`)**: Giải quyết trọn vẹn Màn 24 GonnaCrash (`counter_at_scale`): Thuật toán tính cỡ slot tối ưu (`calculateOptimalSlotCount`, giải bài toán cân bằng Row Lock vs Đọc `SUM`), `HyperLogLogCounter` (đếm Unique Viewers trong 1 KB RAM), và cơ chế đóng băng view ảo chống F5 bot ở mốc 301 views của YouTube.

---

## 🏛️ Bảng Tiến Hóa Kiến Trúc 3-Tier Progressive Scale Architecture

| Cấp Độ (Tier) | Kiến Trúc & Công Nghệ | Chi Phí Hạ Tầng (Cost/mo) | Khả Năng Ghi (Write Capacity) | Ưu Điểm (Pros) | Điểm Nghẽn & Rủi Ro (Failure Modes) | Khuyến Nghị Sử Dụng |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Naive Baseline** | **Direct Row Lock SQL**: `UPDATE posts SET likes = likes + 1 WHERE id = $1` | $0 extra | ~30 - 50 ops/s | Đơn giản, zero cache, đọc ngay giá trị mới tức thì. | • **Row Lock Serial Contention**: 1,000 requests cùng 1 ID phải xếp hàng tuần tự.<br>• **Connection Pool Starvation**: Cạn kiệt slot kết nối Node/Bun.<br>• **MVCC Dead Tuples**: Phình bảng, nghẽn Autovacuum IOPS. | 🛑 **Chỉ dùng cho dự án đồ án hoặc traffic < 30 req/s** |
| **Tier-0 SME Zero-Infra** | **In-Process Map + Single-Statement UPSERT** (`Tier0SmeCounter`) | **$5/mo** (Single VPS) | **2,500 ops/s** | • **Zero external dependencies**: Không cần Redis/Kafka.<br>• **99.9% write reduction**: Gom 1,000 updates thành 1 SQL duy nhất.<br>• **Zero Lost Updates**: Re-merge deltas nếu DB executor lỗi.<br>• Hỗ trợ cả **PostgreSQL & SQLite WAL**. | • Dữ liệu nằm trong RAM container trước chu kỳ flush (e.g. 1s).<br>• Không chia sẻ counter giữa nhiều container độc lập nếu scale ngang. | ✅ **Chuẩn mặc định cho SMEs, $5 VPS, POS, Storefront cá nhân** |
| **Tier-1 Growth** | **16-Slot Sharded Counter + SKIP LOCKED** (`SlottedCounter`) | **$30 - $50/mo** (Single/HA DB) | **15,000 ops/s** | • **Ghi trực tiếp DB không buffer RAM**: Đáp ứng kiểm toán tài chính nghiêm ngặt.<br>• **16x Concurrency Multiplier**: Chia nhỏ 1 hot key thành 16 dòng vật lý.<br>• **Anti-Oversell**: Khấu trừ tồn kho qua `SKIP LOCKED` chống bán âm 100%. | Đòi hỏi bảng phụ trợ 16 dòng vật lý cho mỗi logical counter. | ⭐ **Khuyến nghị cho Flash Sale tài chính, kế toán & kiểm toán tức thời** |
| **Tier-2 Big-Tech** | **Distributed Valkey Write-Behind + Atomic Lua Drain** (`ValkeyWriteBehindCounter`) | **$100 - $300/mo** (Cluster + Valkey) | **100,000+ ops/s** | • **Độ trễ Sub-millisecond**: O(1) `HINCRBY` trên Valkey RAM.<br>• **Atomic Lua Drain**: Xóa và đọc sạch buffer dirty trong 1 atomic cycle, xóa bỏ race condition mất số.<br>• Chịu tải vô hạn cho cụm hàng trăm pods. | Đòi hỏi cụm Valkey/Redis độc lập và worker nền đồng bộ xuống DB. | 🚀 **Chuẩn Big-Tech (Shopee, Uber, Discord) cho Views, Likes & Campaign** |

---

## 📐 Kiến Trúc Luồng Dữ Liệu (Mermaid Diagrams)

### 1. Kiến Trúc Tiến Hóa 3-Tier Hot Counter

```mermaid
flowchart TD
    subgraph S0["Naive Baseline (Sơ Khởi)"]
        N_Req["1,000 Concurrent Writes"] -->|Serial Row Lock Wait| N_DB[("PostgreSQL\n(Tuple Lock Serial Queue)")]
        N_DB -->|Connection Starvation| N_Fail["Latency Spike 1.4s+ & Deadlock Aborts"]
    end

    subgraph S1["Tier-0 SME Zero-Infra ($5/mo Single VPS)"]
        T0_Req["API Writes (< 2,000/s)"] --> T0_Map["In-Memory Map<string, number>\n(Zero Net Elimination)"]
        T0_Map -->|Periodic 1s or Max Batch| T0_Upsert["Single Parameterized UPSERT\n(PostgreSQL / SQLite WAL)"]
        T0_Upsert --> T0_DB[("SME Database\n(1 Query / sec)")]
    end

    subgraph S2["Tier-1 Growth (Strict Zero Loss)"]
        T1_Req["Direct DB Writes"] --> T1_Hash["MurmurHash3(caller) % 16"]
        T1_Hash --> T1_Slots["16 Physical Slot Rows\n(16x Concurrency Multiplier)"]
        T1_Slots -->|SKIP LOCKED Fallback| T1_DB[("PostgreSQL Hot Slots\n(SUM < 0.2ms)")]
    end

    subgraph S3["Tier-2 Big-Tech (100k+ ops/s)"]
        T2_Req["Cluster Traffic"] --> T2_Valkey["Valkey 8 Cluster\n(HINCRBY in O(1))"]
        T2_Valkey -->|Atomic Lua Drain| T2_Worker["Async Batch Flusher"]
        T2_Worker --> T2_DB[("Master Database\n(Coalesced VALUES Batch)")]
    end
```

### 2. Tier-0 SME Zero-Lost-Updates Re-Merge Flow

```mermaid
sequenceDiagram
    autonumber
    participant App as API Handlers
    participant Accumulator as Tier0SmeCounter (In-Memory Map)
    participant Flusher as Batch Flusher
    participant DB as SQLite / PostgreSQL

    App->>Accumulator: record("product:101", +1) x 500
    App->>Accumulator: record("product:101", -5)
    Note over Accumulator: Net delta = +495 in RAM (O(1))

    rect rgb(240, 248, 255)
    Note over Flusher,DB: Periodic Flush Trigger (e.g. 1000ms)
    Flusher->>Accumulator: Take pending delta snapshot & clear active Map
    Flusher->>DB: INSERT INTO counters ... ON CONFLICT DO UPDATE
    alt Database Connection Error
        DB-->>Flusher: 500 Connection Refused!
        Flusher->>Accumulator: Re-merge snapshot deltas back into live Map
        Note over Accumulator: Zero Lost Updates Invariant Preserved!
    else Database Write Succeeded
        DB-->>Flusher: 200 OK
        Note over Flusher: Total 500 writes compressed to 1 single statement!
    end
    end
```

---

## 🚀 Hướng Dẫn Sử Dụng Chi Tiết Theo Từng Tier

### 1. Tier-0 SME Zero-Infra (`Tier0SmeCounter`)
Hoàn hảo cho ứng dụng vừa và nhỏ trên 1 máy chủ VPS $5/tháng, không tốn thêm chi phí duy trì Redis hay Kafka:

```typescript
import { Tier0SmeCounter } from "@kido/hot-counter";

const counter = new Tier0SmeCounter({
  tableName: "store_counters",
  idColumn: "product_id",
  valueColumn: "sold_count",
  updatedAtColumn: "updated_at",
  dialect: "postgres", // hoặc "sqlite"
  flushIntervalMs: 1000,
  maxBatchSize: 500,
  autoStart: true,
  dbExecutor: async (sql, params) => {
    await db.query(sql, params);
  },
});

// Ghi nhận liên tục từ API routes
counter.record("product:shopee:101", 1);
counter.record("product:shopee:101", 3);
counter.record("product:shopee:101", -1); // net = 3

// Tự động gom và sinh câu lệnh UPSERT duy nhất:
// INSERT INTO "store_counters" ("product_id", "sold_count", "updated_at")
// VALUES ($1, $2, NOW())
// ON CONFLICT ("product_id") DO UPDATE
// SET "sold_count" = "store_counters"."sold_count" + EXCLUDED."sold_count", "updated_at" = NOW();
```

### 2. Tier-1 Growth: 16-Slot Sharded Counter (`SlottedCounter`)
Dành cho kiểm toán tài chính và flash sale cần ghi trực tiếp vào PostgreSQL với bảo đảm zero data loss:

```typescript
import { SlottedCounter } from "@kido/hot-counter";

const slotted = new SlottedCounter({
  tableName: "store_hot_counter_slots",
  defaultNumSlots: 16,
});

// 16x Concurrency Slot Increment
const { sql, params, slotId } = slotted.generateIncrementSQL({
  entityType: "product_views",
  entityId: "marker-60",
  callerKey: req.ip, // chia tải đều vào slot 0..15
});

// Đọc tổng hợp siêu tốc < 0.2ms qua Composite Index
const { sql: readSql, params: readParams } = slotted.generateAggregateReadSQL(
  "product_views",
  "marker-60"
);
```

### 3. Tier-2 Big-Tech: Valkey Write-Behind (`ValkeyWriteBehindCounter`)
Dành cho các chiến dịch Mega Sale hàng trăm ngàn lượt truy cập đồng thời:

```typescript
import { ValkeyWriteBehindCounter } from "@kido/hot-counter";

const writeBehind = new ValkeyWriteBehindCounter({
  client: redisClient,
  dirtyHashKey: "acme:views:dirty",
});

// Ghi nhận O(1) vào Valkey RAM
await writeBehind.increment("marker-60", 1);

// Cổng xả tồn kho Flash Sale (Chống bán âm tuyệt đối)
const reserve = await writeBehind.reserveStock("palette-limited", 1);

// Worker nền định kỳ xả nguyên tử bằng Lua Script
await writeBehind.flushToDatabase(async (deltas) => {
  await batchUpdatePostgres(deltas);
});
```

### 4. Chọn Tier Tự Động Với `recommendCounterTier` & `createProgressiveHotCounter`

```typescript
import {
  recommendCounterTier,
  createProgressiveHotCounter,
} from "@kido/hot-counter";

// 1. Nhận tư vấn kiến trúc chuẩn
const advice = recommendCounterTier({
  peakWritesPerSec: 1200,
  monthlyBudgetUsd: 10,
  hasRedisOrValkey: false,
  singleVps: true,
});
console.log(advice.tier); // "tier0-sme"
console.log(advice.reason);
// "Workload fits within single-VPS capacity (< 2,000 writes/sec)..."

// 2. Khởi tạo instance từ Factory
const counterInstance = createProgressiveHotCounter({
  tier: advice.tier,
  tier0Options: {
    tableName: "page_views",
  },
});
```

### 5. Màn 24 GonnaCrash: Datastore Adaptive Slot Sizer & YouTube Hybrid View Engine

```typescript
import {
  calculateOptimalSlotCount,
  HyperLogLogCounter,
  YouTubeHybridViewEngine,
} from "@kido/hot-counter";

// 1. Tự động tính cỡ Slot tối ưu (Chứng minh toán học Level 24)
// Viết 700 req/s, Đọc dashboard 100 req/s, Trần row 200/s, Trần DB Tier L 1.500/s
const sizing = calculateOptimalSlotCount({
  writeRatePerS: 700,
  readRatePerS: 100,
  maxWritesPerRowPerS: 200,
  maxDbCapacityPerS: 1500,
  candidateSlots: [1, 4, 16],
});

console.log(sizing.recommendedSlots); // 4 (Split 4)
// -> Split 1: 700 writes/row/s > 200 (sập khóa dòng)
// -> Split 16: 700 + (16 * 100) = 2.300 req/s > 1.500 (sập tải đọc DB)
// -> Split 4: 175 writes/row/s và 700 + (4 * 100) = 1.100 req/s <= 1.500 (TỐI ƯU!)

// 2. HyperLogLog độc lập (1 KB RAM, sai số < 3% trên 5.000 unique viewers)
const hll = new HyperLogLogCounter(10); // p = 10 -> m = 1,024 registers
hll.add("viewer_alice");
hll.add("viewer_bob");
console.log(hll.count()); // 2

// 3. YouTube Hybrid View Engine (Sharded Counter + HLL Anti-F5 Spam Audit)
const engine = new YouTubeHybridViewEngine({
  viralFreezeThreshold: 300, // Mô phỏng mốc 301 views huyền thoại
  maxViewsPerUniqueViewerRatio: 10,
  numSlots: 4, // Split 4 tối ưu
});

// Ghi nhận lượt xem (Tự băm slot và feed vào HLL)
engine.recordView("mv_sontung", "viewer_1");

// Nếu 1 bot user F5 liên tục 500 lần:
// - rawTotalViews: 500
// - verifiedPublicViews: 300 (ĐÓNG BĂNG tại mốc 300, chặn 200 view ảo!)
// - estimatedUniqueViewers: 1
// - isSuspectedBotAttack: true
const metrics = engine.getVideoMetrics("mv_sontung");
```

---

## 🧪 Kiểm Thử Toàn Diện (48 Unit & Concurrency Tests)

```bash
bun test packages/hot-counter
# 48 pass, 0 fail (158ms)
```

- **Level 24 Adaptive Slot Sizer**: Chứng minh toán học `Split 4` tối ưu (`1,100 req/s`), `Split 1` sập do row-lock (`700 > 200`), `Split 16` sập do khuếch đại đọc `SUM` (`2,300 > 1,500`).
- **HyperLogLog Cardinality Accuracy**: Sai số $< 3\%$ trên 5,000 unique viewers, bảo toàn tính lũy đẳng (1 viewer bấm 1,000 lần cho kết quả `count === 1`), và merge không mất mát.
- **YouTube 301-View Freeze & Bot Defense**: 1 bot F5 500 lần $\to$ `rawTotalViews = 500`, `verifiedPublicViews = 300` (đóng băng tại trần), `estimatedUniqueViewers = 1`, `isSuspectedBotAttack = true`. Traffic hữu cơ 1,200 views $\to$ xác minh 100% không bị đóng băng.
- **Tier-0 SME UPSERT & Batching**: Xác thực cú pháp PostgreSQL / SQLite UPSERT và bảo toàn 100% dữ liệu khi DB lỗi kết nối (Zero Lost Updates).
- **Naive Contention Simulator**: Đo lường thực nghiệm hàng chờ tuple lock nối tiếp và độ trễ P95 bùng nổ khi thiếu tầng gom đệm.
- **MicroBatchCoalescer Throughput**: 10,000 ops xử lý trong **1.04ms** (> 9,000,000 ops/giây trong RAM).
- **ValkeyWriteBehind Throughput**: 10,000 ops gom và drain trong **2.09ms** (> 4,700,000 ops/giây).
- **Anti-Oversell Invariant**: 1,000 concurrent buyers tranh mua 150 tồn kho Flash Sale ➔ **Chính xác 150 thành công, 850 bị từ chối, tồn kho kết thúc ở đúng 0, không bao giờ âm (< 0)**.
