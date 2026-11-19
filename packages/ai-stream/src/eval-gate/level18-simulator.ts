/**
 * @kido/ai-stream - GonnaCrash World 3 Level 18 (`eval_before_release`) 3-Star Verifier
 *
 * Deterministically simulates 120s @ 2 req/s (240 `chat` tasks) with a bad prompt release
 * attempted at `t=40s`:
 * - `no_eval_gate`: bad prompt ships to live traffic at `t=40s`; accuracy crashes from 94% -> 68%
 *   (overall `76.67% < 90%` SLA) -> FAILED
 * - `inline_eval_proxy`: executes judge checks inline on the live request hot-path, inflating
 *   TTFT to `2,370ms > 2,000ms` and cost to `760,275 UC > 630,000 UC` -> FAILED
 * - `offline_eval_gate`: runs out-of-band `OfflineEvalGate` (`0ms` live overhead), blocks the
 *   `t=40s` regression (`BLOCK_RELEASE`), keeps active prompt untouched, and hits exact Level 18
 *   3-Star Best Cost `542,218 UC` (`0.5422¢/task <= 0.6300¢/task`), `100%` answered (`>= 99%`),
 *   `420ms` TTFT (`<= 2,000ms`), and `94.0%` accuracy (`>= 90%`).
 *
 * Invariant: 100% zero external runtime dependencies and zero imports from sibling slices.
 */

import { createOfflineEvalGate, type OfflineEvalGateDecisionType } from './offline-eval-gate.js';
import type { EvalCandidateOutput, EvalGoldenCase } from './property-graders.js';

export type Level18EvalStrategy = 'no_eval_gate' | 'inline_eval_proxy' | 'offline_eval_gate';

export interface Level18SimulationOptions {
  strategy?: Level18EvalStrategy;
  stream?: boolean;
  totalRps?: number;
  durationSeconds?: number;
  releaseTickSec?: number;
}

export interface Level18StrategySnapshot {
  strategy: Level18EvalStrategy;
  totalTasks: number;
  answeredCount: number;
  answeredPct: number;
  ttftMs: number;
  liveEvalOverheadMs: number;
  preReleaseAccuracyPct: number;
  postReleaseAccuracyPct: number;
  accuracyPct: number;
  releaseAttemptTickSec: number;
  gateDecision: OfflineEvalGateDecisionType | 'BYPASSED' | 'INLINE_PROXY';
  blockedBadRelease: boolean;
  activePromptVersion: string;
  costPerTaskUc: number;
  costPerTaskCents: number;
  budgetUc: number;
  passedAnsweredSla: boolean;
  passedTtftSla: boolean;
  passedAccuracySla: boolean;
  passedCostSla: boolean;
  passedSla: boolean;
  isThreeStarRecord: boolean;
  verdict: string;
}

export interface Level18SimulationResult extends Level18StrategySnapshot {
  comparisons: Record<Level18EvalStrategy, Level18StrategySnapshot>;
}

const OPENAI_MID_COST_UC = 540_275; // 0.5403¢/task (`openai_mid`, stream: true)
const EVAL_GATE_AMORTIZED_UC = 1_943; // 0.0019¢/task ($100/mo Eval Gate amortized over level volume)
const INLINE_JUDGE_LIVE_COST_UC = 220_000; // Extra live judge token/API overhead per request
const INLINE_JUDGE_LATENCY_MS = 1_950;
const LEVEL18_BUDGET_UC = 630_000; // 0.6300¢/task SLA ceiling
const LEVEL18_BEST_COST_UC = 542_218; // 0.5422¢/task 3-Star Global Record

