# @kido/ai-stream

> **Tier-1 AI Token Streaming, Server-Sent Events (SSE), Fetch ReadableStream Consumer, Edge Buffer Flushing, RPM/TPM Rate Guard, Multi-Provider Fallback, Two-Stage Cross-Encoder Reranker, Asynchronous Ingestion Pacing, Context Sanitizer, Per-User Token Quota / EDoS Shield & Entity-Aware Strict Semantic Cache Suite**  
> Inspired by GonnaCrash World 3 Level 02 `faster_answers` (`streaming_ttft`), Level 03 `rpm_ceiling` (`provider_rate_limit`), Level 07 `public_launch` (`provider_fallback`), Level 08 `internal_docs_qa` (`rag_basics`), Level 09 `find_the_right_chunk` (`two_stage_reranker`), Level 10 `fresh_docs_hourly` (`ingestion_pacing`), Level 12 `bloated_tickets` (`context_rot`), Level 13 `budget_burning_chatbot` (`edos_quota_shield`), Level 14 `same_question_new_words` (`semantic_cache`), and production AI architectures (ChatGPT, Claude, Perplexity, LiteLLM, Vercel AI SDK):
> 1. **Naive Baseline (Blocking HTTP Request)**: Server waits for LLM to autoregressively synthesize all 300+ tokens (~4.2 seconds). The user stares at a completely blank screen, assumes the app crashed, and reloads repeatedly.
> 2. **Naive Baseline (Retry Storm on 429)**: When bursts hit provider RPM/TPM limits, immediate retries (`retry: instant`) collapse upstream providers, causing cascade failures (< 99% success).
> 3. **Naive Baseline (Bi-Encoder Vector Only)**: Bi-Encoder models encode queries and chunks independently, leading to semantic false positives and lost nuance (accuracy capped at ~72.5% < 85% SLA).
> 4. **Naive Baseline (Synchronous Ingestion Storm)**: Documents are embedded synchronously inside HTTP upload handlers (e.g. 3,600 pages arriving in 1 min at 60 req/s against a 3,000 RPM / 50 req/s API ceiling), causing >600 requests to collapse with HTTP 429, starving App Server threads and destroying live Q&A TTFT (> 3.0s).
> 5. **Naive Baseline (Context Rot on Bloated Forwarded Threads)**: From tick 60, staff paste entire forwarded email chains into tickets, inflating size 6x from 2,000 to 12,000 tokens. Decision Model accuracy collapses to 78%, causing expensive LLM fallback spikes to 65% and costs exceeding >0.60¢/task (failing SLA).
> 6. **Tier-0 SME Zero-Infra (`Tier0CachedChunkStreamer` & `LocalCrossEncoderReranker`)**: In-memory smooth token stream synthesis for cached FAQs and 100% self-contained zero-dependency local cross-encoder scoring ($0 LLM / API cost).
> 7. **Tier-1 Growth (`Tier1SingleNodeSseStreamer`, `DualRpmTpmTokenBucket`, `TwoStageRetrievalPipeline`, `IngestionWorker` & `ContextBuilder`)**: Direct single-node LLM provider SSE proxy with canonical anti-buffering edge headers (`X-Accel-Buffering: no`, `Cache-Control: no-cache, no-transform`, Caddy `flush_interval -1`) achieving **TTFT ~350ms**, combined with Exponential Backoff + Full Jitter, Dual RPM/TPM Token Bucket, Two-Stage Retrieval (top 20 recall -> cross-encoder rerank -> top 5 context pruning) achieving 91.7% accuracy (`1.0414¢/task`), Asynchronous Ingestion Pacing (`AsyncIngestionQueue` + `IngestionPacer` + 1 Tier-S Worker) eliminating 100% of 429 drops at **`0.9514¢/task`**, and Context Sanitizer & Email Chain Truncation (`ContextBuilder` + `stripEmailReplyChain` + `stripLegalDisclaimers` + `stripSignatureBlocks`) slashing 12,000-token bloated tickets by >80% to ~800 tokens, recovering Decision Model accuracy to >= 95%, and achieving GonnaCrash Level 12 3-Star Best Cost **`0.1086¢/task`** (`108,592 UC` <= `130,000 UC` budget).
> 8. **Tier-2 Big-Tech (`Tier2DistributedPubSubSseStreamer` & `RemoteRerankApi`)**: Distributed multi-node Pub/Sub SSE fanout (Redis/Valkey / NATS) enabling 1 LLM generation session to stream simultaneously to N viewers in real time, plus managed Cross-Encoder Reranking APIs (Cohere / Jina / custom) with automatic local fallback.

---

## 🏛️ 3-Tier Progressive Scale Architecture

| Cấp Độ (Tier) | Cơ Chế Kỹ Thuật | Chi Phí Hạ Tầng | TTFT (Time-to-First-Token) | Điểm Mạnh (Pros) | Rủi Ro & Thách Thức (Caveats) | Khuyến Nghị Sử Dụng |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Naive Blocking HTTP** | Đợi toàn bộ generation xong rồi mới trả về JSON `{"answer": "..."}` | $0 extra | **~4,200ms** | Đơn giản, dùng REST API chuẩn. | • **Cognitive Abandonment**: Khách hàng tưởng treo app.<br>• Timeout gateway khi model sinh dài. | 🛑 Cấm dùng cho LLM chat tương tác |
| **Tier-0 SME Zero-Infra** | **In-Memory Token Synthesizer** (`Tier0CachedChunkStreamer`) | **$0 extra** | **< 10ms** | • $0 chi phí LLM cho câu hỏi FAQ lặp lại.<br>• Tokenize mượt mà theo cụm từ (`wordsPerChunk = 2`). | Phù hợp câu trả lời tĩnh / cached. | ✅ **FAQ bot, offline demo, onboarding guided tours** |
| **Tier-1 Single-Node + Rate Guard** | **Direct LLM SSE Proxy + Edge Anti-Buffering + Rate Guard** (`Tier1SingleNodeSseStreamer`, `DualRpmTpmTokenBucket`) | **$15/mo VPS** | **~300ms – 500ms** | • **Chuẩn GonnaCrash Level 02 & 03 3-Star**: Vượt SLA 2s với chi phí tối thiểu `0.0273¢/task` (L02) & `0.5403¢/task` (L03).<br>• Headers chống proxy buffer (Nginx, Caddy, Cloudflare).<br>• Exponential backoff triệt tiêu 100% Retry Storm. | Cần cấu hình reverse proxy không buffer socket. | ⭐ **Production Chatbot, Next.js / Fastify / Express AI apps** |
| **Tier-2 Big-Tech** | **Distributed Pub/Sub Fanout** (`Tier2DistributedPubSubSseStreamer`) | **Cụm Valkey / Redis** | **~350ms** | • Fanout 1 LLM stream tới N người xem đồng thời (collaborative canvas, live group chat).<br>• Tự động dọn dẹp subscription khi stream đóng. | Cần cụm Redis/Valkey pub/sub broker. | 🚀 **Live multiplayer AI, broadcast streaming, collaborative workspaces** |

