/**
 * @kido/ai-stream/conversation-memory - Scoped LRU + TTL Session Store
 *
 * Isolates conversation memory sessions by `scope` (`per_chat` | `global`) and
 * `sharedWith` (`one_bot` | `all_bots`), enforcing bounded LRU capacity and TTL expiration.
 *
 * Invariant: 100% self-contained (zero external deps, zero sibling-slice imports).
 */

import type { ConversationTurn } from './token-budget.js';
import type { ConversationMemoryFact } from './fact-extractor.js';
import type { MemoryScope, MemorySharedWith } from './summary-compactor.js';

export interface MemorySessionState {
  storageKey: string;
  sessionId: string;
  botId: string;
  scope: MemoryScope;
  sharedWith: MemorySharedWith;
  rollingSummary: string;
  activeFacts: ConversationMemoryFact[];
  supersededFacts: ConversationMemoryFact[];
  recentTurns: ConversationTurn[];
  totalTurnsSeen: number;
  summarizedTurnsCount: number;
  summarizationRuns: number;
  summarizerFallbackCount: number;
  rawHistoryTokensCumulative: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface MemorySessionStoreOptions {
  scope: MemoryScope;
  sharedWith: MemorySharedWith;
  defaultBotId: string;
  maxSessions: number;
  ttlMs: number;
  nowFn: () => number;
}

export interface MemorySessionStoreStats {
  activeSessions: number;
  maxSessions: number;
  evictedLruSessions: number;
  expiredTtlSessions: number;
}

export class MemorySessionLruStore {
  private readonly sessions = new Map<string, MemorySessionState>();
  private evictedLruSessions = 0;
  private expiredTtlSessions = 0;

  constructor(private readonly opts: MemorySessionStoreOptions) {}

  resolveStorageKey(sessionId: string, botId?: string): { key: string; resolvedBotId: string } {
    const resolvedBotId = botId ?? this.opts.defaultBotId;
    if (this.opts.scope === 'global') {
      return {
        key: this.opts.sharedWith === 'all_bots' ? 'global::all_bots' : `global::${resolvedBotId}`,
        resolvedBotId,
      };
    }
    return {
      key:
        this.opts.sharedWith === 'all_bots'
          ? `chat::${sessionId}::all_bots`
          : `chat::${sessionId}::${resolvedBotId}`,
      resolvedBotId,
    };
  }

  purgeExpired(nowMs = this.opts.nowFn()): void {
    for (const [key, state] of this.sessions.entries()) {
      if (nowMs - state.updatedAtMs > this.opts.ttlMs) {
        this.sessions.delete(key);
        this.expiredTtlSessions += 1;
      }
    }
  }

  private touch(state: MemorySessionState, nowMs: number): void {
    state.updatedAtMs = nowMs;
    this.sessions.delete(state.storageKey);
    this.sessions.set(state.storageKey, state);
  }

  getOrCreate(sessionId: string, botId?: string): MemorySessionState {
    const nowMs = this.opts.nowFn();
    this.purgeExpired(nowMs);
    const { key, resolvedBotId } = this.resolveStorageKey(sessionId, botId);

    const existing = this.sessions.get(key);
    if (existing) {
      this.touch(existing, nowMs);
      return existing;
    }

    while (this.sessions.size >= this.opts.maxSessions) {
      const oldestKey = this.sessions.keys().next().value;
      if (oldestKey === undefined) break;
      this.sessions.delete(oldestKey);
      this.evictedLruSessions += 1;
    }

    const created: MemorySessionState = {
      storageKey: key,
      sessionId,
      botId: resolvedBotId,
      scope: this.opts.scope,
      sharedWith: this.opts.sharedWith,
      rollingSummary: '',
      activeFacts: [],
      supersededFacts: [],
      recentTurns: [],
      totalTurnsSeen: 0,
      summarizedTurnsCount: 0,
      summarizationRuns: 0,
      summarizerFallbackCount: 0,
      rawHistoryTokensCumulative: 0,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    };
    this.sessions.set(key, created);
    return created;
  }

  getSnapshot(sessionId: string, botId?: string): MemorySessionState | undefined {
    const nowMs = this.opts.nowFn();
    this.purgeExpired(nowMs);
    const { key } = this.resolveStorageKey(sessionId, botId);
    const state = this.sessions.get(key);
    if (!state) return undefined;
    this.touch(state, nowMs);
    return this.clone(state);
  }

  delete(sessionId: string, botId?: string): boolean {
    return this.sessions.delete(this.resolveStorageKey(sessionId, botId).key);
  }

  reset(): void {
    this.sessions.clear();
    this.evictedLruSessions = 0;
    this.expiredTtlSessions = 0;
  }

  getStats(): MemorySessionStoreStats {
    this.purgeExpired();
    return {
      activeSessions: this.sessions.size,
      maxSessions: this.opts.maxSessions,
      evictedLruSessions: this.evictedLruSessions,
      expiredTtlSessions: this.expiredTtlSessions,
    };
  }

  clone(state: MemorySessionState): MemorySessionState {
    return {
      ...state,
      activeFacts: state.activeFacts.map((f) => ({ ...f })),
      supersededFacts: state.supersededFacts.map((f) => ({ ...f })),
      recentTurns: state.recentTurns.map((t) => ({ ...t })),
    };
  }
}
