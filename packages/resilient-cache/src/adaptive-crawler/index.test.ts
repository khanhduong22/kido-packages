import { describe, expect, it } from 'bun:test';

import {
  AdaptiveProxyRotator,
  AdaptiveProxyService,
  BatchConcurrencyLimiter,
  calculateBackoffDelay,
  executeWithConcurrencyLimit,
  extractRetryAfterMs,
  formatCrawlSummaryBox,
  isRateLimitError,
  isRetryableCrawlerError,
  maskProxyUrl,
  OutboundRequestThrottler,
  parseBooleanConfig,
  parseProxyString,
  processBatched,
  RateLimitCooldownError,
  resolveProxyTlsVerification,
  RetryAfterBackoffEngine,
  SmartCrawlLogger,
} from './index';

describe('AdaptiveProxyRotator / AdaptiveProxyService & Proxy Utilities', () => {
  it('parses proxy strings with and without credentials and protocols', () => {
    expect(parseProxyString('http://user:pass123@10.0.0.1:8080')).toEqual({
      host: '10.0.0.1',
      port: 8080,
      protocol: 'http',
      auth: { username: 'user', password: 'pass123' },
    });

    expect(parseProxyString('https://proxy.example.com:8443')).toEqual({
      host: 'proxy.example.com',
      port: 8443,
      protocol: 'https',
      auth: undefined,
    });

    expect(parseProxyString('192.168.1.50:3128')).toEqual({
      host: '192.168.1.50',
      port: 3128,
      protocol: 'http',
      auth: undefined,
    });

    expect(parseProxyString('invalid-proxy')).toBeNull();
    expect(parseProxyString('http://host:notaport')).toBeNull();
    expect(parseProxyString('')).toBeNull();
  });

  it('masks proxy credentials securely and resolves boolean / TLS config', () => {
    expect(maskProxyUrl('http://admin:supersecret@10.0.0.1:8080')).toBe(
      'http://admin:****@10.0.0.1:8080',
    );
    expect(maskProxyUrl('https://10.0.0.1:8443')).toBe('https://10.0.0.1:8443');
    expect(parseBooleanConfig('true')).toBe(true);
    expect(parseBooleanConfig('0')).toBe(false);
    expect(parseBooleanConfig('invalid')).toBeUndefined();
    expect(resolveProxyTlsVerification({ PROXY_TLS_VERIFY: 'false' })).toBe(false);
    expect(resolveProxyTlsVerification({ PROXY_REJECT_UNAUTHORIZED: 'no' })).toBe(false);
    expect(resolveProxyTlsVerification({})).toBe(true);
  });

  it('starts in direct mode, switches to proxy after threshold, rotates round-robin, and falls back to direct with cooldown on wrap-around', () => {
    const rotator = new AdaptiveProxyRotator({
      proxies: 'http://u1:p1@1.1.1.1:8080, https://2.2.2.2:8443',
      directFailureThreshold: 3,
      directCooldownMs: 60_000,
    });

    expect(rotator.getStatus().mode).toBe('direct');
    expect(rotator.getStatus().totalProxies).toBe(2);

    rotator.handleRateLimitError();
    expect(rotator.getStatus().mode).toBe('direct');
    expect(rotator.getStatus().directFailureCount).toBe(1);
    expect(rotator.getStatus().isInCooldown).toBe(true);

    rotator.handleRateLimitError();
    expect(rotator.getStatus().directFailureCount).toBe(2);

    // 3rd failure hits threshold (3) -> switches to proxy[0]
    rotator.handleRateLimitError();
    expect(rotator.getStatus().mode).toBe('proxy');
    expect(rotator.getStatus().currentProxyIndex).toBe(0);
    expect(rotator.getStatus().maskedProxyUrl).toBe('http://u1:****@1.1.1.1:8080');

    // Rate limit on proxy[0] -> rotates to proxy[1]
    rotator.handleRateLimitError();
    expect(rotator.getStatus().currentProxyIndex).toBe(1);
    expect(rotator.getStatus().maskedProxyUrl).toBe('https://2.2.2.2:8443');

    // Rate limit on proxy[1] -> wraps around -> falls back to direct with cooldown
    rotator.handleRateLimitError();
    expect(rotator.getStatus().mode).toBe('direct');
    expect(rotator.getStatus().directFailureCount).toBe(0);
    expect(rotator.getStatus().isInCooldown).toBe(true);

    const stats = rotator.getStats();
    expect(stats.totalRequests).toBe(5);
    expect(stats.failureCount).toBe(5);
    expect(stats.rateLimitCount).toBe(5);

    rotator.handleSuccess();
    expect(rotator.getStats().successCount).toBe(1);
  });

  it('supports getRequestConfig, agentFactory lifecycle, coherent headers, outlier quarantine, and EWMA latency', async () => {
    const destroyedAgents: string[] = [];
    const service = new AdaptiveProxyService({
      proxies: ['http://1.1.1.1:8080', 'http://2.2.2.2:8080', 'http://3.3.3.3:8080'],
      directFailureThreshold: 1,
      directCooldownMs: 50_000,
      ejectionBaseMs: 60_000,
      nonBlockingCooldown: true,
      agentFactory: (url, opts) => ({
        url,
        opts,
        destroy: () => destroyedAgents.push(url),
      }),
    });

    const coherent = service.getCoherentRequestHeaders({ Accept: 'application/json' });
    expect(coherent['User-Agent']).toContain('Mozilla/5.0');
    expect(coherent['Sec-CH-UA-Platform']).toBeDefined();

    // Trigger rate limit in direct mode -> switches to proxy[0]
    service.handleRateLimitError();
    const cfg = await service.mergeProxyConfig({ headers: { 'X-Custom': '1' } });
    expect(cfg.proxy).toBe(false);
    expect((cfg.httpsAgent as { url: string }).url).toBe('http://1.1.1.1:8080');
    expect(cfg.headers?.['X-Custom']).toBe('1');

    // Record EWMA latency on proxy[0]
    service.recordProxyLatency(100);
    service.recordProxyLatency(200);
    expect(service.getProxyHealth()[0].ewmaLatencyMs).toBe(120);

    // Fail proxy[0] -> quarantined, switches to proxy[1], and destroys proxy[0] agent
    service.handleRateLimitError();
    expect(destroyedAgents).toContain('http://1.1.1.1:8080');
    expect(service.getStatus().currentProxyIndex).toBe(1);
    expect(service.getProxyHealth()[0].quarantinedUntil).toBeGreaterThan(Date.now());

    service.onModuleDestroy();
    expect(destroyedAgents).toContain('http://2.2.2.2:8080');
  });

  it('tracks windowed stats and probabilistic sampling in SmartCrawlLogger', () => {
    const logs: string[] = [];
    const logger = new SmartCrawlLogger({
      logIntervalMs: 1000,
      sampleRate: 0.5,
      sink: { log: (msg) => logs.push(msg) },
      randomFn: () => 0.2,
    });

    expect(logger.logSampled('sampled-hit')).toBe(true);
    expect(logs).toContain('sampled-hit');

    const t0 = Date.now();
    logger.recordRequest(true, false, t0);
    logger.recordRequest(false, true, t0 + 1500);
    expect(logs.some((l) => l.includes('📊 Stats'))).toBe(true);

    const box = formatCrawlSummaryBox('Daily OHLCV Sync', {
      totalRecords: 100,
      created: 80,
      successRate: 95.0,
      rateLimitedSymbols: ['VNM', 'FPT'],
      failedSymbols: [{ symbol: 'HPG', reason: 'Timeout' }],
    });
    expect(box).toContain('📈 Daily OHLCV Sync:');
    expect(box).toContain('🎉 Success rate: 95.0%');
  });
});