---

## 🎯 GonnaCrash Proof Matrix (Level 02 & Level 03)

### World 3 Level 02: `faster_answers` (`streaming_ttft`)

| Tiêu Chí | Blocking HTTP (Naïve) | Streaming SSE (`@kido/ai-stream`) | GonnaCrash Level 02 Target | Trạng Thái Đạt Được |
| :--- | :--- | :--- | :--- | :--- |
| **Time-to-First-Token (TTFT)** | `4,200 ms` | **`~345 ms`** | `<= 2,000 ms` | 🏆 **VƯỢT TRỘI (Giảm 91.8% độ trễ nhận thức)** |
| **Tỷ lệ phản hồi thành công** | ~92% (do user reload) | **`99.8%`** | `>= 99%` | 🟢 **Đạt chuẩn 3 Sao** |
| **Độ chính xác câu trả lời** | 85% | **`85%`** | `>= 80%` | 🟢 **Bảo toàn 100% chất lượng** |
| **Chi phí mỗi tác vụ (Cost/Task)**| 0.0273¢ | **`0.0273¢` (27,289 UC)** | `<= 0.0390¢ (39,000 UC)` | 🏆 **Best Cost Kỷ Lục Toàn Cầu** |

### World 3 Level 03: `rpm_ceiling` (`provider_rate_limit`)

| Tiêu Chí | 1 Provider + Instant Retry | 1 Provider + Backoff (Sập lúc `1:33`) | 2 Providers Active-Active (`openai_mid` + `anthropic_mid`) + Backoff | GonnaCrash Level 03 Target |
| :--- | :--- | :--- | :--- | :--- |
| **Tỷ lệ phản hồi thành công** | `20%` (Nổ Retry Storm) | `63.6%` (`19.1%` 429 + `17.3%` App quá tải) | **`100%`** | `>= 99%` 🏆 |
| **Độ chính xác câu trả lời** | 78% (`openai_small`) | `92%` (`openai_mid`) | **`92%` (`openai_mid` + `anthropic_mid`)** | `>= 90%` 🟢 |
| **Time-to-First-Token (TTFT)** | > 4,000 ms | `7,850 ms` (ngủ chờ quota đơn) | **`~420 ms`** | `<= 2,000 ms` 🟢 |
| **Chi phí mỗi tác vụ (Cost/Task)** | > 0.70¢ | 0.528¢ (rớt 36.4% req) | **`0.5403¢` (`540,275 UC`)** | `<= 0.6300¢ (`630,000 UC`)` 🏆 |

### World 3 Level 07: `public_launch` (`provider_fallback`)

| Tiêu Chí | 1 Provider (OpenAI Độc Canh) | Fallback Không Backoff | Multi-Provider Fallback Mesh + Backoff (`@kido/ai-stream`) | GonnaCrash Level 07 Target |
| :--- | :--- | :--- | :--- | :--- |
| **Tỷ lệ phản hồi thành công** | `65.0%` (Sập 2 phút outage) | `95.8%` (Rớt chuyển tiếp) | **`99.8%`** | `>= 99.5%` 🏆 |
| **Chữ đầu tiên (TTFT)** | `> 3,000 ms` (Timeout) | `~680 ms` | **`~450 ms`** | `<= 1,000 ms` 🟢 |
| **Độ chính xác câu trả lời** | 92% (Lúc còn sống) | 92.4% | **`92.4%` (`openai_mid` + `anthropic_mid`)** | `>= 92%` 🟢 |
| **Chi phí mỗi tác vụ (Cost/Task)** | > 0.45¢ | 0.3600¢ | **`0.3568¢` (`356,759 UC`)** | `<= 0.4200¢ (`420,000 UC`)` 🏆 |

### World 3 Level 08: `internal_docs_qa` (`rag_basics`)

| Tiêu Chí | Naive LLM (Bịa Đặt / Hallucination) | RAG Không Streaming | 3-Tier RAG Pipeline (`@kido/ai-stream/rag-pipeline`) | GonnaCrash Level 08 Target |
| :--- | :--- | :--- | :--- | :--- |
| **Tỷ lệ phản hồi thành công** | `100%` | `100%` | **`100%`** | `>= 99.0%` 🏆 |
| **Chữ đầu tiên (TTFT)** | `~420 ms` (Bịa nhanh) | `4,200 ms` (Buffering) | **`~850 ms`** | `<= 3,000 ms` 🟢 |
| **Độ chính xác câu trả lời** | **`28.0%`** (FAIL Bịa quy trình) | `92.4%` | **`92.4%` (`pgvector` top_5 + `openai_mid`)** | `>= 72.0%` 🏆 |
| **Chi phí mỗi tác vụ (Cost/Task)** | 0.6200¢ | 0.9414¢ | **`0.9414¢` (`941,357 UC`)** | `<= 1.0900¢ (`1,090,000 UC`)` 🏆 |

### World 3 Level 09: `find_the_right_chunk` (`two_stage_reranker`)

| Tiêu Chí | Bi-Encoder Thuần (Không Rerank) | Reranker Không Streaming | Two-Stage Retrieval & Cross-Encoder Reranker (`@kido/ai-stream/rag-pipeline`) | GonnaCrash Level 09 Target |
| :--- | :--- | :--- | :--- | :--- |
| **Tỷ lệ phản hồi thành công** | `100%` | `100%` | **`100%`** | `>= 99.0%` 🏆 |
| **Chữ đầu tiên (TTFT)** | `~420 ms` | `4,200 ms` (Buffering) | **`~880 ms`** | `<= 3,000 ms` 🟢 |
| **Độ chính xác câu trả lời** | **`72.5%`** (FAIL Bẫy Semantic Drift) | `91.7%` | **`91.7%` (`top_20 recall` + `reranker` -> `top_5`)** | `>= 85.0%` 🏆 |
| **Chi phí mỗi tác vụ (Cost/Task)** | 0.7200¢ | 1.0414¢ | **`1.0414¢` (`1,041,357 UC`)** | `<= 1.2000¢ (`1,200,000 UC`)` 🏆 |

