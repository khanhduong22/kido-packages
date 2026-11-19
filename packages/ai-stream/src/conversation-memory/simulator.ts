/**
 * @kido/ai-stream/conversation-memory - GonnaCrash World 3 Level 26 (`long_conversation_memory`) Verifier
 *
 * Verified per-turn cost math at `2 req/s` (`5,184,000 turns/mo`, `long_chat` workload):
 * - `App Server (S = $15/mo)`: `289 UC` (`0.0003¢/turn`)
 * - `Conversation Memory (Rolling summary = $0/mo)`: `0 UC`
 * - `LLM Provider`:
 *   - `openai_small` + Rolling Summary: `40,000 UC` -> total **`40,289 UC`** (`0.0403¢/task` EXACT!)
 *   - `openai_small` + Full 24-Turn History: `145,000 UC` -> `145,289 UC > 47,000 UC` (`history_resent` FAIL)
 *   - `openai_mid` + Rolling Summary: `120,000 UC` -> `120,289 UC > 47,000 UC` (`budget_exceeded` FAIL)
 *   - `Context Builder (Rules: last_turn_only)` alone OR chained BEFORE `Conversation Memory`:
 *     hard-trims to 1 turn -> accuracy `58%–61% < 85%` (`memory_dropped` FAIL).
 *
 * Invariant: 100% self-contained (zero external deps, zero sibling-slice imports).
 */

import { estimateConversationTokens, type ConversationTurn } from './token-budget.js';
import { RollingSummaryMemory, buildLastTurnOnlyPrompt } from './rolling-summary-memory.js';

export type Level26MemoryStrategy =
  | 'full_history_naive'
  | 'last_turn_only_trap'
  | 'context_builder_before_memory_trap'
  | 'rolling_summary_mid_model'
  | 'rolling_summary_three_star';

export type Level26FailureReasonCode =
  | 'history_resent'
  | 'memory_dropped'
  | 'upstream_context_truncated'
  | 'budget_exceeded'
  | 'low_answered';

export interface Level26CostBreakdownUc {
  appServerUc: number;
  memoryUc: number;
  llmUc: number;
  totalUc: number;
}

export interface Level26SimulationOptions {
  strategy?: Level26MemoryStrategy;
  totalTurns?: number;
}

export interface Level26StrategySnapshot {
  strategy: Level26MemoryStrategy;
  topology: string;
  llmModel: 'openai_small' | 'openai_mid';
  usesContextBuilderRules: boolean;
  usesRollingSummaryMemory: boolean;
  totalTurns: number;
  answeredCount: number;
  answeredPct: number;
  accuracyPct: number;
  backReferenceAccuracyPct: number;
  avgPromptTokens: number;
  tokenReductionVsFullHistoryPct: number;
  costBreakdownUc: Level26CostBreakdownUc;
  costPerTaskUc: number;
  costPerTaskCents: number;
  budgetUc: number;
  reasonCodes: Level26FailureReasonCode[];
  passedAnsweredSla: boolean;
  passedAccuracySla: boolean;
  passedCostSla: boolean;
  passedSla: boolean;
  isThreeStarRecord: boolean;
  verdict: string;
}

export interface Level26ProbeSummary {
  fullHistoryTokens: number;
  rollingSummaryPromptTokens: number;
  tokenSavingsPct: number;
  backReferenceDetected: boolean;
  orderAnchorRetainedInRollingSummary: boolean;
  budgetSupersededCorrectly: boolean;
  lastTurnOnlyDroppedAnchor: boolean;
  contextBuilderBeforeMemoryDroppedAnchor: boolean;
  perChatIsolationPreserved: boolean;
}

export interface Level26SimulationResult extends Level26StrategySnapshot {
  levelKey: 'long_conversation_memory';
  concept: 'rolling_summary_memory';
  probes: Level26ProbeSummary;
  comparisons: Record<Level26MemoryStrategy, Level26StrategySnapshot>;
}

export const LEVEL26_COST_COMPONENTS_UC = Object.freeze({
  appServerSmallUc: 289, // $15/mo over 5,184,000 turns/mo (2 req/s)
  conversationMemoryRollingUc: 0, // $0/mo rolling summary engine
  contextBuilderRulesUc: 0, // $0/mo rule-based trimmer (decoy trap!)
  openaiSmallRollingUc: 40_000, // 0.0400¢/turn -> total 40,289 UC EXACT
  openaiSmallFullHistoryUc: 145_000, // 0.1450¢/turn -> 145,289 UC (> 47,000 UC history_resent)
  openaiSmallLastTurnOnlyUc: 16_000, // 0.0160¢/turn -> cheap, fails accuracy (< 85%)
  openaiSmallContextBuilderBeforeMemoryUc: 18_500, // 0.0185¢/turn -> upstream trim kills memory
  openaiMidRollingUc: 120_000, // 0.1200¢/turn -> 120,289 UC (> 47,000 UC budget_exceeded)
});