describe('OutboundRequestThrottler', () => {
  it('applies safetyMargin (default 0.1 -> 90% of maxRequests), updates rate limit, and returns tokens', async () => {
    const throttler = new OutboundRequestThrottler({
      defaultCooldownMs: 200,
      debounceWindowMs: 100,
    });

    const result = await throttler.throttle('provider-a', async () => 'ok', {
      maxRequests: 10,
      windowMs: 60_000,
    });
    expect(result).toBe('ok');

    const statusBefore = throttler.getStatus('provider-a');
    expect(statusBefore?.maxTokens).toBe(9);
    expect(Math.floor(statusBefore!.tokens)).toBe(8);

    throttler.returnToken('provider-a');
    expect(Math.floor(throttler.getStatus('provider-a')!.tokens)).toBe(9);

    throttler.updateRateLimit('provider-a', 20, 60_000);
    expect(throttler.getStatus('provider-a')!.maxTokens).toBe(20);
  });

  it('enforces debounced IP-Level Cooldown Circuit Breaker', async () => {
    const throttler = new OutboundRequestThrottler({
      defaultCooldownMs: 80,
      debounceWindowMs: 50,
    });

    expect(throttler.triggerRateLimitCooldown('provider-ip', 'HTTP 429 from upstream', 80)).toBe(
      true,
    );
    expect(throttler.isInCooldown('provider-ip')).toBe(true);
    expect(throttler.triggerRateLimitCooldown('provider-ip', 'Duplicate 429', 80)).toBe(false);
    expect(() => throttler.assertNotInCooldown('provider-ip')).toThrow(RateLimitCooldownError);

    await new Promise((r) => setTimeout(r, 95));
    expect(throttler.isInCooldown('provider-ip')).toBe(false);
  });
});

