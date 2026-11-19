/**
 * @kido/ai-stream/conversation-memory - Extractive Rolling Summary & Anti-Pattern Comparator
 *
 * Provides:
 * - Deterministic zero-dependency `buildExtractiveRollingSummary` (default / fallback summarizer)
 * - Explicit `buildLastTurnOnlyPrompt` anti-pattern comparator (`Context Builder Rules` trap)
 * - Shared compression metric & summarizer contracts
 *
 * Invariant: 100% self-contained (zero external deps, zero sibling-slice imports).
 */

import {
  computeMemoryTokenBudget,
  estimateConversationTokens,
  estimateMemoryTextTokens,
  truncateTextToTokenBudget,
  type ConversationTurn,
  type MemoryTokenBudgetSnapshot,
} from './token-budget.js';
import {
  extractConversationFacts,
  hasBackReference,
  type ConversationMemoryFact,
} from './fact-extractor.js';

export type MemoryScope = 'per_chat' | 'global';
export type MemorySharedWith = 'one_bot' | 'all_bots';

export interface MemorySummarizerInput {
  sessionId: string;
  previousSummary: string;
  turnsToSummarize: readonly ConversationTurn[];
  activeFacts: readonly ConversationMemoryFact[];
  maxSummaryTokens: number;
}

export type MemorySummarizerFn = (input: MemorySummarizerInput) => Promise<string> | string;

export interface MemoryCompressionMetrics {
  mode: 'passthrough' | 'rolling_summary' | 'last_turn_only_antipattern';
  scope: MemoryScope;
  sharedWith: MemorySharedWith;
  totalTurnsSeen: number;
  summarizedTurnsCount: number;
  keptRecentMessages: number;
  activeFactsCount: number;
  supersededFactsCount: number;
  rawHistoryTokens: number;
  compressedPromptTokens: number;
  tokensSaved: number;
  compressionRatio: number;
  summarizerUsed: 'none' | 'custom' | 'extractive_fallback';
  summarizerErrorRecovered: boolean;
  backReferenceDetected: boolean;
  backReferenceMatchedPhrases: string[];
  tokenBudget: MemoryTokenBudgetSnapshot;
}

export interface LastTurnOnlyPromptInput {
  systemPrompt?: string;
  history: readonly ConversationTurn[];
  currentTurn: string | ConversationTurn;
  maxTotalTokens?: number;
}

export interface LastTurnOnlyPromptResult {
  /** Explicitly flags the Level 26 `Context Builder (Rules)` `memory_dropped` anti-pattern. */
  antiPattern: 'last_turn_only_memory_dropped';
  messages: ConversationTurn[];
  droppedTurnsCount: number;
  droppedFactsCount: number;
  backReferenceDetected: boolean;
  metrics: MemoryCompressionMetrics;
}

export function normalizeConversationTurn(turn: string | ConversationTurn): ConversationTurn {
  return typeof turn === 'string' ? { role: 'user', content: turn } : { ...turn };
}

function compactSentenceSnippet(text: string, maxChars = 95): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxChars) return cleaned;
  const firstEnd = cleaned.search(/[.!?](?:\s|$)/);
  if (firstEnd >= 20 && firstEnd < maxChars) return cleaned.slice(0, firstEnd + 1);
  return `${cleaned.slice(0, maxChars - 3).trimEnd()}...`;
}

/**
 * Deterministic zero-dependency extractive rolling summarizer used as default
 * or automatic fallback whenever a custom LLM summarizer fails or returns empty.
 */
