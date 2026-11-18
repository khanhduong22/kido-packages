/**
 * @kido/ai-stream - Level 15 Intelligent Model Routing & FrugalGPT Cascade Test Suite
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  PromptComplexityClassifier,
  DEFAULT_ROUTE_CENTROIDS,
  computeRouterTrigramVector,
  computeRouterCosineSimilarity,
  calibrateRouteThreshold,
  evaluateAnswerConfidence,
  IntelligentModelRouter,
  FrugalModelCascade,
  createIntelligentModelRouter,
  createFrugalModelCascade,
  simulateLevel15CheapModelFirst,
  type RouteUtteranceCentroid,
} from '../src/model-router/index.js';
import * as rootPackage from '../src/index.js';

describe('Level 15 Intelligent Model Routing & FrugalGPT Cascade Suite', () => {
  describe('1. Router-local Trigram Vector & Cosine Similarity', () => {
    it('computes L2-normalized vectors with high similarity for paraphrases and low for unrelated text', () => {
      const vEmpty = computeRouterTrigramVector('');
      assert.equal(vEmpty.length, 128);
      assert.equal(computeRouterCosineSimilarity(vEmpty, vEmpty), 0);

      const v1 = computeRouterTrigramVector('quên mật khẩu thì làm sao');
      const v2 = computeRouterTrigramVector('quen mat khau lam sao de doi');
      const v3 = computeRouterTrigramVector('PostgreSQL pgvector HNSW deadlock explain analyze');

      const norm1 = Math.sqrt(v1.reduce((acc, x) => acc + x * x, 0));
      assert.ok(Math.abs(norm1 - 1) < 1e-6);
      assert.ok(computeRouterCosineSimilarity(v1, v2) > computeRouterCosineSimilarity(v1, v3));
      assert.equal(computeRouterCosineSimilarity([1, 0], [1, 0, 0]), 0);
    });
  });

  describe('2. PromptComplexityClassifier (English + Vietnamese + Centroids)', () => {
    const classifier = new PromptComplexityClassifier();

    it('routes empty input, greetings, banter, thanks, and capability checks to zero_cost', () => {
      for (const prompt of ['', '   ', 'hi', 'xin chào shop', 'cảm ơn bạn nhiều nhé!', 'thanks!', '👍', 'what can you do?']) {
        const res = classifier.classify(prompt);
        assert.equal(res.tier, 'zero_cost', `Expected zero_cost for "${prompt}", got ${res.tier}`);
        assert.equal(res.routePort, 'easy');
        assert.equal(res.score, 0);
      }
    });

    it('routes simple EN/VI FAQs and single-item lookups to easy', () => {
      const easyPrompts = [
        'quên mật khẩu thì làm sao',
        'forgot my password, how do I reset it?',
        'lấy hóa đơn VAT ở đâu vậy?',
        'where can I download my monthly invoice?',
        'giấy vẽ màu nước Baohong 300gsm giá bao nhiêu?',
        'giờ mở cửa của ArtSupplyStore là mấy giờ?',
        'hi shop, shipping fee to Da Nang is how much?',
      ];
      for (const prompt of easyPrompts) {
        const res = classifier.classify(prompt);
        assert.equal(res.routePort, 'easy', `Expected easy routePort for "${prompt}", got ${res.routePort} (${res.score})`);
        assert.notEqual(res.tier, 'zero_cost', `Must not short-circuit real FAQ "${prompt}" to zero_cost`);
        assert.notEqual(res.tier, 'hard', `Must not over-classify FAQ "${prompt}" as hard`);
      }
    });

    it('routes stack traces, code/JSON/webhook debug, and multi-constraint combos to hard', () => {
      const hardPrompts = [
        "TypeError: Cannot read properties of undefined (reading 'hmac')\n  at verifyWebhook (/app/src/webhooks.ts:42:18)",
        'Webhook signature verification returns 401 on payload {"event":"invoice.paid","amount":199000}. How do I debug the HMAC-SHA256 digest?',
        'Tại sao webhook bị lỗi chữ ký HMAC và timeout 502 khi stream SSE qua reverse proxy?',
        'Compare pgvector HNSW vs IVFFlat recall, memory usage, and write latency tradeoffs for a multi-tenant SaaSSupportBot.',
        'So sánh ưu nhược điểm và tư vấn combo màu nước giấy 300gsm dưới 500k cho người mới bắt đầu kèm cọ tỉa nét.',
        '```sql\nEXPLAIN ANALYZE SELECT * FROM orders WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 20;\n```\nWhy is this causing a deadlock under burst traffic?',
      ];
      for (const prompt of hardPrompts) {
        const res = classifier.classify(prompt);
        assert.equal(res.tier, 'hard', `Expected hard tier for "${prompt}", got ${res.tier} (${res.score})`);
        assert.equal(res.routePort, 'hard');
        assert.ok(res.score >= classifier.getThreshold());
      }
    });

    it('supports custom RouteUtteranceCentroid overrides and executes in < 1ms per classification', () => {
      const customCentroids: RouteUtteranceCentroid[] = [
        ...DEFAULT_ROUTE_CENTROIDS,
        {
          id: 'custom_enterprise_rfp',
          tier: 'hard',
          port: 'hard',
          utterances: ['multi region active active disaster recovery compliance audit schedule'],
          weight: 1.2,
        },
      ];
      const customClassifier = new PromptComplexityClassifier({ centroids: customCentroids });
      const customRes = customClassifier.classify('multi region active active disaster recovery compliance audit');
      assert.equal(customRes.routePort, 'hard');
      assert.equal(customRes.signals.matchedCentroidId, 'custom_enterprise_rfp');

      const start = performance.now();
      for (let i = 0; i < 500; i++) {
        customClassifier.classify(i % 5 === 0 ? 'Debug webhook HMAC signature JSON 502 error' : 'quên mật khẩu thì làm sao');
      }
      const elapsedPerCallMs = (performance.now() - start) / 500;
      assert.ok(elapsedPerCallMs < 1.0, `Expected <1ms per classify(), got ${elapsedPerCallMs}ms`);
    });
  });

  describe('3. RouteLLM-Style Threshold Calibration (calibrateRouteThreshold)', () => {
    it('solves optimal tau for targetHardShare (20%) and budget cap (0.76c/task)', () => {
      const samples = [
        ...Array.from({ length: 8 }, (_, i) => ({
          prompt: i % 2 === 0 ? 'quên mật khẩu thì làm sao' : 'where can I download my invoice?',
          expectedPort: 'easy' as const,
        })),
        {
          prompt: 'TypeError: Cannot read properties of undefined at verifyWebhook (/app/webhook.ts:12:4)',
          expectedPort: 'hard' as const,
        },
        {
          prompt: 'So sánh chi tiết ưu nhược điểm và tư vấn combo họa cụ dưới 500k cho người mới bắt đầu',
          expectedPort: 'hard' as const,
        },
      ];

      const byShare = calibrateRouteThreshold(samples, 0.2);
      assert.equal(byShare.sampleCount, 10);
      assert.equal(byShare.hardCount, 2);
      assert.equal(byShare.easyCount, 8);
      assert.equal(byShare.achievedHardShare, 0.2);
      assert.ok(byShare.optimalTau >= 0.15 && byShare.optimalTau <= 0.92);
      assert.ok(byShare.estimatedCostPerTaskCents < 0.76);
      assert.equal(byShare.estimatedAccuracyPct, 100);

      const byBudget = calibrateRouteThreshold(samples, {
        maxCostPerTaskCents: 0.76,
        smallCostCents: 0.0273,
        largeCostCents: 3.19,
      });
      assert.ok(byBudget.estimatedCostPerTaskCents <= 0.76);
      assert.ok(byBudget.optimalTau > 0.2);
    });
  });

  describe('4. evaluateAnswerConfidence (FrugalGPT <1ms Scorer)', () => {
    it('rejects empty answers, EN/VI refusal hedging, unclosed fences, and missing entity/price/citation grounding', () => {
      assert.equal(evaluateAnswerConfidence('test', '').score, 0);
      assert.equal(evaluateAnswerConfidence('test', '   ').passed, false);

      const enHedge = evaluateAnswerConfidence('Debug webhook', "I'm not sure how your HMAC signature works; please contact support for more.");
      assert.equal(enHedge.checks.noRefusalOrHedging, false);
      assert.equal(enHedge.passed, false);
      assert.ok(enHedge.score < 0.6);

      const viHedge = evaluateAnswerConfidence('Kiểm tra tồn kho', 'Mình không chắc chắn thông tin này, chưa có thông tin chính xác ạ.');
      assert.equal(viHedge.checks.noRefusalOrHedging, false);
      assert.equal(viHedge.passed, false);

      const unclosed = evaluateAnswerConfidence('Write code', '```ts\nconst x = 1;');
      assert.equal(unclosed.checks.structurallyComplete, false);
      assert.equal(unclosed.passed, false);

      const badJson = evaluateAnswerConfidence('Return JSON', '{ "status": "ok"');
      assert.equal(badJson.checks.structurallyComplete, false);

      const strictJson = evaluateAnswerConfidence('Return JSON', 'not json at all', { expectedFormat: 'json' });
      assert.equal(strictJson.checks.structurallyComplete, false);
      assert.equal(strictJson.passed, false);

      const missingEntityPriceCitation = evaluateAnswerConfidence('Baohong 300gsm giá bao nhiêu?', 'Sản phẩm đang có sẵn tại cửa hàng.', {
        requiredEntities: ['Baohong', '300gsm'],
        requirePriceGrounding: true,
        requireCitations: true,
      });
      assert.equal(missingEntityPriceCitation.checks.entityGrounded, false);
      assert.equal(missingEntityPriceCitation.checks.priceGrounded, false);
      assert.equal(missingEntityPriceCitation.checks.citationGrounded, false);
      assert.equal(missingEntityPriceCitation.passed, false);

      const grounded = evaluateAnswerConfidence(
        'Baohong 300gsm giá bao nhiêu?',
        'Giấy vẽ màu nước Baohong 300gsm có giá 145k/tệp theo bảng giá [Doc 1].',
        {
          requiredEntities: ['Baohong', '300gsm'],
          requirePriceGrounding: true,
          requireCitations: true,
        }
      );
      assert.equal(grounded.score, 1);
      assert.equal(grounded.passed, true);
      assert.deepEqual(grounded.reasons, []);
    });
  });

  describe('5. IntelligentModelRouter & FrugalModelCascade (Routing, Escalation & Large RPM Shield)', () => {
    it('routes zero_cost (0c), easy -> small, hard -> large, and tracks rolling savings', async () => {
      let smallCalls = 0;
      let largeCalls = 0;
      const router = createIntelligentModelRouter({
        handlers: {
          zeroCostHandler: () => 'Xin chào! Mình là CommerceCopilot.',
          smallModelHandler: () => {
            smallCalls++;
            return 'Bạn bấm vào Quên mật khẩu ở màn hình đăng nhập để nhận link đặt lại qua email.';
          },
          largeModelHandler: () => {
            largeCalls++;
            return 'Hãy verify HMAC-SHA256 trên raw request body Buffer trước khi JSON.parse để tránh mismatch chữ ký.';
          },
        },
      });

      const rZero = await router.route({ prompt: 'xin chào' });
      assert.equal(rZero.selectedModelTier, 'zero_cost');
      assert.equal(rZero.costCents, 0);
      assert.equal(rZero.headers['X-Model-Tier'], 'zero_cost');

      const rEasy = await router.route({ prompt: 'quên mật khẩu thì làm sao' });
      assert.equal(rEasy.selectedModelTier, 'small');
      assert.equal(rEasy.costCents, 0.0273);
      assert.equal(rEasy.escalated, false);
      assert.equal(rEasy.headers['X-Route-Port'], 'easy');

      const rHard = await router.route({
        prompt: 'Debug webhook HMAC-SHA256 signature returning 401 on JSON payload {"event":"order.paid"}',
      });
      assert.equal(rHard.selectedModelTier, 'large');
      assert.equal(rHard.costCents, 3.19);
      assert.equal(rHard.headers['X-Route-Port'], 'hard');

      assert.equal(smallCalls, 1);
      assert.equal(largeCalls, 1);

      const stats = router.getStats();
      assert.equal(stats.totalRequests, 3);
      assert.equal(stats.zeroCostCount, 1);
      assert.equal(stats.smallCount, 1);
      assert.equal(stats.largeCount, 1);
      assert.ok(stats.totalSavedCents > 6);
      assert.ok(stats.savingsPct > 60);
    });

    it('escalates from small -> large in FrugalModelCascade when confidence < minConfidence', async () => {
      let smallCalls = 0;
      let largeCalls = 0;
      const cascade = createFrugalModelCascade({
        minConfidence: 0.72,
        handlers: {
          smallModelHandler: () => {
            smallCalls++;
            return 'Mình không chắc chắn thông tin tồn kho sản phẩm này, xin lỗi không thể xác nhận.';
          },
          largeModelHandler: () => {
            largeCalls++;
            return 'Sản phẩm giấy vẽ 300gsm hiện còn 32 tệp tại kho, giá 145k [Doc 1].';
          },
        },
      });

      const res = await cascade.cascade({ prompt: 'giấy vẽ 300gsm giá bao nhiêu?' });
      assert.equal(smallCalls, 1);
      assert.equal(largeCalls, 1);
      assert.equal(res.selectedModelTier, 'large');
      assert.equal(res.escalated, true);
      assert.equal(res.headers['X-Frugal-Escalated'], '1');
      assert.equal(res.costCents, Number((0.0273 + 3.19).toFixed(6)));
      assert.equal(cascade.getStats().escalatedCount, 1);
    });

    it('keeps 80% easy traffic off large-tier RPM and gracefully degrades when large hits RPM ceiling or 429', async () => {
      let nowMs = 1_000_000;
      let largeCalls = 0;
      let smallCalls = 0;
      const router = new IntelligentModelRouter({
        largeTierMaxRpm: 2,
        largeCeilingFallbackMode: 'small_fallback',
        now: () => nowMs,
        handlers: {
          smallModelHandler: ({ isDegradedFallback }) => {
            smallCalls++;
            return isDegradedFallback
              ? 'Hệ thống đang phân luồng xử lý nhanh: kiểm tra raw body HMAC secret và thử lại.'
              : 'Vào Cài đặt -> Tài khoản -> Đặt lại mật khẩu để nhận mã xác nhận.';
          },
          largeModelHandler: () => {
            largeCalls++;
            return 'Phân tích stack trace chi tiết: kiểm tra middleware rawBody trước jsonParser.';
          },
        },
      });

      // 8 easy queries should NEVER consume large RPM quota
      for (let i = 0; i < 8; i++) {
        const res = await router.route({ prompt: 'quên mật khẩu thì làm sao' });
        assert.equal(res.selectedModelTier, 'small');
      }
      assert.equal(router.getStats().largeTierRemainingRpm, 2);
      assert.equal(largeCalls, 0);

      // First 2 hard queries succeed on large
      const h1 = await router.route({ prompt: 'TypeError: Cannot read properties of undefined at handler (app.ts:10:2)' });
      const h2 = await router.route({ prompt: 'Debug webhook HMAC signature verification 401 JSON payload {"id":1}' });
      assert.equal(h1.selectedModelTier, 'large');
      assert.equal(h2.selectedModelTier, 'large');
      assert.equal(h1.degradedFromLarge, false);

      // 3rd hard query within same 60s window hits large RPM ceiling -> degrades gracefully to small (no 429 throw!)
      const h3 = await router.route({ prompt: 'Compare PostgreSQL pgvector HNSW vs IVFFlat tradeoffs under burst traffic' });
      assert.equal(h3.selectedModelTier, 'small');
      assert.equal(h3.degradedFromLarge, true);
      assert.equal(h3.degradationReason, 'large_rpm_ceiling');
      assert.equal(h3.headers['X-Large-Degraded'], '1');
      assert.equal(largeCalls, 2);
      assert.equal(smallCalls, 9);

      // Advancing clock past 60s window replenishes large RPM capacity
      nowMs += 61_000;
      const h4 = await router.route({ prompt: 'Debug webhook HMAC signature verification 401 JSON payload {"id":2}' });
      assert.equal(h4.selectedModelTier, 'large');
      assert.equal(h4.degradedFromLarge, false);

      // Upstream 429 from large provider also degrades gracefully
      const upstream429Cascade = new FrugalModelCascade({
        handlers: {
          smallModelHandler: () => 'Hướng dẫn nhanh: kiểm tra biến môi trường WEBHOOK_SECRET trên gateway.',
          largeModelHandler: () => {
            const err = new Error('HTTP 429 Too Many Requests') as Error & { status?: number };
            err.status = 429;
            throw err;
          },
        },
      });
      const degraded429 = await upstream429Cascade.route({
        prompt: 'Debug webhook HMAC signature verification 401 JSON payload {"id":3}',
      });
      assert.equal(degraded429.selectedModelTier, 'small');
      assert.equal(degraded429.degradedFromLarge, true);
      assert.equal(degraded429.degradationReason, 'large_upstream_429');
    });

    it('supports classifyOnly, trySmallFirstOnHard, static_fallback, throw mode, setThreshold, and resetStats', async () => {
      let nowMs = 500_000;
      const router = createFrugalModelCascade({
        largeTierMaxRpm: 1,
        largeCeilingFallbackMode: 'static_fallback',
        staticFallbackAnswer: 'Capacity busy fallback.',
        trySmallFirstOnHard: true,
        now: () => nowMs,
        handlers: {
          smallModelHandler: ({ prompt }) => {
            if (prompt.includes('Uncertain')) return "I don't know, unable to verify.";
            return 'Valid JSON: {"ok":true}';
          },
          largeModelHandler: () => 'Detailed architectural root-cause fix for webhook HMAC verification.',
        },
      });

      const preview = router.classifyOnly('quên mật khẩu thì làm sao', { nowMs });
      assert.equal(preview.targetModelTier, 'small');
      assert.equal(preview.largeTierHasCapacity, true);

      // Default zeroCostHandler (EN & VI)
      const enZero = await router.route({ prompt: 'hello' });
      const viZero = await router.route({ prompt: 'xin chào' });
      assert.ok(enZero.answer.includes('Hello'));
      assert.ok(viZero.answer.includes('Xin chào'));

      // trySmallFirstOnHard passes when small returns confident answer
      const hardSolvedBySmall = await router.route({
        prompt: 'Compare HNSW vs IVFFlat tradeoffs',
        confidenceOptions: { expectedFormat: 'code' },
      });
      // small returned plain JSON text without code syntax -> escalated to large!
      assert.equal(hardSolvedBySmall.selectedModelTier, 'large');
      assert.equal(hardSolvedBySmall.escalated, true);

      // Next hard call exceeds largeTierMaxRpm=1 -> static_fallback
      const hardStaticFallback = await router.route({
        prompt: 'Uncertain debug webhook HMAC signature error 502',
      });
      assert.equal(hardStaticFallback.degradedFromLarge, true);
      assert.equal(hardStaticFallback.degradationReason, 'large_rpm_ceiling');
      assert.equal(hardStaticFallback.answer, 'Capacity busy fallback.');

      // Strict throw mode
      const strictRouter = createIntelligentModelRouter({
        largeTierMaxRpm: 0,
        largeCeilingFallbackMode: 'throw',
        handlers: {
          smallModelHandler: () => 'small',
          largeModelHandler: () => 'large',
        },
      });
      await assert.rejects(
        () => strictRouter.route({ prompt: 'TypeError: undefined at app.ts:1:1' }),
        /Large tier RPM ceiling exceeded/
      );

      // Threshold adjustment & resetStats
      router.getClassifier().setThreshold(0.3);
      assert.equal(router.getClassifier().getThreshold(), 0.3);
      router.resetStats();
      assert.equal(router.getStats().totalRequests, 0);
      assert.equal(router.getStats().largeTierRemainingRpm, 1);
    });
  });

  describe('6. simulateLevel15CheapModelFirst (GonnaCrash World 3 Level 15 3-Star Verifier)', () => {
    it('proves all_large fails 429/budget, all_small fails accuracy, and model_router achieves 0.6599c/task (659,856 UC)', () => {
      const sim = simulateLevel15CheapModelFirst();

      // Compare all_large: 20 req/s @ 3.19c/task -> hits 429 ceiling & > 0.76c/task budget
      const allLarge = sim.comparisons.all_large;
      assert.ok(allLarge.rateLimited429Count > 0);
      assert.equal(allLarge.passedAnsweredSla, false);
      assert.ok(allLarge.costPerTaskCents > 0.76);
      assert.equal(allLarge.passedCostSla, false);
      assert.equal(allLarge.passedSla, false);

      // Compare all_small: 0.0273c/task -> fails >=93% hard & >=85% overall accuracy
      const allSmall = sim.comparisons.all_small;
      assert.equal(allSmall.costPerTaskCents, 0.0273);
      assert.ok(allSmall.hardAccuracyPct < 93);
      assert.ok(allSmall.overallAccuracyPct < 85);
      assert.equal(allSmall.passedHardAccuracySla, false);
      assert.equal(allSmall.passedOverallAccuracySla, false);
      assert.equal(allSmall.passedSla, false);

      // Verify model_router 3-Star record (80% easy -> openai_small + 20% hard -> openai_large, stream: true)
      assert.equal(sim.strategy, 'model_router');
      assert.equal(sim.totalTasks, 2400);
      assert.equal(sim.easyTasks, 1920);
      assert.equal(sim.hardTasks, 480);
      assert.equal(sim.rateLimited429Count, 0);
      assert.ok(sim.answeredPct >= 99);
      assert.ok(sim.ttftMs < 2000);
      assert.ok(sim.hardAccuracyPct >= 93);
      assert.ok(sim.overallAccuracyPct >= 85);
      assert.equal(sim.costPerTaskUc, 659_856);
      assert.equal(sim.costPerTaskCents, 0.6599);
      assert.ok(sim.costPerTaskUc <= 760_000);
      assert.equal(sim.passedSla, true);
      assert.equal(sim.isThreeStarRecord, true);

      // Non-streaming fails < 2,000ms TTFT SLA
      const nonStreaming = simulateLevel15CheapModelFirst({ strategy: 'model_router', stream: false });
      assert.ok(nonStreaming.ttftMs > 2000);
      assert.equal(nonStreaming.passedTtftSla, false);
      assert.equal(nonStreaming.passedSla, false);
    });

    it('re-exports model-router APIs cleanly from package root index.ts without collisions', () => {
      assert.equal(typeof rootPackage.PromptComplexityClassifier, 'function');
      assert.equal(typeof rootPackage.calibrateRouteThreshold, 'function');
      assert.equal(typeof rootPackage.evaluateAnswerConfidence, 'function');
      assert.equal(typeof rootPackage.IntelligentModelRouter, 'function');
      assert.equal(typeof rootPackage.FrugalModelCascade, 'function');
      assert.equal(typeof rootPackage.simulateLevel15CheapModelFirst, 'function');
    });
  });
});
