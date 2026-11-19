/**
 * @kido/ai-stream - Level 19 Full-Stack AI Production Delivery Test Suite
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  parsePartialJson,
  StreamingProductCardExtractor,
  createStreamingProductCardExtractor,
  validateStrictJsonPayload,
  ValidatedSemanticCacheGate,
  createValidatedSemanticCacheGate,
  formatSseWaitingFrame,
  parseSseWaitingFrame,
  streamWithWaitingFeedback,
  createRateGuardWaitingBridge,
  simulateLevel19AiFeatureLaunch,
  type StrictJsonSchemaSpec,
} from '../src/structured-launch/index.js';
import { executeWithAiRateGuard } from '../src/rpm-rate-guard/index.js';
import * as rootPackage from '../src/index.js';

interface ProductCard {
  sku: string;
  name: string;
  size: string;
  priceVnd: number;
  inStock: boolean;
  meta?: { finish: string };
}

interface ProductCardEnvelope {
  reply: string;
  cards: ProductCard[];
}

const PRODUCT_CARD_SCHEMA: StrictJsonSchemaSpec<ProductCardEnvelope> = {
  name: 'ProductCardEnvelope',
  allowAdditionalProperties: false,
  fields: {
    reply: { type: 'string', nonEmpty: true },
    cards: {
      type: 'array',
      minItems: 1,
      itemSchema: {
        allowAdditionalProperties: false,
        fields: {
          sku: { type: 'string', nonEmpty: true },
          name: { type: 'string', nonEmpty: true },
          size: { type: 'string', nonEmpty: true },
          priceVnd: { type: 'number', min: 1 },
          inStock: { type: 'boolean' },
          meta: {
            type: 'object',
            required: false,
            nestedSchema: { fields: { finish: { type: 'string', nonEmpty: true } } },
          },
        },
      },
    },
  },
};

describe('Level 19 Full-Stack AI Production Delivery (`structured-launch`)', () => {
  describe('1. Partial JSON Lexer & Progressive StreamingProductCardExtractor', () => {
    it('strips ```json fences, preserves Vietnamese & escaped quotes, drops incomplete tails, and closes LIFO', () => {
      const midStream =
        '```json\n{"reply":"Gợi ý \\"Kido\\" 🎨","cards":[{"sku":"ART-M","name":"Áo thun họa sĩ \\"Sáng Tạo\\"';
      const r1 = parsePartialJson<ProductCardEnvelope>(midStream);
      assert.equal(r1.ok, true);
      assert.equal(r1.isComplete, false);
      assert.equal(r1.strippedMarkdownFence, true);
      assert.equal(r1.value?.reply, 'Gợi ý "Kido" 🎨');
      assert.equal(r1.value?.cards[0]?.name, 'Áo thun họa sĩ "Sáng Tạo"');
      assert.ok(r1.autoClosedCount >= 3);

      // Incomplete trailing key, colon, comma, partial number, partial literal, and partial \u00 escape
      const trailingKey = parsePartialJson<{ a: number; b?: string }>('{"a": 1, "na');
      assert.equal(trailingKey.ok, true);
      assert.deepEqual(trailingKey.value, { a: 1 });
      assert.equal(trailingKey.droppedIncompleteTail, true);

      const trailingColon = parsePartialJson<{ a: number }>('{"a": 1, "name": ');
      assert.equal(trailingColon.ok, true);
      assert.deepEqual(trailingColon.value, { a: 1 });

      const partialNum = parsePartialJson<{ price: number }>('{"price": 145.');
      assert.equal(partialNum.ok, true);
      assert.deepEqual(partialNum.value, { price: 145 });

      const partialBool = parsePartialJson<{ ok: boolean; draft?: boolean }>('{"ok": true, "draft": tr');
      assert.equal(partialBool.ok, true);
      assert.deepEqual(partialBool.value, { ok: true });

      const partialEscape = parsePartialJson<{ title: string }>('{"title": "Màu nước \\u00e');
      assert.equal(partialEscape.ok, true);
      assert.deepEqual(partialEscape.value, { title: 'Màu nước ' });

      const completeFence = parsePartialJson<{ ok: boolean }>('```json\n{"ok":true}\n```');
      assert.equal(completeFence.ok, true);
      assert.equal(completeFence.isComplete, true);
      assert.equal(completeFence.strippedMarkdownFence, true);

      assert.equal(parsePartialJson('```json').ok, false);
      assert.equal(parsePartialJson('   ').ok, false);
    });

    it('emits completed cards progressively as each {...} closes while ignoring braces inside strings', () => {
      const seenCallbacks: number[] = [];
      const extractor = createStreamingProductCardExtractor<ProductCard>({
        arrayKeys: ['cards'],
        onCard: (_card, idx) => seenCallbacks.push(idx),
      });

      assert.deepEqual(extractor.pushChunk('```json\n{"warnings":["none"],"reply":"Top picks","cards":['), []);
      assert.deepEqual(
        extractor.pushChunk('{"sku":"BH-300","name":"Giấy Baohong {300gsm}","size":"A4","priceVnd":145000'),
        []
      );

      // Card 1 closes, Card 2 opens mid-chunk
      const batch1 = extractor.pushChunk(',"inStock":true,"meta":{"finish":"cold_press"}},{"sku":"ART-M","name":"Áo ');
      assert.equal(batch1.length, 1);
      assert.equal(batch1[0].sku, 'BH-300');
      assert.equal(batch1[0].meta?.finish, 'cold_press');
      assert.equal(extractor.getPartialSnapshot<ProductCardEnvelope>().value?.cards.length, 2);

      // Card 2 closes + trailing footer object after cards array must be ignored
      const batch2 = extractor.pushChunk('size M","size":"M","priceVnd":245000,"inStock":true}],"footer":{"note":"ok"}}\n```');
      assert.equal(batch2.length, 1);
      assert.equal(batch2[0].sku, 'ART-M');
      assert.equal(extractor.getCards().length, 2);
      assert.deepEqual(seenCallbacks, [0, 1]);

      extractor.reset();
      assert.equal(extractor.getCards().length, 0);
      assert.ok(new StreamingProductCardExtractor().pushChunk('[{"sku":"X1"}]').length === 1);
    });
  });

  describe('2. Strict Schema-Validated Semantic Cache Gate (`size M` vs `size L` & anti-poisoning)', () => {
    it('blocks malformed/NaN/schema-violating JSON on write and evicts corrupt cached entries on read', async () => {
      const gate = createValidatedSemanticCacheGate<ProductCardEnvelope>({
        schema: PRODUCT_CARD_SCHEMA,
        similarityThreshold: 0.95,
        requireEntityMatch: true,
      });

      const malformed = await gate.store({
        query: 'Áo thun họa sĩ size M còn hàng không shop?',
        payload: '{"reply":"ok","cards":[{"sku":' as unknown as ProductCardEnvelope,
      });
      assert.equal(malformed.stored, false);
      assert.ok(malformed.errors[0].includes('invalid_json'));

      const badNumber = await gate.store({
        query: 'Áo thun họa sĩ size M còn hàng không shop?',
        payload: {
          reply: 'Có hàng',
          cards: [{ sku: 'ART-M', name: 'Áo thun', size: 'M', priceVnd: Number.NaN, inStock: true }],
        },
      });
      assert.equal(badNumber.stored, false);
      assert.ok(badNumber.errors.some((e) => e.includes('finite number')));

      const emptyCards = await gate.store({
        query: 'Áo thun họa sĩ size M còn hàng không shop?',
        payload: { reply: 'Empty', cards: [] },
      });
      assert.equal(emptyCards.stored, false);
      assert.equal(gate.getStats().writeBlockedInvalidJson, 3);
      assert.equal(gate.getStats().size, 0);

      // Simulate legacy corrupt L2 payload hydrated prior to write-gate rollout
      await gate.importUnvalidatedEntry({
        query: 'Giấy vẽ Baohong 300gsm còn hàng không?',
        rawPayload: '{"reply":"broken","cards":[]}',
      });
      assert.equal(gate.getStats().size, 1);

      const evictedLookup = await gate.lookup('Giấy vẽ Baohong 300gsm còn hàng không?');
      assert.equal(evictedLookup.hit, false);
      assert.equal(evictedLookup.readEvictedInvalidJson, true);
      assert.equal(gate.getStats().readEvictedInvalidJson, 1);
      assert.equal(gate.getStats().size, 0);

      assert.equal(validateStrictJsonPayload({ reply: '', cards: [] }, PRODUCT_CARD_SCHEMA).valid, false);
    });

    it('hits Vietnamese paraphrases for size M while strictly blocking size M -> size L collisions', async () => {
      const gate = new ValidatedSemanticCacheGate<ProductCardEnvelope>({
        schema: PRODUCT_CARD_SCHEMA,
        similarityThreshold: 0.95,
        requireEntityMatch: true,
      });

      const sizeMPayload: ProductCardEnvelope = {
        reply: 'Áo thun họa sĩ size M hiện còn 14 chiếc ạ!',
        cards: [{ sku: 'ART-TEE-M', name: 'Áo thun họa sĩ size M', size: 'M', priceVnd: 245_000, inStock: true }],
      };
      const stored = await gate.store({
        query: 'Áo thun họa sĩ size M còn hàng không shop?',
        payload: JSON.stringify(sizeMPayload),
      });
      assert.equal(stored.stored, true);
      assert.equal(stored.entityFingerprint, 'sizes:m');

      const paraphraseHit = await gate.lookup('Shop ơi áo thun họa sĩ cỡ M còn không ạ?');
      assert.equal(paraphraseHit.hit, true);
      assert.equal(paraphraseHit.status, 'HIT_SEMANTIC');
      assert.ok(paraphraseHit.similarity >= 0.95);
      assert.equal(paraphraseHit.payload?.cards[0].size, 'M');

      const sizeLMiss = await gate.lookup('Áo thun họa sĩ size L còn hàng không shop?');
      assert.equal(sizeLMiss.hit, false);
      assert.equal(sizeLMiss.entityFingerprint, 'sizes:l');
      assert.equal(sizeLMiss.entityMismatchBlocked, true);
      assert.equal(gate.getStats().entityMismatchBlockedCount, 1);
    });
  });

  describe('3. Backoff-to-Client SSE `event: waiting` Feedback Bridge', () => {
    it('formats/parses event: waiting frames and hooks executeWithAiRateGuard onRetry directly into SSE stream', async () => {
      const rawFrame = formatSseWaitingFrame({
        attempt: 2,
        delayMs: 340,
        reason: '429 rate limit\ninjected',
        id: 'w-2\n',
        timestampMs: 1_700_000_000_000,
      });
      assert.ok(rawFrame.startsWith('event: waiting\nid: w-2\ndata: '));
      const parsed = parseSseWaitingFrame(rawFrame);
      assert.equal(parsed?.status, 'waiting');
      assert.equal(parsed?.attempt, 2);
      assert.equal(parsed?.delayMs, 340);
      assert.equal(parsed?.reason, '429 rate limit injected');
      assert.equal(parsed?.id, 'w-2');
      assert.equal(parseSseWaitingFrame('event: delta\ndata: {"ok":true}\n\n'), null);

      let upstreamCalls = 0;
      const stream = streamWithWaitingFeedback({
        execute: async ({ onRetry }) => {
          const tokens = await executeWithAiRateGuard(
            async () => {
              upstreamCalls++;
              if (upstreamCalls <= 2) {
                const err = new Error('429 upstream quota ceiling') as Error & { status?: number };
                err.status = 429;
                throw err;
              }
              return ['{"reply":"Ready","cards":', '[{"sku":"HWC-24"}]}'];
            },
            {
              maxRetries: 3,
              baseDelayMs: 5,
              maxDelayMs: 15,
              onRetry: createRateGuardWaitingBridge(onRetry),
            }
          );
          return tokens;
        },
      });

      const sseText = await new Response(stream).text();
      assert.ok(sseText.startsWith(': stream-open\n\n'));
      assert.ok(sseText.endsWith('data: [DONE]\n\n'));

      const waitingBlocks = sseText
        .split('\n\n')
        .map((blk) => parseSseWaitingFrame(blk))
        .filter((ev): ev is NonNullable<typeof ev> => ev !== null);
      assert.equal(waitingBlocks.length, 2);
      assert.equal(waitingBlocks[0].attempt, 0);
      assert.equal(waitingBlocks[1].attempt, 1);
      assert.ok(sseText.includes('data: {"reply":"Ready","cards":'));
    });
  });

  describe('4. simulateLevel19AiFeatureLaunch (GonnaCrash World 3 Level 19 Boss Fight)', () => {
    it('proves all 5 failure modes fail SLAs while three_star_launch hits 355,785 UC 3-Star record', async () => {
      const sim = await simulateLevel19AiFeatureLaunch();

      assert.equal(sim.comparisons.small_model.passedAccuracySla, false);
      assert.equal(sim.comparisons.small_model.passedSla, false);

      assert.equal(sim.comparisons.free_text_json.passedAnsweredSla, false);
      assert.ok(sim.comparisons.free_text_json.brokenJsonDroppedCount > 0);
      assert.equal(sim.comparisons.free_text_json.passedSla, false);

      assert.equal(sim.comparisons.no_semantic_cache.passedCostSla, false);
      assert.ok(sim.comparisons.no_semantic_cache.costPerTaskUc > 410_000);
      assert.equal(sim.comparisons.no_semantic_cache.passedSla, false);

      assert.equal(sim.comparisons.loose_semantic_cache.passedAccuracySla, false);
      assert.equal(sim.comparisons.loose_semantic_cache.passedSla, false);

      assert.equal(sim.comparisons.no_backoff_retry.passedAnsweredSla, false);
      assert.ok(sim.comparisons.no_backoff_retry.rateLimited429Count > 0);
      assert.equal(sim.comparisons.no_backoff_retry.passedSla, false);

      assert.equal(sim.strategy, 'three_star_launch');
      assert.equal(sim.totalTicks, 180);
      assert.equal(sim.totalTasks, 960);
      assert.ok(sim.answeredPct >= 99.9);
      assert.ok(sim.ttftMs <= 2_000);
      assert.ok(sim.accuracyPct >= 94);
      assert.equal(sim.costPerTaskUc, 355_785);
      assert.equal(sim.costPerTaskCents, 0.3558);
      assert.equal(sim.budgetUc, 410_000);
      assert.equal(sim.passedSla, true);
      assert.equal(sim.isThreeStarRecord, true);

      assert.equal(sim.probes.partialStreamCardsExtracted, 2);
      assert.equal(sim.probes.writeBlockedInvalidJson, 1);
      assert.equal(sim.probes.sizeIsolationBlocked, true);
      assert.equal(sim.probes.waitingFramesBridged, 1);

      const noStream = await simulateLevel19AiFeatureLaunch({ stream: false });
      assert.equal(noStream.passedTtftSla, false);
      assert.equal(noStream.passedSla, false);
    });

    it('re-exports structured-launch APIs cleanly from package root index.ts without collisions', () => {
      assert.equal(typeof rootPackage.parsePartialJson, 'function');
      assert.equal(typeof rootPackage.StreamingProductCardExtractor, 'function');
      assert.equal(typeof rootPackage.validateStrictJsonPayload, 'function');
      assert.equal(typeof rootPackage.ValidatedSemanticCacheGate, 'function');
      assert.equal(typeof rootPackage.formatSseWaitingFrame, 'function');
      assert.equal(typeof rootPackage.parseSseWaitingFrame, 'function');
      assert.equal(typeof rootPackage.streamWithWaitingFeedback, 'function');
      assert.equal(typeof rootPackage.simulateLevel19AiFeatureLaunch, 'function');
    });
  });
});
