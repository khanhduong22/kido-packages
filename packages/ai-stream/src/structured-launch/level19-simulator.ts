/**
 * @kido/ai-stream - GonnaCrash World 3 Level 19 Boss Fight (`ai_feature_launch`) Verifier
 *
 * Deterministically simulates 180s (`0-60s` @ 3 req/s + `60-120s` livestream spike @ 10 req/s
 * + `120-180s` @ 3 req/s = 960 `product_card` tasks; budget `<= 410,000 UC = 0.4100¢/task`),
 * comparing all 5 failure modes against `three_star_launch`:
 * - `small_model`: cheap, but accuracy `86.0% < 94%` SLA -> FAILED
 * - `free_text_json`: broken JSON drops cards (`94.38% < 99.9%` answered SLA) -> FAILED
 * - `no_semantic_cache`: blows `410,000 UC` budget (`642,800 UC`) -> FAILED
 * - `loose_semantic_cache`: confuses `"size M"` vs `"size L"` (`78.5% < 94%`) -> FAILED
 * - `no_backoff_retry`: drops 429s during `60s-120s` livestream spike (`85.0% < 99.9%`) -> FAILED
 * - `three_star_launch` (`openai_mid` + `json_schema` + `stream=true` + `strict` cache + `backoff`):
 *   `100%` answered (`>= 99.9%`), `310ms` TTFT (`<= 2,000ms`), `96.25%` accuracy (`>= 94%`),
 *   exact `355,785 UC` (`0.3558¢/task <= 410,000 UC`), `isThreeStarRecord: true`.
 *
 * Invariant: 100% zero external runtime dependencies and zero imports from sibling slices.
 */

import { StreamingProductCardExtractor } from './partial-json-stream.js';
import { ValidatedSemanticCacheGate, type StrictJsonSchemaSpec } from './validated-semantic-cache.js';
import { formatSseWaitingFrame, parseSseWaitingFrame } from './waiting-feedback-sse.js';

export type Level19LaunchStrategy =
  | 'small_model'
  | 'free_text_json'
  | 'no_semantic_cache'
  | 'loose_semantic_cache'
  | 'no_backoff_retry'
  | 'three_star_launch';

export interface Level19SimulationOptions {
  strategy?: Level19LaunchStrategy;
  stream?: boolean;
  steadyRps?: number;
  livestreamSpikeRps?: number;
  durationSeconds?: number;
}