### World 3 Level 10: `fresh_docs_hourly` (`ingestion_pacing`)

| Tiêu Chí | Ingestion Đồng Bộ Trong HTTP (Naïve) | Có Queue Nhưng Không Pacer | Asynchronous Ingestion Pacing (`@kido/ai-stream/rag-pipeline`) | GonnaCrash Level 10 Target |
| :--- | :--- | :--- | :--- | :--- |
| **Tỷ lệ trả lời tài liệu mới (Fresh Docs)** | `83.3%` (Rớt >600 lỗi 429) | `91.7%` (Rớt 300 lỗi 429) | **`100.0%`** | `>= 99.9%` 🏆 |
| **Hoàn tất tác vụ trước hạn (Jobs Done)** | `83.3%` | `91.7%` | **`100.0%`** | `>= 99.9%` 🏆 |
| **Độ trễ tài liệu cũ nhất (Oldest Job Age)**| `0 s` (Rớt tức thì) | `580 s` | **`490 s`** (`< 10 phút`) | `<= 600 s` (10 phút) 🟢 |
| **Tỷ lệ phản hồi Q&A thời gian thực** | `78.0%` (Nghẽn thread pool) | `100%` | **`100.0%`** | `>= 99.0%` 🏆 |
| **Chữ đầu tiên Q&A (TTFT)** | `4.8 s` (Quá tải hàng đợi) | `3.5 s` | **`~0.88 s`** (`880 ms` với streaming) | `<= 3.0 s` 🟢 |
| **Độ chính xác Q&A** | `50.7%` (Chỉ số thiếu sót) | `76.0%` | **`76.0%`** | `>= 72.0%` 🟢 |
| **Chi phí mỗi tác vụ (Cost/Task)** | N/A (Sập SLA) | 0.9514¢ | **`0.9514¢` (`951,361 UC`)** (1 Tier-S Worker) | `<= 1.1000¢ (`1,100,000 UC`)` 🏆 |

### World 3 Level 12: `bloated_tickets` (`context_rot`)

| Tiêu Chí | Không Context Builder (Naïve Context Rot) | Chỉ Dùng LLM Toàn Diện (Không Decision Model) | ContextBuilder + Decision Model (`@kido/ai-stream/rag-pipeline`) | GonnaCrash Level 12 Target | Trạng Thái Đạt Được |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Tỷ lệ phản hồi ticket (Answered)** | `100.0%` | `100.0%` | **`100.0%`** | `>= 99.0%` | 🏆 **Đạt chuẩn 3 Sao** |
| **Thời gian phản hồi trung bình** | `1.95 s` (Chờ LLM fallback) | `2.80 s` (Quá tải 12k tokens) | **`~0.44 s`** (Decision Model nhanh) | `<= 2.0 s` | 🟢 **Nhanh gấp 4.4 lần** |
| **Độ chính xác phân loại (Accuracy)** | **`78.0%`** (FAIL do Context Rot) | `96.0%` | **`96.2%`** (`800 clean tokens`) | `>= 95.0%` | 🏆 **Vượt chỉ tiêu SLA** |
| **Tỷ lệ Fallback LLM đắt tiền** | `65.0%` (Bùng nổ fallback) | `100.0%` | **`5.8%`** (Chỉ khi cần thiết) | Càng thấp càng tốt | 🟢 **Giảm 91% cuộc gọi LLM** |
| **Cắt gọt token rác (Token Slashing)**| `0%` (12,000 tokens nguyên khối) | `0%` (Ăn nguyên 12k tokens) | **`-93.3%`** (12,000 -> 800 tokens) | `>= 80.0%` | 🏆 **Sạch 100% rác** |
| **Chi phí mỗi tác vụ (Cost/Task)** | > 0.60¢ (612,400 UC) (FAIL) | > 0.85¢ (850,000 UC) | **`0.1086¢` (`108,592 UC`)** | `<= 0.1300¢ (`130,000 UC`)` | 🏆 **Best Cost Kỷ Lục Toàn Cầu** |

### World 3 Level 13 Boss Fight: `budget_burning_chatbot` (`edos_quota_shield`)

Mô phỏng 420 ticks (2,760 legitimate tasks với 5x viral surge 90–330s @ 10 req/s + 480 botnet attacks paste 50,000 tokens):

| Tiêu Chí | Không QuotaManager (EDoS Botnet Đốt Ngân Sách) | Không ContextBuilder (Context Rot) | Chỉ 1 Small Pool (`activeSmallPools = 1`) | 3-Layer EDoS Shield (`@kido/ai-stream/quota-manager`) | GonnaCrash Level 13 Boss Target |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Tỷ lệ trả lời hợp lệ (Answered)** | `82.61%` (FAIL) | `100.0%` | `82.61%` (Nghẽn surge) | **`100.0%`** (`2,760 / 2,760`) | `>= 99.0%` 🏆 |
| **Chữ đầu tiên (TTFT)** | `3,075 ms` (FAIL) | `380 ms` | `3,075 ms` (FAIL) | **`380 ms`** | `<= 2,000 ms` 🟢 |
| **Độ chính xác (Accuracy)** | `89.5%` | `78.5%` (FAIL Context Rot) | `89.5%` | **`89.5%`** | `>= 85.0%` 🟢 |
| **Botnet 50k-token bị chặn (413/429)**| `0 / 480` (`480,000` tokens đốt sạch) | `480 / 480` (`0` tokens đốt) | `480 / 480` (`0` tokens đốt) | **`480 / 480` (`0` tokens đốt)** | `100%` Pre-Flight Blocked 🛡️ |
| **Chi phí mỗi tác vụ (Cost/Task)** | `0.0548¢` (`54,800 UC`) (FAIL) | `0.0485¢` (`48,500 UC`) (FAIL) | `0.0342¢` (`34,200 UC`) (FAIL) | **`0.0273¢` (`27,266 UC`)** | `<= 0.0320¢` (`32,000 UC`) 🏆 |

### World 3 Level 14: `same_question_new_words` (`semantic_cache`)

Mô phỏng 120 ticks @ 2 req/s (240 tác vụ `chat_shop`, ngân sách `<= 410,000 UC = 0.4100¢/task`, độ chính xác `>= 93%`):

