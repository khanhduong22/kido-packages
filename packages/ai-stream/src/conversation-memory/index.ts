/**
 * @kido/ai-stream - Conversation Memory Compression & Sliding Window Summarization Suite
 * (GonnaCrash World 3 Level 26 `long_conversation_memory`)
 *
 * Implements:
 * - Deterministic UTF-8/CJK/Vietnamese-aware token budgeting (`estimateConversationTokens`,
 *   `estimateTurnTokens`, `computeMemoryTokenBudget`, `truncateTextToTokenBudget`)
 * - Zero-dep Mem0/Zep-style fact extraction & latest-wins temporal superseding
 *   (`extractConversationFacts`, `mergeMemoryFacts`, `formatPinnedFactsBlock`, `hasBackReference`)
 * - Hybrid LangChain/Letta-style `RollingSummaryMemory` (verbatim recent window + rolling summary +
 *   pinned facts + custom async summarizer with deterministic fallback + LRU/TTL + per-chat/global scope)
 * - Explicit `buildLastTurnOnlyPrompt` anti-pattern comparator (`Context Builder Rules` trap)
 * - Deterministic `simulateLevel26LongConversationMemory()` (`40,289 UC`, `0.0403¢/task`, ★★★ record)
 */

export * from './token-budget.js';
export * from './fact-extractor.js';
export * from './rolling-summary-memory.js';
export * from './simulator.js';
