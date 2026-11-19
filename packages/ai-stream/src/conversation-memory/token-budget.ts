/**
 * @kido/ai-stream/conversation-memory - Deterministic Token Budget Estimator
 *
 * Fast, zero-dependency, UTF-8 / CJK / Vietnamese-aware token estimation and
 * surrogate-pair-safe budget truncation for long-running chat sessions.
 *
 * Invariant: 100% self-contained (zero external deps, zero sibling-slice imports).
 */

export type ConversationRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ConversationTurn {
  role: ConversationRole;
  content: string;
  /** Optional 1-based turn sequence number. */
  turnIndex?: number;
  /** Optional UNIX epoch timestamp in milliseconds. */
  timestampMs?: number;
  /** Optional caller-provided message ID. */
  id?: string;
}

export interface TokenEstimatorOptions {
  /** Per-message framing overhead in chat-completion APIs (default: 4). */
  messageOverheadTokens?: number;
  /** Conversation-level priming overhead (default: 3). */
  conversationBaseTokens?: number;
}

export interface MemoryTokenBudgetSnapshot {
  systemTokens: number;
  summaryTokens: number;
  pinnedFactsTokens: number;
  recentWindowTokens: number;
  currentTurnTokens: number;
  totalPromptTokens: number;
  maxTotalTokens: number;
  remainingBudgetTokens: number;
  utilizationRatio: number;
  withinBudget: boolean;
}

export interface ComputeMemoryTokenBudgetInput {
  systemPrompt?: string;
  rollingSummary?: string;
  pinnedFactsBlock?: string;
  recentTurns: readonly ConversationTurn[];
  currentTurn?: ConversationTurn | string;
  maxTotalTokens: number;
  options?: TokenEstimatorOptions;
}

const DEFAULT_MESSAGE_OVERHEAD = 4;
const DEFAULT_CONVERSATION_BASE = 3;

function isCjkCodePoint(cp: number): boolean {
  return (
    (cp >= 0x3040 && cp <= 0x30ff) || // Hiragana & Katakana
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Unified Ideographs Extension A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs
    (cp >= 0xac00 && cp <= 0xd7af) || // Hangul Syllables
    (cp >= 0xf900 && cp <= 0xfaff) // CJK Compatibility Ideographs
  );
}

function isVietnameseOrExtendedLatin(cp: number): boolean {
  return (cp >= 0x00c0 && cp <= 0x024f) || (cp >= 0x1e00 && cp <= 0x1eff);
}

function estimateCodePointWeight(cp: number): number {
  if (cp > 0xffff) return 2.0; // Astral plane emojis / supplementary symbols
  if (isCjkCodePoint(cp)) return 1.5; // CJK ideographs tokenize ~1-2 tokens/char
  if (isVietnameseOrExtendedLatin(cp)) return 0.55; // Diacritic Latin splits denser than ASCII
  if (cp >= 0x30 && cp <= 0x39) return 0.45; // Digits split into short numeric subwords
  if (
    (cp >= 0x21 && cp <= 0x2f) ||
    (cp >= 0x3a && cp <= 0x40) ||
    (cp >= 0x5b && cp <= 0x60) ||
    (cp >= 0x7b && cp <= 0x7e)
  ) {
    return 0.5; // Punctuation / JSON / markdown delimiters
  }
  return 0.25; // Standard ASCII letters and spaces (~4 chars/token)
}

/**
 * Deterministic UTF-8 / CJK / Vietnamese-aware token estimator.
 * Iterates Unicode code points so surrogate pairs are never split.
 */
export function estimateMemoryTextTokens(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;

  let weight = 0;
  for (const ch of trimmed) {
    const cp = ch.codePointAt(0);
    if (cp !== undefined) {
      weight += estimateCodePointWeight(cp);
    }
  }
  return Math.max(1, Math.ceil(weight));
}

/**
 * Estimates chat-completion tokens for a single turn including role & framing overhead.
 */
export function estimateTurnTokens(
  turn: Pick<ConversationTurn, 'role' | 'content'>,
  options: TokenEstimatorOptions = {}
): number {
  const overhead = Math.max(0, options.messageOverheadTokens ?? DEFAULT_MESSAGE_OVERHEAD);
  return overhead + estimateMemoryTextTokens(turn.role) + estimateMemoryTextTokens(turn.content);
}

/**
 * Estimates total chat-completion tokens for an ordered sequence of conversation turns.
 */
