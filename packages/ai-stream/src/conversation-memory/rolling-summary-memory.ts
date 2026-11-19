/**
 * @kido/ai-stream/conversation-memory - Rolling Summary + Sliding Window Memory Engine
 *
 * Hybrid Conversation Memory Compression distilled from:
 * - LangChain `ConversationSummaryBufferMemory` (verbatim recent window + rolling summary)
 * - Mem0 (~69k★) & Zep/Graphiti (~32k★) (pinned entity facts + temporal superseding)
 * - Letta (~25.5k★) (bounded core memory blocks in system context)
 * - GonnaCrash World 3 Level 26 (`long_conversation_memory`)
 *
 * Invariant: 100% self-contained (zero external deps, zero sibling-slice imports).
 */

import {
  computeMemoryTokenBudget,
  estimateConversationTokens,
  estimateTurnTokens,
  truncateTextToTokenBudget,
  type ConversationTurn,
} from './token-budget.js';
import {
  extractConversationFacts,
  formatPinnedFactsBlock,
  hasBackReference,
  mergeMemoryFacts,
  type ConversationMemoryFact,
} from './fact-extractor.js';
import {
  buildExtractiveRollingSummary,
  buildLastTurnOnlyPrompt,
  normalizeConversationTurn,
  type LastTurnOnlyPromptInput,
  type LastTurnOnlyPromptResult,
  type MemoryCompressionMetrics,
  type MemoryScope,
  type MemorySharedWith,
  type MemorySummarizerFn,
  type MemorySummarizerInput,
} from './summary-compactor.js';
import { MemorySessionLruStore, type MemorySessionState } from './session-store.js';

export {
  buildExtractiveRollingSummary,
  buildLastTurnOnlyPrompt,
  type LastTurnOnlyPromptInput,
  type LastTurnOnlyPromptResult,
  type MemoryCompressionMetrics,
  type MemoryScope,
  type MemorySessionState,
  type MemorySharedWith,
  type MemorySummarizerFn,
  type MemorySummarizerInput,
};

export interface RollingSummaryMemoryOptions {
  /** Number of recent user+assistant pairs kept verbatim (default: 2 -> 4 messages). */
  recentWindowTurns?: number;
  /** Hard prompt token ceiling across all blocks (default: 1_200). */
  maxTotalTokens?: number;
  /** Maximum tokens allocated to rolling summary text (default: 260). */
  maxSummaryTokens?: number;
  /** Maximum tokens allocated to pinned entity facts (default: 140). */
  maxFactsTokens?: number;
  /** Token threshold triggering compaction even within recent window (default: 420). */
  triggerTokenThreshold?: number;
  /** Session isolation scope (`per_chat` prevents cross-user leaks; default: 'per_chat'). */
  scope?: MemoryScope;
  /** Bot namespace sharing (`one_bot` isolates per botId; default: 'one_bot'). */
  sharedWith?: MemorySharedWith;
  /** Default bot ID when `sharedWith === 'one_bot'` (default: 'default_bot'). */
  defaultBotId?: string;
  /** Maximum concurrent sessions in LRU store (default: 500). */
  maxSessions?: number;
  /** Session idle TTL in milliseconds (default: 30 minutes). */
  ttlMs?: number;
  /** Optional custom async/sync summarizer; falls back deterministically on omit or error. */
  summarizer?: MemorySummarizerFn;
  /** Error callback invoked whenever custom `summarizer` fails and fallback activates. */
  onSummarizerError?: (error: unknown, context: { sessionId: string; turnsCount: number }) => void;
  /** Injectable clock for deterministic LRU/TTL tests (default: Date.now). */
  nowFn?: () => number;
}

export interface BuildMemoryPromptInput {
  sessionId: string;
  currentTurn: string | ConversationTurn;
  systemPrompt?: string;
  botId?: string;
  /** Optional full conversation history to synchronize before assembling the prompt. */
  turns?: readonly ConversationTurn[];
}

export interface BuiltMemoryPromptResult {
  messages: ConversationTurn[];
  rollingSummary: string;
  pinnedFactsBlock: string;
  activeFacts: ConversationMemoryFact[];
  supersededFacts: ConversationMemoryFact[];
  recentWindow: ConversationTurn[];
  metrics: MemoryCompressionMetrics;
}

