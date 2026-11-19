/**
 * @kido/ai-stream/voice-pipeline - GonnaCrash World 3 Level 25 (`voice_assistant_latency`) Verifier
 *
 * Verified per-turn cost math at `2 voice_turn/s` (`5,184,000 turns/mo`):
 * - `App Server (S = $15/mo)`: `289 UC` (`0.0003¢`)
 * - `Speech-to-Text ($500/1M)`: `50,000 UC` (`0.0500¢`, `~$2,592/mo`)
 * - `Text-to-Speech ($6,000/1M)`: `600,000 UC` (`0.6000¢`, `~$31,104/mo` — 90% of bill!)
 * - `LLM Provider`:
 *   - `openai_mid`: `260,000 UC` (`0.2600¢`) -> total `910,289 UC` (`> 770,000 UC` BUDGET FAIL!)
 *   - `openai_small`: `13,000 UC` (`0.0130¢`) -> total **`663,289 UC`** (`0.6633¢/turn` EXACT!)
 *
 * Proves all 4 Level 25 scenarios deterministically:
 * 1. `serial_batch` (`openai_small`, no streaming): `4,400ms > 1,200ms` -> FAIL
 *    (`unstreamed_speech`, `no_streaming_ttft`).
 * 2. `partial_streaming` (only LLM streamed; STT + TTS batch): `2,740ms > 1,200ms` -> FAIL
 *    (`unstreamed_speech`).
 * 3. `streaming_mid_model` (all streaming with `openai_mid`): `1,160ms <= 1,200ms`, `94% >= 85%`,
 *    BUT `910,289 UC > 770,000 UC` -> FAIL (`budget_exceeded`).
 * 4. `full_duplex_three_star` (`App Server (S)` + `STT` + `openai_small` + `TTS` all `stream: true`):
 *    `750ms <= 1,200ms`, `87.0% >= 85%` accuracy, `99.8% >= 99%` answered, exact **`663,289 UC`**
 *    (`isThreeStarRecord: true`) -> ★★★ 3-Star Record PASS!
 *
 * Invariant: 100% zero external runtime dependencies and zero sibling-slice imports.
 */

import { VoiceSentenceChunker, sanitizeForSpeech } from './sentence-chunker.js';
import {
  VoiceLatencyBudgetTracker,
  VoiceTurnController,
  type VoiceLatencyBudgetReport,
  type VoiceLatencyReasonCode,
} from './turn-controller.js';

export type Level25VoiceStrategy =
  | 'serial_batch'
  | 'partial_streaming'
  | 'streaming_mid_model'
  | 'full_duplex_three_star';

export type Level25FailureReasonCode = VoiceLatencyReasonCode | 'budget_exceeded';

export interface Level25CostBreakdownUc {
  appServerUc: number;
  sttUc: number;
  ttsUc: number;
  llmUc: number;
  totalUc: number;
}

export interface Level25SimulationOptions {
  strategy?: Level25VoiceStrategy;
  totalTurns?: number;
  budgetMs?: number;
}

export interface Level25StrategySnapshot {
  strategy: Level25VoiceStrategy;
  topology: string;
  sttStream: boolean;
  llmModel: 'openai_small' | 'openai_mid';
  llmStream: boolean;
  ttsStream: boolean;
  totalTurns: number;
  answeredCount: number;
  answeredPct: number;
  firstAudioMs: number;
  latencyReport: VoiceLatencyBudgetReport;
  speedupVsBatchPct: number;
  accuracyPct: number;
  costBreakdownUc: Level25CostBreakdownUc;
  costPerTaskUc: number;
  costPerTaskCents: number;
  budgetUc: number;
  reasonCodes: Level25FailureReasonCode[];
  passedAnsweredSla: boolean;
  passedFirstAudioSla: boolean;
  passedAccuracySla: boolean;
  passedCostSla: boolean;
  passedSla: boolean;
  isThreeStarRecord: boolean;
  verdict: string;
}

export interface Level25ProbeSummary {
  firstClauseFlushedEarly: boolean;
  protectedEntitiesIntact: boolean;
  markdownStrippedForSpeech: boolean;
  bargeInAbortedSignal: boolean;
  chunksProduced: number;
}

export interface Level25SimulationResult extends Level25StrategySnapshot {
  levelKey: 'voice_assistant_latency';
  concept: 'voice_latency_budget';
  probes: Level25ProbeSummary;
  comparisons: Record<Level25VoiceStrategy, Level25StrategySnapshot>;
}

export const LEVEL25_COST_COMPONENTS_UC = Object.freeze({
  appServerSmallUc: 289, // $15/mo over 5,184,000 turns/mo (2 turns/s)
  sttPerTurnUc: 50_000, // $500 / 1M turns (~$2,592/mo)
  ttsPerTurnUc: 600_000, // $6,000 / 1M turns (~$31,104/mo — 90% of bill)
  openaiSmallUc: 13_000, // 0.0130¢/turn -> total 663,289 UC
  openaiMidUc: 260_000, // 0.2600¢/turn -> total 910,289 UC (> 770,000 UC budget)
});