describe('RetryAfterBackoffEngine', () => {
  it('calculates exponential backoff, parses Retry-After, and retries 429/5xx', async () => {
    const delay0 = calculateBackoffDelay(0, {
      initialDelayMs: 1000,
      exponentialBase: 2,
      maxDelayMs: 5000,
      jitterFactor: 0.2,
    });
    expect(delay0).toBeGreaterThanOrEqual(800);
    expect(delay0).toBeLessThanOrEqual(1200);

    expect(extractRetryAfterMs({ response: { headers: { 'Retry-After': '12' } } })).toBe(12_000);
    expect(isRateLimitError(Object.assign(new Error('Too Many Requests'), { statusCode: 429 }))).toBe(true);
    expect(isRetryableCrawlerError(Object.assign(new Error('Bad Gateway'), { statusCode: 502 }))).toBe(true);
    expect(isRetryableCrawlerError(Object.assign(new Error('Bad Request'), { statusCode: 400 }))).toBe(false);

    const engine = new RetryAfterBackoffEngine({
      maxRetries: 3,
      initialDelayMs: 10,
      jitterFactor: 0,
    });

    let calls = 0;
    const result = await engine.executeWithRateLimitRetry(async () => {
      calls++;
      if (calls === 1) {
        throw Object.assign(new Error('Rate limit exceeded'), {
          response: { status: 429, headers: { 'retry-after': '0.02' } },
        });
      }
      return 'crawled-payload';
    });

    expect(result.success).toBe(true);
    expect(result.data).toBe('crawled-payload');
    expect(result.attempts).toBe(2);
  });
});

describe('BatchConcurrencyLimiter', () => {
  it('limits concurrent executions and processes batched items', async () => {
    let active = 0;
    let maxObservedActive = 0;

    const tasks = Array.from({ length: 7 }, (_, idx) => async () => {
      active++;
      maxObservedActive = Math.max(maxObservedActive, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      if (idx === 4) throw new Error('task-4-failed');
      return idx * 10;
    });

    const settled = await executeWithConcurrencyLimit(tasks, 3, 5);
    expect(settled).toHaveLength(7);
    expect(maxObservedActive).toBeLessThanOrEqual(3);
    expect(settled[4].status).toBe('rejected');

    const limiter = new BatchConcurrencyLimiter({ maxConcurrent: 2, delayBetweenBatchesMs: 5 });
    const results = await processBatched([1, 2, 3, 4], async (item) => item * 2, {
      batchSize: 2,
      concurrency: 2,
    });
    expect(results.map((r) => (r.status === 'fulfilled' ? r.value : null))).toEqual([2, 4, 6, 8]);
    expect(await limiter.processBatched([1, 2], async (i) => i + 1)).toHaveLength(2);
  });
});
