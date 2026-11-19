/**
 * @kido/ai-stream/voice-pipeline - Voice Latency Budget Tracker
 *
 * Tracks per-stage latency milestones across STT -> LLM -> Sentence Chunker -> TTS,
 * evaluates adherence to GonnaCrash World 3 Level 25 (`<= 1,200ms` first-audio SLA),
 * attributes the primary bottleneck stage, and emits linked reason codes
 * (`unstreamed_speech`, `no_streaming_ttft`, `latency_budget_exceeded`).
 *
 * Invariant: 100% zero external runtime dependencies and zero sibling-slice imports.
 */

export type VoiceLatencyStage = 'stt' | 'llm' | 'chunker' | 'tts' | 'none';

export type VoiceLatencyReasonCode =
  | 'unstreamed_speech'
  | 'no_streaming_ttft'
  | 'latency_budget_exceeded';

export interface VoiceLatencyBudgetOptions {
  /** SLA ceiling for end-to-end first audio in milliseconds (default: 1200). */
  budgetMs?: number;
  /** Deterministic clock hook (default: `Date.now`). */
  now?: () => number;
}

export interface VoiceLatencyStageDurations {
  sttFinalMs: number;
  llmTtftMs: number;
  firstClauseMs: number;
  ttsFirstAudioMs: number;
}

export interface VoiceLatencyBudgetReport extends VoiceLatencyStageDurations {
  e2eFirstAudioMs: number;
  budgetMs: number;
  withinBudget: boolean;
  headroomMs: number;
  bottleneckStage: VoiceLatencyStage;
  stageSharesPct: {
    stt: number;
    llm: number;
    chunker: number;
    tts: number;
  };
  reasonCodes: VoiceLatencyReasonCode[];
}

function buildLatencyBudgetReport(
  durations: VoiceLatencyStageDurations,
  budgetMs: number
): VoiceLatencyBudgetReport {
  const sttFinalMs = Math.max(0, Math.round(durations.sttFinalMs));
  const llmTtftMs = Math.max(0, Math.round(durations.llmTtftMs));
  const firstClauseMs = Math.max(0, Math.round(durations.firstClauseMs));
  const ttsFirstAudioMs = Math.max(0, Math.round(durations.ttsFirstAudioMs));
  const e2eFirstAudioMs = sttFinalMs + llmTtftMs + firstClauseMs + ttsFirstAudioMs;
  const headroomMs = budgetMs - e2eFirstAudioMs;
  const withinBudget = e2eFirstAudioMs <= budgetMs;

  const entries: Array<[VoiceLatencyStage, number]> = [
    ['stt', sttFinalMs],
    ['llm', llmTtftMs],
    ['chunker', firstClauseMs],
    ['tts', ttsFirstAudioMs],
  ];
  let bottleneckStage: VoiceLatencyStage = 'none';
  let maxMs = 0;
  for (const [stage, ms] of entries) {
    if (ms > maxMs) {
      maxMs = ms;
      bottleneckStage = stage;
    }
  }

  const pct = (ms: number): number =>
    e2eFirstAudioMs > 0 ? Number(((ms / e2eFirstAudioMs) * 100).toFixed(1)) : 0;

  const reasonCodes: VoiceLatencyReasonCode[] = [];
  if (sttFinalMs >= 800 || ttsFirstAudioMs >= 1_000) {
    reasonCodes.push('unstreamed_speech');
  }
  if (llmTtftMs >= 1_500) {
    reasonCodes.push('no_streaming_ttft');
  }
  if (!withinBudget) {
    reasonCodes.push('latency_budget_exceeded');
  }

  return {
    sttFinalMs,
    llmTtftMs,
    firstClauseMs,
    ttsFirstAudioMs,
    e2eFirstAudioMs,
    budgetMs,
    withinBudget,
    headroomMs,
    bottleneckStage,
    stageSharesPct: {
      stt: pct(sttFinalMs),
      llm: pct(llmTtftMs),
      chunker: pct(firstClauseMs),
      tts: pct(ttsFirstAudioMs),
    },
    reasonCodes,
  };
}