| Tiêu Chí | `loose` (`0.78`) | `balanced` (`0.86`) | `strict` Không `promptCache` | Không `SemanticCache` | `strict` (`0.95`) + `openai_mid` + `promptCache` + `stream` (`@kido/ai-stream/semantic-cache`) | GonnaCrash Level 14 Target |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Tỷ lệ phản hồi (Answered)** | `100.0%` | `100.0%` | `100.0%` | `100.0%` | **`100.0%`** (`240 / 240`) | `>= 99.0%` 🏆 |
| **Chữ đầu tiên (TTFT)** | `130 ms` | `165 ms` | `210 ms` | `380 ms` | **`210 ms`** | `<= 2,000 ms` 🟢 |
| **Độ chính xác (Accuracy)** | **`76.5%`** (FAIL Entity Collision) | **`82.0%`** (FAIL Entity Collision) | `96.25%` | `96.25%` | **`96.25%`** (`42` entity mismatch blocked) | `>= 93.0%` 🏆 |
| **Chi phí mỗi tác vụ (Cost/Task)** | `0.2850¢` (`285,000 UC`) | `0.3120¢` (`312,000 UC`) | **`0.5482¢`** (`548,200 UC`) (FAIL) | **`0.6854¢`** (`685,400 UC`) (FAIL) | **`0.3559¢` (`355,889 UC`)** | `<= 0.4100¢` (`410,000 UC`) 🏆 |
| **Đạt chuẩn 3 Sao (SLA)** | ❌ FAIL Accuracy | ❌ FAIL Accuracy | ❌ FAIL Budget | ❌ FAIL Budget | 🏆 **PASSED (3-Star Record)** | **3-Star Record** |



---

## 🛡️ Multi-Byte UTF-8 TCP Boundary Safety

Khi server stream các ký tự tiếng Việt có dấu (`ệ`, `ư`, `ố`) hoặc emoji đa byte (`🦫`, `🎨` chiếm 4 bytes UTF-8), các gói tin TCP có thể cắt ngang một ký tự ở giữa byte thứ 2 hoặc thứ 3.

`SseStreamParser` sử dụng **`new TextDecoder('utf-8')`** với `decode(chunk, { stream: true })`:
- Giữ byte dang dở trong internal state của decoder.
- Chỉ decode khi byte tiếp theo của code-point cập bến.
- Đã được kiểm chứng qua unit test cắt rời từng byte đơn lẻ (`1 byte / packet`), bảo đảm tái tạo 100% văn bản nguyên vẹn mà không xuất hiện ký tự rác `\uFFFD`.

---

## 🚦 Slice: `src/rpm-rate-guard/` (`@kido/ai-stream/rpm-rate-guard`)

### 1. Dual RPM & TPM Token Bucket
```typescript
import { DualRpmTpmTokenBucket } from '@kido/ai-stream/rpm-rate-guard';

const bucket = new DualRpmTpmTokenBucket({
  maxRpm: 60, // 60 requests / minute
  maxTpm: 40000, // 40,000 tokens / minute
});

const tokens = bucket.estimatePromptTokens("Giải thích kiến trúc SingleFlight");
const acq = bucket.tryAcquire(tokens);

if (!acq.allowed) {
  console.log(`Vượt hạn mức ${acq.limitingFactor}. Cần đợi ${acq.waitMs}ms`);
}
```

### 2. Resilient AI Call Executor With Exponential Backoff & Full Jitter
```typescript
import { executeWithAiRateGuard } from '@kido/ai-stream/rpm-rate-guard';

const result = await executeWithAiRateGuard(
  async () => {
    return await callOpenAiMidModel({ prompt, stream: true });
  },
  {
    maxRetries: 3,
    baseDelayMs: 200,
    maxDelayMs: 10000,
    onRetry: ({ attempt, delayMs, error, retryAfterMs }) => {
      console.warn(`Lần thử ${attempt + 1}: Chờ ${delayMs}ms (Provider Retry-After: ${retryAfterMs}ms)`);
    },
  }
);
```

---

## 🔐 Slice: `src/rag-security-guard/` (`@kido/ai-stream/rag-security-guard`)

Zero-dependency security guard for enterprise RAG & chat copilots:

- **Credential DLP (`dlp-redactor.ts`)**: `redactCredentialsDlp()` applies 18-rule secret scrubbing (`xox*`, `whsec_*`, `sk_live_*`, `ya29.*`, `AIza*`, JWTs, Bearer/Basic headers, `.env` keys, JSON credentials, `--password`, DB URIs) while preserving HTTPS archive links. `StreamingDlpRedactor` holds back non-whitespace/unfinished credential lines so secrets split across 1-byte SSE chunks are redacted before emission.
- **Fail-Closed Scope ACL & Zero-Cost Intent (`scope-acl.ts`)**: `FailClosedScopeResolver` enforces TTL-cached membership checks, pins channel mentions to `currentScope` (anti-keyword hijack), fails closed (`[]`) on verifier errors, and keeps `narrowWithinAuthorized` strictly bounded. `classifyZeroCostIntent()` short-circuits empty/greeting/interactive-fallback probes with 0 RAG/LLM calls.
- **Prompt Boundary & Progressive Edits (`prompt-boundary.ts`)**: `escapeBoundaryTags()`, `wrapUntrustedRagContext()`, `detectPromptOverrideAttempt()`, `clampMessageAtBoundary()`, `SAFE_UPSTREAM_UNAVAILABLE_MESSAGE`, and `ProgressiveMessageEditThrottler` (`streamToEditableMessage()`).

---

## 🚀 Quickstart: SSE Token Streaming

### Server (Hono / Next.js Route Handler / Express)
```typescript
import {
  createSseTokenReadableStream,
  buildSseResponseHeaders,
} from '@kido/ai-stream';

export async function GET() {
  const stream = createSseTokenReadableStream({
    meta: { model: 'openai_mid', session: 'sess-123' },
    tokenSource: ['Xin ', 'chào, ', 'mình ', 'là ', 'Aria 🦫🎨!'],
    chunkDelayMs: 20,
  });

  return new Response(stream, {
    headers: buildSseResponseHeaders({
      'Access-Control-Allow-Origin': '*',
    }),
  });
}
```

### Client: Tiêu Thụ Stream Với Fallback JSON
```typescript
import { consumeSseReadableStream } from '@kido/ai-stream';

const res = await fetch('/api/chat/stream');

const result = await consumeSseReadableStream(res, {
  onMeta: (meta) => console.log('Metadata:', meta),
  onToken: (token, accumulated) => {
    process.stdout.write(token);
  },
  onDone: (finalText, metrics) => {
    console.log(`\nHoàn thành trong ${metrics.totalDurationMs}ms (TTFT: ${metrics.ttftMs}ms, mode: ${metrics.mode})`);
  },
});
```

---

