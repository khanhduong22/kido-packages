# @kido/ai-stream

> **Tier-1 AI Token Streaming, Server-Sent Events (SSE), Fetch ReadableStream Consumer, Edge Buffer Flushing & RPM/TPM Rate Guard Suite**  
> Inspired by GonnaCrash World 3 Level 02 `faster_answers` (`streaming_ttft`), Level 03 `rpm_ceiling` (`provider_rate_limit`), and production AI architectures (ChatGPT, Claude, Perplexity, LiteLLM, Vercel AI SDK, and enterprise RAG copilots):
> 1. **Naive Baseline (Blocking HTTP Request)**: Server waits for LLM to autoregressively synthesize all 300+ tokens (~4.2 seconds). The user stares at a completely blank screen, assumes the app crashed, and reloads repeatedly.
> 2. **Naive Baseline (Retry Storm on 429)**: When bursts hit provider RPM/TPM limits, immediate retries (`retry: instant`) collapse upstream providers, causing cascade failures (< 99% success).
> 3. **Tier-0 SME Zero-Infra (`Tier0CachedChunkStreamer`)**: In-memory smooth token stream synthesis for cached FAQs, canned recommendations, or template prompts ($0 LLM cost) with smooth visual chunking.
> 4. **Tier-1 Growth (`Tier1SingleNodeSseStreamer` & `src/rpm-rate-guard`)**: Direct single-node LLM provider SSE proxy with canonical anti-buffering edge headers (`X-Accel-Buffering: no`, `Cache-Control: no-cache, no-transform`, Caddy `flush_interval -1`) achieving **TTFT ~350ms** (far exceeding the 2,000ms SLA), combined with Exponential Backoff + Full Jitter & Dual RPM/TPM Token Bucket.
> 5. **Tier-2 Big-Tech (`Tier2DistributedPubSubSseStreamer`)**: Distributed multi-node Pub/Sub SSE fanout (Redis/Valkey / NATS) enabling 1 LLM generation session to stream simultaneously to N viewers in real time.

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

```typescript
import {
  FailClosedScopeResolver,
  ProgressiveMessageEditThrottler,
  wrapUntrustedRagContext,
} from '@kido/ai-stream/rag-security-guard';

const acl = new FailClosedScopeResolver({
  allowedScopes: ['C_ENG_CORE', 'C_BILLING'],
  isMember: async ({ userId, scope }) => checkMembership(userId, scope),
});
const scopeResult = await acl.resolve({ userId: 'U_ALICE', currentScope: 'C_ENG_CORE', isDirectMessage: false });
const promptBody = wrapUntrustedRagContext({ userQuery: 'Status?', contextBlocks: ['Chunk 1'] });
const throttler = new ProgressiveMessageEditThrottler();
```

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
    tokenSource: ['Khạp ', 'khạp, ', 'mình ', 'là ', 'Capy 🦫🎨!'],
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