export const LEVEL26_SLA_TARGETS = Object.freeze({
  levelKey: 'long_conversation_memory' as const,
  concept: 'rolling_summary_memory' as const,
  trafficRps: 2,
  monthlyTurns: 5_184_000,
  minAnsweredPct: 99.0,
  minAccuracyPct: 85.0,
  maxCostPerTaskUc: 47_000, // 0.0470¢/task
  threeStarBestCostUc: 40_289, // 289 + 0 + 40,000 = 0.0403¢/task
  fullHistoryAvgTokens: 2_840,
});

function buildBenchmarkLongChatHistory(): ConversationTurn[] {
  const history: ConversationTurn[] = [
    { role: 'user', content: 'Hi CommerceCopilot, I placed Order #ORD-4821 for a cobalt blue ceramic mug with a budget of $120 and standard shipping.' },
    { role: 'assistant', content: 'Found Order #ORD-4821 for the cobalt blue ceramic mug under your $120 budget with standard shipping.' },
    { role: 'user', content: 'Actually please update my budget to $150 and switch to express shipping with emerald green if available.' },
    { role: 'assistant', content: 'Updated your preference to emerald green, express shipping, and budget $150 on our active session notes.' },
  ];

  const topics: readonly [string, string][] = [
    ['Does CommerceCopilot support eco-friendly gift wrapping for ceramic mugs when ordering multiple sets?', 'Yes, complimentary eco-friendly gift wrapping and cushioned inserts are included on express shipping orders across all fulfillment centers.'],
    ['What is the exact return and exchange window if a ceramic item arrives chipped during transit?', 'You have 30 calendar days from delivery for a free priority replacement or full refund after uploading a single photo of the shipping label.'],
    ['Do you ship internationally to EU regional warehouses and handle customs VAT documentation upfront?', 'Yes, EU fulfillment dispatches within 48 hours of payment confirmation with prepaid VAT invoices attached electronically to your account portal.'],
    ['Can my finance team pay using corporate net-30 invoice billing instead of a credit card?', 'Corporate net-30 invoice billing is available on Business plan and Enterprise plan accounts once domain verification finishes.'],
    ['How should I clean insulated ceramic mugs so the exterior finish does not peel over time?', 'Hand washing with mild liquid soap and warm water preserves the exterior glaze finish longest, though the stainless inner sleeve is top-rack safe.'],
    ['Are replacement silicone travel lids sold separately under SKU-204 for older mug batches?', 'Yes, universal food-grade replacement silicone lids are stocked under SKU-204 and fit every 350ml and 450ml vessel manufactured since 2024.'],
    ['What are your live support operating hours if a courier delays my shipment over the weekend?', 'SaaSSupportBot monitors live tracking webhooks 24/7 and escalates carrier exceptions to live specialists with under 2 minute response times.'],
    ['Can I attach a custom printed gift message card inside the outer carton at checkout?', 'Yes, up to 200 characters can be printed on our recycled cotton gift card, and prices are automatically hidden from the packing slip.'],
    ['Do loyalty reward points expire after 12 months if I only order seasonally for team events?', 'Loyalty reward points stay active indefinitely as long as your workspace places at least one qualifying order every 18 months.'],
    ['Can I split a bulk corporate order across two office delivery addresses in a single invoice?', 'Multi-address split fulfillment is supported for orders of 5 or more sets with individual tracking numbers emailed per destination.'],
  ];

  for (const [q, a] of topics) {
    history.push({ role: 'user', content: q }, { role: 'assistant', content: a });
  }
  return history;
}