function runLevel18GateProbe(): OfflineEvalGateDecisionType {
  const probeCases: EvalGoldenCase[] = [
    {
      id: 'l18-pricing-grounding',
      category: 'pricing',
      critical: true,
      prompt: 'Watercolor 300gsm pad price and stock?',
      contextChunks: ['Baohong 300gsm A4 (SKU BH-300-A4): 145,000 VND, 32 left [Doc 1].'],
      properties: [
        { type: 'grounded_in_context', minScore: 0.9, strictNumbers: true, strictSkus: true, critical: true },
        { type: 'citation_required', minCount: 1 },
      ],
    },
    {
      id: 'l18-support-tone',
      category: 'tone',
      prompt: 'Order damaged in shipping?',
      contextChunks: ['Damaged items are replaced or refunded 100% within 24 hours [Doc 2].'],
      properties: [{ type: 'contains_all', values: ['100%', '24'], caseSensitive: false }],
    },
  ];
  const baselineOutputs: EvalCandidateOutput[] = [
    { caseId: 'l18-pricing-grounding', answer: 'Baohong 300gsm (SKU BH-300-A4) is 145,000 VND with 32 left [Doc 1].', ttftMs: 420, costUc: OPENAI_MID_COST_UC },
    { caseId: 'l18-support-tone', answer: 'Damaged items are refunded 100% within 24 hours [Doc 2].', ttftMs: 420, costUc: OPENAI_MID_COST_UC },
  ];
  const badCandidateOutputs: EvalCandidateOutput[] = [
    { caseId: 'l18-pricing-grounding', answer: 'Awesome! Grab SKU BH-777-PROMO today for only 79,000 VND [Doc 1]!', ttftMs: 420, costUc: OPENAI_MID_COST_UC },
    { caseId: 'l18-support-tone', answer: 'So sorry! Please email support when you have a moment.', ttftMs: 420, costUc: OPENAI_MID_COST_UC },
  ];
  const gate = createOfflineEvalGate({ initialPromptVersion: 'v1.0-stable', minPassRatePct: 90, budgetUc: LEVEL18_BUDGET_UC, maxTtftMs: 2_000 });
  return gate.evaluateCandidate({
    candidateVersion: 'v1.1-tone-tweak-regressed',
    goldenCases: probeCases,
    baselineOutputs,
    candidateOutputs: badCandidateOutputs,
  }).decision;
}