export function buildExtractiveRollingSummary(input: MemorySummarizerInput): string {
  const maxSummaryTokens = Math.max(16, input.maxSummaryTokens);
  const segments: string[] = [];
  const seen = new Set<string>();

  const pushUnique = (line: string): void => {
    const clean = line.replace(/\s+/g, ' ').trim();
    if (clean.length === 0) return;
    const key = clean.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    segments.push(clean);
  };

  if (input.previousSummary.trim().length > 0) {
    for (const part of input.previousSummary.split(' ; ')) pushUnique(part);
  }

  for (const turn of input.turnsToSummarize) {
    if (turn.role === 'system') continue;
    const label = turn.role === 'user' ? 'User' : turn.role === 'assistant' ? 'Assistant' : 'Tool';
    pushUnique(`${label}: ${compactSentenceSnippet(turn.content)}`);
  }

  if (segments.length === 0) return '';
  let joined = segments.join(' ; ');
  if (estimateMemoryTextTokens(joined) <= maxSummaryTokens) return joined;

  // Retain opening anchor + most recent turns within maxSummaryTokens
  const anchor = segments[0]!;
  const tail: string[] = [];
  for (let i = segments.length - 1; i >= 1; i--) {
    const candidate = [anchor, ...tail, segments[i]!].join(' ; ');
    if (estimateMemoryTextTokens(candidate) > maxSummaryTokens) break;
    tail.unshift(segments[i]!);
  }

  joined = tail.length > 0 ? [anchor, ...tail].join(' ; ') : anchor;
  return truncateTextToTokenBudget(joined, maxSummaryTokens);
}

/**
 * Benchmark anti-pattern matching GonnaCrash Level 26 `Context Builder (Rules)`:
 * hard-trims history to ONLY the single most recent turn, causing `memory_dropped`
 * whenever users ask back-reference follow-ups ("that order from earlier").
 */
export function buildLastTurnOnlyPrompt(input: LastTurnOnlyPromptInput): LastTurnOnlyPromptResult {
  const currentTurn = normalizeConversationTurn(input.currentTurn);
  const maxTotalTokens = Math.max(64, input.maxTotalTokens ?? 1_200);
  const keptRecent = input.history.length > 0 ? [input.history[input.history.length - 1]!] : [];
  const droppedTurns = input.history.slice(0, Math.max(0, input.history.length - keptRecent.length));
  const droppedFacts = extractConversationFacts(droppedTurns, 1);
  const backRef = hasBackReference(currentTurn.content);

  const systemPrompt = input.systemPrompt?.trim() || undefined;
  const messages: ConversationTurn[] = [
    ...(systemPrompt ? [{ role: 'system' as const, content: systemPrompt }] : []),
    ...keptRecent,
    currentTurn,
  ];
  const fullTurns: ConversationTurn[] = [
    ...(systemPrompt ? [{ role: 'system' as const, content: systemPrompt }] : []),
    ...input.history,
    currentTurn,
  ];

  const rawHistoryTokens = estimateConversationTokens(fullTurns);
  const compressedPromptTokens = estimateConversationTokens(messages);
  const tokensSaved = Math.max(0, rawHistoryTokens - compressedPromptTokens);
  const tokenBudget = computeMemoryTokenBudget({
    systemPrompt,
    recentTurns: keptRecent,
    currentTurn,
    maxTotalTokens,
  });

  return {
    antiPattern: 'last_turn_only_memory_dropped',
    messages,
    droppedTurnsCount: droppedTurns.length,
    droppedFactsCount: droppedFacts.length,
    backReferenceDetected: backRef.detected,
    metrics: {
      mode: 'last_turn_only_antipattern',
      scope: 'per_chat',
      sharedWith: 'one_bot',
      totalTurnsSeen: input.history.length,
      summarizedTurnsCount: 0,
      keptRecentMessages: keptRecent.length,
      activeFactsCount: 0,
      supersededFactsCount: 0,
      rawHistoryTokens,
      compressedPromptTokens,
      tokensSaved,
      compressionRatio:
        rawHistoryTokens > 0 ? Number((compressedPromptTokens / rawHistoryTokens).toFixed(4)) : 1,
      summarizerUsed: 'none',
      summarizerErrorRecovered: false,
      backReferenceDetected: backRef.detected,
      backReferenceMatchedPhrases: backRef.matchedPhrases,
      tokenBudget,
    },
  };
}