export interface RollingSummaryMemoryStats {
  activeSessions: number;
  maxSessions: number;
  evictedLruSessions: number;
  expiredTtlSessions: number;
  totalPromptsBuilt: number;
  totalSummarizationRuns: number;
  totalSummarizerFallbacks: number;
}

export interface AddTurnsResult {
  session: MemorySessionState;
  summarizerUsed: 'none' | 'custom' | 'extractive_fallback';
  summarizerErrorRecovered: boolean;
}

export class RollingSummaryMemory {
  private readonly recentWindowTurns: number;
  private readonly maxTotalTokens: number;
  private readonly maxSummaryTokens: number;
  private readonly maxFactsTokens: number;
  private readonly triggerTokenThreshold: number;
  private readonly summarizer?: MemorySummarizerFn;
  private readonly onSummarizerError?: (
    error: unknown,
    context: { sessionId: string; turnsCount: number }
  ) => void;
  private readonly nowFn: () => number;
  private readonly store: MemorySessionLruStore;

  private totalPromptsBuilt = 0;
  private totalSummarizationRuns = 0;
  private totalSummarizerFallbacks = 0;

  constructor(options: RollingSummaryMemoryOptions = {}) {
    this.recentWindowTurns = Math.max(1, Math.floor(options.recentWindowTurns ?? 2));
    this.maxTotalTokens = Math.max(128, Math.floor(options.maxTotalTokens ?? 1_200));
    this.maxSummaryTokens = Math.max(32, Math.floor(options.maxSummaryTokens ?? 260));
    this.maxFactsTokens = Math.max(24, Math.floor(options.maxFactsTokens ?? 140));
    this.triggerTokenThreshold = Math.max(64, Math.floor(options.triggerTokenThreshold ?? 420));
    this.summarizer = options.summarizer;
    this.onSummarizerError = options.onSummarizerError;
    this.nowFn = options.nowFn ?? (() => Date.now());
    this.store = new MemorySessionLruStore({
      scope: options.scope ?? 'per_chat',
      sharedWith: options.sharedWith ?? 'one_bot',
      defaultBotId: options.defaultBotId ?? 'default_bot',
      maxSessions: Math.max(1, Math.floor(options.maxSessions ?? 500)),
      ttlMs: Math.max(1_000, Math.floor(options.ttlMs ?? 30 * 60 * 1_000)),
      nowFn: this.nowFn,
    });
  }

  private selectTurnsToCompact(session: MemorySessionState): ConversationTurn[] {
    const keepMessages = this.recentWindowTurns * 2;
    let compactCount = 0;
    if (session.recentTurns.length > keepMessages) {
      compactCount = session.recentTurns.length - keepMessages;
    } else if (
      session.recentTurns.length > 2 &&
      estimateConversationTokens(session.recentTurns) > this.triggerTokenThreshold
    ) {
      compactCount = Math.min(2, session.recentTurns.length - 2);
    }
    return compactCount > 0 ? session.recentTurns.splice(0, compactCount) : [];
  }

  private ingestTurnsAndFacts(session: MemorySessionState, turns: readonly ConversationTurn[]): void {
    if (turns.length === 0) return;
    const startIdx = session.totalTurnsSeen + 1;
    const indexed: ConversationTurn[] = turns.map((turn, offset) => ({
      ...turn,
      turnIndex: turn.turnIndex ?? startIdx + offset,
      timestampMs: turn.timestampMs ?? this.nowFn(),
    }));

    const newFacts = extractConversationFacts(indexed, startIdx);
    const merged = mergeMemoryFacts([...session.activeFacts, ...session.supersededFacts], newFacts);
    session.activeFacts = merged.activeFacts;
    session.supersededFacts = merged.supersededFacts;

    for (const turn of indexed) {
      session.recentTurns.push(turn);
      session.rawHistoryTokensCumulative += estimateTurnTokens(turn);
    }
    session.totalTurnsSeen += indexed.length;
  }

