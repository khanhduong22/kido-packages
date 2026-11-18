/**
 * @kido/ai-stream - GonnaCrash World 3 Level 15 (`cheap_model_first`) 3-Star Verifier
 *
 * Deterministically simulates 120s @ 20 req/s (2,400 `chat_support` tasks: 80% easy, 20% hard):
 * - `all_large`: hits large-tier RPM ceiling (`429` drops) & blows `0.76¢/task` budget (`3.19¢/task`)
 * - `all_small`: cheap (`0.0273¢/task`) & 0 429s, but fails hard (`55.0% < 93%`) & overall (`82.2% < 85%`) accuracy
 * - `model_router` (`80% easy -> openai_small` + `20% hard -> openai_large`, `stream: true`):
 *   hits exact 3-Star Best Cost `0.6599¢/task` (`659,856 UC <= 760,000 UC`), `100%` answered (`0` 429s),
 *   `340ms` TTFT (`< 2,000ms`), `96.25%` hard accuracy (`>= 93%`), `90.45%` overall accuracy (`>= 85%`).
 *
 * Invariant: 100% zero external runtime dependencies and zero imports from sibling slices.
 */

export type Level15RoutingStrategy = 'all_large' | 'all_small' | 'model_router';

export interface Level15SimulationOptions {
  strategy?: Level15RoutingStrategy;
  stream?: boolean;
  easyShare?: number;
  totalRps?: number;
  durationSeconds?: number;
  largeTierMaxRps?: number;
}

export interface Level15StrategySnapshot {
  strategy: Level15RoutingStrategy;
  totalTasks: number;
  easyTasks: number;
  hardTasks: number;
  answeredCount: number;
  answeredPct: number;
  rateLimited429Count: number;
  ttftMs: number;
  hardAccuracyPct: number;
  overallAccuracyPct: number;
  costPerTaskUc: number;
  costPerTaskCents: number;
  budgetUc: number;
  passedAnsweredSla: boolean;
  passedTtftSla: boolean;
  passedHardAccuracySla: boolean;
  passedOverallAccuracySla: boolean;
  passedCostSla: boolean;
  passedSla: boolean;
  isThreeStarRecord: boolean;
  verdict: string;
}

export interface Level15SimulationResult extends Level15StrategySnapshot {
  comparisons: Record<Level15RoutingStrategy, Level15StrategySnapshot>;
}

const SMALL_MODEL_COST_UC = 27_300; // 0.0273 cents/task (`openai_small`)
const LARGE_MODEL_COST_UC = 3_190_000; // 3.1900 cents/task (`openai_large`)
const ROUTER_OVERHEAD_UC = 16; // Amortized App Server + Model Router infra over 2,400 tasks
const LEVEL15_BUDGET_UC = 760_000; // 0.7600 cents/task SLA budget
const LEVEL15_BEST_COST_UC = 659_856; // 0.6599 cents/task 3-Star Global Record

