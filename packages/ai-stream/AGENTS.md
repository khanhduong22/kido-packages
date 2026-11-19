# Package Directives: @kido/ai-stream

> **Scope**: Tier-1 AI Token Streaming, Server-Sent Events (SSE), Fetch ReadableStream Consumer, Edge Buffer Flushing, RPM/TPM Rate Guard, RAG Security Guard (Dual-Layer Guardrail Cascade & Canary Shield), Multi-Provider Fallback, 3-Tier RAG Pipeline, EDoS Quota Shield, Entity-Aware Semantic Cache, Intelligent Model Routing / FrugalGPT Cascade, Out-of-Band Offline Eval Gate, Structured Feature Launch Delivery, Full-Duplex Voice Streaming Pipeline & Rolling Summary Conversation Memory Suite.  
> **Standards Reference**: GonnaCrash World 3 Level 02 `faster_answers`, Level 03 `rpm_ceiling`, Level 07 `public_launch`, Level 08 `internal_docs_qa`, Level 09 `find_the_right_chunk`, Level 10 `fresh_docs_hourly`, Level 12 `bloated_tickets`, Level 13 `budget_burning_chatbot`, Level 14 `same_question_new_words`, Level 15 `cheap_model_first`, Level 18 `eval_before_release`, Level 19 `ai_feature_launch`, Level 20 `poisoned_chat_text`, Level 25 `voice_assistant_latency`, Level 26 `long_conversation_memory`, OpenAI Chat Completion Stream Protocol, WHATWG ReadableStream & TextDecoder Streaming Standards, RouteLLM, FrugalGPT, Shopify Storefront AI, Vercel AI SDK, Perplexity Product Cards, Llama Guard, Braintrust Canary, Anthropic Constitutional Classifiers, LiveKit Agents, Pipecat, Deepgram Streaming STT, ElevenLabs WebSocket TTS, LangChain ConversationSummaryBufferMemory, Mem0, Zep/Graphiti, Letta, Enterprise AI RAG & Offline Eval Architecture.

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
8. **RAG Security Guard, Streaming DLP & Level 20 Dual-Layer Guardrail Invariants (`src/rag-security-guard/`)**:
   - `FailClosedScopeResolver` MUST fail closed (`allowed: false, scopes: []`) on missing `userId`, unwhitelisted scope, or verifier exception, and MUST pin non-DM channel requests to `currentScope`.
   - `StreamingDlpRedactor` MUST hold back incomplete tokens/credential lines so split secrets are scrubbed before emission; `ProgressiveMessageEditThrottler` MUST emit `SAFE_UPSTREAM_UNAVAILABLE_MESSAGE` on upstream errors without dumping raw RAG snippets.
   - `DualLayerGuardrailCascade` MUST remain self-contained inside `src/rag-security-guard/` (zero external runtime deps, zero imports from sibling slices) and run Layer 1 (`evaluateFastJevGuard`: NFKC + zero-width strip + Base64/Hex/URL decoding in `'permissive'` mode with `0%` false-positive recall loss on tricky benign queries) -> Layer 2 (`evaluateSemanticJudgeGuard`: orthogonal roleplay/translation-exfil/tag-spoofing + async `customJudgeFn`) in series.
   - `CanaryStreamKillSwitch` MUST hold back at least `canaryToken.length + 8` chars (plus viable variant prefixes) so raw, case-folded, spaced, and Base64 canary leaks split across SSE chunks abort mid-stream with `0` leaked characters and emit a safe refusal.
   - `simulateLevel20PoisonedChatText()` verifies GonnaCrash Level 20 3-Star Best Cost `46,622 UC <= 54,000 UC` (`Jev [1,050] + Judge [18,283] + openai_small [27,289]`), `<= 0.1%` leak, `>= 99%` answered, and `<= 6,000ms` latency against `unguarded`, `single_jev_permissive`, `duplicate_jev_permissive`, and `strict_policy_guard`.
9. **Intelligent Model Routing & FrugalGPT Cascade Invariants (`src/model-router/`)**:
   - `src/model-router/` MUST remain 100% self-contained with zero imports from sibling slices (`rag-pipeline`, `semantic-cache`, `rpm-rate-guard`, etc.) and zero external runtime dependencies.
   - `PromptComplexityClassifier` MUST evaluate in `<1ms` without blocking I/O; `zero_cost` greetings/acknowledgments MUST never burn LLM tokens (`0¢`), `easy` queries MUST stay off `large`-tier RPM budgets, and `large`-tier RPM ceiling saturation MUST degrade gracefully (`small_fallback` / `static_fallback`) rather than crashing with HTTP 429.
   - `simulateLevel15CheapModelFirst()` verifies GonnaCrash Level 15 3-Star Best Cost `0.6599¢/task` (`659,856 UC <= 760,000 UC`), `>=99%` answered (`0` 429s), `<2,000ms` TTFT, `>=93%` hard accuracy, and `>=85%` overall accuracy.
10. **Out-of-Band Offline Eval Gate & Judge Calibration Invariants (`src/eval-gate/`)**:
   - `src/eval-gate/` MUST remain 100% self-contained with zero imports from sibling slices and zero external runtime dependencies.
   - `OfflineEvalGate` runs strictly out-of-band on the control plane (`liveHotPathLatencyMs: 0`) and MUST block release (`BLOCK_RELEASE`, preserving active prompt version intact) on any critical regression, pass rate `< 90%`, net drop vs baseline, cost/budget breach, or `p95TtftMs > maxTtftMs`.
   - `simulateLevel18EvalBeforeRelease()` verifies GonnaCrash Level 18 3-Star Best Cost `0.5422¢/task` (`542,218 UC <= 630,000 UC`), `100%` answered (`>=99%`), `420ms` TTFT (`<=2,000ms`), and `94.0%` accuracy (`>=90%`).