export const LEVEL25_SLA_TARGETS = Object.freeze({
  levelKey: 'voice_assistant_latency' as const,
  concept: 'voice_latency_budget' as const,
  minAnsweredPct: 99.0,
  maxFirstAudioMs: 1_200,
  minAccuracyPct: 85.0,
  maxCostPerTaskUc: 770_000, // 0.7700¢/turn
  threeStarBestCostUc: 663_289, // 289 + 50,000 + 600,000 + 13,000 = 0.6633¢/turn
  serialBatchFirstAudioMs: 4_400, // 1,000ms STT + 2,000ms LLM + 1,400ms TTS
});

function runLevel25LiveProbes(): Level25ProbeSummary {
  const chunker = new VoiceSentenceChunker({
    minChunkChars: 14,
    firstClauseCommaFlush: true,
    firstClauseMinChars: 14,
  });

  const sampleTokens = [
    '**CommerceVoiceBot** xác nhận giao tại TP. Hồ Chí Minh, ',
    'tổng đơn **150.000đ** với độ trễ 1.2s (v.v. miễn phí đóng gói). ',
    'Cảm ơn bạn đã gọi!',
  ];
  const chunks = sampleTokens.flatMap((token) => chunker.push(token)).concat(chunker.flush());

  const firstClauseFlushedEarly =
    chunks.length >= 2 && chunks[0]!.reason === 'first_clause_comma' && chunks[0]!.isFirstClause;
  const joined = chunks.map((c) => c.speakableText).join(' ');
  const protectedEntitiesIntact =
    chunks.some((c) => c.speakableText.includes('TP. Hồ Chí Minh')) &&
    chunks.some((c) => c.speakableText.includes('150.000đ')) &&
    chunks.some((c) => c.speakableText.includes('1.2s'));
  const markdownStrippedForSpeech =
    !joined.includes('**') &&
    sanitizeForSpeech('**BankingVoiceAssistant**: Xem [biểu phí](https://example.com/fees).') ===
      'BankingVoiceAssistant: Xem biểu phí.';

  const controller = new VoiceTurnController();
  const { signal } = controller.beginProcessing('Kiểm tra trạng thái đơn hàng');
  controller.beginSpeaking();
  const bargeIn = controller.triggerBargeIn('caller_interrupted');
  const bargeInAbortedSignal =
    bargeIn.interrupted && signal.aborted && controller.getState() === 'interrupted';

  return {
    firstClauseFlushedEarly,
    protectedEntitiesIntact,
    markdownStrippedForSpeech,
    bargeInAbortedSignal,
    chunksProduced: chunks.length,
  };
}