export interface Level19StrategySnapshot {
  strategy: Level19LaunchStrategy;
  modelFlavor: 'openai_small' | 'openai_mid';
  outputMode: 'free' | 'json_schema';
  retryMode: 'none' | 'backoff';
  semanticCacheMode: 'none' | 'loose' | 'strict';
  stream: boolean;
  totalTicks: number;
  totalTasks: number;
  answeredCount: number;
  answeredPct: number;
  brokenJsonDroppedCount: number;
  rateLimited429Count: number;
  cacheHitCount: number;
  ttftMs: number;
  accuracyPct: number;
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

export interface Level19ProbeSummary {
  partialStreamCardsExtracted: number;
  writeBlockedInvalidJson: number;
  sizeIsolationBlocked: boolean;
  waitingFramesBridged: number;
}

export interface Level19SimulationResult extends Level19StrategySnapshot {
  probes: Level19ProbeSummary;
  comparisons: Record<Level19LaunchStrategy, Level19StrategySnapshot>;
}

const LEVEL19_BUDGET_UC = 410_000;
const LEVEL19_BEST_COST_UC = 355_785; // 0.3558¢/task (0.0010¢ Semantic Cache + 0.3548¢ openai_mid)

interface ProbeCard { sku: string; name: string; size: string; priceVnd: number; }
interface ProbePayload { cards: ProbeCard[]; }

const PROBE_SCHEMA: StrictJsonSchemaSpec<ProbePayload> = {
  fields: {
    cards: {
      type: 'array',
      minItems: 1,
      itemSchema: {
        fields: {
          sku: { type: 'string', nonEmpty: true },
          name: { type: 'string', nonEmpty: true },
          size: { type: 'string', nonEmpty: true },
          priceVnd: { type: 'number', min: 1 },
        },
      },
    },
  },
};

async function runLevel19LiveProbes(): Promise<Level19ProbeSummary> {
  const extractor = new StreamingProductCardExtractor<ProbeCard>({ arrayKeys: ['cards'] });
  const chunks = [
    '```json\n{"cards":[{"sku":"ART-TEE-M","name":"Áo thun họa sĩ',
    ' size M","size":"M","priceVnd":245000},{"sku":"BH-300","name":"Giấy Baohong',
    ' 300gsm","size":"A4","priceVnd":145000}]}\n```',
  ];
  let extracted = 0;
  for (const chunk of chunks) extracted += extractor.pushChunk(chunk).length;

  const cache = new ValidatedSemanticCacheGate<ProbePayload>({ schema: PROBE_SCHEMA, similarityThreshold: 0.95, requireEntityMatch: true });
  await cache.store({ query: 'Áo thun họa sĩ size M còn hàng không?', payload: { cards: extractor.getCards().slice(0, 1) } });
  await cache.store({ query: 'Áo thun họa sĩ size M còn hàng không?', payload: '{"cards": [' as unknown as ProbePayload });
  const sizeLMiss = await cache.lookup('Áo thun họa sĩ size L còn hàng không?');

  const frame = formatSseWaitingFrame({ attempt: 1, delayMs: 280, reason: 'livestream_spike_429' });
  const parsedFrame = parseSseWaitingFrame(frame);

  return {
    partialStreamCardsExtracted: extracted,
    writeBlockedInvalidJson: cache.getStats().writeBlockedInvalidJson,
    sizeIsolationBlocked: !sizeLMiss.hit && sizeLMiss.entityMismatchBlocked,
    waitingFramesBridged: parsedFrame?.status === 'waiting' ? 1 : 0,
  };
}

function evaluateStrategy(
  strategy: Level19LaunchStrategy,
  params: { stream: boolean; steadyRps: number; livestreamSpikeRps: number; durationSeconds: number }
): Level19StrategySnapshot {
  const { stream, steadyRps, livestreamSpikeRps, durationSeconds } = params;
  const steadyWindow = Math.round(durationSeconds / 3);
  const spikeWindow = durationSeconds - steadyWindow * 2;
  const baselineTasks = steadyRps * steadyWindow * 2;
  const spikeTasks = livestreamSpikeRps * spikeWindow;
  const totalTasks = Math.max(1, baselineTasks + spikeTasks);

  let modelFlavor: 'openai_small' | 'openai_mid' = 'openai_mid';
  let outputMode: 'free' | 'json_schema' = 'json_schema';
  let retryMode: 'none' | 'backoff' = 'backoff';
  let semanticCacheMode: 'none' | 'loose' | 'strict' = 'strict';
  let brokenJsonDroppedCount = 0;
  let rateLimited429Count = 0;
  let cacheHitCount = Math.round(totalTasks * 0.45);
  let ttftMs = stream ? 310 : 2_650;
  let accuracyPct = 96.25;
  let costPerTaskUc = LEVEL19_BEST_COST_UC;

  if (strategy === 'small_model') {
    modelFlavor = 'openai_small';
    accuracyPct = 86.0;
    ttftMs = stream ? 240 : 2_150;
    costPerTaskUc = 142_000;
  } else if (strategy === 'free_text_json') {
    outputMode = 'free';
    brokenJsonDroppedCount = Math.max(1, Math.round(totalTasks * 0.05625));
    accuracyPct = 91.5;
    ttftMs = stream ? 330 : 2_650;
  } else if (strategy === 'no_semantic_cache') {
    semanticCacheMode = 'none';
    cacheHitCount = 0;
    ttftMs = stream ? 380 : 2_650;
    costPerTaskUc = 642_800;
  } else if (strategy === 'loose_semantic_cache') {
    semanticCacheMode = 'loose';
    cacheHitCount = Math.round(totalTasks * 0.72);
    accuracyPct = 78.5;
    ttftMs = stream ? 220 : 2_150;
    costPerTaskUc = 285_000;
  } else if (strategy === 'no_backoff_retry') {
    retryMode = 'none';
    rateLimited429Count = Math.max(1, Math.round(spikeTasks * 0.24));
    ttftMs = stream ? 390 : 2_650;
  }

  const answeredCount = Math.max(0, totalTasks - brokenJsonDroppedCount - rateLimited429Count);
  const answeredPct = Number(((answeredCount / totalTasks) * 100).toFixed(2));
  const costPerTaskCents = Number((costPerTaskUc / 1_000_000).toFixed(4));

  const passedAnsweredSla = answeredPct >= 99.9;
  const passedTtftSla = ttftMs <= 2_000;
  const passedAccuracySla = accuracyPct >= 94.0;
  const passedCostSla = costPerTaskUc <= LEVEL19_BUDGET_UC;
  const passedSla = passedAnsweredSla && passedTtftSla && passedAccuracySla && passedCostSla;
  const isThreeStarRecord = passedSla && costPerTaskUc <= LEVEL19_BEST_COST_UC;

  let verdict = `PASSED (★★★ 3-Star Record: ${costPerTaskUc.toLocaleString('en-US')} UC)`;
  if (!passedAnsweredSla) {
    verdict =
      brokenJsonDroppedCount > 0
        ? `FAILED (Broken JSON dropped ${brokenJsonDroppedCount} product cards: answered ${answeredPct}% < 99.9% SLA)`
        : `FAILED (429 spike dropped ${rateLimited429Count} requests during 60s-120s livestream: answered ${answeredPct}% < 99.9% SLA)`;
  } else if (!passedAccuracySla) {
    verdict = `FAILED (Accuracy ${accuracyPct}% < 94% SLA: ${semanticCacheMode === 'loose' ? 'loose cache confused size M vs size L' : 'small_model accuracy too low'})`;
  } else if (!passedCostSla) {
    verdict = `FAILED (Cost ${costPerTaskUc.toLocaleString('en-US')} UC > ${LEVEL19_BUDGET_UC.toLocaleString('en-US')} UC budget: missing semantic cache)`;
  } else if (!passedTtftSla) {
    verdict = `FAILED (TTFT ${ttftMs}ms > 2000ms SLA: enable SSE streaming)`;
  }

  return {
    strategy, modelFlavor, outputMode, retryMode, semanticCacheMode, stream,
    totalTicks: durationSeconds, totalTasks, answeredCount, answeredPct,
    brokenJsonDroppedCount, rateLimited429Count, cacheHitCount, ttftMs, accuracyPct,
    costPerTaskUc, costPerTaskCents, budgetUc: LEVEL19_BUDGET_UC,
    passedAnsweredSla, passedTtftSla, passedAccuracySla, passedCostSla, passedSla, isThreeStarRecord, verdict,
  };
}

/**
 * Deterministic GonnaCrash World 3 Level 19 (`ai_feature_launch`) Boss-Fight 3-Star verifier
 * comparing all 5 production failure modes against `three_star_launch` (`355,785 UC`).
 */
export async function simulateLevel19AiFeatureLaunch(
  options: Level19SimulationOptions = {}
): Promise<Level19SimulationResult> {
  const strategy: Level19LaunchStrategy = options.strategy ?? 'three_star_launch';
  const stream = options.stream ?? true;
  const steadyRps = Math.max(1, options.steadyRps ?? 3);
  const livestreamSpikeRps = Math.max(steadyRps, options.livestreamSpikeRps ?? 10);
  const durationSeconds = Math.max(3, options.durationSeconds ?? 180);

  const probes = await runLevel19LiveProbes();
  const shared = { stream, steadyRps, livestreamSpikeRps, durationSeconds };

  const comparisons: Record<Level19LaunchStrategy, Level19StrategySnapshot> = {
    small_model: evaluateStrategy('small_model', shared),
    free_text_json: evaluateStrategy('free_text_json', shared),
    no_semantic_cache: evaluateStrategy('no_semantic_cache', shared),
    loose_semantic_cache: evaluateStrategy('loose_semantic_cache', shared),
    no_backoff_retry: evaluateStrategy('no_backoff_retry', shared),
    three_star_launch: evaluateStrategy('three_star_launch', shared),
  };

  return { ...comparisons[strategy], probes, comparisons };
}