  addTurnsSync(sessionId: string, turns: readonly ConversationTurn[], botId?: string): AddTurnsResult {
    const session = this.store.getOrCreate(sessionId, botId);
    this.ingestTurnsAndFacts(session, turns);
    const toCompact = this.selectTurnsToCompact(session);
    if (toCompact.length === 0) {
      return { session, summarizerUsed: 'none', summarizerErrorRecovered: false };
    }

    session.rollingSummary = buildExtractiveRollingSummary({
      sessionId: session.sessionId,
      previousSummary: session.rollingSummary,
      turnsToSummarize: toCompact,
      activeFacts: session.activeFacts,
      maxSummaryTokens: this.maxSummaryTokens,
    });
    session.summarizedTurnsCount += toCompact.length;
    session.summarizationRuns += 1;
    this.totalSummarizationRuns += 1;
    return { session, summarizerUsed: 'extractive_fallback', summarizerErrorRecovered: false };
  }

  async addTurns(
    sessionId: string,
    turns: readonly ConversationTurn[],
    botId?: string
  ): Promise<AddTurnsResult> {
    const session = this.store.getOrCreate(sessionId, botId);
    this.ingestTurnsAndFacts(session, turns);
    const toCompact = this.selectTurnsToCompact(session);
    if (toCompact.length === 0) {
      return { session, summarizerUsed: 'none', summarizerErrorRecovered: false };
    }

    const summaryInput: MemorySummarizerInput = {
      sessionId: session.sessionId,
      previousSummary: session.rollingSummary,
      turnsToSummarize: toCompact,
      activeFacts: session.activeFacts,
      maxSummaryTokens: this.maxSummaryTokens,
    };

    let summarizerUsed: 'custom' | 'extractive_fallback' = 'extractive_fallback';
    let summarizerErrorRecovered = false;
    let nextSummary = '';

    if (this.summarizer) {
      try {
        const candidate = (await this.summarizer(summaryInput)).trim();
        if (candidate.length === 0) throw new Error('Custom summarizer returned empty output');
        nextSummary = truncateTextToTokenBudget(candidate, this.maxSummaryTokens);
        summarizerUsed = 'custom';
      } catch (error: unknown) {
        summarizerErrorRecovered = true;
        session.summarizerFallbackCount += 1;
        this.totalSummarizerFallbacks += 1;
        this.onSummarizerError?.(error, { sessionId: session.sessionId, turnsCount: toCompact.length });
        nextSummary = buildExtractiveRollingSummary(summaryInput);
      }
    } else {
      nextSummary = buildExtractiveRollingSummary(summaryInput);
    }

    session.rollingSummary = nextSummary;
    session.summarizedTurnsCount += toCompact.length;
    session.summarizationRuns += 1;
    this.totalSummarizationRuns += 1;
    return { session, summarizerUsed, summarizerErrorRecovered };
  }

  async addTurn(sessionId: string, turn: ConversationTurn, botId?: string): Promise<MemorySessionState> {
    const res = await this.addTurns(sessionId, [turn], botId);
    return this.store.clone(res.session);
  }

