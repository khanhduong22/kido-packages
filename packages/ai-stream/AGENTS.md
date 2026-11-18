# Package Directives: @kido/ai-stream

> **Scope**: Tier-1 AI Token Streaming, Server-Sent Events (SSE), Fetch ReadableStream Consumer & Edge Buffer Flushing Suite.  
> **Standards Reference**: GonnaCrash World 3 Level 02 `faster_answers`, OpenAI Chat Completion Stream Protocol, WHATWG ReadableStream & TextDecoder Streaming Standards.

## 1. Core Invariants & Boundaries

1. **Zero External Runtime Dependencies**: Pure TypeScript utilizing native WHATWG `ReadableStream`, `TextDecoder`, `TextEncoder`, `Response`, and `Headers`.
2. **Multi-Byte UTF-8 Boundary Safety**:
   - `SseStreamParser` MUST instantiate `TextDecoder('utf-8', { stream: true })`.
   - Incoming byte chunks split across arbitrary TCP segment boundaries (e.g., Vietnamese diacritics `ệ`, `ư` and emojis `🦫`, `🎨`) must NEVER produce replacement character `\uFFFD`.
3. **Sub-10ms TTFT Socket Flush Frame**:
   - Every stream created with `createSseTokenReadableStream` immediately enqueues `: stream-open\n\n` to force the reverse proxy (Nginx/Caddy) to flush its transport buffer.
   - Initial metadata (`event: meta\ndata: ...\n\n`) is flushed before model token generation commences.
4. **Canonical Anti-Buffering Headers**:
   - `Content-Type: text/event-stream; charset=utf-8`
   - `Cache-Control: no-cache, no-transform`
   - `Connection: keep-alive`
   - `X-Accel-Buffering: no`
   - `X-Content-Type-Options: nosniff`
5. **GonnaCrash Level 02 SLA Compliance**:
   - `evaluateTtftSla()` verifies TTFT <= 2,000ms SLA, 3-Star Best Cost `0.0273¢/task` (27,289 UC), and perceived latency reduction > 90% against 4,200ms blocking HTTP.
6. **Graceful Fallback**:
   - `consumeSseReadableStream()` automatically falls back to `response.json()` when `Content-Type` is `application/json`, extracting `answer`, `reply`, `content`, or `advice` seamlessly.
7. **RAG Security Guard & Streaming DLP Invariants (`src/rag-security-guard/`)**:
   - `FailClosedScopeResolver` MUST fail closed (`allowed: false, scopes: []`) on missing `userId`, unwhitelisted scope, or verifier exception, and MUST pin non-DM channel requests to `currentScope`.
   - `StreamingDlpRedactor` MUST hold back incomplete tokens/credential lines so split secrets are scrubbed before emission; `ProgressiveMessageEditThrottler` MUST emit `SAFE_UPSTREAM_UNAVAILABLE_MESSAGE` on upstream errors without dumping raw RAG snippets.

## 2. Directory Layout

```
packages/ai-stream/
├── src/
│   ├── index.ts                  # Clean public re-exports
│   ├── edge-flush-headers.ts     # Anti-buffering headers & Nginx/Caddy configurations
│   ├── sse-protocol.ts           # OpenAI delta framing & UTF-8 safe incremental parser
│   ├── readable-stream-engine.ts # ReadableStream synthesis, smooth chunking & fetch consumer
│   ├── progressive-tier.ts       # Tier 0 (Cached) / Tier 1 (Single-Node) / Tier 2 (PubSub) & SLA
│   ├── rpm-rate-guard/           # Dual RPM/TPM token bucket, Full Jitter & pool router
│   ├── rag-security-guard/       # Streaming DLP redactor, fail-closed ACL & prompt boundary guard
│   │   ├── dlp-redactor.ts
│   │   ├── scope-acl.ts
│   │   ├── prompt-boundary.ts
│   │   ├── index.ts
│   │   └── index.test.ts         # 17 RAG security guard unit tests
│   └── index.test.ts             # 35 streaming & rate-guard unit tests
├── tsup.config.ts
├── tsconfig.json
├── package.json
├── README.md
└── AGENTS.md
```

## 3. Verification Commands

```bash
cd packages/ai-stream
pnpm test
pnpm typecheck
pnpm build
```