function runLevel26LiveProbes(): Level26ProbeSummary {
  const history = buildBenchmarkLongChatHistory();
  const followUp = 'Can we still expedite that order from earlier within my updated budget?';
  const systemPrompt = 'You are CommerceCopilot helping shoppers manage active orders.';

  const fullHistoryTokens = estimateConversationTokens([
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: followUp },
  ]);

  const rollingMemory = new RollingSummaryMemory({
    recentWindowTurns: 2,
    maxTotalTokens: 700,
    maxSummaryTokens: 150,
    maxFactsTokens: 90,
    scope: 'per_chat',
    sharedWith: 'one_bot',
  });
  const rollingResult = rollingMemory.buildPromptSync({
    sessionId: 'shopper-alpha',
    systemPrompt,
    turns: history,
    currentTurn: followUp,
  });

  const rollingText = rollingResult.messages.map((m) => m.content).join('\n');
  const activeBudget = rollingResult.activeFacts.find((f) => f.key === 'budget');
  const supersededBudget = rollingResult.supersededFacts.find(
    (f) => f.key === 'budget' && f.value === '$120' && f.supersededAtTurn !== undefined
  );

  // Trap A: Context Builder (Rules: last_turn_only)
  const lastTurnOnly = buildLastTurnOnlyPrompt({ systemPrompt, history, currentTurn: followUp });
  const lastTurnOnlyDroppedAnchor = !lastTurnOnly.messages.map((m) => m.content).join('\n').includes('ORD-4821');

  // Trap B: Context Builder (Rules) chained BEFORE Conversation Memory
  const poisonedMemory = new RollingSummaryMemory({ recentWindowTurns: 2, scope: 'per_chat' });
  const chainedTrap = poisonedMemory.buildPromptSync({
    sessionId: 'shopper-trap',
    systemPrompt,
    turns: history.slice(-1), // Upstream Context Builder already dropped 21 turns!
    currentTurn: followUp,
  });
  const contextBuilderBeforeMemoryDroppedAnchor = !chainedTrap.messages
    .map((m) => m.content)
    .join('\n')
    .includes('ORD-4821');

  // Per-chat isolation probe (Session B never sees Session A's ORD-4821)
  const sessionB = rollingMemory.buildPromptSync({
    sessionId: 'shopper-beta',
    systemPrompt,
    currentTurn: 'Check status of that order from earlier please.',
  });
  const perChatIsolationPreserved = !sessionB.messages.map((m) => m.content).join('\n').includes('ORD-4821');

  const rollingSummaryPromptTokens = rollingResult.metrics.compressedPromptTokens;
  const tokenSavingsPct = Number(
    (((fullHistoryTokens - rollingSummaryPromptTokens) / Math.max(1, fullHistoryTokens)) * 100).toFixed(2)
  );

  return {
    fullHistoryTokens,
    rollingSummaryPromptTokens,
    tokenSavingsPct,
    backReferenceDetected: rollingResult.metrics.backReferenceDetected,
    orderAnchorRetainedInRollingSummary: rollingText.includes('ORD-4821'),
    budgetSupersededCorrectly: activeBudget?.value === '$150' && supersededBudget !== undefined,
    lastTurnOnlyDroppedAnchor,
    contextBuilderBeforeMemoryDroppedAnchor,
    perChatIsolationPreserved,
  };
}