export function estimateConversationTokens(
  turns: readonly Pick<ConversationTurn, 'role' | 'content'>[],
  options: TokenEstimatorOptions = {}
): number {
  if (turns.length === 0) return 0;
  const base = Math.max(0, options.conversationBaseTokens ?? DEFAULT_CONVERSATION_BASE);
  let total = base;
  for (const turn of turns) {
    total += estimateTurnTokens(turn, options);
  }
  return total;
}

/**
 * Computes a structured token-budget snapshot across system prompt, rolling summary,
 * pinned facts, verbatim recent window, and the active user turn.
 */
export function computeMemoryTokenBudget(
  input: ComputeMemoryTokenBudgetInput
): MemoryTokenBudgetSnapshot {
  const opts = input.options ?? {};
  const maxTotalTokens = Math.max(1, Math.floor(input.maxTotalTokens));

  const systemTokens =
    input.systemPrompt && input.systemPrompt.trim().length > 0
      ? estimateTurnTokens({ role: 'system', content: input.systemPrompt }, opts)
      : 0;
  const summaryTokens =
    input.rollingSummary && input.rollingSummary.trim().length > 0
      ? estimateTurnTokens({ role: 'system', content: input.rollingSummary }, opts)
      : 0;
  const pinnedFactsTokens =
    input.pinnedFactsBlock && input.pinnedFactsBlock.trim().length > 0
      ? estimateTurnTokens({ role: 'system', content: input.pinnedFactsBlock }, opts)
      : 0;

  let recentWindowTokens = 0;
  for (const turn of input.recentTurns) {
    recentWindowTokens += estimateTurnTokens(turn, opts);
  }

  let currentTurnTokens = 0;
  if (input.currentTurn !== undefined) {
    const normalized: Pick<ConversationTurn, 'role' | 'content'> =
      typeof input.currentTurn === 'string'
        ? { role: 'user', content: input.currentTurn }
        : input.currentTurn;
    currentTurnTokens = estimateTurnTokens(normalized, opts);
  }

  const hasAnyMessage =
    systemTokens + summaryTokens + pinnedFactsTokens + recentWindowTokens + currentTurnTokens > 0;
  const baseOverhead = hasAnyMessage
    ? Math.max(0, opts.conversationBaseTokens ?? DEFAULT_CONVERSATION_BASE)
    : 0;

  const totalPromptTokens =
    baseOverhead +
    systemTokens +
    summaryTokens +
    pinnedFactsTokens +
    recentWindowTokens +
    currentTurnTokens;

  const remainingBudgetTokens = Math.max(0, maxTotalTokens - totalPromptTokens);
  const utilizationRatio = Number((totalPromptTokens / maxTotalTokens).toFixed(4));

  return {
    systemTokens,
    summaryTokens,
    pinnedFactsTokens,
    recentWindowTokens,
    currentTurnTokens,
    totalPromptTokens,
    maxTotalTokens,
    remainingBudgetTokens,
    utilizationRatio,
    withinBudget: totalPromptTokens <= maxTotalTokens,
  };
}

/**
 * Deterministically truncates text to fit within `maxTokens` without splitting
 * UTF-16 surrogate pairs and preferring whitespace boundaries.
 */
export function truncateTextToTokenBudget(text: string, maxTokens: number): string {
  const trimmed = text.trim();
  if (trimmed.length === 0 || maxTokens <= 0) return '';
  if (estimateMemoryTextTokens(trimmed) <= maxTokens) return trimmed;

  const ellipsis = '...';
  const ellipsisTokens = estimateMemoryTextTokens(ellipsis);
  const targetBudget = Math.max(1, maxTokens - ellipsisTokens);

  const codePoints = Array.from(trimmed);
  let weight = 0;
  let cutIndex = 0;

  for (let i = 0; i < codePoints.length; i++) {
    const cp = codePoints[i]!.codePointAt(0);
    const nextWeight = weight + (cp !== undefined ? estimateCodePointWeight(cp) : 0.25);
    if (Math.ceil(nextWeight) > targetBudget) {
      break;
    }
    weight = nextWeight;
    cutIndex = i + 1;
  }

  if (cutIndex === 0) return codePoints[0] ?? '';

  let slice = codePoints.slice(0, cutIndex).join('').trimEnd();
  const lastSpace = slice.lastIndexOf(' ');
  if (lastSpace >= Math.floor(slice.length * 0.6)) {
    slice = slice.slice(0, lastSpace).trimEnd();
  }

  const candidate = maxTokens > ellipsisTokens ? `${slice}${ellipsis}` : slice;
  return candidate;
}