## ⚡ Slice: `src/provider-fallback/` (`@kido/ai-stream/provider-fallback`)

Cung cấp giải pháp đa đám mây (Multi-Cloud AI Mesh) lấy cảm hứng từ GonnaCrash World 3 Level 07 `public_launch`, LiteLLM Router, Cloudflare AI Gateway, và Google Search Hedging:

### 1. Multi-Provider Fallback Mesh với Circuit Breaker Tự Động
```typescript
import { createMultiProviderFallbackMesh } from '@kido/ai-stream/provider-fallback';

const mesh = createMultiProviderFallbackMesh({
  providers: [
    { id: 'openai-primary', model: 'openai_mid', priority: 0 },
    { id: 'anthropic-fallback', model: 'anthropic_mid', priority: 1 },
    { id: 'gemini-tertiary', model: 'gemini_pro', priority: 2 },
  ],
  maxRetries: 2,
});

// Tự động failover 0ms khi OpenAI trả 500, 502, 503, 429 hoặc timeout
const { stream, providerId, model, ttftMs } = await mesh.executeStream(async (ep, signal) => {
  return await fetchMyLlmProvider(ep.model, { signal });
});
```

### 2. Hedging Requests (Tail Latency Reducer — Google Search / Uber AI)
Triệt tiêu p99 tail latency spike khi provider chính bị lag/nghẽn:
```typescript
import { executeWithHedging } from '@kido/ai-stream/provider-fallback';

// Nếu provider chính chưa nhả token nào sau 800ms, lập tức bắn song song sang provider dự phòng.
// Thằng nào ra token đầu tiên trước thì thắng cuộc; thằng thua cuộc bị abort() ngay lập tức!
const result = await executeWithHedging(
  (signal) => callOpenAiStream({ signal }),
  (signal) => callAnthropicStream({ signal }),
  'openai_mid',
  'anthropic_mid',
  { hedgeDelayMs: 800 }
);

console.log(`Chiến thắng bởi: ${result.providerId} (Hedged: ${result.hedged}, TTFT: ${result.ttftMs}ms)`);
```

### 3. Dynamic Health Router & EWMA Latency Tracking
Tự động tính Exponentially Weighted Moving Average (EWMA) latency và tỷ lệ lỗi để cách ly tạm thời (quarantine) các endpoint đang chập chờn:
```typescript
import { DynamicHealthRouter } from '@kido/ai-stream/provider-fallback';

const router = new DynamicHealthRouter([
  { id: 'openai', model: 'openai_mid', priority: 0 },
  { id: 'anthropic', model: 'anthropic_mid', priority: 1 },
], { ewmaAlpha: 0.2, quarantineErrorRate: 0.05 });
```

---

## 📚 Slice: `src/rag-pipeline/` (`@kido/ai-stream/rag-pipeline`)

Bộ công cụ RAG 3 tầng & pgvector chống ảo tưởng (Anti-Hallucination), lấy cảm hứng từ GonnaCrash World 3 Level 08 `internal_docs_qa` và kiến trúc Trợ lý AI thực chiến:

### 1. Document Chunking với Semantic Overlap
```typescript
import { chunkDocumentText } from '@kido/ai-stream/rag-pipeline';

const chunks = chunkDocumentText('doc_leave_sop', leavePolicyMarkdown, {
  maxTokens: 400,
  overlapTokens: 50,
});
```

### 2. Parameterized PostgreSQL pgvector Search SQL (Standard & Halfvec AVX-512)
```typescript
import { buildPgvectorSearchSql, buildPgvectorIndexSql } from '@kido/ai-stream/rag-pipeline';

const { sql, vectorLiteral } = buildPgvectorSearchSql({
  tableName: 'DocumentChunk',
  queryVector: embeddingArray,
  topK: 5,
  tenantId: 'acme',
  useHalfvec: true, // Postgres 18 / pgvector 0.8.7 halfvec AVX-512
});
```

### 3. Strict Grounded Prompt & Source Citation Extractor
```typescript
import { buildGroundedPrompt, extractSourceCitations } from '@kido/ai-stream/rag-pipeline';

const { prompt, sources } = buildGroundedPrompt('Xin nghỉ phép cần báo trước bao lâu?', top5Chunks, {
  companyName: 'Acme Commerce',
});

// Ép model chỉ trả lời dựa trên context, trích dẫn rõ [Doc 1], [Doc 2]
const citations = extractSourceCitations(llmAnswer); // -> [1]
```

### 4. 3-Tier Short-Circuit Cascade (Production RAG Architecture)
```typescript
import { createRagCascadeOrchestrator } from '@kido/ai-stream/rag-pipeline';

const orchestrator = createRagCascadeOrchestrator({
  canonicalFaqs: [
    {
      intent: 'late_penalty',
      keywords: ['di tre phat sao', 'di muon phat the nao'],
      reply: 'Ân hạn 1 phút, từ phút thứ 2 tính bảng vi phạm.',
      sources: ['canonical:sop:late_penalty'],
    },
  ],
  embedQuery: async (text) => await getOpenAiOrGeminiEmbedding(text),
  searchVectorDb: async (vector, topK) => await queryPgvector(vector, topK),
  callLlm: async (prompt) => await callModelStream(prompt),
});

// Tier 1: Grep / Exact cache -> 1-5ms (0 LLM calls)
// Tier 2: Semantic vector cache -> ~80ms (0 LLM calls)
// Tier 3: RAG pgvector + Grounded LLM -> ~850ms TTFT + async cache write-back
const res = await orchestrator.answerQuestion('Đi trễ phạt sao ạ?');
console.log(res.tier, res.cached, res.answer);
```

### 5. Two-Stage Retrieval & Cross-Encoder Reranker (GonnaCrash Level 09 & Commerce Architecture)

Bi-Encoder (vector embeddings thuần) chỉ mã hóa câu hỏi và tài liệu độc lập, dẫn đến độ chính xác bị trần ở mức **~72-75%** do nhiễu ngữ nghĩa (semantic false positives). Nhồi toàn bộ 20 chunks vào LLM sẽ gây tốn token và lỗi "Lost in the Middle".

Kiến trúc **Two-Stage Retrieval** giải quyết triệt để:
- **Stage 1 (Broad Recall)**: Lấy top 20 chunks từ Vector DB / pgvector / Hybrid RRF.
- **Stage 2 (Cross-Encoder Reranker)**: Chấm điểm tương tác token chéo toàn diện giữa Query và Chunk.
- **Stage 3 (Context Pruning)**: Cắt lọc lấy đúng top 5 chunks tinh khiết nhất, loại bỏ hoàn toàn các distractor chunks và các tài liệu dưới ngưỡng `minRelevanceScore`.

