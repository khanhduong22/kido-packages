/**
 * @kido/ai-stream - Level 26 Conversation Memory Compression Test Suite
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  estimateMemoryTextTokens,
  estimateTurnTokens,
  estimateConversationTokens,
  computeMemoryTokenBudget,
  truncateTextToTokenBudget,
  extractConversationFacts,
  mergeMemoryFacts,
  formatPinnedFactsBlock,
  hasBackReference,
  buildExtractiveRollingSummary,
  buildLastTurnOnlyPrompt,
  RollingSummaryMemory,
  createRollingSummaryMemory,
  simulateLevel26LongConversationMemory,
  LEVEL26_COST_COMPONENTS_UC,
  LEVEL26_SLA_TARGETS,
  type ConversationTurn,
} from '../src/conversation-memory/index.js';
import * as rootPackage from '../src/index.js';

function makeLongCommerceHistory(): ConversationTurn[] {
  const turns: ConversationTurn[] = [
    {
      role: 'user',
      content:
        'Hi CommerceCopilot, I placed Order #ORD-4821 for a cobalt blue ceramic mug under a budget of $120 with standard shipping.',
    },
    {
      role: 'assistant',
      content:
        'Confirmed Order #ORD-4821 for the cobalt blue ceramic mug within your $120 budget using standard shipping.',
    },
    {
      role: 'user',
      content:
        'Please update my budget to $150, switch color to emerald green, and upgrade to express shipping on ticket #TKT-901.',
    },
    {
      role: 'assistant',
      content:
        'Logged ticket #TKT-901 with updated budget $150, emerald green color preference, and express shipping.',
    },
  ];
  for (let i = 1; i <= 9; i++) {
    turns.push(
      { role: 'user', content: `Follow-up policy question #${i}: how do warranty claims work for SKU-204 accessories?` },
      { role: 'assistant', content: `Answer #${i}: SKU-204 accessories carry a 24-month replacement warranty via SaaSSupportBot.` }
    );
  }
  return turns;
}

describe('Level 26 Conversation Memory Compression (`conversation-memory`)', () => {
  describe('1. UTF-8 / CJK / Vietnamese Token Budget Estimator', () => {
    it('estimates English, Vietnamese, CJK, and emoji text deterministically with denser weighting', () => {
      assert.equal(estimateMemoryTextTokens(''), 0);
      assert.equal(estimateMemoryTextTokens('   '), 0);

      const enTokens = estimateMemoryTextTokens('hello world order check');
      const viTokens = estimateMemoryTextTokens('kiểm tra đơn hàng mẫu màu nước');
      const cjkTokens = estimateMemoryTextTokens('注文番号確認お願いします');
      const emojiTokens = estimateMemoryTextTokens('🚀🎉📦');

      assert.ok(enTokens >= 5 && enTokens <= 10);
      assert.ok(viTokens > enTokens, 'Vietnamese diacritics should estimate denser than ASCII');
      assert.ok(cjkTokens >= 15, 'CJK ideographs should estimate >= 1.5 tokens/char');
      assert.ok(emojiTokens >= 6, 'Astral-plane emojis should estimate ~2 tokens each');

      const turnTokens = estimateTurnTokens({ role: 'user', content: 'Order #ORD-4821 status?' });
      assert.ok(turnTokens > estimateMemoryTextTokens('Order #ORD-4821 status?'));

      const convTokens = estimateConversationTokens([
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello there!' },
      ]);
      assert.ok(convTokens > 10);
      assert.equal(estimateConversationTokens([]), 0);
    });

    it('truncates UTF-8/emoji strings safely without surrogate splitting and computes budget snapshots', () => {
      const text = 'CommerceCopilot 🚀 tracking Order #ORD-4821 với ngân sách 150.000đ cho khách hàng thân thiết';
      const truncated = truncateTextToTokenBudget(text, 10);
      assert.ok(truncated.length > 0 && truncated.length < text.length);
      assert.ok(!truncated.includes('\uFFFD'), 'Must never emit broken UTF-16 surrogate chars');
      assert.ok(estimateMemoryTextTokens(truncated) <= 12);

      const budget = computeMemoryTokenBudget({
        systemPrompt: 'You are CommerceCopilot.',
        rollingSummary: '[CONVERSATION_SUMMARY]\nUser ordered ORD-4821.',
        pinnedFactsBlock: '[PINNED_FACTS] order_id=ORD-4821 | budget=$150',
        recentTurns: [{ role: 'user', content: 'Check ETA' }],
        currentTurn: 'Can we expedite that order?',
        maxTotalTokens: 300,
      });
      assert.equal(budget.withinBudget, true);
      assert.ok(budget.totalPromptTokens < 300);
      assert.equal(budget.remainingBudgetTokens, 300 - budget.totalPromptTokens);
    });
  });

  describe('2. Mem0/Zep Fact Extraction, Temporal Superseding & Back-Reference Detection', () => {
    it('extracts EN/VI entities and applies latest-wins temporal superseding with audit history', () => {
      const turns: ConversationTurn[] = [
        {
          role: 'user',
          content:
            'Checking Order #ORD-4821 for 2 sets of ceramic mug in cobalt blue, budget $120, Starter plan, standard shipping.',
        },
        {
          role: 'user',
          content:
            'Actually update budget to $150, change color to emerald green, Pro plan, and express shipping for SKU-204.',
        },
      ];

      const extracted = extractConversationFacts(turns, 1);
      const merged = mergeMemoryFacts([], extracted);

      const byKey = new Map(merged.activeFacts.map((f) => [f.key, f]));
      assert.equal(byKey.get('order_id:ORD-4821')?.value, 'ORD-4821');
      assert.equal(byKey.get('sku:SKU-204')?.value, 'SKU-204');
      assert.equal(byKey.get('budget')?.value, '$150');
      assert.equal(byKey.get('color')?.value, 'emerald green');
      assert.equal(byKey.get('plan')?.value, 'pro plan');
      assert.equal(byKey.get('shipping')?.value, 'express shipping');
      assert.equal(byKey.get('quantity')?.value, '2 sets');

      // Verify old values were temporally superseded at turn 2
      const supersededBudget = merged.supersededFacts.find((f) => f.key === 'budget');
      const supersededColor = merged.supersededFacts.find((f) => f.key === 'color');
      assert.equal(supersededBudget?.value, '$120');
      assert.equal(supersededBudget?.supersededAtTurn, 2);
      assert.equal(supersededColor?.value, 'cobalt blue');
      assert.equal(supersededColor?.supersededAtTurn, 2);

      const pinned = formatPinnedFactsBlock(merged.allFacts, 120);
      assert.ok(pinned.startsWith('[PINNED_FACTS] '));
      assert.ok(pinned.includes('order_id=ORD-4821'));
      assert.ok(pinned.includes('budget=$150'));
      assert.ok(!pinned.includes('budget=$120'), 'Superseded values must not pollute pinned facts');
    });

    it('detects English and Vietnamese back-references accurately', () => {
      const en = hasBackReference('Can you expedite that order from earlier within my updated budget?');
      assert.equal(en.detected, true);
      assert.ok(en.matchedPhrases.length >= 2);
      assert.ok(en.referencedCategories.includes('order_id'));
      assert.ok(en.referencedCategories.includes('budget'));

      const vi = hasBackReference('Đơn hàng đó lúc nãy có đổi sang màu đó được không?');
      assert.equal(vi.detected, true);
      assert.ok(vi.referencedCategories.includes('order_id'));
      assert.ok(vi.referencedCategories.includes('color'));

      const standalone = hasBackReference('What are your standard return policy hours?');
      assert.equal(standalone.detected, false);
      assert.equal(standalone.matchedPhrases.length, 0);
    });
  });

  describe('3. RollingSummaryMemory Hybrid Window, Fallbacks, Scoping, LRU & TTL', () => {
    it('stays in passthrough mode for short chats and compresses long 22-turn chats cleanly', async () => {
      const memory = createRollingSummaryMemory({
        recentWindowTurns: 2,
        maxTotalTokens: 800,
        maxSummaryTokens: 200,
        maxFactsTokens: 120,
      });

      const shortRes = await memory.buildPrompt({
        sessionId: 'short-chat',
        systemPrompt: 'You are CommerceCopilot.',
        turns: [
          { role: 'user', content: 'Hi, checking Order #ORD-1001.' },
          { role: 'assistant', content: 'Order #ORD-1001 is packed and ready.' },
        ],
        currentTurn: 'Thanks!',
      });
      assert.equal(shortRes.metrics.mode, 'passthrough');
      assert.equal(shortRes.metrics.summarizedTurnsCount, 0);
      assert.equal(shortRes.rollingSummary, '');

      const history = makeLongCommerceHistory();
      const longRes = await memory.buildPrompt({
        sessionId: 'long-chat',
        systemPrompt: 'You are CommerceCopilot.',
        turns: history,
        currentTurn: 'Can we still ship that order from earlier under my updated budget?',
      });

      assert.equal(longRes.metrics.mode, 'rolling_summary');
      assert.equal(longRes.metrics.summarizedTurnsCount, history.length - 4);
      assert.equal(longRes.recentWindow.length, 4);
      assert.equal(longRes.metrics.backReferenceDetected, true);
      assert.equal(longRes.metrics.tokenBudget.withinBudget, true);
      assert.ok(longRes.metrics.tokensSaved > 150, `Expected substantial token savings, got ${longRes.metrics.tokensSaved}`);
      assert.ok(longRes.metrics.compressionRatio < 0.7);
      assert.ok(longRes.pinnedFactsBlock.includes('ORD-4821'));
      assert.ok(longRes.pinnedFactsBlock.includes('$150'));
      assert.ok(longRes.messages.some((m) => m.content.startsWith('[CONVERSATION_SUMMARY]')));
      assert.ok(longRes.messages.some((m) => m.content.startsWith('[PINNED_FACTS]')));
    });

    it('supports custom async summarizer and recovers safely to extractive fallback on failure', async () => {
      const customMemory = createRollingSummaryMemory({
        recentWindowTurns: 1,
        summarizer: async (input) =>
          `Custom summary (${input.turnsToSummarize.length} turns): ORD-4821 budget $150.`,
      });
      const okRes = await customMemory.buildPrompt({
        sessionId: 'custom-ok',
        turns: makeLongCommerceHistory().slice(0, 6),
        currentTurn: 'Status of that order?',
      });
      assert.equal(okRes.metrics.summarizerUsed, 'custom');
      assert.equal(okRes.metrics.summarizerErrorRecovered, false);
      assert.ok(okRes.rollingSummary.includes('Custom summary'));

      const capturedErrors: string[] = [];
      const failingMemory = createRollingSummaryMemory({
        recentWindowTurns: 1,
        summarizer: async () => {
          throw new Error('upstream_summarizer_503');
        },
        onSummarizerError: (err, ctx) => {
          capturedErrors.push(`${ctx.sessionId}:${err instanceof Error ? err.message : String(err)}`);
        },
      });
      const fallbackRes = await failingMemory.buildPrompt({
        sessionId: 'custom-fail',
        turns: makeLongCommerceHistory().slice(0, 6),
        currentTurn: 'Status of that order?',
      });
      assert.equal(fallbackRes.metrics.summarizerUsed, 'extractive_fallback');
      assert.equal(fallbackRes.metrics.summarizerErrorRecovered, true);
      assert.ok(fallbackRes.rollingSummary.length > 0, 'Must preserve extractive summary on failure');
      assert.equal(capturedErrors.length, 1);
      assert.ok(capturedErrors[0]!.includes('upstream_summarizer_503'));
      assert.equal(failingMemory.getStats().totalSummarizerFallbacks, 1);

      const standaloneExtractive = buildExtractiveRollingSummary({
        sessionId: 'direct',
        previousSummary: '',
        turnsToSummarize: makeLongCommerceHistory().slice(0, 4),
        activeFacts: [],
        maxSummaryTokens: 80,
      });
      assert.ok(standaloneExtractive.includes('ORD-4821'));
    });

    it('enforces per_chat vs global scope, one_bot vs all_bots sharing, LRU eviction, and TTL expiry', async () => {
      let clockMs = 10_000;
      const isolated = createRollingSummaryMemory({
        recentWindowTurns: 1,
        scope: 'per_chat',
        sharedWith: 'one_bot',
        maxSessions: 2,
        ttlMs: 5_000,
        nowFn: () => clockMs,
      });

      await isolated.addTurns('user-A', makeLongCommerceHistory().slice(0, 4), 'CommerceCopilot');
      await isolated.addTurns('user-B', [{ role: 'user', content: 'Hello from user B' }], 'CommerceCopilot');

      // Touch user-A so user-B becomes LRU victim
      assert.ok(isolated.getSession('user-A', 'CommerceCopilot') !== undefined);
      const otherBot = isolated.getSession('user-A', 'BillingBot');
      assert.equal(otherBot, undefined, 'one_bot must isolate CommerceCopilot from BillingBot');

      // Adding user-C evicts user-B (LRU)
      await isolated.addTurns('user-C', [{ role: 'user', content: 'Hello from user C' }], 'CommerceCopilot');
      assert.equal(isolated.getSession('user-B', 'CommerceCopilot'), undefined);
      assert.equal(isolated.getStats().evictedLruSessions, 1);

      // Advance clock past TTL -> remaining sessions expire
      clockMs += 10_000;
      assert.equal(isolated.getSession('user-A', 'CommerceCopilot'), undefined);
      assert.ok(isolated.getStats().expiredTtlSessions >= 2);

      // Shared across bots for same chat session
      const sharedBots = createRollingSummaryMemory({ scope: 'per_chat', sharedWith: 'all_bots' });
      await sharedBots.addTurns('user-A', makeLongCommerceHistory().slice(0, 4), 'CommerceCopilot');
      const billingView = await sharedBots.buildPrompt({
        sessionId: 'user-A',
        botId: 'BillingBot',
        currentTurn: 'Verify that order from earlier.',
      });
      assert.ok(billingView.pinnedFactsBlock.includes('ORD-4821'));

      // Global scope shares memory across session IDs when explicitly enabled
      const globalMem = createRollingSummaryMemory({ scope: 'global', sharedWith: 'all_bots' });
      await globalMem.addTurns('session-1', [{ role: 'user', content: 'Tracking Order #ORD-9999' }]);
      const fromSession2 = await globalMem.buildPrompt({
        sessionId: 'session-2',
        currentTurn: 'Check that order.',
      });
      assert.ok(fromSession2.pinnedFactsBlock.includes('ORD-9999'));
    });

    it('flags buildLastTurnOnlyPrompt as the memory_dropped anti-pattern dropping earlier facts', () => {
      const history = makeLongCommerceHistory();
      const trapped = buildLastTurnOnlyPrompt({
        systemPrompt: 'You are CommerceCopilot.',
        history,
        currentTurn: 'Expedite that order from earlier under my updated budget.',
      });

      assert.equal(trapped.antiPattern, 'last_turn_only_memory_dropped');
      assert.equal(trapped.metrics.mode, 'last_turn_only_antipattern');
      assert.equal(trapped.droppedTurnsCount, history.length - 1);
      assert.ok(trapped.droppedFactsCount >= 4);
      assert.equal(trapped.backReferenceDetected, true);
      assert.ok(!trapped.messages.map((m) => m.content).join('\n').includes('ORD-4821'));
    });
  });

  describe('4. GonnaCrash World 3 Level 26 Simulator & Root Export Verification', () => {
    it('proves all 5 Level 26 strategies and exact 40,289 UC 3-Star Record', () => {
      const sim = simulateLevel26LongConversationMemory();

      assert.equal(sim.levelKey, 'long_conversation_memory');
      assert.equal(sim.strategy, 'rolling_summary_three_star');
      assert.equal(sim.passedSla, true);
      assert.equal(sim.isThreeStarRecord, true);
      assert.equal(sim.costPerTaskUc, 40_289);
      assert.equal(sim.costPerTaskCents, 0.0403);
      assert.equal(
        sim.costBreakdownUc.appServerUc + sim.costBreakdownUc.memoryUc + sim.costBreakdownUc.llmUc,
        LEVEL26_SLA_TARGETS.threeStarBestCostUc
      );
      assert.equal(LEVEL26_COST_COMPONENTS_UC.appServerSmallUc, 289);
      assert.equal(LEVEL26_COST_COMPONENTS_UC.conversationMemoryRollingUc, 0);
      assert.equal(LEVEL26_COST_COMPONENTS_UC.openaiSmallRollingUc, 40_000);
      assert.ok(sim.answeredPct >= LEVEL26_SLA_TARGETS.minAnsweredPct);
      assert.ok(sim.accuracyPct >= LEVEL26_SLA_TARGETS.minAccuracyPct);
      assert.ok(sim.costPerTaskUc <= LEVEL26_SLA_TARGETS.maxCostPerTaskUc);

      // Verify all 4 failing topologies fail for their exact GonnaCrash reasons
      const fullHist = sim.comparisons.full_history_naive;
      assert.equal(fullHist.passedSla, false);
      assert.equal(fullHist.passedCostSla, false);
      assert.ok(fullHist.reasonCodes.includes('history_resent'));
      assert.ok(fullHist.costPerTaskUc > LEVEL26_SLA_TARGETS.maxCostPerTaskUc);

      const lastTurnTrap = sim.comparisons.last_turn_only_trap;
      assert.equal(lastTurnTrap.passedSla, false);
      assert.equal(lastTurnTrap.passedAccuracySla, false);
      assert.ok(lastTurnTrap.reasonCodes.includes('memory_dropped'));
      assert.ok(lastTurnTrap.accuracyPct < LEVEL26_SLA_TARGETS.minAccuracyPct);

      const chainedTrap = sim.comparisons.context_builder_before_memory_trap;
      assert.equal(chainedTrap.passedSla, false);
      assert.equal(chainedTrap.passedAccuracySla, false);
      assert.ok(chainedTrap.reasonCodes.includes('memory_dropped'));
      assert.ok(chainedTrap.reasonCodes.includes('upstream_context_truncated'));

      const midModel = sim.comparisons.rolling_summary_mid_model;
      assert.equal(midModel.passedSla, false);
      assert.equal(midModel.passedCostSla, false);
      assert.ok(midModel.reasonCodes.includes('budget_exceeded'));
      assert.ok(midModel.costPerTaskUc > LEVEL26_SLA_TARGETS.maxCostPerTaskUc);

      // Live probes validate real engine behavior
      assert.equal(sim.probes.backReferenceDetected, true);
      assert.equal(sim.probes.orderAnchorRetainedInRollingSummary, true);
      assert.equal(sim.probes.budgetSupersededCorrectly, true);
      assert.equal(sim.probes.lastTurnOnlyDroppedAnchor, true);
      assert.equal(sim.probes.contextBuilderBeforeMemoryDroppedAnchor, true);
      assert.equal(sim.probes.perChatIsolationPreserved, true);
      assert.ok(sim.probes.tokenSavingsPct > 35);
    });

    it('re-exports Level 26 symbols cleanly from @kido/ai-stream root without collisions', () => {
      assert.equal(typeof rootPackage.RollingSummaryMemory, 'function');
      assert.equal(typeof rootPackage.createRollingSummaryMemory, 'function');
      assert.equal(typeof rootPackage.extractConversationFacts, 'function');
      assert.equal(typeof rootPackage.mergeMemoryFacts, 'function');
      assert.equal(typeof rootPackage.formatPinnedFactsBlock, 'function');
      assert.equal(typeof rootPackage.hasBackReference, 'function');
      assert.equal(typeof rootPackage.buildLastTurnOnlyPrompt, 'function');
      assert.equal(typeof rootPackage.simulateLevel26LongConversationMemory, 'function');
      // Verify Level 25 voice-pipeline exports remain intact alongside Level 26
      assert.equal(typeof rootPackage.simulateLevel25VoiceAssistantLatency, 'function');
    });
  });
});