/**
 * Tracks per-stage latency milestones across STT -> LLM -> Chunker -> TTS
 * and validates adherence to the `<= 1,200ms` conversational voice SLA.
 */
export class VoiceLatencyBudgetTracker {
  private readonly budgetMs: number;
  private readonly now: () => number;

  private speechEndAtMs: number | null = null;
  private sttFinalAtMs: number | null = null;
  private llmFirstTokenAtMs: number | null = null;
  private firstClauseAtMs: number | null = null;
  private ttsFirstAudioAtMs: number | null = null;
  private explicitDurations: VoiceLatencyStageDurations | null = null;

  constructor(options: VoiceLatencyBudgetOptions = {}) {
    this.budgetMs = Math.max(1, options.budgetMs ?? 1_200);
    this.now = options.now ?? (() => Date.now());
  }

  static fromDurations(
    durations: VoiceLatencyStageDurations,
    budgetMs = 1_200
  ): VoiceLatencyBudgetReport {
    return buildLatencyBudgetReport(durations, Math.max(1, budgetMs));
  }

  markSpeechEnd(atMs?: number): this {
    this.explicitDurations = null;
    this.speechEndAtMs = atMs ?? this.now();
    this.sttFinalAtMs = null;
    this.llmFirstTokenAtMs = null;
    this.firstClauseAtMs = null;
    this.ttsFirstAudioAtMs = null;
    return this;
  }

  markSttFinal(atMs?: number): this {
    const t = atMs ?? this.now();
    if (this.speechEndAtMs === null) this.speechEndAtMs = t;
    if (this.sttFinalAtMs === null) this.sttFinalAtMs = Math.max(this.speechEndAtMs, t);
    return this;
  }

  markLlmFirstToken(atMs?: number): this {
    const t = atMs ?? this.now();
    if (this.speechEndAtMs === null) this.speechEndAtMs = t;
    if (this.sttFinalAtMs === null) this.sttFinalAtMs = this.speechEndAtMs;
    if (this.llmFirstTokenAtMs === null) this.llmFirstTokenAtMs = Math.max(this.sttFinalAtMs, t);
    return this;
  }

  markFirstClauseReady(atMs?: number): this {
    const t = atMs ?? this.now();
    if (this.llmFirstTokenAtMs === null) this.markLlmFirstToken(t);
    if (this.firstClauseAtMs === null) {
      this.firstClauseAtMs = Math.max(this.llmFirstTokenAtMs!, t);
    }
    return this;
  }

  markTtsFirstAudio(atMs?: number): this {
    const t = atMs ?? this.now();
    if (this.firstClauseAtMs === null) this.markFirstClauseReady(t);
    if (this.ttsFirstAudioAtMs === null) {
      this.ttsFirstAudioAtMs = Math.max(this.firstClauseAtMs!, t);
    }
    return this;
  }

  recordDurations(durations: VoiceLatencyStageDurations): this {
    this.explicitDurations = { ...durations };
    return this;
  }

  getReport(): VoiceLatencyBudgetReport {
    if (this.explicitDurations) {
      return buildLatencyBudgetReport(this.explicitDurations, this.budgetMs);
    }

    const t0 = this.speechEndAtMs ?? 0;
    const tStt = this.sttFinalAtMs ?? t0;
    const tLlm = this.llmFirstTokenAtMs ?? tStt;
    const tClause = this.firstClauseAtMs ?? tLlm;
    const tTts = this.ttsFirstAudioAtMs ?? tClause;

    return buildLatencyBudgetReport(
      {
        sttFinalMs: tStt - t0,
        llmTtftMs: tLlm - tStt,
        firstClauseMs: tClause - tLlm,
        ttsFirstAudioMs: tTts - tClause,
      },
      this.budgetMs
    );
  }
}

export const createVoiceLatencyBudgetTracker = (
  options: VoiceLatencyBudgetOptions = {}
): VoiceLatencyBudgetTracker => new VoiceLatencyBudgetTracker(options);