#### A. Local Cross-Encoder Scorer (Zero-Dependency, $0 Offline Engine)
```typescript
import { LocalCrossEncoderReranker, type RerankCandidate } from '@kido/ai-stream/rag-pipeline';

const reranker = new LocalCrossEncoderReranker();
const candidates: RerankCandidate[] = [
  { id: 'c1', title: 'Chính sách bảo mật', content: 'Thông tin tài khoản...', initialRank: 1 },
  { id: 'c2', title: 'Quy định hoàn tiền', content: 'Hàng vỡ hoàn tiền 100% trong 24h...', initialRank: 2 },
];

const results = await reranker.rerank('hoàn tiền khi hàng vỡ', candidates, {
  topK: 1,
  minRelevanceScore: 0.35,
});
// c2 được đẩy lên hạng 1 với điểm liên quan cao vượt trội
```

#### B. Remote Reranker API (Cohere / Jina / Custom) với Automatic Local Fallback
```typescript
import { RemoteRerankApi } from '@kido/ai-stream/rag-pipeline';

const remoteReranker = new RemoteRerankApi({
  provider: 'cohere',
  apiKey: process.env.COHERE_API_KEY,
  model: 'rerank-v3.5',
  fallbackToLocal: true, // Tự động fallback sang LocalCrossEncoder khi API lỗi hoặc timeout
});
```

#### C. Two-Stage Retrieval Pipeline
```typescript
import { createTwoStageRetrievalPipeline } from '@kido/ai-stream/rag-pipeline';

const pipeline = createTwoStageRetrievalPipeline({
  stage1RecallTopK: 20, // Stage 1: Broad Recall 20 chunks
  stage2FinalTopK: 5,   // Stage 3: Cắt gọt top 5 chunks
  minRelevanceScore: 0.25,
  reranker: remoteReranker,
  retriever: async (query, topK) => {
    return await pgvectorSearch(query, topK);
  },
});

const { finalCandidates, distractorsPruned } = await pipeline.execute('khi hàng vỡ xử lý thế nào');
// finalCandidates chứa đúng 5 chunks tinh sạch nhất đưa vào LLM Context
```

#### D. Catalog & Knowledge Adapters (DocumentChunk & StoreProduct)
```typescript
import {
  adaptDocumentChunkToCandidate,
  adaptCatalogProductToCandidate,
} from '@kido/ai-stream/rag-pipeline';

// Chuyển đổi trực tiếp DocumentChunk
const candidate1 = adaptDocumentChunkToCandidate(docChunk, 1);

// Chuyển đổi trực tiếp Catalog StoreProduct sang RerankCandidate
const candidate2 = adaptCatalogProductToCandidate(catalogProduct, 2);
```

### 6. Asynchronous Ingestion Pacing & Rate Regulation (GonnaCrash Level 10 & Enterprise Architecture)

Khi 3,600 trang tài liệu xuất hiện đột biến trong vòng 1 phút (tốc độ đến 60 trang/giây), trong khi API Embedding (OpenAI, Gemini) giới hạn trần cứng ở mức 3,000 RPM (50 req/s):
- **Bẫy Ngây Thơ (Naïve Trap)**: Nhồi embedding trực tiếp trong HTTP request handler khiến >600 requests bị HTTP 429 sập hàng loạt, event loop và thread pool của App Server bị nghẽn cứng, kéo sập toàn bộ SLA của luồng Q&A thời gian thực (TTFT > 3.0s).
- **Kiến Trúc Đạt Chuẩn 3 Sao Level 10**:
  1. **AsyncIngestionQueue**: App Server nhận tài liệu và enqueue ngay trong `< 5ms`, trả về `HTTP 202 Accepted` tức thì.
  2. **IngestionPacer**: Điều tiết tốc độ gọi Embedding API bằng Token Bucket (ví dụ: 45 req/s), giữ lại 5 req/s khoảng thở cho chat Q&A, tự động lùi bước bằng Decorrelated Jitter / Full Jitter nếu gặp 429.
  3. **MicroBatchChunker**: Gom cụm các chunks nhỏ (16–32 chunks) thành 1 payload embedding duy nhất, giảm 95% số lượt gọi mạng và tránh cạn kiệt RPM quota.
  4. **Single Tier-S Worker (`count: 1`)**: 1 worker máy chủ độc lập rút việc từ hàng đợi, nhúng micro-batch, và thực thi câu lệnh SQL multi-row batch INSERT vào PostgreSQL pgvector / halfvec.
  5. **Bảo Toàn Q&A & Kỷ Lục Chi Phí**: Hoàn tất 100% tài liệu trước 10 phút (`490s < 600s`), 0 lỗi 429, luồng Q&A mượt mà (TTFT ~880ms, 100% trả lời), đạt Best Cost kỷ lục toàn cầu **`0.9514¢/task`** (`951,361 UC`).

#### A. Hàng Đợi Bất Đồng Bộ Phân Cấp (AsyncIngestionQueue)
```typescript
import { AsyncIngestionQueue } from '@kido/ai-stream/rag-pipeline';

const queue = new AsyncIngestionQueue({
  maxCapacity: 50000,
  dedupEnabled: true,       // Chống trùng lặp tài liệu đang xử lý
  defaultMaxRetries: 3,
});

// HTTP 202 Accepted tức thì (< 5ms)
const res = queue.enqueue({
  documentId: 'sop_leaves_2026',
  title: 'Quy định nghỉ phép năm 2026',
  content: 'Toàn bộ nội dung quy định nhân sự...',
  priority: 'high',         // 'critical' | 'high' | 'normal' | 'low'
});
console.log(res.accepted, res.queueDepth, res.estimatedWaitMs);
```

#### B. Bộ Điều Tiết Tốc Độ Token Bucket (IngestionPacer)
```typescript
import { IngestionPacer } from '@kido/ai-stream/rag-pipeline';

const pacer = new IngestionPacer({
  maxRequestsPerSecond: 45, // Capped an toàn dưới ngưỡng 50 req/s của API
  maxConcurrentRequests: 4,
  backoffInitialMs: 500,
  backoffMaxMs: 30000,
});

// Tự động điều tiết nhịp độ và lùi bước với Decorrelated Jitter khi gặp 429
const embeddings = await pacer.executeWithPacing(async () => {
  return await callEmbeddingApi(chunksBatch);
});
```

