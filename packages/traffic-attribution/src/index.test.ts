import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isSpeculativePrefetch,
  getPrefetchType,
  getHeaderValue,
  detectTrafficSource,
  isAiTraffic,
  isSocialTraffic,
  selectUnvisitedLinkBitmask,
  parseBitmask,
  serializeBitmask,
  isBitVisited,
  markBitVisited,
  getVisitedIndices,
  getUnvisitedIndices,
  isAllVisited,
  createBitmaskCookieString,
  resolveUtmParams,
  injectUtmParams,
  stripTrackingParameters,
  buildDynamicUtm,
} from './index';

describe('@kido/traffic-attribution Test Suite', () => {
  describe('1. Browser Prefetch & Prerender Filtering', () => {
    it('should detect Sec-Purpose: prefetch', () => {
      const headers = { 'sec-purpose': 'prefetch' };
      assert.equal(isSpeculativePrefetch(headers), true);
      assert.equal(getPrefetchType(headers), 'prefetch');
    });

    it('should detect Sec-Purpose: prerender', () => {
      const headers = { 'Sec-Purpose': 'prerender' };
      assert.equal(isSpeculativePrefetch(headers), true);
      assert.equal(getPrefetchType(headers), 'prerender');
    });

    it('should detect Purpose: prefetch (Chromium legacy)', () => {
      const headers = { purpose: 'prefetch' };
      assert.equal(isSpeculativePrefetch(headers), true);
      assert.equal(getPrefetchType(headers), 'prefetch');
    });

    it('should detect Purpose: preview', () => {
      const headers = { purpose: 'preview' };
      assert.equal(isSpeculativePrefetch(headers), true);
      assert.equal(getPrefetchType(headers), 'preview');
    });

    it('should detect X-Moz: prefetch (Firefox speculative)', () => {
      const headers = { 'x-moz': 'prefetch' };
      assert.equal(isSpeculativePrefetch(headers), true);
      assert.equal(getPrefetchType(headers), 'prefetch');
    });

    it('should detect X-Purpose: preview & prefetch', () => {
      assert.equal(isSpeculativePrefetch({ 'x-purpose': 'preview' }), true);
      assert.equal(isSpeculativePrefetch({ 'x-purpose': 'prefetch' }), true);
    });

    it('should detect X-Prerender: 1', () => {
      const headers = { 'x-prerender': '1' };
      assert.equal(isSpeculativePrefetch(headers), true);
      assert.equal(getPrefetchType(headers), 'prerender');
    });

    it('should return false for regular user navigation requests', () => {
      const headers = {
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
        accept: 'text/html,application/xhtml+xml',
        referer: 'https://google.com',
      };
      assert.equal(isSpeculativePrefetch(headers), false);
      assert.equal(getPrefetchType(headers), null);
    });

    it('should work with Web Standard Headers API and Maps', () => {
      const headers = new Headers();
      headers.set('Sec-Purpose', 'prefetch');
      assert.equal(isSpeculativePrefetch(headers), true);

      const map = new Map<string, string>();
      map.set('Purpose', 'prefetch');
      assert.equal(isSpeculativePrefetch(map), true);
    });

    it('should handle null, undefined, or empty headers safely', () => {
      assert.equal(isSpeculativePrefetch(null), false);
      assert.equal(isSpeculativePrefetch(undefined), false);
      assert.equal(isSpeculativePrefetch({}), false);
      assert.equal(getHeaderValue(null, 'any'), null);
    });
  });

  describe('2. Intelligent Traffic Source Attribution & AI Agent Detection', () => {
    // A. AI Agents
    it('should detect ChatGPT from referer and user-agent', () => {
      const res1 = detectTrafficSource({ referer: 'https://chatgpt.com/' });
      assert.equal(res1.channel, 'ai_agent');
      assert.equal(res1.platform, 'chatgpt');
      assert.equal(res1.isAiAgent, true);
      assert.equal(isAiTraffic(res1), true);

      const res2 = detectTrafficSource({ userAgent: 'Mozilla/5.0 AppleWebKit/537.36 (compatible; GPTBot/1.2)' });
      assert.equal(res2.channel, 'ai_agent');
      assert.equal(res2.platform, 'chatgpt');
      assert.equal(res2.isBot, true);
    });

    it('should detect Claude / Anthropic from referer and user-agent', () => {
      const res1 = detectTrafficSource({ referer: 'https://claude.ai/chat/123' });
      assert.equal(res1.channel, 'ai_agent');
      assert.equal(res1.platform, 'claude');
      assert.equal(res1.isAiAgent, true);

      const res2 = detectTrafficSource({ userAgent: 'ClaudeBot/1.0; +claudebot@anthropic.com' });
      assert.equal(res2.platform, 'claude');
    });

    it('should detect Gemini / Google AI', () => {
      const res1 = detectTrafficSource({ referer: 'https://gemini.google.com/' });
      assert.equal(res1.channel, 'ai_agent');
      assert.equal(res1.platform, 'gemini');

      const res2 = detectTrafficSource({ userAgent: 'Google-Extended' });
      assert.equal(res2.platform, 'gemini');
    });

    it('should detect Perplexity AI', () => {
      const res1 = detectTrafficSource({ referer: 'https://www.perplexity.ai/search' });
      assert.equal(res1.channel, 'ai_agent');
      assert.equal(res1.platform, 'perplexity');

      const res2 = detectTrafficSource({ userAgent: 'PerplexityBot/1.0' });
      assert.equal(res2.platform, 'perplexity');
    });

    it('should detect Microsoft Copilot and DeepSeek', () => {
      const resCopilot = detectTrafficSource({ referer: 'https://copilot.microsoft.com/' });
      assert.equal(resCopilot.platform, 'copilot');

      const resDeepseek = detectTrafficSource({ referer: 'https://chat.deepseek.com/' });
      assert.equal(resDeepseek.platform, 'deepseek');
    });

    // B. Search Engines
    it('should detect Google organic search and extract query param', () => {
      const res = detectTrafficSource({ referer: 'https://www.google.com.vn/search?q=tiem+chup+anh+tred' });
      assert.equal(res.channel, 'search_engine');
      assert.equal(res.platform, 'google');
      assert.equal(res.isSearch, true);
      assert.equal(res.details?.searchQueryParam, 'tiem chup anh tred');
    });

    it('should detect Bing search', () => {
      const res = detectTrafficSource({ referer: 'https://www.bing.com/search?q=calisthenics' });
      assert.equal(res.channel, 'search_engine');
      assert.equal(res.platform, 'bing');
      assert.equal(res.isSearch, true);
    });

    it('should detect Cốc Cốc (Vietnam national browser / search)', () => {
      const res1 = detectTrafficSource({ referer: 'https://coccoc.com/search?query=fastfood' });
      assert.equal(res1.channel, 'search_engine');
      assert.equal(res1.platform, 'coccoc');

      const res2 = detectTrafficSource({ userAgent: 'Mozilla/5.0 (Windows NT 10.0) CocCoc/115.0' });
      assert.equal(res2.channel, 'search_engine');
      assert.equal(res2.platform, 'coccoc');
    });

    // C. Social Networks (Vietnam Domestic & Global)
    it('should detect Zalo from referer and user-agent', () => {
      const res1 = detectTrafficSource({ referer: 'https://chat.zalo.me/' });
      assert.equal(res1.channel, 'social_network');
      assert.equal(res1.platform, 'zalo');
      assert.equal(isSocialTraffic(res1), true);

      const res2 = detectTrafficSource({ userAgent: 'Mozilla/5.0 (iPhone) ZaloTheme/1.0 ZaloMobile' });
      assert.equal(res2.platform, 'zalo');
    });

    it('should detect TikTok from referer and in-app webview UA', () => {
      const res1 = detectTrafficSource({ referer: 'https://www.tiktok.com/@examplebrand' });
      assert.equal(res1.channel, 'social_network');
      assert.equal(res1.platform, 'tiktok');

      const res2 = detectTrafficSource({ userAgent: 'Mozilla/5.0 ByteLocale/vi_VN musical_ly_28.0.0' });
      assert.equal(res2.platform, 'tiktok');
    });

    it('should detect Facebook & Instagram in-app browser', () => {
      const resFb = detectTrafficSource({ referer: 'https://l.facebook.com/l.php?u=...' });
      assert.equal(resFb.channel, 'social_network');
      assert.equal(resFb.platform, 'facebook');

      const resFbUa = detectTrafficSource({ userAgent: 'Mozilla/5.0 [FBAN/FBIOS;FBAV/400.0.0.0]' });
      assert.equal(resFbUa.platform, 'facebook');

      const resIg = detectTrafficSource({ referer: 'https://l.instagram.com/' });
      assert.equal(resIg.platform, 'instagram');
    });

    it('should detect Telegram bot & messenger links', () => {
      const res1 = detectTrafficSource({ referer: 'https://t.me/kido_channel' });
      assert.equal(res1.channel, 'social_network');
      assert.equal(res1.platform, 'telegram');

      const res2 = detectTrafficSource({ userAgent: 'TelegramBot (like TwitterBot)' });
      assert.equal(res2.platform, 'telegram');
    });

    // D. Direct and Internal
    it('should detect Direct traffic when no referer provided', () => {
      const res = detectTrafficSource({});
      assert.equal(res.channel, 'direct');
      assert.equal(res.platform, 'direct');
    });

    it('should recognize Internal traffic when referer matches internalDomains', () => {
      const res = detectTrafficSource({
        referer: 'https://portfolio.khanhdp.com/apps/fastfood',
        internalDomains: ['khanhdp.com', 'tikat.vn'],
      });
      assert.equal(res.channel, 'internal');
      assert.equal(res.platform, 'portfolio.khanhdp.com');
    });
  });

  describe('3. Zero-State Cookie Bitmask Link Rotator', () => {
    const candidateLinks = [
      'https://tred.vn/photobooth-offer-a',
      'https://tred.vn/photobooth-offer-b',
      'https://tred.vn/photobooth-offer-c',
    ];

    it('should rotate sequentially and advance bitmask across 3 visits', () => {
      // Visit 1: initial bitmask = 0
      const visit1 = selectUnvisitedLinkBitmask(candidateLinks, 0);
      assert.equal(visit1.selectedIndex, 0);
      assert.equal(visit1.selectedItem, candidateLinks[0]);
      assert.equal(visit1.currentBitmask, 0);
      assert.equal(visit1.nextBitmask, 1); // bit 0 set (1)
      assert.equal(visit1.isCycleCompleted, false);
      assert.equal(visit1.visitedCount, 1);
      assert.deepEqual(visit1.unvisitedIndices, [1, 2]);

      // Visit 2: bitmask passed back from cookie is 1
      const visit2 = selectUnvisitedLinkBitmask(candidateLinks, visit1.nextBitmask);
      assert.equal(visit2.selectedIndex, 1);
      assert.equal(visit2.selectedItem, candidateLinks[1]);
      assert.equal(visit2.currentBitmask, 1);
      assert.equal(visit2.nextBitmask, 3); // bits 0 and 1 set (1 | 2 = 3)
      assert.equal(visit2.isCycleCompleted, false);
      assert.equal(visit2.visitedCount, 2);
      assert.deepEqual(visit2.unvisitedIndices, [2]);

      // Visit 3: bitmask passed back is 3
      const visit3 = selectUnvisitedLinkBitmask(candidateLinks, visit2.nextBitmask);
      assert.equal(visit3.selectedIndex, 2);
      assert.equal(visit3.selectedItem, candidateLinks[2]);
      assert.equal(visit3.currentBitmask, 3);
      assert.equal(visit3.nextBitmask, 7); // bits 0, 1, 2 set (1 | 2 | 4 = 7)
      assert.equal(visit3.isCycleCompleted, true); // Full cycle completed!
      assert.equal(visit3.visitedCount, 3);
      assert.deepEqual(visit3.unvisitedIndices, []);

      // Visit 4: bitmask is 7 (all visited). Should automatically reset to 0 and start new cycle!
      const visit4 = selectUnvisitedLinkBitmask(candidateLinks, visit3.nextBitmask);
      assert.equal(visit4.selectedIndex, 0);
      assert.equal(visit4.selectedItem, candidateLinks[0]);
      assert.equal(visit4.currentBitmask, 0);
      assert.equal(visit4.nextBitmask, 1);
      assert.equal(visit4.isCycleCompleted, false);
    });

    it('should support string cookie input and parse safely', () => {
      const res = selectUnvisitedLinkBitmask(candidateLinks, '1');
      assert.equal(res.selectedIndex, 1);
      assert.equal(res.nextBitmask, 3);

      const resInvalid = selectUnvisitedLinkBitmask(candidateLinks, 'invalid_text');
      assert.equal(resInvalid.selectedIndex, 0);
      assert.equal(resInvalid.nextBitmask, 1);
    });

    it('should support random mode picking from remaining unvisited items', () => {
      const res = selectUnvisitedLinkBitmask(candidateLinks, 1, { mode: 'random' });
      assert.equal([1, 2].includes(res.selectedIndex), true);
      assert.equal(res.currentBitmask, 1);
    });

    it('should throw error for empty candidate links', () => {
      assert.throws(() => selectUnvisitedLinkBitmask([]), /Items array must not be empty/);
    });

    it('should test bitmask utility functions', () => {
      assert.equal(parseBitmask(null), 0);
      assert.equal(parseBitmask(-5), 0);
      assert.equal(parseBitmask(12), 12);
      assert.equal(serializeBitmask(5), '5');

      assert.equal(isBitVisited(5, 0), true); // 5 is 101 in binary -> bit 0 is 1
      assert.equal(isBitVisited(5, 1), false); // bit 1 is 0
      assert.equal(isBitVisited(5, 2), true); // bit 2 is 1

      assert.equal(markBitVisited(1, 1), 3);
      assert.deepEqual(getVisitedIndices(3, 4), [0, 1]);
      assert.deepEqual(getUnvisitedIndices(3, 4), [2, 3]);
      assert.equal(isAllVisited(7, 3), true);
      assert.equal(isAllVisited(6, 3), false);

      const cookieStr = createBitmaskCookieString('ab_rot', 3, { maxAgeSeconds: 3600, secure: true });
      assert.equal(cookieStr.includes('ab_rot=3'), true);
      assert.equal(cookieStr.includes('Max-Age=3600'), true);
      assert.equal(cookieStr.includes('Secure'), true);
    });
  });

  describe('4. Dynamic UTM Parameter Resolution & Injection', () => {
    it('should resolve and normalize UTM parameters from URL', () => {
      const url = 'https://tred.vn/booking?utm_source=FACEBOOK&utm_medium=PAID_AD&utm_campaign=Summer_2026';
      const utm = resolveUtmParams(url);
      assert.equal(utm.utm_source, 'facebook');
      assert.equal(utm.utm_medium, 'paid_ad');
      assert.equal(utm.utm_campaign, 'Summer_2026');
    });

    it('should apply defaults and overrides in resolveUtmParams', () => {
      const utm = resolveUtmParams('https://tred.vn/', {
        defaults: { utm_source: 'direct', utm_medium: 'none' },
        override: { utm_campaign: 'promo_q4' },
      });
      assert.equal(utm.utm_source, 'direct');
      assert.equal(utm.utm_medium, 'none');
      assert.equal(utm.utm_campaign, 'promo_q4');
    });

    it('should inject UTM parameters into target URL properly', () => {
      const target = 'https://app.example.com/schedule#pricing';
      const enriched = injectUtmParams(target, {
        utm_source: 'tiktok',
        utm_medium: 'social',
        utm_campaign: 'calis_challenge',
      });
      assert.equal(enriched.includes('utm_source=tiktok'), true);
      assert.equal(enriched.includes('utm_medium=social'), true);
      assert.equal(enriched.includes('utm_campaign=calis_challenge'), true);
      assert.equal(enriched.includes('#pricing'), true);
    });

    it('should strip invasive ad click tracking parameters', () => {
      const dirtyUrl = 'https://tred.vn/?fbclid=IwAR123xyz&gclid=CjwKCAjw&utm_source=fb&utm_medium=cpc&ttclid=tt123';
      const cleanUrl = stripTrackingParameters(dirtyUrl);
      assert.equal(cleanUrl.includes('fbclid'), false);
      assert.equal(cleanUrl.includes('gclid'), false);
      assert.equal(cleanUrl.includes('ttclid'), false);
      assert.equal(cleanUrl.includes('utm_source=fb'), true);
      assert.equal(cleanUrl.includes('utm_medium=cpc'), true);
    });

    it('should build dynamic UTM parameters based on TrafficSourceInfo', () => {
      const aiSource = detectTrafficSource({ referer: 'https://chatgpt.com/' });
      const aiUtm = buildDynamicUtm(aiSource, { campaign: 'ai_referral_drive' });
      assert.equal(aiUtm.utm_source, 'chatgpt');
      assert.equal(aiUtm.utm_medium, 'ai_referral');
      assert.equal(aiUtm.utm_campaign, 'ai_referral_drive');

      const socialSource = detectTrafficSource({ referer: 'https://zalo.me/' });
      const socialUtm = buildDynamicUtm(socialSource);
      assert.equal(socialUtm.utm_source, 'zalo');
      assert.equal(socialUtm.utm_medium, 'social');
    });
  });

  describe('5. Best-Effort OTLP Web Vitals Proxy Forwarder', () => {
    it('should parse OTEL_EXPORTER_OTLP_HEADERS with equals signs in values', async () => {
      const { parseOtlpHeaders, resolveOtlpEndpoint } = await import('./index');
      const headers = parseOtlpHeaders('x-honeycomb-team=abc=123, x-dataset = web-vitals ');
      assert.equal(headers['x-honeycomb-team'], 'abc=123');
      assert.equal(headers['x-dataset'], 'web-vitals');
      assert.equal(resolveOtlpEndpoint('https://otel.example.com/', 'metrics'), 'https://otel.example.com/v1/metrics');
      assert.equal(resolveOtlpEndpoint('https://otel.example.com', null), 'https://otel.example.com/v1/traces');
    });

    it('should safely skip in development or when endpoint is missing and swallow collector errors', async () => {
      const { forwardOtlpTelemetry } = await import('./index');

      const devRes = await forwardOtlpTelemetry({
        body: '{}',
        isDevelopment: true,
        endpoint: 'https://otel.example.com',
      });
      assert.equal(devRes.clientAckOk, true);
      assert.equal(devRes.status, 'skipped_dev');

      const noEpRes = await forwardOtlpTelemetry({
        body: '{}',
        endpoint: '   ',
      });
      assert.equal(noEpRes.clientAckOk, true);
      assert.equal(noEpRes.status, 'skipped_no_endpoint');

      const networkErrRes = await forwardOtlpTelemetry({
        body: '{}',
        endpoint: 'https://otel.example.com',
        fetchImpl: async () => {
          throw new Error('ECONNREFUSED');
        },
      });
      assert.equal(networkErrRes.clientAckOk, true);
      assert.equal(networkErrRes.forwarded, false);
      assert.equal(networkErrRes.status, 'network_timeout_or_error');
    });
  });
});