function evaluateLevel26Strategy(
  strategy: Level26MemoryStrategy,
  totalTurns: number
): Level26StrategySnapshot {
  const c = LEVEL26_COST_COMPONENTS_UC;
  let topology = 'App Server (S) + Conversation Memory (Rolling summary, per_chat) + LLM (openai_small)';
  let llmModel: 'openai_small' | 'openai_mid' = 'openai_small';
  let usesContextBuilderRules = false;
  let usesRollingSummaryMemory = true;
  let answeredPct = 99.8;
  let accuracyPct = 90.5;
  let backReferenceAccuracyPct = 89.2;
  let avgPromptTokens = 540;
  let llmUc: number = c.openaiSmallRollingUc;
  const reasonCodes: Level26FailureReasonCode[] = [];

  if (strategy === 'full_history_naive') {
    topology = 'App Server (S) + Full 24-Turn History Resent + LLM (openai_small)';
    usesRollingSummaryMemory = false;
    accuracyPct = 93.5;
    backReferenceAccuracyPct = 95.0;
    avgPromptTokens = LEVEL26_SLA_TARGETS.fullHistoryAvgTokens;
    llmUc = c.openaiSmallFullHistoryUc;
    reasonCodes.push('history_resent');
  } else if (strategy === 'last_turn_only_trap') {
    topology = 'App Server (S) + Context Builder (Rules: last_turn_only) + LLM (openai_small)';
    usesContextBuilderRules = true;
    usesRollingSummaryMemory = false;
    accuracyPct = 58.0;
    backReferenceAccuracyPct = 14.0;
    avgPromptTokens = 210;
    llmUc = c.openaiSmallLastTurnOnlyUc;
    reasonCodes.push('memory_dropped');
  } else if (strategy === 'context_builder_before_memory_trap') {
    topology =
      'App Server (S) + Context Builder (Rules: last_turn_only) -> Conversation Memory (Rolling summary) + LLM (openai_small)';
    usesContextBuilderRules = true;
    usesRollingSummaryMemory = true;
    accuracyPct = 61.0;
    backReferenceAccuracyPct = 18.0;
    avgPromptTokens = 245;
    llmUc = c.openaiSmallContextBuilderBeforeMemoryUc;
    reasonCodes.push('memory_dropped', 'upstream_context_truncated');
  } else if (strategy === 'rolling_summary_mid_model') {
    topology = 'App Server (S) + Conversation Memory (Rolling summary, per_chat) + LLM (openai_mid)';
    llmModel = 'openai_mid';
    accuracyPct = 94.0;
    backReferenceAccuracyPct = 93.5;
    avgPromptTokens = 540;
    llmUc = c.openaiMidRollingUc;
  }

  const totalUc = c.appServerSmallUc + c.conversationMemoryRollingUc + llmUc;
  const passedAnsweredSla = answeredPct >= LEVEL26_SLA_TARGETS.minAnsweredPct;
  const passedAccuracySla = accuracyPct >= LEVEL26_SLA_TARGETS.minAccuracyPct;
  const passedCostSla = totalUc <= LEVEL26_SLA_TARGETS.maxCostPerTaskUc;
  const passedSla = passedAnsweredSla && passedAccuracySla && passedCostSla;
  const isThreeStarRecord = passedSla && totalUc === LEVEL26_SLA_TARGETS.threeStarBestCostUc;

  if (!passedAnsweredSla) reasonCodes.push('low_answered');
  if (!passedCostSla) reasonCodes.push('budget_exceeded');

  let verdict = `PASSED (★★★ 3-Star Record: ${accuracyPct}% accuracy, ${totalUc.toLocaleString('en-US')} UC)`;
  if (!passedAccuracySla) {
    verdict = `FAILED (Accuracy ${accuracyPct}% < ${LEVEL26_SLA_TARGETS.minAccuracyPct}% SLA: ${reasonCodes.join(', ')})`;
  } else if (!passedCostSla) {
    verdict = `FAILED (Cost ${totalUc.toLocaleString('en-US')} UC > ${LEVEL26_SLA_TARGETS.maxCostPerTaskUc.toLocaleString('en-US')} UC budget: ${reasonCodes.join(', ')})`;
  } else if (!passedAnsweredSla) {
    verdict = `FAILED (Answered ${answeredPct}% < ${LEVEL26_SLA_TARGETS.minAnsweredPct}% SLA)`;
  }

  return {
    strategy,
    topology,
    llmModel,
    usesContextBuilderRules,
    usesRollingSummaryMemory,
    totalTurns,
    answeredCount: Math.round((totalTurns * answeredPct) / 100),
    answeredPct,
    accuracyPct,
    backReferenceAccuracyPct,
    avgPromptTokens,
    tokenReductionVsFullHistoryPct: Number(
      (((LEVEL26_SLA_TARGETS.fullHistoryAvgTokens - avgPromptTokens) / LEVEL26_SLA_TARGETS.fullHistoryAvgTokens) * 100).toFixed(2)
    ),
    costBreakdownUc: { appServerUc: c.appServerSmallUc, memoryUc: c.conversationMemoryRollingUc, llmUc, totalUc },
    costPerTaskUc: totalUc,
    costPerTaskCents: Number((totalUc / 1_000_000).toFixed(4)),
    budgetUc: LEVEL26_SLA_TARGETS.maxCostPerTaskUc,
    reasonCodes,
    passedAnsweredSla,
    passedAccuracySla,
    passedCostSla,
    passedSla,
    isThreeStarRecord,
    verdict,
  };
}

/**
 * Deterministic GonnaCrash World 3 Level 26 (`long_conversation_memory`) 3-Star verifier:
 * proves `full_history_naive`, `last_turn_only_trap`, `context_builder_before_memory_trap`,
 * and `rolling_summary_mid_model` fail SLA while `rolling_summary_three_star` passes every SLA
 * at exact `40,289 UC` (`0.0403¢/task`).
 */
export function simulateLevel26LongConversationMemory(
  options: Level26SimulationOptions = {}
): Level26SimulationResult {
  const strategy: Level26MemoryStrategy = options.strategy ?? 'rolling_summary_three_star';
  const totalTurns = Math.max(1, options.totalTurns ?? 600);
  const probes = runLevel26LiveProbes();

  const comparisons: Record<Level26MemoryStrategy, Level26StrategySnapshot> = {
    full_history_naive: evaluateLevel26Strategy('full_history_naive', totalTurns),
    last_turn_only_trap: evaluateLevel26Strategy('last_turn_only_trap', totalTurns),
    context_builder_before_memory_trap: evaluateLevel26Strategy('context_builder_before_memory_trap', totalTurns),
    rolling_summary_mid_model: evaluateLevel26Strategy('rolling_summary_mid_model', totalTurns),
    rolling_summary_three_star: evaluateLevel26Strategy('rolling_summary_three_star', totalTurns),
  };

  return {
    levelKey: LEVEL26_SLA_TARGETS.levelKey,
    concept: LEVEL26_SLA_TARGETS.concept,
    ...comparisons[strategy],
    probes,
    comparisons,
  };
}