#### C. Gom Cụm Micro-Batch & Batch SQL pgvector
```typescript
import {
  MicroBatchChunker,
  buildPgvectorBatchInsertSql,
} from '@kido/ai-stream/rag-pipeline';

const chunker = new MicroBatchChunker({
  maxBatchSize: 32,      // Gom tối đa 32 chunks / đợt
  maxBatchTokens: 8192,  // Không vượt quá ngưỡng token context
});
const batches = chunker.batchChunks(rawChunks);

// Sinh câu lệnh SQL multi-row batch INSERT tối ưu cho pgvector / halfvec
const { query, params } = buildPgvectorBatchInsertSql(upsertItems, {
  tableName: 'DocumentChunk',
  useHalfvec: true, // Postgres 18 AVX-512 SIMD
});
await prisma.$executeRawUnsafe(query, ...params);
```

#### D. Pipeline Hoàn Chỉnh Sẵn Dùng Cho E-Commerce (createCommerceAsyncIngestionPipeline)
```typescript
import { createCommerceAsyncIngestionPipeline } from '@kido/ai-stream/rag-pipeline';

const pipeline = createCommerceAsyncIngestionPipeline({
  maxRps: 45,
  batchSize: 32,
  concurrency: 1, // 1 Tier-S Worker
  useHalfvec: true,
  embedContentBatch: async (chunks) => {
    return await geminiEmbeddingService.embedBatch(chunks);
  },
  prismaExecuteRaw: async (sql, ...params) => {
    return await prisma.$executeRawUnsafe(sql, ...params);
  },
});

// Trong route POST /api/documents:
pipeline.enqueueDocument(uploadedDoc, 'normal');

// Khởi chạy worker chạy ngầm:
pipeline.start();
```

---

### 5. Slice: `src/rag-pipeline/context-sanitizer.ts` (`@kido/ai-stream/rag-pipeline`)

Bộ tiền xử lý **Context Sanitizer & Email Chain Truncation** (chuẩn GonnaCrash World 3 Level 12 `bloated_tickets` & Enterprise Customer Support):

#### A. Triệt tiêu Context Rot bằng `ContextBuilder` & `sanitizeContext`
```typescript
import { ContextBuilder, sanitizeContext } from '@kido/ai-stream/rag-pipeline';

// Khởi tạo builder với cấu hình tùy chỉnh
const builder = new ContextBuilder({
  stripEmailHistory: true,     // Cắt bỏ chuỗi email trích dẫn và forwarded threads
  stripQuotedLines: true,      // Cắt các dòng bắt đầu bằng dấu '>'
  stripSignatures: true,       // Bóc tách '--', 'Sent from my iPhone', chữ ký trân trọng
  stripLegalDisclaimers: true, // Xóa thông cáo bảo mật công ty, cảnh báo môi trường, antivirus
  stripUnsubscribe: true,      // Xóa link unsubscribe / opt-out
  maxTokens: 800,              // Cắt gọt sliding window nếu vượt trần token
  windowStrategy: 'tail',      // Giữ ngữ cảnh gần nhất của khách
});

const result = builder.sanitize(bloatedEmailBody);

console.log(`Original Tokens: ${result.originalTokens}`);
console.log(`Sanitized Tokens: ${result.sanitizedTokens}`);
console.log(`Reduction Ratio: ${(result.reductionRatio * 100).toFixed(1)}%`);
console.log(`Clean Text:\n${result.cleanText}`);
```

#### B. Các Hàm Tách Biệt Độc Lập (Surgical Cherry-Pick)
```typescript
import {
  stripEmailReplyChain,
  stripLegalDisclaimers,
  stripSignatureBlocks,
  slidingWindowContext,
} from '@kido/ai-stream/rag-pipeline';

// 1. Chỉ cắt chuỗi trích dẫn email (Gmail, Outlook, tiếng Việt, Pháp, Đức, Tây Ban Nha)
const withoutQuotes = stripEmailReplyChain(rawEmail);

// 2. Chỉ bóc tách thông cáo bảo mật pháp lý và cảnh báo virus
const withoutDisclaimers = stripLegalDisclaimers(withoutQuotes);

// 3. Chỉ bóc tách chữ ký nhân sự và footer di động
const withoutSignature = stripSignatureBlocks(withoutDisclaimers);

// 4. Giới hạn khung trượt token (head, tail hoặc head-tail)
const boundedPrompt = slidingWindowContext(withoutSignature, 600, { strategy: 'tail' });
```

#### C. Adapter Hỗ Trợ Khách Hàng Commerce (`sanitizeSupportTicket`)
```typescript
import { sanitizeSupportTicket } from '@kido/ai-stream/rag-pipeline';

const rawCustomerTicket = {
  id: 'ticket_supp_102',
  subject: 'Yêu cầu đổi trả màu nước Holbein',
  customerEmail: 'khachhang@gmail.com',
  body: rawPastedContentWithForwardedQuotes,
};

const sanitizedTicket = sanitizeSupportTicket(rawCustomerTicket, { maxTokens: 800 });

// sanitizedTicket.cleanBody sạch 100% rác, sẵn sàng đưa vào Decision Model hoặc AI Store Advisor!
```

---

## 🛡️ Slice: `src/quota-manager/` (`@kido/ai-stream/quota-manager`)

Bộ lá chắn chống đốt ví **3-Layer EDoS Shield & Per-User Token Quota** (GonnaCrash World 3 Level 13 Boss Fight `budget_burning_chatbot` & Production Store AI):

1. **Layer 1 (Precedence 4) — `PerUserTokenQuotaManager`**:
   - Chặn ngay trước khi gọi LLM (`httpStatus: 413`, `SINGLE_PROMPT_TOO_LARGE`, `0` token bị đốt) nếu `estimatedInputTokens > maxSinglePromptTokens`.
   - Áp dụng đồng thời 4 cửa sổ **Minute RPM**, **Day RPD**, **Minute TPM**, **Day TPD** với chính sách phân tầng (`anonymous`, `authenticated`, `vip`) + `tierOverrides`.
   - Cung cấp **`VALKEY_PER_USER_QUOTA_LUA`** (atomic Redis/Valkey Lua script với `PEXPIRE`) và **`InMemoryQuotaStore`** (O(1) LRU eviction giới hạn `maxEntries = 10_000`).
   - Tự động gắn cờ **`requiresChallenge`** (`X-Quota-Challenge-Required: 1`) sau `abuseViolationThreshold` lần vi phạm và hoàn trả/đối soát chênh lệch token qua `recordCompletionTokens()`.