  private assemblePrompt(
    session: MemorySessionState,
    input: BuildMemoryPromptInput,
    summarizerUsed: 'none' | 'custom' | 'extractive_fallback',
    summarizerErrorRecovered: boolean
  ): BuiltMemoryPromptResult {
    const currentTurn = normalizeConversationTurn(input.currentTurn);
    const backRef = hasBackReference(currentTurn.content);
    const systemPrompt = input.systemPrompt?.trim() || undefined;
    const summaryContent =
      session.rollingSummary.length > 0
        ? `[CONVERSATION_SUMMARY]\n${truncateTextToTokenBudget(session.rollingSummary, this.maxSummaryTokens)}`
        : '';
    const pinnedFactsBlock = formatPinnedFactsBlock(session.activeFacts, this.maxFactsTokens);

    const recentWindow = [...session.recentTurns];
    let tokenBudget = computeMemoryTokenBudget({
      systemPrompt,
      rollingSummary: summaryContent,
      pinnedFactsBlock,
      recentTurns: recentWindow,
      currentTurn,
      maxTotalTokens: this.maxTotalTokens,
    });
    while (!tokenBudget.withinBudget && recentWindow.length > 1) {
      recentWindow.shift();
      tokenBudget = computeMemoryTokenBudget({
        systemPrompt,
        rollingSummary: summaryContent,
        pinnedFactsBlock,
        recentTurns: recentWindow,
        currentTurn,
        maxTotalTokens: this.maxTotalTokens,
      });
    }

    const messages: ConversationTurn[] = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    if (summaryContent.length > 0) messages.push({ role: 'system', content: summaryContent });
    if (pinnedFactsBlock.length > 0) messages.push({ role: 'system', content: pinnedFactsBlock });
    messages.push(...recentWindow, currentTurn);

    const compressedPromptTokens = estimateConversationTokens(messages);
    const overheadTokens =
      (systemPrompt ? estimateTurnTokens({ role: 'system', content: systemPrompt }) : 0) +
      estimateTurnTokens(currentTurn) +
      3;
    const rawHistoryTokens = session.rawHistoryTokensCumulative + overheadTokens;
    const tokensSaved = Math.max(0, rawHistoryTokens - compressedPromptTokens);
    this.totalPromptsBuilt += 1;

    return {
      messages,
      rollingSummary: session.rollingSummary,
      pinnedFactsBlock,
      activeFacts: session.activeFacts.map((f) => ({ ...f })),
      supersededFacts: session.supersededFacts.map((f) => ({ ...f })),
      recentWindow: recentWindow.map((t) => ({ ...t })),
      metrics: {
        mode: session.summarizedTurnsCount > 0 ? 'rolling_summary' : 'passthrough',
        scope: session.scope,
        sharedWith: session.sharedWith,
        totalTurnsSeen: session.totalTurnsSeen,
        summarizedTurnsCount: session.summarizedTurnsCount,
        keptRecentMessages: recentWindow.length,
        activeFactsCount: session.activeFacts.length,
        supersededFactsCount: session.supersededFacts.length,
        rawHistoryTokens,
        compressedPromptTokens,
        tokensSaved,
        compressionRatio:
          rawHistoryTokens > 0 ? Number((compressedPromptTokens / rawHistoryTokens).toFixed(4)) : 1,
        summarizerUsed,
        summarizerErrorRecovered,
        backReferenceDetected: backRef.detected,
        backReferenceMatchedPhrases: backRef.matchedPhrases,
        tokenBudget,
      },
    };
  }

  async buildPrompt(input: BuildMemoryPromptInput): Promise<BuiltMemoryPromptResult> {
    const session = this.store.getOrCreate(input.sessionId, input.botId);
    let summarizerUsed: 'none' | 'custom' | 'extractive_fallback' = 'none';
    let summarizerErrorRecovered = false;
    if (input.turns && input.turns.length > session.totalTurnsSeen) {
      const res = await this.addTurns(input.sessionId, input.turns.slice(session.totalTurnsSeen), input.botId);
      summarizerUsed = res.summarizerUsed;
      summarizerErrorRecovered = res.summarizerErrorRecovered;
    }
    return this.assemblePrompt(session, input, summarizerUsed, summarizerErrorRecovered);
  }

  buildPromptSync(input: BuildMemoryPromptInput): BuiltMemoryPromptResult {
    const session = this.store.getOrCreate(input.sessionId, input.botId);
    let summarizerUsed: 'none' | 'custom' | 'extractive_fallback' = 'none';
    if (input.turns && input.turns.length > session.totalTurnsSeen) {
      summarizerUsed = this.addTurnsSync(input.sessionId, input.turns.slice(session.totalTurnsSeen), input.botId)
        .summarizerUsed;
    }
    return this.assemblePrompt(session, input, summarizerUsed, false);
  }

  getSession(sessionId: string, botId?: string): MemorySessionState | undefined {
    return this.store.getSnapshot(sessionId, botId);
  }

  clearSession(sessionId: string, botId?: string): boolean {
    return this.store.delete(sessionId, botId);
  }

  reset(): void {
    this.store.reset();
    this.totalPromptsBuilt = 0;
    this.totalSummarizationRuns = 0;
    this.totalSummarizerFallbacks = 0;
  }

  getStats(): RollingSummaryMemoryStats {
    return {
      ...this.store.getStats(),
      totalPromptsBuilt: this.totalPromptsBuilt,
      totalSummarizationRuns: this.totalSummarizationRuns,
      totalSummarizerFallbacks: this.totalSummarizerFallbacks,
    };
  }
}

export function createRollingSummaryMemory(
  options: RollingSummaryMemoryOptions = {}
): RollingSummaryMemory {
  return new RollingSummaryMemory(options);
}
