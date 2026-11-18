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
    const originalText = 'Khạp khạp! Capy Họa Sĩ 🦫🎨 cọ vẽ tuyệt đỉnh!';
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
    const text = '### 🎨 Capy Art Guide\n\n```typescript\nconst speed = 100;\n```\n- Bullet 🦫';
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
      tokenSource: ['Khạp ', 'khạp, ', 'Capy!'],
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
    assert(accumulatedRaw.includes('Khạp '));
    assert(accumulatedRaw.includes('Capy!'));
    assert(accumulatedRaw.includes('event: done\n'));
    assert(accumulatedRaw.includes('data: [DONE]\n\n'));
  });

  // Test 18: consumeSseReadableStream with text/event-stream
  it('18. consumeSseReadableStream consumes text/event-stream with TTFT metrics', async () => {
    const sseBody = [
      ': stream-open\n\n',
      'event: meta\ndata: {"recommendation":"watercolor"}\n\n',
      formatOpenAiDeltaFrame('Capy '),
      formatOpenAiDeltaFrame('Họa Sĩ!'),
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

    assert.equal(result.text, 'Capy Họa Sĩ!');
    assert.deepEqual(receivedMeta, { recommendation: 'watercolor' });
    assert.deepEqual(tokens, ['Capy ', 'Họa Sĩ!']);
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

    await tier2.publishToken(channelId, 'Khạp ');
    await tier2.publishToken(channelId, 'Capy!');
    await tier2.publishDone(channelId, { totalTokens: 2 });

    const result = await consumePromise;
    assert.equal(result.text, 'Khạp Capy!');
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
});