function evaluateStrategySnapshot(
  strategy: Level15RoutingStrategy,
  params: {
    stream: boolean;
    easyShare: number;
    totalRps: number;
    durationSeconds: number;
    largeTierMaxRps: number;
  }
): Level15StrategySnapshot {
  const { stream, easyShare, totalRps, durationSeconds, largeTierMaxRps } = params;
  const totalTasks = Math.max(1, Math.round(totalRps * durationSeconds));
  const easyTasks = Math.round(totalTasks * easyShare);
  const hardTasks = totalTasks - easyTasks;
  const hardShare = 1 - easyShare;

  let largeRps = 0;
  let hardAccuracyPct = 96.25;
  let easyAccuracyPct = 89.0;
  let ttftMs = stream ? 340 : 3200;
  let costPerTaskUc = LEVEL15_BEST_COST_UC;

  if (strategy === 'all_large') {
    largeRps = totalRps;
    hardAccuracyPct = 96.25;
    easyAccuracyPct = 96.25;
    ttftMs = stream ? 2350 : 4200; // Degraded under 429 retry/queue saturation
    costPerTaskUc = LARGE_MODEL_COST_UC;
  } else if (strategy === 'all_small') {
    largeRps = 0;
    hardAccuracyPct = 55.0; // Fails >= 93% hard SLA
    easyAccuracyPct = 89.0;
    ttftMs = stream ? 280 : 2100;
    costPerTaskUc = SMALL_MODEL_COST_UC;
  } else {
    largeRps = totalRps * hardShare;
    hardAccuracyPct = 96.25;
    easyAccuracyPct = 89.0;
    ttftMs = stream ? 340 : 3200;
    costPerTaskUc = Math.round(easyShare * SMALL_MODEL_COST_UC + hardShare * LARGE_MODEL_COST_UC + ROUTER_OVERHEAD_UC);
  }

  let rateLimited429Count = 0;
  if (largeRps > largeTierMaxRps) {
    const excessRatio = (largeRps - largeTierMaxRps) / largeRps;
    const largeVolume = strategy === 'all_large' ? totalTasks : hardTasks;
    rateLimited429Count = Math.round(largeVolume * excessRatio);
  }

  const answeredCount = Math.max(0, totalTasks - rateLimited429Count);
  const answeredPct = Number(((answeredCount / totalTasks) * 100).toFixed(2));
  const overallAccuracyPct = Number((easyShare * easyAccuracyPct + hardShare * hardAccuracyPct).toFixed(2));
  const costPerTaskCents = Number((costPerTaskUc / 1_000_000).toFixed(4));

  const passedAnsweredSla = answeredPct >= 99;
  const passedTtftSla = ttftMs <= 2_000;
  const passedHardAccuracySla = hardAccuracyPct >= 93;
  const passedOverallAccuracySla = overallAccuracyPct >= 85;
  const passedCostSla = costPerTaskUc <= LEVEL15_BUDGET_UC;
  const passedSla =
    passedAnsweredSla &&
    passedTtftSla &&
    passedHardAccuracySla &&
    passedOverallAccuracySla &&
    passedCostSla;
  const isThreeStarRecord = passedSla && costPerTaskUc <= LEVEL15_BEST_COST_UC;

  let verdict = `PASSED (★★★ 3-Star Record: ${costPerTaskUc.toLocaleString('en-US')} UC)`;
  if (!passedAnsweredSla) {
    verdict = `FAILED (HTTP 429 RPM Ceiling: ${answeredPct}% answered < 99% SLA, ${rateLimited429Count} dropped)`;
  } else if (!passedHardAccuracySla || !passedOverallAccuracySla) {
    verdict = `FAILED (Accuracy: hard=${hardAccuracyPct}% [<93%], overall=${overallAccuracyPct}% [<85%])`;
  } else if (!passedCostSla) {
    verdict = `FAILED (Cost ${costPerTaskUc} UC > ${LEVEL15_BUDGET_UC} UC budget)`;
  } else if (!passedTtftSla) {
    verdict = `FAILED (TTFT ${ttftMs}ms > 2000ms SLA: enable SSE streaming)`;
  } else if (!isThreeStarRecord) {
    verdict = `PASSED (SLA met at ${costPerTaskUc} UC)`;
  }

  return {
    strategy,
    totalTasks,
    easyTasks,
    hardTasks,
    answeredCount,
    answeredPct,
    rateLimited429Count,
    ttftMs,
    hardAccuracyPct,
    overallAccuracyPct,
    costPerTaskUc,
    costPerTaskCents,
    budgetUc: LEVEL15_BUDGET_UC,
    passedAnsweredSla,
    passedTtftSla,
    passedHardAccuracySla,
    passedOverallAccuracySla,
    passedCostSla,
    passedSla,
    isThreeStarRecord,
    verdict,
  };
}

/**
 * Deterministic GonnaCrash World 3 Level 15 (`cheap_model_first`) 3-Star verifier
 * comparing `all_large`, `all_small`, and `model_router` (80% easy -> small + 20% hard -> large, stream=true).
 */
export function simulateLevel15CheapModelFirst(options: Level15SimulationOptions = {}): Level15SimulationResult {
  const strategy: Level15RoutingStrategy = options.strategy ?? 'model_router';
  const stream = options.stream ?? true;
  const easyShare = Math.min(1, Math.max(0, options.easyShare ?? 0.8));
  const totalRps = Math.max(1, options.totalRps ?? 20);
  const durationSeconds = Math.max(1, options.durationSeconds ?? 120);
  const largeTierMaxRps = Math.max(1, options.largeTierMaxRps ?? 10);

  const shared = { stream, easyShare, totalRps, durationSeconds, largeTierMaxRps };
  const comparisons: Record<Level15RoutingStrategy, Level15StrategySnapshot> = {
    all_large: evaluateStrategySnapshot('all_large', shared),
    all_small: evaluateStrategySnapshot('all_small', shared),
    model_router: evaluateStrategySnapshot('model_router', shared),
  };

  return {
    ...comparisons[strategy],
    comparisons,
  };
}