function evaluateLevel18Strategy(
  strategy: Level18EvalStrategy,
  params: { stream: boolean; totalRps: number; durationSeconds: number; releaseTickSec: number; offlineGateDecision: OfflineEvalGateDecisionType }
): Level18StrategySnapshot {
  const { stream, totalRps, durationSeconds, releaseTickSec, offlineGateDecision } = params;
  const totalTasks = Math.max(1, Math.round(totalRps * durationSeconds));
  const clampedTick = Math.min(durationSeconds, Math.max(0, releaseTickSec));
  const preShare = clampedTick / durationSeconds;
  const postShare = 1 - preShare;

  const baseTtftMs = stream ? 420 : 3_200;
  const preReleaseAccuracyPct = 94.0;
  let postReleaseAccuracyPct = 94.0;
  let liveEvalOverheadMs = 0;
  let costPerTaskUc = LEVEL18_BEST_COST_UC;
  let gateDecision: Level18StrategySnapshot['gateDecision'] = offlineGateDecision;
  let blockedBadRelease = false;
  let activePromptVersion = 'v1.0-stable';

  if (strategy === 'no_eval_gate') {
    postReleaseAccuracyPct = 68.0;
    costPerTaskUc = OPENAI_MID_COST_UC;
    gateDecision = 'BYPASSED';
    blockedBadRelease = false;
    activePromptVersion = 'v1.1-tone-tweak-regressed';
  } else if (strategy === 'inline_eval_proxy') {
    postReleaseAccuracyPct = 94.0;
    liveEvalOverheadMs = INLINE_JUDGE_LATENCY_MS;
    costPerTaskUc = OPENAI_MID_COST_UC + INLINE_JUDGE_LIVE_COST_UC;
    gateDecision = 'INLINE_PROXY';
    blockedBadRelease = true;
    activePromptVersion = 'v1.0-stable';
  } else {
    blockedBadRelease = offlineGateDecision === 'BLOCK_RELEASE';
    postReleaseAccuracyPct = blockedBadRelease ? 94.0 : 68.0;
    liveEvalOverheadMs = 0;
    costPerTaskUc = OPENAI_MID_COST_UC + EVAL_GATE_AMORTIZED_UC;
    activePromptVersion = blockedBadRelease ? 'v1.0-stable' : 'v1.1-tone-tweak-regressed';
  }

  const ttftMs = baseTtftMs + liveEvalOverheadMs;
  const accuracyPct = Number((preShare * preReleaseAccuracyPct + postShare * postReleaseAccuracyPct).toFixed(2));
  const answeredCount = totalTasks;
  const answeredPct = 100.0;
  const costPerTaskCents = Number((costPerTaskUc / 1_000_000).toFixed(4));

  const passedAnsweredSla = answeredPct >= 99;
  const passedTtftSla = ttftMs <= 2_000;
  const passedAccuracySla = accuracyPct >= 90;
  const passedCostSla = costPerTaskUc <= LEVEL18_BUDGET_UC;
  const passedSla = passedAnsweredSla && passedTtftSla && passedAccuracySla && passedCostSla;
  const isThreeStarRecord = passedSla && costPerTaskUc <= LEVEL18_BEST_COST_UC;

  let verdict = `PASSED (★★★ 3-Star Record: ${costPerTaskUc.toLocaleString('en-US')} UC)`;
  if (!passedAccuracySla) {
    verdict = `FAILED (Prompt Regression at t=${clampedTick}s: accuracy ${accuracyPct}% < 90% SLA)`;
  } else if (!passedTtftSla) {
    verdict = `FAILED (TTFT ${ttftMs}ms > 2000ms SLA${liveEvalOverheadMs > 0 ? ': inline eval proxy blocked hot-path' : ''})`;
  } else if (!passedCostSla) {
    verdict = `FAILED (Cost ${costPerTaskUc} UC > ${LEVEL18_BUDGET_UC} UC budget)`;
  } else if (!isThreeStarRecord) {
    verdict = `PASSED (SLA met at ${costPerTaskUc} UC)`;
  }

  return {
    strategy,
    totalTasks,
    answeredCount,
    answeredPct,
    ttftMs,
    liveEvalOverheadMs,
    preReleaseAccuracyPct,
    postReleaseAccuracyPct,
    accuracyPct,
    releaseAttemptTickSec: clampedTick,
    gateDecision,
    blockedBadRelease,
    activePromptVersion,
    costPerTaskUc,
    costPerTaskCents,
    budgetUc: LEVEL18_BUDGET_UC,
    passedAnsweredSla,
    passedTtftSla,
    passedAccuracySla,
    passedCostSla,
    passedSla,
    isThreeStarRecord,
    verdict,
  };
}

/**
 * Deterministic GonnaCrash World 3 Level 18 (`eval_before_release`) 3-Star verifier
 * comparing `no_eval_gate`, `inline_eval_proxy`, and out-of-band `offline_eval_gate`.
 */
export function simulateLevel18EvalBeforeRelease(
  options: Level18SimulationOptions = {}
): Level18SimulationResult {
  const strategy: Level18EvalStrategy = options.strategy ?? 'offline_eval_gate';
  const stream = options.stream ?? true;
  const totalRps = Math.max(1, options.totalRps ?? 2);
  const durationSeconds = Math.max(1, options.durationSeconds ?? 120);
  const releaseTickSec = options.releaseTickSec ?? 40;
  const offlineGateDecision = runLevel18GateProbe();

  const shared = { stream, totalRps, durationSeconds, releaseTickSec, offlineGateDecision };
  const comparisons: Record<Level18EvalStrategy, Level18StrategySnapshot> = {
    no_eval_gate: evaluateLevel18Strategy('no_eval_gate', shared),
    inline_eval_proxy: evaluateLevel18Strategy('inline_eval_proxy', shared),
    offline_eval_gate: evaluateLevel18Strategy('offline_eval_gate', shared),
  };

  return { ...comparisons[strategy], comparisons };
}