11. **Full-Stack Structured Launch Delivery Invariants (`src/structured-launch/`)**:
   - `src/structured-launch/` MUST remain 100% self-contained with zero imports from sibling slices and zero external runtime dependencies, and MUST NOT duplicate exponential-backoff math owned by `src/rpm-rate-guard/`.
   - `parsePartialJson` & `StreamingProductCardExtractor` MUST strip ` ```json ` fences, preserve Vietnamese diacritics & escaped quotes, drop incomplete trailing keys/colons/commas, close strings & `{`/`[` LIFO, and emit cards progressively as each `{...}` closes.
   - `ValidatedSemanticCacheGate` MUST reject malformed/NaN/schema-violating payloads at write time (`writeBlockedInvalidJson`), evict corrupt cached entries on read (`readEvictedInvalidJson`), and isolate entity fingerprints (`"size M"` never hits `"size L"`).
   - `streamWithWaitingFeedback` MUST flush `event: waiting\ndata: {...}\n\n` immediately when upstream `onRetry(attempt, delayMs, reason)` fires.
   - `simulateLevel19AiFeatureLaunch()` verifies GonnaCrash Level 19 Boss-Fight 3-Star Record `0.3558¢/task` (`355,785 UC <= 410,000 UC`), `>=99.9%` answered, `<=2,000ms` TTFT, and `>=94.0%` accuracy against all 5 failure modes.
12. **Full-Duplex Voice Streaming & Sentence-Level Chunking Invariants (`src/voice-pipeline/`)**:
   - `src/voice-pipeline/` MUST remain 100% self-contained with zero imports from sibling slices and zero external runtime dependencies.
   - `VoiceSentenceChunker` & `sanitizeForSpeech` MUST prevent false splits on bilingual EN/VI abbreviations (`Mr.`, `Dr.`, `TP.`, `v.v.`, `e.g.`), decimals/currency (`1.2s`, `150.000đ`, `1,200 ms`), URLs, and numbered lists while supporting early `firstClauseCommaFlush` and markdown stripping.
   - `VoiceTurnController` MUST enforce the full-duplex state machine (`idle -> listening -> processing -> speaking -> interrupted`) and propagate barge-in cancellation instantly via `AbortController` so `runVoiceStreamPipeline` emits zero stale audio after interruption while maintaining strict FIFO clause playback ordering under concurrent TTS synthesis.
   - `simulateLevel25VoiceAssistantLatency()` verifies GonnaCrash World 3 Level 25 (`voice_assistant_latency`) 3-Star Record `663,289 UC` (`289` App + `50,000` STT + `600,000` TTS + `13,000` `openai_small` <= `770,000 UC` budget) at `750ms <= 1,200ms` first audio, `87.0% >= 85%` accuracy, and `99.8% >= 99%` answered — proving `serial_batch` (`4,400ms`), `partial_streaming` (`2,740ms`), and `streaming_mid_model` (`openai_mid` -> `910,289 UC > 770,000 UC`) fail SLA.
13. **Conversation Memory Compression & Sliding Window Summarization Invariants (`src/conversation-memory/`)**:
   - `src/conversation-memory/` MUST remain 100% self-contained with zero imports from sibling slices and zero external runtime dependencies.
   - `extractConversationFacts` & `mergeMemoryFacts` MUST preserve durable entity anchors (order IDs, ticket IDs, SKUs, budgets, colors, plans, shipping, products) with latest-wins temporal superseding (`validTurn`, `supersededAtTurn`) so updated user constraints never conflict with stale turns.
   - `RollingSummaryMemory` MUST enforce strict `scope` (`per_chat` | `global`), `sharedWith` (`one_bot` | `all_bots`), bounded LRU `maxSessions`, TTL expiry (`nowFn`), and graceful fallback to `buildExtractiveRollingSummary` whenever a custom async `summarizer` fails or returns empty (zero silent catches, zero dropped memory).
   - Never place `Context Builder (Rules)` (`buildLastTurnOnlyPrompt`) upstream of `Conversation Memory` — hard-trimming to the last turn drops earlier entity anchors before summarization can see them (`memory_dropped`, accuracy `< 85%`).
   - `simulateLevel26LongConversationMemory()` verifies GonnaCrash World 3 Level 26 (`long_conversation_memory`) 3-Star Record **`40,289 UC`** (`289` App + `0` Memory + `40,000` `openai_small` <= `47,000 UC` / `0.0470¢` budget) with `>= 99%` answered & `>= 85%` accuracy against `full_history_naive` (`history_resent`), `last_turn_only_trap` (`memory_dropped`), `context_builder_before_memory_trap` (`memory_dropped`), and `rolling_summary_mid_model` (`budget_exceeded`).

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
│   ├── model-router/             # Intelligent Model Routing & FrugalGPT Cascade (Level 15)
│   ├── eval-gate/                # Out-of-Band Offline Eval Gate & LLM-as-a-Judge (Level 18)
│   ├── structured-launch/        # Partial JSON, Validated Cache & Waiting SSE Bridge (Level 19)
│   ├── voice-pipeline/           # Full-Duplex Voice Streaming, Sentence Chunker & Barge-In (Level 25)
│   ├── conversation-memory/      # Rolling Summary, Pinned Facts & Sliding Window Memory (Level 26)
│   └── index.test.ts             # Streaming, rate-guard, fallback & RAG unit tests
├── test/                         # Level 09/10/12/13/14/15/18/19/20/25/26 integration suites
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