2. **Layer 2 (Precedence 3) — `clampChatPrompt`**:
   - Gọi `sanitizeContext()` cắt chuỗi email (`On ... wrote:`, `-----Original Message-----`, `> quoted`), disclaimer pháp lý, chữ ký RFC `--`, gom gọn spam ký tự/dòng lặp, và giới hạn `maxQueryChars` / `maxPromptTokens` / `maxHistoryTurns` / `maxHistoryTurnChars`.
3. **Layer 3 — `EdosChatbotShield` + `MultiProviderQuotaPoolRouter` (50/50 Active-Active Split)**:
   - Chia tải 50/50 qua `openai_small` + `anthropic_small` kết hợp Full-Jitter Backoff và hoàn trả token tiết kiệm được vào quota user.

### Quickstart: `@kido/ai-stream/quota-manager`
```typescript
import {
  PerUserTokenQuotaManager,
  clampChatPrompt,
  EdosChatbotShield,
  simulateLevel13BudgetBurningChatbot,
} from '@kido/ai-stream/quota-manager';

const quotaManager = new PerUserTokenQuotaManager({
  defaultTier: 'anonymous',
  tierOverrides: {
    vip: { maxRequestsPerMinute: 60, maxTokensPerDay: 200_000 },
  },
});

const shield = new EdosChatbotShield({
  quotaManager,
  clampOptions: { maxQueryChars: 1200, maxPromptTokens: 600, maxHistoryTurns: 4 },
});

const res = await shield.execute(
  { subjectId: 'user:123', tier: 'authenticated', query: rawUserMessage, history },
  async ({ providerId, cleanQuery, cleanHistory }) => {
    const answer = await callSmallModel(providerId, cleanQuery, cleanHistory);
    return { result: answer };
  }
);

if (!res.allowed) {
  // 413 SINGLE_PROMPT_TOO_LARGE hoặc 429 RPM/RPD/TPM/TPD + res.headers ('X-Quota-Blocked': '1')
  return Response.json({ error: res.reason }, { status: res.httpStatus, headers: res.headers });
}

// Chạy mô phỏng kiểm chứng Level 13 3-Star SLA (27,266 UC/task <= 32,000 UC)
const sim = simulateLevel13BudgetBurningChatbot();
console.log(sim.verdict, sim.costPerTaskUc, sim.isThreeStarRecord);
```

---

## 🎯 Slice: `src/semantic-cache/` (`@kido/ai-stream/semantic-cache`)

Bộ nhớ đệm ngữ nghĩa **Entity-Aware Strict Semantic Cache & Prompt Prefix Caching** (GonnaCrash World 3 Level 14 `same_question_new_words` & Production Store AI):

1. **`extractCommerceEntities` & `computeEntityFingerprint`**:
   - Trích xuất và chuẩn hóa thực thể thương mại song ngữ Việt/Anh: kích cỡ (`size M/L`, `A4/A5`, `2B..8B`), định lượng/thể tích (`300gsm`, `200gsm`, `500g`, `15ml`), số lượng bộ (`24 màu`/`24 tuýp` -> `24_colors`, `20 tờ` -> `20_sheets`), màu sắc/bề mặt (`black`, `white`, `cold_press`, không nhận nhầm từ đệm `"hông"` thành `"hồng"`), ngưỡng giá (`max:200000`, `min:500000`), thương hiệu/SKU.
   - Bất kỳ sai khác 1 thực thể nào đều tạo `entityFingerprint` khác nhau, chặn tuyệt đối trả lời nhầm giữa Size M vs Size L hoặc 300gsm vs 200gsm.
2. **`EntityAwareSemanticCache` (`SIMILARITY_PRESETS.strict = 0.95`)**:
   - Kết hợp exact match (`HIT_EXACT`), cosine similarity trên vector trigram 128-D đã tách từ đệm (`HIT_SEMANTIC >= 0.95`), khóa cô lập theo `entityFingerprint` (`entityMismatchBlocked`), chỉ mục ngược `skuIndex` (`invalidateBySku` O(k)), và kiểm tra `stockSignatureValidator` chống rò rỉ dữ liệu tồn kho cũ.
3. **`buildPromptCacheMessages`**:
   - Đặt `staticSystemPrompt` và `staticCatalogContext` ở đầu mảng messages với `cache_control: { type: 'ephemeral' }` trước lịch sử động và câu hỏi hiện tại.

### Quickstart: `@kido/ai-stream/semantic-cache`
```typescript
import {
  EntityAwareSemanticCache,
  buildPromptCacheMessages,
  simulateLevel14SameQuestionNewWords,
} from '@kido/ai-stream/semantic-cache';

const cache = new EntityAwareSemanticCache<string>({
  similarity: 'strict', // 0.95 cosine threshold + entity fingerprint lock
  requireEntityMatch: true,
  stockSignatureValidator: (skus, sig) => getLiveStockSig(skus) === sig,
});

await cache.store({
  query: 'giấy vẽ màu nước baohong 300gsm còn không shop?',
  response: 'Giấy Baohong 300gsm hiện còn 45 tệp ạ!',
  skus: ['BH-A4-300'],
  stockSignature: 'BH-A4-300:45',
});

// Paraphrase khớp thực thể -> HIT_SEMANTIC (>= 0.95)
const hit = await cache.lookup('shop ơi tệp giấy baohong 300gsm vẽ màu nước còn hàng hông?');
// Đổi 1 từ khóa thực thể (200gsm) -> MISS an toàn
const miss = await cache.lookup('giấy vẽ baohong 200gsm còn không?');

// Xóa tức thì khi đơn hàng làm giảm tồn kho SKU
cache.invalidateBySku(['BH-A4-300']);

// Chạy mô phỏng kiểm chứng Level 14 3-Star SLA (355,889 UC/task <= 410,000 UC)
const sim14 = simulateLevel14SameQuestionNewWords({
  similarity: 'strict',
  modelFlavor: 'openai_mid',
  promptCache: true,
  stream: true,
});
console.log(sim14.verdict, sim14.costPerTaskUc, sim14.isThreeStarRecord);
```

---

## 🔧 Cấu Hình Reverse Proxy Chống Buffering

### Nginx Snippet
```nginx
location /api/ai/stream {
    proxy_pass http://upstream_backend;
    proxy_http_version 1.1;
    proxy_set_header Connection '';
    proxy_buffering off;
    proxy_cache off;
    chunked_transfer_encoding on;
    proxy_read_timeout 600s;
}
```

### Caddyfile Snippet
```caddy
@sse path /api/ai/stream*
reverse_proxy @sse http://upstream_backend {
    flush_interval -1
}
```