function evaluateLevel25Strategy(
  strategy: Level25VoiceStrategy,
  params: { totalTurns: number; budgetMs: number }
): Level25StrategySnapshot {
  const { totalTurns, budgetMs } = params;
  const { appServerSmallUc, sttPerTurnUc, ttsPerTurnUc, openaiSmallUc, openaiMidUc } =
    LEVEL25_COST_COMPONENTS_UC;

  let topology =
    'App Server (S) + STT (stream: true) + LLM (openai_small, stream: true) + TTS (stream: true)';
  let sttStream = true;
  let llmModel: 'openai_small' | 'openai_mid' = 'openai_small';
  let llmStream = true;
  let ttsStream = true;
  let sttFinalMs = 220;
  let llmTtftMs = 240;
  let firstClauseMs = 100;
  let ttsFirstAudioMs = 190;
  let answeredPct = 99.8;
  let accuracyPct = 87.0;
  let llmUc: number = openaiSmallUc;

  if (strategy === 'serial_batch') {
    topology =
      'App Server (S) + STT (stream: false) + LLM (openai_small, stream: false) + TTS (stream: false)';
    sttStream = false;
    llmStream = false;
    ttsStream = false;
    sttFinalMs = 1_000;
    llmTtftMs = 2_000;
    firstClauseMs = 0;
    ttsFirstAudioMs = 1_400;
    answeredPct = 99.5;
  } else if (strategy === 'partial_streaming') {
    topology =
      'App Server (S) + STT (stream: false) + LLM (openai_small, stream: true) + TTS (stream: false)';
    sttStream = false;
    llmStream = true;
    ttsStream = false;
    sttFinalMs = 1_000;
    llmTtftMs = 240;
    firstClauseMs = 100;
    ttsFirstAudioMs = 1_400;
    answeredPct = 99.7;
  } else if (strategy === 'streaming_mid_model') {
    topology =
      'App Server (S) + STT (stream: true) + LLM (openai_mid, stream: true) + TTS (stream: true)';
    llmModel = 'openai_mid';
    sttFinalMs = 240;
    llmTtftMs = 540;
    firstClauseMs = 160;
    ttsFirstAudioMs = 220;
    answeredPct = 99.8;
    accuracyPct = 94.0;
    llmUc = openaiMidUc;
  }

  const totalUc = appServerSmallUc + sttPerTurnUc + ttsPerTurnUc + llmUc;
  const costBreakdownUc: Level25CostBreakdownUc = {
    appServerUc: appServerSmallUc,
    sttUc: sttPerTurnUc,
    ttsUc: ttsPerTurnUc,
    llmUc,
    totalUc,
  };

  const latencyReport = VoiceLatencyBudgetTracker.fromDurations(
    { sttFinalMs, llmTtftMs, firstClauseMs, ttsFirstAudioMs },
    budgetMs
  );
  const firstAudioMs = latencyReport.e2eFirstAudioMs;
  const speedupVsBatchPct = Number(
    (
      ((LEVEL25_SLA_TARGETS.serialBatchFirstAudioMs - firstAudioMs) /
        LEVEL25_SLA_TARGETS.serialBatchFirstAudioMs) *
      100
    ).toFixed(2)
  );
  const answeredCount = Math.round((totalTurns * answeredPct) / 100);
  const costPerTaskCents = Number((totalUc / 1_000_000).toFixed(4));

  const passedAnsweredSla = answeredPct >= LEVEL25_SLA_TARGETS.minAnsweredPct;
  const passedFirstAudioSla = firstAudioMs <= budgetMs;
  const passedAccuracySla = accuracyPct >= LEVEL25_SLA_TARGETS.minAccuracyPct;
  const passedCostSla = totalUc <= LEVEL25_SLA_TARGETS.maxCostPerTaskUc;
  const passedSla =
    passedAnsweredSla && passedFirstAudioSla && passedAccuracySla && passedCostSla;
  const isThreeStarRecord = passedSla && totalUc === LEVEL25_SLA_TARGETS.threeStarBestCostUc;

  const reasonCodes: Level25FailureReasonCode[] = [...latencyReport.reasonCodes];
  if (!passedCostSla) reasonCodes.push('budget_exceeded');

  let verdict = `PASSED (★★★ 3-Star Record: ${firstAudioMs}ms first audio, ${totalUc.toLocaleString('en-US')} UC)`;
  if (!passedFirstAudioSla) {
    verdict = `FAILED (First audio ${firstAudioMs}ms > ${budgetMs}ms SLA: ${reasonCodes.join(', ')})`;
  } else if (!passedCostSla) {
    verdict = `FAILED (Cost ${totalUc.toLocaleString('en-US')} UC > ${LEVEL25_SLA_TARGETS.maxCostPerTaskUc.toLocaleString('en-US')} UC budget: TTS eats 600,000 UC + ${llmModel} adds ${llmUc.toLocaleString('en-US')} UC)`;
  } else if (!passedAccuracySla) {
    verdict = `FAILED (Accuracy ${accuracyPct}% < ${LEVEL25_SLA_TARGETS.minAccuracyPct}% SLA)`;
  } else if (!passedAnsweredSla) {
    verdict = `FAILED (Answered ${answeredPct}% < ${LEVEL25_SLA_TARGETS.minAnsweredPct}% SLA)`;
  }

  return {
    strategy,
    topology,
    sttStream,
    llmModel,
    llmStream,
    ttsStream,
    totalTurns,
    answeredCount,
    answeredPct,
    firstAudioMs,
    latencyReport,
    speedupVsBatchPct,
    accuracyPct,
    costBreakdownUc,
    costPerTaskUc: totalUc,
    costPerTaskCents,
    budgetUc: LEVEL25_SLA_TARGETS.maxCostPerTaskUc,
    reasonCodes,
    passedAnsweredSla,
    passedFirstAudioSla,
    passedAccuracySla,
    passedCostSla,
    passedSla,
    isThreeStarRecord,
    verdict,
  };
}

/**
 * Deterministic GonnaCrash World 3 Level 25 (`voice_assistant_latency`) 3-Star verifier:
 * proves `serial_batch` (`4,400ms`), `partial_streaming` (`2,740ms`), and `streaming_mid_model`
 * (`910,289 UC > 770,000 UC`) fail SLA while `full_duplex_three_star` (`openai_small` + full
 * streaming) passes all 4 SLA goals at `750ms` and exact `663,289 UC` (`0.6633¢/turn`).
 */
export function simulateLevel25VoiceAssistantLatency(
  options: Level25SimulationOptions = {}
): Level25SimulationResult {
  const strategy: Level25VoiceStrategy = options.strategy ?? 'full_duplex_three_star';
  const totalTurns = Math.max(1, options.totalTurns ?? 600);
  const budgetMs = Math.max(1, options.budgetMs ?? LEVEL25_SLA_TARGETS.maxFirstAudioMs);

  const probes = runLevel25LiveProbes();
  const params = { totalTurns, budgetMs };

  const comparisons: Record<Level25VoiceStrategy, Level25StrategySnapshot> = {
    serial_batch: evaluateLevel25Strategy('serial_batch', params),
    partial_streaming: evaluateLevel25Strategy('partial_streaming', params),
    streaming_mid_model: evaluateLevel25Strategy('streaming_mid_model', params),
    full_duplex_three_star: evaluateLevel25Strategy('full_duplex_three_star', params),
  };

  return {
    levelKey: LEVEL25_SLA_TARGETS.levelKey,
    concept: LEVEL25_SLA_TARGETS.concept,
    ...comparisons[strategy],
    probes,
    comparisons,
  };
}
