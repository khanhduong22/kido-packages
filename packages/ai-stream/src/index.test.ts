import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSseResponseHeaders,
  CANONICAL_SSE_HEADERS,
  generateNginxSseLocationConfig,
  generateCaddySseProxyConfig,
} from './edge-flush-headers.js';
import {
  formatSseDataFrame,
  formatOpenAiDeltaFrame,
  formatSseEventFrame,
  formatSseDoneFrame,
  SseStreamParser,
  OpenAiDeltaChunk,
} from './sse-protocol.js';
import {
  tokenizeForSmoothStream,
  createSseTokenReadableStream,
  consumeSseReadableStream,
} from './readable-stream-engine.js';
import {
  Tier0CachedChunkStreamer,
  Tier1SingleNodeSseStreamer,
  Tier2DistributedPubSubSseStreamer,
  evaluateTtftSla,
} from './progressive-tier.js';
import {
  computeFullJitterBackoffMs,
  computeDecorrelatedJitterMs,
  parseDurationString,
  parseProviderRetryAfterMs,
  DualRpmTpmTokenBucket,
  MultiProviderQuotaPoolRouter,
  executeWithAiRateGuard,
  simulateLevel03RpmCeiling,
} from './rpm-rate-guard/index.js';
import {
  ProviderCircuitBreaker,
  DynamicHealthRouter,
  executeWithHedging,
  MultiProviderFallbackMesh,
  simulateLevel07PublicLaunch,
} from './provider-fallback/index.js';
import {
  chunkDocumentText,
  normalizeRagQuery,
  removeDiacritics,
  cosineSimilarity,
  cosineDistance,
  computeRrfScore,
  buildPgvectorSearchSql,
  buildPgvectorIndexSql,
  buildGroundedPrompt,
  extractSourceCitations,
  createRagCascadeOrchestrator,
  simulateLevel08InternalDocsQa,
  LocalCrossEncoderReranker,
  RemoteRerankApi,
  TwoStageRetrievalPipeline,
  createTwoStageRetrievalPipeline,
  simulateLevel09FindTheRightChunk,
  adaptDocumentChunkToCandidate,
  adaptCatalogProductToCandidate,
  RerankCandidate,
} from './rag-pipeline/index.js';



