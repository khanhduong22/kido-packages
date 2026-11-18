# Package Directives: @kido/ai-stream

> **Scope**: Tier-1 AI Token Streaming, Server-Sent Events (SSE), Fetch ReadableStream Consumer, Edge Buffer Flushing, RPM/TPM Rate Guard, RAG Security Guard, Multi-Provider Fallback, 3-Tier RAG Pipeline, EDoS Quota Shield & Entity-Aware Semantic Cache Suite.  
> **Standards Reference**: GonnaCrash World 3 Level 02 `faster_answers`, Level 03 `rpm_ceiling`, Level 07 `public_launch`, Level 08 `internal_docs_qa`, Level 09 `find_the_right_chunk`, Level 10 `fresh_docs_hourly`, Level 12 `bloated_tickets`, Level 13 `budget_burning_chatbot`, Level 14 `same_question_new_words`, OpenAI Chat Completion Stream Protocol, WHATWG ReadableStream & TextDecoder Streaming Standards, Enterprise AI RAG Architecture.

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
5. **GonnaCrash SLA Compliance (Level 02, 03, 07 & 08)**:
   - `evaluateTtftSla()` verifies Level 02 TTFT <= 2,000ms SLA, 3-Star Best Cost `0.0273¢/task` (27,289 UC), and perceived latency reduction > 90% against 4,200ms blocking HTTP.
   - `simulateLevel03RpmCeiling()` verifies Level 03 Multi-Pool active-active load splitting and exponential backoff avoiding 100% of retry storms at `0.5403¢/task`.
   - `simulateLevel07PublicLaunch()` verifies Level 07 Multi-Provider Fallback Mesh (`openai_mid` -> `anthropic_mid`) with backoff sustaining `99.8%` answered SLA, TTFT <= 1s, and matching 3-Star Best Cost `0.3568¢/task` (356,759 UC).
   - `simulateLevel08InternalDocsQa()` verifies Level 08 RAG Pipeline (`pgvector` top_5 + `openai_mid` + streaming) sustaining `100%` answered SLA, TTFT ~850ms <= 3s, correctness `92.4%` >= 72%, and matching 3-Star Best Cost `0.9414¢/task` (941,357 UC).
6. **Graceful Fallback & Hedging Concurrency**:
   - `consumeSseReadableStream()` automatically falls back to `response.json()` when `Content-Type` is `application/json`, extracting `answer`, `reply`, `content`, or `advice` seamlessly.
   - `executeWithHedging()` launches fallback provider after `hedgeDelayMs` if primary token chunk hasn't arrived, immediately aborting the losing stream to prevent double billing.
7. **Strict Grounding & Anti-Hallucination Invariant**:
   - `buildGroundedPrompt()` injects strict negative constraints ("Do NOT guess, speculate, or hallucinate procedures that are not explicitly documented; explicitly state information is missing").
   - `extractSourceCitations()` parses `[Doc N]` references, enforcing verifiable attribution.
8. **RAG Security Guard & Streaming DLP Invariants (`src/rag-security-guard/`)**:
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
│   ├── rpm-rate-guard/           # Dual RPM/TPM token bucket, Full Jitter & pool router (Level 03)
│   ├── rag-security-guard/       # Streaming DLP redactor, fail-closed ACL & prompt boundary guard
│   ├── provider-fallback/        # Multi-Provider Circuit Breaker, Hedging & EWMA Router (Level 07)
│   ├── rag-pipeline/             # 3-Tier RAG Cascade, Reranker, Ingestion Pacer & Sanitizer (L08-L12)
│   ├── quota-manager/            # 3-Layer EDoS Shield & Per-User Token Quota (Level 13)
│   ├── semantic-cache/           # Entity-Aware Strict Semantic Cache (Level 14)
│   └── index.test.ts             # Streaming, rate-guard, fallback & RAG unit tests
├── test/                         # Level 09/10/12/13/14 integration suites
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
