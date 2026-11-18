/**
 * @kido/ai-stream - Level 14 Entity-Aware Strict Semantic Cache Test Suite
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  SIMILARITY_PRESETS,
  EntityAwareSemanticCache,
  extractCommerceEntities,
  computeEntityFingerprint,
  computeSemanticTrigramVector,
  buildPromptCacheMessages,
  simulateLevel14SameQuestionNewWords,
} from '../src/semantic-cache/index.js';
import { cosineSimilarity } from '../src/rag-pipeline/index.js';

describe('Level 14 Entity-Aware Strict Semantic Cache Suite', () => {
  describe('1. extractCommerceEntities & computeEntityFingerprint', () => {
    it('differentiates apparel sizes (M vs L) and paper sizes (A4 vs A5)', () => {
      const mEnt = extractCommerceEntities('Áo hoodie form rộng size M còn không shop');
      const lEnt = extractCommerceEntities('Áo hoodie form rộng size L còn không shop');
      assert.deepEqual(mEnt.sizes, ['m']);
      assert.deepEqual(lEnt.sizes, ['l']);
      assert.notEqual(computeEntityFingerprint(mEnt), computeEntityFingerprint(lEnt));

      const a4 = extractCommerceEntities('Giấy vẽ màu nước khổ A4 300gsm');
      const a5 = extractCommerceEntities('Giấy vẽ màu nước khổ A5 300gsm');
      assert.deepEqual(a4.sizes, ['a4']);
      assert.deepEqual(a5.sizes, ['a5']);
      assert.notEqual(computeEntityFingerprint(a4), computeEntityFingerprint(a5));
    });

    it('differentiates paper gsm (300gsm vs 200gsm) and set counts (24 màu vs 36 màu)', () => {
      const g300 = extractCommerceEntities('Giấy Baohong 300gsm cold press');
      const g200 = extractCommerceEntities('Giấy Baohong 200gsm cold press');
      assert.deepEqual(g300.weightsOrVolumes, ['300gsm']);
      assert.deepEqual(g200.weightsOrVolumes, ['200gsm']);
      assert.notEqual(computeEntityFingerprint(g300), computeEntityFingerprint(g200));

      const s24 = extractCommerceEntities('Set màu nước Holbein 24 màu');
      const s24Tubes = extractCommerceEntities('Set màu nước Holbein 24 tuýp');
      const s36 = extractCommerceEntities('Set màu nước Holbein 36 màu');
      assert.deepEqual(s24.quantitiesOrSets, ['24_colors']);
      assert.deepEqual(s24Tubes.quantitiesOrSets, ['24_colors']);
      assert.deepEqual(s36.quantitiesOrSets, ['36_colors']);
      assert.equal(computeEntityFingerprint(s24), computeEntityFingerprint(s24Tubes));
      assert.notEqual(computeEntityFingerprint(s24), computeEntityFingerprint(s36));
    });

    it('differentiates colors (đen vs trắng), avoids "hông" filler false positives, and normalizes prices', () => {
      const black = extractCommerceEntities('Bút đi nét màu đen');
      const white = extractCommerceEntities('Bút đi nét màu trắng');
      assert.deepEqual(black.colorsOrFinishes, ['black']);
      assert.deepEqual(white.colorsOrFinishes, ['white']);
      assert.notEqual(computeEntityFingerprint(black), computeEntityFingerprint(white));

      const fillerHong = extractCommerceEntities('giấy baohong 300gsm còn hàng hông shop');
      assert.equal(fillerHong.colorsOrFinishes.includes('pink'), false);
      assert.deepEqual(fillerHong.brandsOrSkus, ['baohong']);

      const p200 = extractCommerceEntities('Combo họa cụ dưới 200k cho người mới');
      const p500 = extractCommerceEntities('Combo họa cụ dưới 500k cho người mới');
      assert.deepEqual(p200.priceBounds, ['max:200000']);
      assert.deepEqual(p500.priceBounds, ['max:500000']);
      assert.notEqual(computeEntityFingerprint(p200), computeEntityFingerprint(p500));

      assert.equal(computeEntityFingerprint(extractCommerceEntities('cho mình hỏi chung chút')), '__general__');
    });
  });

  describe('2. EntityAwareSemanticCache Strict Paraphrase Hit vs 1-Word Entity Mismatch', () => {
    it('hits strict paraphrase (>= 0.95) while blocking 1-word entity mismatch', async () => {
      const cache = new EntityAwareSemanticCache<string>({ similarity: 'strict' });
      assert.equal(SIMILARITY_PRESETS.strict, 0.95);

      const qSeed = 'áo này còn size M không';
      const qPara = 'size M áo này còn hàng hông shop';
      const qMismatch = 'áo này còn size L không';

      const simPara = cosineSimilarity(
        computeSemanticTrigramVector(qSeed),
        computeSemanticTrigramVector(qPara)
      );
      assert.ok(simPara >= 0.95, `Expected paraphrase cosine >= 0.95, got ${simPara}`);

      await cache.store({
        query: qSeed,
        response: 'Còn đủ size M ạ!',
        skus: ['TEE-M'],
        stockSignature: 'TEE-M:12',
      });

      const exact = await cache.lookup(qSeed);
      assert.equal(exact.hit, true);
      assert.equal(exact.status, 'HIT_EXACT');
      assert.equal(exact.similarity, 1.0);

      const hit = await cache.lookup(qPara);
      assert.equal(hit.hit, true);
      assert.equal(hit.status, 'HIT_SEMANTIC');
      assert.ok(hit.similarity >= 0.95);
      assert.equal(hit.response, 'Còn đủ size M ạ!');
      assert.equal(hit.entityMismatchBlocked, false);

      const miss = await cache.lookup(qMismatch);
      assert.equal(miss.hit, false);
      assert.equal(miss.status, 'MISS');

      // Real long commerce query + dense embedder confirming entityMismatchBlocked === true when sim >= 0.95
      const longM = 'áo khoác gió chống nước hai lớp màu đen form rộng unisex mặc đi phượt size M còn không shop';
      const longL = 'áo khoác gió chống nước hai lớp màu đen form rộng unisex mặc đi phượt size L còn không shop';
      await cache.store({ query: longM, response: 'Áo khoác gió đen size M còn 8 chiếc ạ!', skus: ['JKT-BLK-M'] });
      const longMiss = await cache.lookup(longL);
      assert.equal(longMiss.hit, false);
      assert.equal(longMiss.status, 'MISS');
      assert.equal(longMiss.entityMismatchBlocked, true);

      const denseCache = new EntityAwareSemanticCache<string>({
        similarity: 'strict',
        embedder: (txt) => (txt.includes('size M') ? [1, 0, 0] : txt.includes('size L') ? [0.985, 0.172, 0] : [0, 1, 0]),
      });
      await denseCache.store({ query: qSeed, response: 'Còn size M!', skus: ['TEE-M'] });
      const denseBlocked = await denseCache.lookup(qMismatch);
      assert.equal(denseBlocked.hit, false);
      assert.equal(denseBlocked.entityMismatchBlocked, true);
      assert.equal(denseCache.getStats().entityMismatchBlockedCount, 1);
    });

    it('hits Vietnamese art-supply paraphrase >= 0.95 and misses on 200gsm change', async () => {
      const cache = new EntityAwareSemanticCache<string>({ similarity: 'strict' });
      await cache.store({
        query: 'giấy vẽ màu nước baohong 300gsm còn không shop?',
        response: 'Giấy Baohong 300gsm còn 45 tệp ạ!',
        skus: ['BH-A4-300'],
      });

      const para = await cache.lookup('shop ơi tệp giấy baohong 300gsm vẽ màu nước còn hàng hông?');
      assert.equal(para.hit, true);
      assert.equal(para.status, 'HIT_SEMANTIC');
      assert.ok(para.similarity >= 0.95);

      const diffGsm = await cache.lookup('giấy vẽ baohong 200gsm còn không?');
      assert.equal(diffGsm.hit, false);
      assert.equal(diffGsm.status, 'MISS');
    });
  });

  describe('3. invalidateBySku & stockSignatureValidator', () => {
    it('immediately evicts entries on invalidateBySku and stale stockSignatureValidator', async () => {
      const stockMap: Record<string, string> = { 'BH-300': 'BH-300:45', 'MM-CLAY': 'MM-CLAY:30' };
      const cache = new EntityAwareSemanticCache<string>({
        similarity: 'strict',
        stockSignatureValidator: (skus, cachedSig) => {
          const current = skus.map((s) => stockMap[s] ?? `${s}:0`).join('|');
          return current === cachedSig;
        },
      });

      await cache.store({
        query: 'giấy vẽ baohong 300gsm còn không shop?',
        response: 'Còn 45 tệp Baohong 300gsm',
        skus: ['BH-300'],
        stockSignature: 'BH-300:45',
      });
      await cache.store({
        query: 'đất sét tự khô mont marte 500g còn không shop?',
        response: 'Còn 30 gói đất sét Mont Marte 500g',
        skus: ['MM-CLAY'],
        stockSignature: 'MM-CLAY:30',
      });

      // Selective O(k) SKU eviction keeps unrelated SKU entry alive
      const evicted = cache.invalidateBySku('BH-300');
      assert.equal(evicted, 1);
      assert.equal((await cache.lookup('giấy vẽ baohong 300gsm còn không shop?')).hit, false);
      assert.equal((await cache.lookup('đất sét tự khô mont marte 500g còn không shop?')).hit, true);

      // Re-store BH-300 and mutate underlying stock without explicit invalidation -> stockSignatureValidator evicts
      await cache.store({
        query: 'giấy vẽ baohong 300gsm còn không shop?',
        response: 'Còn 45 tệp Baohong 300gsm',
        skus: ['BH-300'],
        stockSignature: 'BH-300:45',
      });
      stockMap['BH-300'] = 'BH-300:0';
      const stale = await cache.lookup('shop ơi tệp giấy vẽ baohong 300gsm còn hàng hông?');
      assert.equal(stale.hit, false);
      assert.equal(stale.status, 'MISS');
      assert.equal(cache.getStats().staleStockEvictions, 1);
      assert.equal((await cache.lookup('đất sét tự khô mont marte 500g còn không shop?')).hit, true);
    });
  });

  describe('4. buildPromptCacheMessages Static Prefix Ordering', () => {
    it('places static system/catalog blocks with ephemeral cache_control before dynamic turns', () => {
      const built = buildPromptCacheMessages({
        staticSystemPrompt: 'You are Aria Product Advisor for Acme Store. Never hallucinate inventory.',
        staticCatalogContext: 'Catalog rules & shipping policy v4. ' + 'SKU policy details. '.repeat(20),
        dynamicHistory: [
          { role: 'user', content: 'Mình mới tập vẽ màu nước' },
          { role: 'assistant', content: 'Bạn nên chọn giấy 300gsm 100% cotton nhé!' },
        ],
        dynamicQuery: 'Giấy Baohong 300gsm A4 còn hàng không?',
      });

      assert.equal(built.messages[0].role, 'system');
      assert.ok(Array.isArray(built.messages[0].content));
      assert.equal(built.messages[0].content.length, 2);
      assert.deepEqual(built.messages[0].content[0].cache_control, { type: 'ephemeral' });
      assert.deepEqual(built.messages[0].content[1].cache_control, { type: 'ephemeral' });
      assert.equal(built.messages[1].role, 'user');
      assert.equal(built.messages[2].role, 'assistant');
      assert.equal(built.messages[3].role, 'user');
      assert.equal(built.messages[3].content, 'Giấy Baohong 300gsm A4 còn hàng không?');
      assert.ok(built.staticPrefixTokens > built.dynamicTokens);
      assert.ok(built.cacheableRatioPct > 50);
    });
  });

  describe('5. simulateLevel14SameQuestionNewWords (3-Star SLA Proof)', () => {
    it('proves loose/balanced fail accuracy (<93%), promptCache=false fails budget, and strict+openai_mid+promptCache+stream hits 355,889 UC', () => {
      const loose = simulateLevel14SameQuestionNewWords({ similarity: 'loose' });
      assert.ok(loose.accuracyPct < 93);
      assert.equal(loose.passedAccuracySla, false);
      assert.equal(loose.passedSla, false);

      const balanced = simulateLevel14SameQuestionNewWords({ similarity: 'balanced' });
      assert.ok(balanced.accuracyPct < 93);
      assert.equal(balanced.passedAccuracySla, false);
      assert.equal(balanced.passedSla, false);

      const noPromptCache = simulateLevel14SameQuestionNewWords({
        similarity: 'strict',
        modelFlavor: 'openai_mid',
        promptCache: false,
        stream: true,
      });
      assert.ok(noPromptCache.costPerTaskUc > 410_000);
      assert.equal(noPromptCache.passedCostSla, false);
      assert.equal(noPromptCache.passedSla, false);

      const noSemCache = simulateLevel14SameQuestionNewWords({ hasSemanticCache: false });
      assert.ok(noSemCache.costPerTaskUc > 410_000);
      assert.equal(noSemCache.passedSla, false);

      const optimal = simulateLevel14SameQuestionNewWords({
        similarity: 'strict',
        modelFlavor: 'openai_mid',
        promptCache: true,
        stream: true,
        hasSemanticCache: true,
      });
      assert.equal(optimal.answeredPct, 100);
      assert.equal(optimal.ttftMs, 210);
      assert.equal(optimal.accuracyPct, 96.25);
      assert.equal(optimal.costPerTaskUc, 355_889);
      assert.equal(optimal.costPerTaskCents, 0.3559);
      assert.equal(optimal.passedSla, true);
      assert.equal(optimal.isThreeStarRecord, true);
    });
  });
});