describe('@kido/ai-stream Test Suite', () => {
  // Test 1: Canonical SSE headers
  it('1. buildSseResponseHeaders returns canonical anti-buffering headers', () => {
    const headers = buildSseResponseHeaders();
    assert.equal(headers['Content-Type'], 'text/event-stream; charset=utf-8');
    assert.equal(headers['Cache-Control'], 'no-cache, no-transform');
    assert.equal(headers['Connection'], 'keep-alive');
    assert.equal(headers['X-Accel-Buffering'], 'no');
    assert.equal(headers['X-Content-Type-Options'], 'nosniff');
  });

  // Test 2: Merges extra headers
  it('2. buildSseResponseHeaders merges custom extra headers', () => {
    const headers = buildSseResponseHeaders({
      'X-Custom-Trace': 'trace-123',
      'Access-Control-Allow-Origin': '*',
    });
    assert.equal(headers['X-Custom-Trace'], 'trace-123');
    assert.equal(headers['Access-Control-Allow-Origin'], '*');
    assert.equal(headers['X-Accel-Buffering'], 'no');
  });

  // Test 3: Nginx SSE snippet
  it('3. generateNginxSseLocationConfig generates unbuffered proxy directives', () => {
    const config = generateNginxSseLocationConfig('/v1/chat/completions');
    assert.match(config, /location \/v1\/chat\/completions/);
    assert.match(config, /proxy_buffering off;/);
    assert.match(config, /proxy_cache off;/);
    assert.match(config, /chunked_transfer_encoding on;/);
  });

  // Test 4: Caddy SSE snippet
  it('4. generateCaddySseProxyConfig generates flush_interval -1 directives', () => {
    const config = generateCaddySseProxyConfig('/api/stream/*');
    assert.match(config, /@sse path \/api\/stream\/\*/);
    assert.match(config, /flush_interval -1/);
  });

  // Test 5: formatSseDataFrame
  it('5. formatSseDataFrame formats both string and JSON payloads', () => {
    const strFrame = formatSseDataFrame('hello world');
    assert.equal(strFrame, 'data: hello world\n\n');

    const jsonFrame = formatSseDataFrame({ score: 100 });
    assert.equal(jsonFrame, 'data: {"score":100}\n\n');
  });

  // Test 6: formatOpenAiDeltaFrame
  it('6. formatOpenAiDeltaFrame creates compliant chat.completion.chunk', () => {
    const frame = formatOpenAiDeltaFrame('Xin chào!', {
      id: 'chat-99',
      model: 'openai_small',
    });
    assert(frame.startsWith('data: '));
    assert(frame.endsWith('\n\n'));

    const json = JSON.parse(frame.slice(6, -2));
    assert.equal(json.id, 'chat-99');
    assert.equal(json.object, 'chat.completion.chunk');
    assert.equal(json.model, 'openai_small');
    assert.equal(json.choices[0].delta.content, 'Xin chào!');
    assert.equal(json.choices[0].finish_reason, null);
  });

  // Test 7: formatSseEventFrame
  it('7. formatSseEventFrame formats named events with optional ID', () => {
    const frameWithoutId = formatSseEventFrame('meta', { query: 'test' });
    assert.equal(frameWithoutId, 'event: meta\ndata: {"query":"test"}\n\n');

    const frameWithId = formatSseEventFrame('ping', 'pong', 'id-42');
    assert.equal(frameWithId, 'event: ping\nid: id-42\ndata: pong\n\n');
  });

  // Test 8: formatSseDoneFrame
  it('8. formatSseDoneFrame formats standard terminal [DONE] frame', () => {
    assert.equal(formatSseDoneFrame(), 'data: [DONE]\n\n');
  });

  // Test 9: SseStreamParser basic parsing
  it('9. SseStreamParser parses standard event blocks and custom events', () => {
    const parser = new SseStreamParser();
    const raw = 'event: greeting\ndata: {"msg":"Chào bạn"}\n\n';
    const events = parser.push(raw);

    assert.equal(events.length, 1);
    assert.equal(events[0].event, 'greeting');
    assert.equal(events[0].data, '{"msg":"Chào bạn"}');
    assert.deepEqual(events[0].parsedJson, { msg: 'Chào bạn' });
    assert.equal(events[0].isDone, false);
  });

  // Test 10: SseStreamParser ignores comments
  it('10. SseStreamParser ignores keepalive comments starting with colon', () => {
    const parser = new SseStreamParser();
    const raw = ': stream-open\n: keepalive ping\ndata: actual-content\n\n';
    const events = parser.push(raw);

    assert.equal(events.length, 1);
    assert.equal(events[0].data, 'actual-content');
  });

  // Test 11: SseStreamParser multi-line data
  it('11. SseStreamParser joins multiple data: lines with newlines per SSE standard', () => {
    const parser = new SseStreamParser();
    const raw = 'data: line 1\ndata: line 2\ndata: line 3\n\n';
    const events = parser.push(raw);

    assert.equal(events.length, 1);
    assert.equal(events[0].data, 'line 1\nline 2\nline 3');
  });

  // Test 12: SseStreamParser isDone detection
  it('12. SseStreamParser detects [DONE] and done event names', () => {
    const parser = new SseStreamParser();
    const ev1 = parser.push('data: [DONE]\n\n');
    assert.equal(ev1.length, 1);
    assert.equal(ev1[0].isDone, true);

    const ev2 = parser.push('event: done\ndata: {"finished":true}\n\n');
    assert.equal(ev2.length, 1);
    assert.equal(ev2[0].isDone, true);
  });

  // Test 13: Multi-byte UTF-8 boundary splitting test (Crucial!)
  it('13. SseStreamParser handles multi-byte UTF-8 bytes split across TCP packets (1 byte at a time)', () => {
    const parser = new SseStreamParser();
    const originalText = 'Xin chào! Aria AI Assistant 🦫🎨 cọ vẽ tuyệt đỉnh!';
    const rawPayload = `data: ${JSON.stringify({ content: originalText })}\n\n`;
    const buffer = Buffer.from(rawPayload, 'utf-8');

    const receivedEvents: any[] = [];
    // Feed one single byte per push to simulate the most fragmented TCP packet stream possible
    for (let i = 0; i < buffer.length; i++) {
      const singleByteSlice = buffer.subarray(i, i + 1);
      const events = parser.push(singleByteSlice);
      if (events.length > 0) {
        receivedEvents.push(...events);
      }
    }
    const flushed = parser.flush();
    receivedEvents.push(...flushed);

    assert.equal(receivedEvents.length, 1);
    assert.equal(receivedEvents[0].parsedJson.content, originalText);
    assert(!receivedEvents[0].parsedJson.content.includes('\uFFFD'));
  });

  // Test 14: tokenizeForSmoothStream join parity
  it('14. tokenizeForSmoothStream preserves exact string reconstruction (chunks.join("") === text)', () => {
    const text = 'Chào mừng bạn đến với Kido Packages! Cùng khám phá SSE streaming.';
    const chunks = tokenizeForSmoothStream(text, 2);
    assert(chunks.length > 1);
    assert.equal(chunks.join(''), text);
  });

  // Test 15: tokenizeForSmoothStream preserves markdown, emojis, codeblocks
  it('15. tokenizeForSmoothStream preserves Markdown syntax and emoji clusters', () => {
    const text = '### 🎨 Aria Art Guide\n\n```typescript\nconst speed = 100;\n```\n- Bullet 🦫';
    const chunks = tokenizeForSmoothStream(text, 3);
    assert.equal(chunks.join(''), text);
  });

  // Test 16: tokenizeForSmoothStream empty/edge inputs
  it('16. tokenizeForSmoothStream handles empty string and single token', () => {
    assert.deepEqual(tokenizeForSmoothStream(''), []);
    assert.deepEqual(tokenizeForSmoothStream('hello', 5), ['hello']);
  });

  // Test 17: createSseTokenReadableStream
  it('17. createSseTokenReadableStream flushes stream-open, meta, delta tokens and done', async () => {
    const stream = createSseTokenReadableStream({
      meta: { model: 'openai_small', session: 's-1' },
      tokenSource: ['Xin ', 'chào, ', 'Aria!'],
      chunkDelayMs: 2,
    });

    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let accumulatedRaw = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) accumulatedRaw += decoder.decode(value);
    }

    assert(accumulatedRaw.includes(': stream-open\n\n'));
    assert(accumulatedRaw.includes('event: meta\ndata: {"model":"openai_small","session":"s-1"}\n\n'));
    assert(accumulatedRaw.includes('Xin '));
    assert(accumulatedRaw.includes('Aria!'));
    assert(accumulatedRaw.includes('event: done\n'));
    assert(accumulatedRaw.includes('data: [DONE]\n\n'));
  });

  // Test 18: consumeSseReadableStream with text/event-stream
  it('18. consumeSseReadableStream consumes text/event-stream with TTFT metrics', async () => {
    const sseBody = [
      ': stream-open\n\n',
      'event: meta\ndata: {"recommendation":"watercolor"}\n\n',
      formatOpenAiDeltaFrame('Aria '),
      formatOpenAiDeltaFrame('Assistant!'),
      formatSseDoneFrame(),
    ].join('');

    const response = new Response(sseBody, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
    });

    const tokens: string[] = [];
    let receivedMeta: any = null;

    const result = await consumeSseReadableStream(response, {
      onMeta: (meta) => {
        receivedMeta = meta;
      },
      onToken: (tok) => {
        tokens.push(tok);
      },
    });

    assert.equal(result.text, 'Aria Assistant!');
    assert.deepEqual(receivedMeta, { recommendation: 'watercolor' });
    assert.deepEqual(tokens, ['Aria ', 'Assistant!']);
    assert.equal(result.metrics.mode, 'sse');
    assert.equal(result.metrics.chunkCount, 2);
    assert(result.metrics.ttftMs >= 0);
  });

  // Test 19: consumeSseReadableStream with application/json fallback
  it('19. consumeSseReadableStream gracefully falls back on application/json', async () => {
    const jsonBody = JSON.stringify({
      advice: 'Sử dụng giấy vẽ màu nước 300gsm để đạt độ loang màu tối ưu.',
      meta: { source: 'cached-faq' },
    });

    const response = new Response(jsonBody, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

    let onDoneCalled = false;
    const result = await consumeSseReadableStream(response, {
      onDone: () => {
        onDoneCalled = true;
      },
    });

    assert.equal(result.text, 'Sử dụng giấy vẽ màu nước 300gsm để đạt độ loang màu tối ưu.');
    assert.deepEqual(result.meta, { source: 'cached-faq' });
    assert.equal(result.metrics.mode, 'json-fallback');
    assert.equal(result.metrics.chunkCount, 1);
    assert(onDoneCalled);
  });

  // Test 20: Tier0CachedChunkStreamer
  it('20. Tier0CachedChunkStreamer synthesizes smooth stream from cached text with zero LLM cost', async () => {
    const tier0 = new Tier0CachedChunkStreamer();
    const stream = tier0.streamCachedResponse('Màu nước Daniel Smith', { sku: 'DS-01' }, 1);

    const response = new Response(stream, {
      headers: { 'Content-Type': 'text/event-stream' },
    });

    const result = await consumeSseReadableStream(response);
    assert.equal(result.text, 'Màu nước Daniel Smith');
    assert.equal(result.meta.cacheHit, true);
    assert.equal(result.meta.tier, 'tier0-cached');
  });

  // Test 21: Tier1SingleNodeSseStreamer
  it('21. Tier1SingleNodeSseStreamer creates Response with unbuffered edge headers', async () => {
    const tier1 = new Tier1SingleNodeSseStreamer();
    const response = tier1.createProxyResponse(['Token 1 ', 'Token 2'], {
      model: 'openai_small',
      extraHeaders: { 'X-Test': 'true' },
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Content-Type'), 'text/event-stream; charset=utf-8');
    assert.equal(response.headers.get('X-Accel-Buffering'), 'no');
    assert.equal(response.headers.get('X-Test'), 'true');

    const result = await consumeSseReadableStream(response);
    assert.equal(result.text, 'Token 1 Token 2');
  });

  // Test 22: Tier2DistributedPubSubSseStreamer
  it('22. Tier2DistributedPubSubSseStreamer fans out tokens to distributed subscribers', async () => {
    const tier2 = new Tier2DistributedPubSubSseStreamer();
    const channelId = 'room-abc';
    const stream = tier2.subscribeChannelStream(channelId);

    const consumePromise = consumeSseReadableStream(
      new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } })
    );

    // Give microtask tick to let subscription attach
    await new Promise((resolve) => setTimeout(resolve, 5));

    await tier2.publishToken(channelId, 'Xin ');
    await tier2.publishToken(channelId, 'Aria!');
    await tier2.publishDone(channelId, { totalTokens: 2 });

    const result = await consumePromise;
    assert.equal(result.text, 'Xin Aria!');
  });

  // Test 23: evaluateTtftSla - World 3 Level 02 'faster_answers' Success
  it('23. evaluateTtftSla validates GonnaCrash Level 02 faster_answers (TTFT ~350ms <= 2,000ms SLA, 3-Star Best Cost: 0.0273¢)', () => {
    const report = evaluateTtftSla({
      ttftMs: 345,
      totalDurationMs: 1450,
      chunkCount: 38,
      totalChars: 180,
      mode: 'sse',
    }, 2000);

    assert.equal(report.levelKey, 'faster_answers');
    assert.equal(report.withinSla, true);
    assert.equal(report.threeStarAwarded, true);
    assert.equal(report.costPerTaskUsd, 0.000273);
    assert.equal(report.bestCostUsd, 0.000273);
    assert(report.perceivedLatencyReductionPercent >= 90); // ~91.8% reduction vs 4,200ms blocking HTTP
    assert(report.summary.includes('PASSED'));
  });

  // Test 24: evaluateTtftSla - SLA Breach case
  it('24. evaluateTtftSla detects breach when TTFT exceeds target threshold', () => {
    const report = evaluateTtftSla({
      ttftMs: 2500,
      totalDurationMs: 4500,
      chunkCount: 10,
      totalChars: 50,
      mode: 'sse',
    }, 2000);

    assert.equal(report.withinSla, false);
    assert.equal(report.threeStarAwarded, false);
    assert(report.summary.includes('BREACHED'));
  });

  // Test 25: computeFullJitterBackoffMs
  it('25. computeFullJitterBackoffMs bounds jitter and honors provider retryAfterMs', () => {
    const delay1 = computeFullJitterBackoffMs({
      attempt: 2,
      baseDelayMs: 100,
      maxDelayMs: 2000,
      rng: () => 0.5,
      mode: 'full',
    });
    // temp = min(2000, 100 * 2^2) = 400. 0.5 * 400 = 200
    assert.equal(delay1, 200);

    const delayEqual = computeFullJitterBackoffMs({
      attempt: 2,
      baseDelayMs: 100,
      maxDelayMs: 2000,
      rng: () => 0.5,
      mode: 'equal',
    });
    // temp = 400. 400/2 + 0.5*(400/2) = 200 + 100 = 300
    assert.equal(delayEqual, 300);

    // With provider retryAfterMs
    const delayWithRetryAfter = computeFullJitterBackoffMs({
      attempt: 1,
      baseDelayMs: 100,
      maxDelayMs: 2000,
      retryAfterMs: 800,
      rng: () => 0.1,
    });
    assert.equal(delayWithRetryAfter, 800);
  });

  // Test 26: computeDecorrelatedJitterMs
  it('26. computeDecorrelatedJitterMs decorrelates delay between base and 3x previous delay', () => {
    const delay = computeDecorrelatedJitterMs({
      previousDelayMs: 500,
      baseDelayMs: 100,
      maxDelayMs: 5000,
      rng: () => 0.5,
    });
    // prev*3 - base = 1500 - 100 = 1400. 0.5 * 1400 + 100 = 800
    assert.equal(delay, 800);
  });

  // Test 27: parseDurationString
  it('27. parseDurationString parses ms, s, m, h and composite duration strings', () => {
    assert.equal(parseDurationString('120ms'), 120);
    assert.equal(parseDurationString('1.5s'), 1500);
    assert.equal(parseDurationString('1m30s'), 90000);
    assert.equal(parseDurationString('6m0s'), 360000);
    assert.equal(parseDurationString('2h'), 7200000);
    assert.equal(parseDurationString('500'), 500000); // pure seconds string
    assert.equal(parseDurationString('invalid'), null);
  });

  // Test 28: parseProviderRetryAfterMs
  it('28. parseProviderRetryAfterMs extracts retry duration from diverse headers and error shapes', () => {
    // Direct ms header
    assert.equal(parseProviderRetryAfterMs({ 'retry-after-ms': '350' }), 350);

    // Standard retry-after seconds
    assert.equal(parseProviderRetryAfterMs({ 'retry-after': '3' }), 3000);

    // OpenAI reset string
    assert.equal(parseProviderRetryAfterMs({ 'x-ratelimit-reset-requests': '2.5s' }), 2500);

    // Gemini error message
    const geminiError = new Error('Resource exhausted. retryDelay: "1.8s"');
    assert.equal(parseProviderRetryAfterMs(geminiError), 1800);

    // Fallback error message
    const msError = new Error('Please retry after 400ms');
    assert.equal(parseProviderRetryAfterMs(msError), 400);
  });

  // Test 29: DualRpmTpmTokenBucket token estimation and acquisition
  it('29. DualRpmTpmTokenBucket estimates tokens and manages dual RPM/TPM capacity', () => {
    let mockTime = 1000;
    const bucket = new DualRpmTpmTokenBucket({
      maxRpm: 60, // 1 req/sec
      maxTpm: 6000, // 100 tokens/sec
      nowFn: () => mockTime,
    });

    assert.equal(bucket.estimatePromptTokens('Hello world!'), 4); // 12 chars / 3.5 ~ 4 tokens

    // Acquire valid capacity
    const acq1 = bucket.tryAcquire(500);
    assert.equal(acq1.allowed, true);
    assert.equal(acq1.remainingRpm, 59);
    assert.equal(acq1.remainingTpm, 5500);

    // Attempt to exceed RPM by acquiring 60 more requests
    for (let i = 0; i < 59; i++) {
      bucket.tryAcquire(10);
    }
    const acqExceeded = bucket.tryAcquire(10);
    assert.equal(acqExceeded.allowed, false);
    assert.equal(acqExceeded.limitingFactor, 'rpm');
    assert(acqExceeded.waitMs > 0);

    // Advance time by 2000ms (2 seconds = +2 RPM refilled)
    mockTime += 2000;
    assert.equal(bucket.canAcquire(10), true);
  });

  // Test 30: DualRpmTpmTokenBucket syncFromProviderHeaders
  it('30. DualRpmTpmTokenBucket syncs state from provider rate limit headers', () => {
    const bucket = new DualRpmTpmTokenBucket({
      maxRpm: 100,
      maxTpm: 10000,
    });

    bucket.syncFromProviderHeaders({
      'x-ratelimit-remaining-requests': '15',
      'x-ratelimit-remaining-tokens': '2400',
    });

    const acq = bucket.tryAcquire(100);
    assert.equal(acq.remainingRpm, 14);
    assert.equal(acq.remainingTpm, 2300);
  });

  // Test 31: executeWithAiRateGuard retries on 429 and succeeds
  it('31. executeWithAiRateGuard retries on HTTP 429 and succeeds on subsequent try', async () => {
    let calls = 0;
    const retryHistory: any[] = [];

    const result = await executeWithAiRateGuard(
      async () => {
        calls++;
        if (calls === 1) {
          const err: any = new Error('Rate limit exceeded');
          err.status = 429;
          err.headers = { 'retry-after-ms': '10' };
          throw err;
        }
        return 'success-from-llm';
      },
      {
        baseDelayMs: 5,
        maxDelayMs: 50,
        onRetry: (info) => retryHistory.push(info),
      }
    );

    assert.equal(result, 'success-from-llm');
    assert.equal(calls, 2);
    assert.equal(retryHistory.length, 1);
    assert.equal(retryHistory[0].retryAfterMs, 10);
  });

  // Test 32: executeWithAiRateGuard exhausts maxRetries on permanent failure
  it('32. executeWithAiRateGuard throws after exceeding maxRetries', async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        executeWithAiRateGuard(
          async () => {
            calls++;
            const err: any = new Error('429 Too Many Requests');
            err.status = 429;
            throw err;
          },
          { maxRetries: 2, baseDelayMs: 2, maxDelayMs: 10 }
        ),
      /429 Too Many Requests/
    );
    assert.equal(calls, 3); // initial + 2 retries
  });

  // Test 33: simulateLevel03RpmCeiling
  it('33. simulateLevel03RpmCeiling proves GonnaCrash Level 03 multi-pool + backoff 3-Star math', () => {
    const sim = simulateLevel03RpmCeiling();
    assert.equal(sim.instantRetrySuccessRate, 20); // 20% due to retry storm
    assert.equal(sim.singleProviderBackoffSuccessRate, 63.6); // 1x openai_mid crashes at 1:33!
    assert.equal(sim.multiPoolBackoffSuccessRate, 100); // 2x mid pools active-active 50/50
    assert.equal(sim.backoffRetrySuccessRate, 100); // 100% >= 99% SLA
    assert.equal(sim.threeStarAwarded, true);
    assert.equal(sim.qualityPercent, 92);
    assert.equal(sim.costPerTaskUsd, 0.005403); // 0.5403¢/task (540,275 UC)
    assert(sim.ttftMs < 2000);
    assert(sim.verdict.includes('PASSED'));
  });

  // Test 34: MultiProviderQuotaPoolRouter active-active 50/50 quota sharding
  it('34. MultiProviderQuotaPoolRouter splits load 50/50 across independent vendor RPM/TPM pools', async () => {
    const poolOpenAi = new DualRpmTpmTokenBucket({ maxRpm: 2, maxTpm: 10000 });
    const poolAnthropic = new DualRpmTpmTokenBucket({ maxRpm: 2, maxTpm: 10000 });
    const router = new MultiProviderQuotaPoolRouter([
      { id: 'openai_mid', bucket: poolOpenAi },
      { id: 'anthropic_mid', bucket: poolAnthropic },
    ]);

    const servedBy: string[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await router.execute(async (providerId) => {
        servedBy.push(providerId);
        return `ok-${providerId}`;
      }, { estimatedTokens: 500 });
      assert(res.value.startsWith('ok-'));
    }

    // 4 burst requests succeed immediately across 2x 2-RPM pools (2 each) with 0 retries!
    assert.equal(servedBy.filter((p) => p === 'openai_mid').length, 2);
    assert.equal(servedBy.filter((p) => p === 'anthropic_mid').length, 2);
  });

  // Test 35: MultiProviderQuotaPoolRouter instant sibling failover on HTTP 429 (0ms wait)
  it('35. MultiProviderQuotaPoolRouter fails over immediately (0ms delay) to sibling pool on HTTP 429', async () => {
    const router = new MultiProviderQuotaPoolRouter([
      { id: 'openai_mid', bucket: new DualRpmTpmTokenBucket({ maxRpm: 60, maxTpm: 60000 }) },
      { id: 'anthropic_mid', bucket: new DualRpmTpmTokenBucket({ maxRpm: 60, maxTpm: 60000 }) },
    ]);

    const retryDelays: number[] = [];
    const res = await router.execute(
      async (providerId) => {
        if (providerId === 'openai_mid') {
          const err: any = new Error('429 rate limit exceeded');
          err.status = 429;
          throw err;
        }
        return 'answered-by-anthropic';
      },
      {
        estimatedTokens: 300,
        onRetry: ({ delayMs }) => retryDelays.push(delayMs),
      }
    );

    assert.equal(res.providerId, 'anthropic_mid');
    assert.equal(res.value, 'answered-by-anthropic');
    assert.deepEqual(retryDelays, [0]); // 0ms wait because sibling pool had immediate capacity!
  });

  // Test 36: ProviderCircuitBreaker lifecycle transitions (CLOSED -> OPEN -> HALF_OPEN -> CLOSED)
  it('36. ProviderCircuitBreaker transitions CLOSED -> OPEN -> HALF_OPEN -> CLOSED', () => {
    let mockTime = 1000;
    const cb = new ProviderCircuitBreaker({
      failureThreshold: 2,
      successThreshold: 2,
      resetTimeoutMs: 5000,
      now: () => mockTime,
    });

    assert.equal(cb.getState(), 'CLOSED');
    assert.equal(cb.canAttempt(), true);

    // 1st failure
    cb.recordFailure(new Error('500 Internal Server Error'));
    assert.equal(cb.getState(), 'CLOSED');

    // 2nd failure trips breaker
    cb.recordFailure(new Error('503 Service Unavailable'));
    assert.equal(cb.getState(), 'OPEN');
    assert.equal(cb.canAttempt(), false);

    // Fast-forward time before cooldown
    mockTime += 2000;
    assert.equal(cb.getState(), 'OPEN');
    assert.equal(cb.canAttempt(), false);

    // Fast-forward time past 5000ms cooldown
    mockTime += 4000;
    assert.equal(cb.getState(), 'HALF_OPEN');
    assert.equal(cb.canAttempt(), true);

    // 1st probe success
    cb.recordSuccess();
    assert.equal(cb.getState(), 'HALF_OPEN');

    // 2nd probe success closes breaker
    cb.recordSuccess();
    assert.equal(cb.getState(), 'CLOSED');
    assert.equal(cb.getStats().failureCount, 0);
  });

  // Test 37: DynamicHealthRouter tracks EWMA latency and handles auto-quarantine
  it('37. DynamicHealthRouter tracks EWMA latency, error rate, and sorts candidates', () => {
    const router = new DynamicHealthRouter([
      { id: 'openai', model: 'openai_mid', priority: 0 },
      { id: 'anthropic', model: 'anthropic_mid', priority: 1 },
    ], { ewmaAlpha: 0.5 });

    // Initial candidates: openai is priority 0, anthropic is priority 1
    let cands = router.selectCandidates();
    assert.equal(cands[0].endpoint.id, 'openai');
    assert.equal(cands[1].endpoint.id, 'anthropic');

    // Record sample latencies
    router.recordSuccess('openai', 400);
    router.recordSuccess('openai', 300); // EWMA: 0.5 * 300 + 0.5 * 400 = 350
    assert.equal(router.getProvider('openai')?.ewmaLatencyMs, 350);

    // Trip OpenAI breaker
    router.recordFailure('openai', new Error('500 Outage'));
    router.recordFailure('openai', new Error('500 Outage'));
    router.recordFailure('openai', new Error('500 Outage'));

    // Candidates now immediately select Anthropic as #1
    cands = router.selectCandidates();
    assert.equal(cands[0].endpoint.id, 'anthropic');
  });

  // Test 38: executeWithHedging resolves primary when fast without firing fallback
  it('38. executeWithHedging returns primary stream when primary responds before hedge delay', async () => {
    const encoder = new TextEncoder();
    let fallbackCalled = false;

    const res = await executeWithHedging(
      async () => {
        return new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('data: primary-chunk-1\n\n'));
            controller.close();
          },
        });
      },
      async () => {
        fallbackCalled = true;
        return new ReadableStream();
      },
      'primary',
      'fallback',
      { hedgeDelayMs: 200 }
    );

    assert.equal(res.providerId, 'primary');
    assert.equal(res.hedged, false);
    assert.equal(fallbackCalled, false);

    const reader = res.stream.getReader();
    const { value } = await reader.read();
    assert(new TextDecoder().decode(value).includes('primary-chunk-1'));
  });

  // Test 39: executeWithHedging fires fallback on slow primary and aborts loser
  it('39. executeWithHedging launches fallback when primary lags and races first chunk', async () => {
    const encoder = new TextEncoder();
    let primaryAborted = false;

    const res = await executeWithHedging(
      async (signal) => {
        signal.addEventListener('abort', () => {
          primaryAborted = true;
        });
        // Slow primary that sleeps 500ms
        await new Promise((r) => setTimeout(r, 500));
        return new ReadableStream();
      },
      async () => {
        // Fast fallback that answers in 10ms
        await new Promise((r) => setTimeout(r, 10));
        return new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('data: fallback-chunk-1\n\n'));
            controller.close();
          },
        });
      },
      'openai',
      'anthropic',
      { hedgeDelayMs: 50 } // Low hedge delay to trigger race quickly
    );

    assert.equal(res.providerId, 'anthropic');
    assert.equal(res.hedged, true);
    assert.equal(primaryAborted, true);

    const reader = res.stream.getReader();
    const { value } = await reader.read();
    assert(new TextDecoder().decode(value).includes('fallback-chunk-1'));
  });

  // Test 40: MultiProviderFallbackMesh instant failover from OpenAI to Anthropic
  it('40. MultiProviderFallbackMesh fails over immediately (0ms wait) from Primary to Fallback on 500', async () => {
    const encoder = new TextEncoder();
    const mesh = new MultiProviderFallbackMesh({
      providers: [
        { id: 'openai_mid', model: 'openai_mid', priority: 0 },
        { id: 'anthropic_mid', model: 'anthropic_mid', priority: 1 },
      ],
    });

    const servedProviders: string[] = [];

    const res = await mesh.executeStream(async (ep) => {
      servedProviders.push(ep.id);
      if (ep.id === 'openai_mid') {
        const err: any = new Error('500 Internal Server Error (OpenAI Degraded)');
        err.status = 500;
        throw err;
      }
      return new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: token-from-claude\n\n'));
          controller.close();
        },
      });
    });

    assert.equal(res.providerId, 'anthropic_mid');
    assert.equal(res.model, 'anthropic_mid');
    assert.equal(res.attempts, 2);
    assert.deepEqual(servedProviders, ['openai_mid', 'anthropic_mid']);
  });

  // Test 41: simulateLevel07PublicLaunch verifies GonnaCrash Level 07 3-Star metrics
  it('41. simulateLevel07PublicLaunch proves GonnaCrash Level 07 3-Star SLA & Best Cost', () => {
    // 1. Without fallback: Answered drops to ~65% (fails >= 99.5% SLA)
    const noFallback = simulateLevel07PublicLaunch({ hasFallback: false, hasRetryBackoff: false });
    assert.equal(noFallback.passedAnsweredSla, false);
    assert.equal(noFallback.isThreeStarRecord, false);

    // 2. With fallback but without retry backoff: Drops ~4% at edge transitions (fails >= 99.5% SLA)
    const fallbackNoRetry = simulateLevel07PublicLaunch({ hasFallback: true, hasRetryBackoff: false });
    assert.equal(fallbackNoRetry.passedAnsweredSla, false);

    // 3. Complete Tier-1 Multi-Provider Fallback Mesh + Backoff: Hits 100% 3-Star SLA!
    const winning = simulateLevel07PublicLaunch({ hasFallback: true, hasRetryBackoff: true });
    assert.equal(winning.passedAnsweredSla, true);
    assert(winning.answeredPpm >= 995_000); // >= 99.5%
    assert.equal(winning.passedTtftSla, true);
    assert(winning.averageTtftMs <= 1000); // TTFT <= 1s
    assert.equal(winning.passedCorrectSla, true);
    assert(winning.correctPpm >= 920_000); // >= 92%
    assert.equal(winning.passedCostSla, true);
    assert.equal(winning.costPerTaskUc, 356759); // 356,759 UC (0.3568¢/task)
    assert.equal(winning.costPerTaskCents, 0.3568);
    assert.equal(winning.isThreeStarRecord, true);
    assert.equal(winning.outageHandledGracefully, true);
  });

  // Test 42: chunkDocumentText chunking with token bounds & semantic overlap
  it('42. chunkDocumentText splits document into overlapping chunks with token estimation', () => {
    const text = `
Quy trình xin nghỉ phép tại Acme Store:
Nhân viên cần gửi đơn xin nghỉ phép trước tối thiểu 24 giờ trên ứng dụng di động.

Quy định chấm công và ân hạn:
Hệ thống cho phép ân hạn 1 phút so với giờ bắt đầu ca làm việc đã đăng ký.
Từ phút thứ 2 trở đi, lượt chấm công sẽ bị ghi nhận vào danh sách đi muộn.

Chính sách thưởng nóng 200.000 ₫:
Nhân viên đạt trên 130 giờ công trong tháng sẽ được thưởng nóng 200k cộng vào bảng lương.
    `.trim();

    const chunks = chunkDocumentText('doc_acme_sop', text, {
      maxTokens: 50,
      overlapTokens: 15,
    });

    assert(chunks.length >= 2);
    assert.equal(chunks[0].documentId, 'doc_acme_sop');
    assert.equal(chunks[0].chunkIndex, 0);
    assert(chunks[0].content.includes('nghỉ phép'));
    assert(chunks[0].tokenCount > 0);

    // Empty text returns empty array
    assert.deepEqual(chunkDocumentText('doc_empty', ''), []);
  });

  // Test 43: Pure vector math & RRF calculation
  it('43. Vector math calculates cosine similarity/distance and RRF fusion score', () => {
    const vecA = [1, 0, 0];
    const vecB = [1, 0, 0];
    const vecC = [0, 1, 0];
    const vecNear = [0.99, 0.05, 0];

    // Identical vectors
    assert.equal(Number(cosineSimilarity(vecA, vecB).toFixed(4)), 1);
    assert.equal(Number(cosineDistance(vecA, vecB).toFixed(4)), 0);

    // Orthogonal vectors
    assert.equal(Number(cosineSimilarity(vecA, vecC).toFixed(4)), 0);
    assert.equal(Number(cosineDistance(vecA, vecC).toFixed(4)), 1);

    // Near-identical vectors
    assert(cosineDistance(vecA, vecNear) < 0.05);

    // Reciprocal Rank Fusion: RRF(1, 1, 60) = 1/61 + 1/61 = 2/61 ≈ 0.032787
    const rrfBoth = computeRrfScore(1, 1, 60);
    assert.equal(rrfBoth, 0.032787);

    // Vector rank 1 only: 1/61 ≈ 0.016393
    const rrfVectorOnly = computeRrfScore(1, null, 60);
    assert.equal(rrfVectorOnly, 0.016393);
  });

  // Test 44: buildPgvectorSearchSql generates parameterized SQL for vector & halfvec
  it('44. buildPgvectorSearchSql and buildPgvectorIndexSql generate valid pgvector queries', () => {
    const search = buildPgvectorSearchSql({
      tableName: 'DocumentChunk',
      queryVector: [0.1, 0.2, 0.3],
      topK: 5,
      tenantId: 'acme',
      useHalfvec: true,
    });

    assert(search.sql.includes('DocumentChunk'));
    assert(search.sql.includes('halfvec <=>'));
    assert(search.sql.includes('LIMIT 5'));
    assert(search.sql.includes('"tenantId" = \'acme\''));
    assert.equal(search.vectorLiteral, '[0.1,0.2,0.3]');

    const indexSql = buildPgvectorIndexSql({
      tableName: 'DocumentChunk',
      dimensions: 1536,
      useHalfvec: true,
    });
    assert(indexSql.includes('CREATE INDEX IF NOT EXISTS'));
    assert(indexSql.includes('USING hnsw (embedding halfvec_cosine_ops)'));
  });

  // Test 45: buildGroundedPrompt & extractSourceCitations
  it('45. buildGroundedPrompt creates anti-hallucination prompt and extracts citations', () => {
    const chunks = [
      { id: 'c1', title: 'Quy chế nghỉ phép', path: 'sop/leave.md', content: 'Nghỉ phép báo trước 24h.' },
      { id: 'c2', title: 'Chính sách thưởng nóng', path: 'sop/bonus.md', content: 'Thưởng 200k khi đạt 130 giờ công.' },
    ];

    const result = buildGroundedPrompt('Nghỉ phép cần báo trước bao lâu?', chunks, {
      companyName: 'ACME CORP',
    });

    assert(result.prompt.includes('ACME CORP'));
    assert(result.prompt.includes('Do NOT guess, speculate, or hallucinate'));
    assert(result.prompt.includes('[Doc 1] Quy chế nghỉ phép'));
    assert(result.prompt.includes('[Doc 2] Chính sách thưởng nóng'));
    assert.equal(result.sources.length, 2);

    // Citations extractor
    const citations = extractSourceCitations('Theo quy chế [Doc 1], bạn cần báo trước 24h, kèm thưởng [Doc 2].');
    assert.deepEqual(citations, [1, 2]);
  });

  // Test 46: RagCascadeOrchestrator 3-tier cascade short-circuits
  it('46. RagCascadeOrchestrator cascades Tier 1 -> Tier 2 -> Tier 3 with cache write-back', async () => {
    let embedCalls = 0;
    let vectorCalls = 0;
    let llmCalls = 0;

    const orchestrator = createRagCascadeOrchestrator({
      canonicalFaqs: [
        {
          intent: 'late_penalty',
          keywords: ['di tre phat sao', 'di muon phat sao'],
          reply: 'Ân hạn 1 phút, sau đó trừ chuyên cần.',
          sources: ['canonical:sop:late_penalty'],
        },
      ],
      semanticCacheThreshold: 0.12,
      embedQuery: async () => {
        embedCalls++;
        return [0.9, 0.1, 0.05];
      },
      searchVectorDb: async () => {
        vectorCalls++;
        return [
          { id: 'c1', title: 'Quy trình hoàn tiền', path: 'sop/refund.md', content: 'Hoàn tiền 100% nếu hàng vỡ nát.' },
        ];
      },
      callLlm: async () => {
        llmCalls++;
        return 'Dạ quy trình hoàn tiền 100% nếu hàng vỡ [Doc 1].';
      },
    });

    // 1. Tier 1: Canonical SOP Grep Match (0 embed, 0 vector, 0 LLM calls)
    const t1Res = await orchestrator.answerQuestion('Đi trễ phạt sao ạ?');
    assert.equal(t1Res.tier, 'TIER_1_EXACT_OR_GREP');
    assert.equal(t1Res.cached, true);
    assert(t1Res.answer.includes('Ân hạn 1 phút'));
    assert.equal(embedCalls, 0);
    assert.equal(llmCalls, 0);

    // 2. Tier 3: Uncached query -> RAG vector retrieval + LLM generation
    const t3Res = await orchestrator.answerQuestion('Khách làm vỡ hàng thì xử lý hoàn tiền thế nào?');
    assert.equal(t3Res.tier, 'TIER_3_RAG_LLM');
    assert.equal(t3Res.cached, false);
    assert(t3Res.answer.includes('hoàn tiền 100%'));
    assert.equal(embedCalls, 1);
    assert.equal(vectorCalls, 1);
    assert.equal(llmCalls, 1);

    // 3. Tier 1 Exact Cache Hit on subsequent identical query (0 embed, 0 vector, 0 LLM)
    const t1CacheRes = await orchestrator.answerQuestion('Khách làm vỡ hàng thì xử lý hoàn tiền thế nào?');
    assert.equal(t1CacheRes.tier, 'TIER_1_EXACT_OR_GREP');
    assert.equal(t1CacheRes.cached, true);
    assert.equal(embedCalls, 1); // Not called again!
    assert.equal(llmCalls, 1);   // Not called again!

    // 4. Invalidation purges caches
    orchestrator.invalidate();
    assert.equal(orchestrator.getExactCacheSize(), 0);
    assert.equal(orchestrator.getSemanticCacheSize(), 0);
  });

  // Test 47: simulateLevel08InternalDocsQa verifies GonnaCrash Level 08 3-Star metrics
  it('47. simulateLevel08InternalDocsQa proves GonnaCrash Level 08 3-Star SLA & Best Cost', () => {
    // 1. Without RAG: Model hallucinates, correctness ~28% < 72% SLA -> Fails!
    const noRag = simulateLevel08InternalDocsQa({ hasRagRetrieval: false, hasStreaming: true });
    assert.equal(noRag.passedCorrectSla, false);
    assert.equal(noRag.hallucinationPrevented, false);
    assert.equal(noRag.isThreeStarRecord, false);

    // 2. With RAG but without Streaming: TTFT ~4.2s > 3s SLA -> Fails!
    const ragNoStream = simulateLevel08InternalDocsQa({ hasRagRetrieval: true, hasStreaming: false });
    assert.equal(ragNoStream.passedTtftSla, false);
    assert.equal(ragNoStream.isThreeStarRecord, false);

    // 3. Winning 3-Star: RAG Retrieval (pgvector top_5) + openai_mid + stream: True
    const winning = simulateLevel08InternalDocsQa({ hasRagRetrieval: true, hasStreaming: true });
    assert.equal(winning.passedAnsweredSla, true);
    assert.equal(winning.answeredPpm, 1_000_000); // 100% answered
    assert.equal(winning.passedTtftSla, true);
    assert(winning.averageTtftMs <= 3000);         // TTFT ~850ms <= 3s
    assert.equal(winning.passedCorrectSla, true);
    assert(winning.correctPpm >= 720_000);         // Correctness >= 72%
    assert.equal(winning.passedCostSla, true);
    assert.equal(winning.costPerTaskUc, 941357);   // 941,357 UC (0.9414¢/task)
    assert.equal(winning.costPerTaskCents, 0.9414);
    assert.equal(winning.isThreeStarRecord, true);
    assert.equal(winning.hallucinationPrevented, true);
    assert(winning.verdict.includes('PASSED'));
  });

  // Test 48: LocalCrossEncoderReranker evaluates phrase matching, proximity, and tie-breaking
  it('48. LocalCrossEncoderReranker evaluates query coverage, phrase matching, proximity, and tie-breaking', async () => {
    const reranker = new LocalCrossEncoderReranker();
    const query = 'chính sách hoàn tiền khi hàng vỡ';

    const candidates: RerankCandidate[] = [
      {
        id: 'chunk_1_distractor',
        title: 'Chính sách bảo mật thông tin',
        content: 'Chúng tôi cam kết bảo mật thông tin khách hàng và tài khoản thanh toán tiền hàng.',
        initialRank: 1,
        initialScore: 0.82,
      },
      {
        id: 'chunk_2_perfect_match',
        title: 'Quy định đổi trả và hoàn tiền sản phẩm vỡ hỏng',
        content: 'Chính sách hoàn tiền khi hàng vỡ trong quá trình vận chuyển: Khách hàng chụp ảnh kiện hàng, cửa hàng sẽ hoàn tiền 100% trong 24h.',
        initialRank: 2,
        initialScore: 0.79,
      },
      {
        id: 'chunk_3_partial',
        title: 'Quy trình đóng gói hàng hóa',
        content: 'Nhân viên cần bọc xốp bóng khí 3 lớp để tránh hàng vỡ trong quá trình lưu kho.',
        initialRank: 3,
        initialScore: 0.71,
      },
    ];

    const results = await reranker.rerank(query, candidates);
    assert.equal(results.length, 3);
    // Perfect match should rank #1 despite starting at rank 2
    assert.equal(results[0].id, 'chunk_2_perfect_match');
    assert.equal(results[0].rank, 1);
    assert.equal(results[0].initialRank, 2);
    assert(results[0].score > results[1].score);
    assert(results[0].score >= 0.70);

    // Verify tie-breaking when two candidates have identical content
    const identicalCandidates: RerankCandidate[] = [
      { id: 'b_doc', content: 'Same content', initialRank: 2 },
      { id: 'a_doc', content: 'Same content', initialRank: 1 },
    ];
    const tieResults = await reranker.rerank('content', identicalCandidates);
    assert.equal(tieResults[0].id, 'a_doc'); // Preserves lower initialRank (1 < 2)
  });

  // Test 49: LocalCrossEncoderReranker handles Vietnamese diacritics / accents and minRelevanceScore
  it('49. LocalCrossEncoderReranker handles Vietnamese diacritics and minRelevanceScore pruning', async () => {
    const reranker = new LocalCrossEncoderReranker();
    // Query without accents
    const query = 'mau nuoc hang hoa si chuyen nghiep';

    const candidates: RerankCandidate[] = [
      {
        id: 'c1',
        title: 'Màu nước hạng họa sĩ chuyên nghiệp Daniel Smith',
        content: 'Bộ màu nước hạng họa sĩ chuyên nghiệp dạng tuýp 15ml với độ bền sáng tối đa.',
      },
      {
        id: 'c2',
        title: 'Bút chì than vẽ phác thảo',
        content: 'Bút chì than mềm 2B 4B 6B cho người mới bắt đầu.',
      },
    ];

    const results = await reranker.rerank(query, candidates, { minRelevanceScore: 0.3 });
    // Candidate 1 matches via unaccented normalization, candidate 2 is filtered out by minRelevanceScore
    assert.equal(results.length, 1);
    assert.equal(results[0].id, 'c1');
    assert(results[0].score >= 0.5);
  });

  // Test 50: RemoteRerankApi with mocked fetch for Cohere/Jina
  it('50. RemoteRerankApi formats request, parses relevance scores and respects topK', async () => {
    let capturedBody: any = null;
    let capturedHeaders: any = null;

    const mockFetch = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      capturedHeaders = init?.headers;
      capturedBody = JSON.parse(init?.body as string);
      return new Response(
        JSON.stringify({
          results: [
            { index: 1, relevance_score: 0.965 },
            { index: 0, relevance_score: 0.421 },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    const reranker = new RemoteRerankApi({
      provider: 'cohere',
      apiKey: 'test-cohere-key',
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const candidates: RerankCandidate[] = [
      { id: 'cand_0', content: 'Doc zero' },
      { id: 'cand_1', content: 'Doc one' },
    ];

    const results = await reranker.rerank('test query', candidates, { topK: 1 });
    assert.equal(results.length, 1);
    assert.equal(results[0].id, 'cand_1');
    assert.equal(results[0].score, 0.965);
    assert.equal(results[0].rank, 1);
    assert.equal(capturedBody.query, 'test query');
    assert.equal(capturedBody.top_n, 1);
    assert.equal(capturedHeaders['Authorization'], 'Bearer test-cohere-key');
  });

  // Test 51: RemoteRerankApi fails over automatically to LocalCrossEncoderReranker on error
  it('51. RemoteRerankApi automatically falls back to LocalCrossEncoderReranker on remote failure', async () => {
    const failingFetch = async (): Promise<Response> => {
      return new Response('Internal Server Error', { status: 500 });
    };

    const reranker = new RemoteRerankApi({
      provider: 'cohere',
      apiKey: 'test-key',
      maxRetries: 1,
      fallbackToLocal: true,
      fetchFn: failingFetch as unknown as typeof fetch,
    });

    const candidates: RerankCandidate[] = [
      { id: 'c1', content: 'Irrelevant text', title: 'Wrong title' },
      { id: 'c2', content: 'This text explains exactly how to cancel subscription in 2 steps', title: 'Cancel Subscription Guide' },
    ];

    // Must not throw, should fall back seamlessly to LocalCrossEncoderReranker
    const results = await reranker.rerank('cancel subscription guide', candidates);
    assert.equal(results.length, 2);
    assert.equal(results[0].id, 'c2'); // Correctly ranked by local fallback!
    assert.equal(results[0].provider, 'local');
    assert(results[0].explanation?.includes('Fallback from cohere'));
  });

  // Test 52: TwoStageRetrievalPipeline executes Stage 1 Recall -> Stage 2 Rerank -> Stage 3 Pruning
  it('52. TwoStageRetrievalPipeline coordinates Broad Recall -> Precision Rerank -> Context Pruning', async () => {
    // Mock retriever returning 20 candidates (Stage 1 Broad Recall)
    const mockRetriever = async (query: string, topK: number): Promise<RerankCandidate[]> => {
      const all: RerankCandidate[] = [];
      for (let i = 1; i <= topK; i++) {
        if (i === 17) {
          // Ground truth chunk buried deep at position 17 in vector recall
          all.push({
            id: `chunk_${i}_ground_truth`,
            title: 'SOP Xử lý sự cố rách vỡ sản phẩm',
            content: 'Khi hàng bị vỡ, nhân viên chụp 3 góc ảnh và bấm hoàn tiền ngay cho khách.',
            initialRank: i,
            initialScore: 0.65,
          });
        } else {
          all.push({
            id: `chunk_${i}_distractor`,
            title: `Tài liệu quy trình chung số ${i}`,
            content: `Nội dung tổng quát về bảo hộ lao động và nội quy công ty số ${i}.`,
            initialRank: i,
            initialScore: 0.70 + (i * 0.005),
          });
        }
      }
      return all;
    };

    const pipeline = createTwoStageRetrievalPipeline({
      stage1RecallTopK: 20,
      stage2FinalTopK: 5,
      minRelevanceScore: 0.1,
      reranker: new LocalCrossEncoderReranker(),
      retriever: mockRetriever,
    });

    const result = await pipeline.execute('khi hàng bị vỡ hoàn tiền cho khách');
    assert.equal(result.stage1Count, 20);
    assert.equal(result.stage2Count, 5); // Pruned from 20 down to top 5
    assert.equal(result.finalCount, 5);
    assert.equal(result.distractorsPruned, 15);

    // Buried chunk #17 is propelled to #1 by cross-encoder!
    assert.equal(result.finalCandidates[0].id, 'chunk_17_ground_truth');
    assert.equal(result.finalCandidates[0].rank, 1);
    assert.equal(result.finalCandidates[0].initialRank, 17);
    assert(result.finalCandidates[0].score >= 0.55);
  });

  // Test 53: simulateLevel09FindTheRightChunk proves GonnaCrash Level 09 3-Star SLA & Best Cost
  it('53. simulateLevel09FindTheRightChunk proves GonnaCrash Level 09 3-Star SLA & Best Cost', () => {
    // 1. Without Reranker: Naive vector search suffers from semantic drift -> correctness ~72.5% < 85% SLA -> Fails!
    const noReranker = simulateLevel09FindTheRightChunk({ hasReranker: false, hasStreaming: true });
    assert.equal(noReranker.passedCorrectSla, false);
    assert(noReranker.correctPpm < 850_000);
    assert.equal(noReranker.isThreeStarRecord, false);

    // 2. With Reranker but without Streaming: TTFT ~4.2s > 3s SLA -> Fails!
    const rerankNoStream = simulateLevel09FindTheRightChunk({ hasReranker: true, hasStreaming: false });
    assert.equal(rerankNoStream.passedTtftSla, false);
    assert.equal(rerankNoStream.isThreeStarRecord, false);

    // 3. Winning 3-Star: pgvector top_20 recall + rerank_api top_5 + openai_mid with stream: True
    const winning = simulateLevel09FindTheRightChunk({ hasReranker: true, hasStreaming: true });
    assert.equal(winning.passedAnsweredSla, true);
    assert.equal(winning.answeredPpm, 1_000_000); // 100% answered >= 99%
    assert.equal(winning.passedTtftSla, true);
    assert(winning.averageTtftMs <= 3000);         // TTFT ~880ms <= 3.0s
    assert.equal(winning.passedCorrectSla, true);
    assert(winning.correctPpm >= 850_000);         // Accuracy ~91.7% >= 85%
    assert.equal(winning.passedCostSla, true);
    assert.equal(winning.costPerTaskUc, 1041357);  // Exactly 1,041,357 UC (1.0414¢/task)
    assert.equal(winning.costPerTaskCents, 1.0414);
    assert.equal(winning.isThreeStarRecord, true); // Proves Best Cost 3-Star record!
    assert(winning.accuracyImprovement >= 15);     // Jumps from ~72.5% to ~91.7% (+19.2%)
    assert(winning.verdict.includes('PASSED'));
  });

  // Test 54: Catalog adapters convert products and document chunks seamlessly
  it('54. Catalog adapters convert products and document chunks to RerankCandidates', () => {
    const catalogProduct = {
      id: 'prod_123',
      name: 'Màu Nước Holbein Artists Water Color 15ml',
      brand: 'Holbein',
      category: 'Màu Nước & Loang Màu',
      tags: ['họa sĩ', 'tuýp 15ml', 'nhật bản'],
      description: 'Màu nước cao cấp từ Nhật Bản, độ hạt mịn và độ trong suốt hoàn hảo.',
      price: 185000,
      matchScore: 0.88,
    };

    const candidate = adaptCatalogProductToCandidate(catalogProduct, 1);
    assert.equal(candidate.id, 'prod_123');
    assert.equal(candidate.title, 'Màu Nước Holbein Artists Water Color 15ml');
    assert(candidate.content.includes('Holbein'));
    assert(candidate.content.includes('185.000đ'));
    assert.equal(candidate.initialScore, 0.88);
    assert.equal(candidate.initialRank, 1);

    const docChunk = {
      id: 'doc_sop_01',
      documentId: 'sop_wms',
      chunkIndex: 2,
      title: 'Quy trình giao hàng nhanh',
      content: 'Shipper cần đối chiếu mã đơn hàng trước khi bấm hoàn tất.',
      similarity: 0.77,
    };

    const docCandidate = adaptDocumentChunkToCandidate(docChunk, 3);
    assert.equal(docCandidate.id, 'doc_sop_01');
    assert.equal(docCandidate.title, 'Quy trình giao hàng nhanh');
    assert.equal(docCandidate.initialScore, 0.77);
    assert.equal(docCandidate.initialRank, 3);
    assert.equal(docCandidate.metadata?.documentId, 'sop_wms');
  });
});



