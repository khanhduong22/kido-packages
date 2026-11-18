/**
 * @kido/ai-stream - Per-User Token Quota & EDoS Pre-Flight Gate (GonnaCrash Level 13)
 *
 * Layer 1 (Precedence 4) of the 3-Layer EDoS Defense:
 * - Pre-flight single-prompt token limit (HTTP 413, 0 LLM tokens deducted)
 * - Dual-window (minute RPM/TPM + daily RPD/TPD) quota enforcement
 * - Tiered policies (anonymous / authenticated / vip) with runtime overrides
 * - Abuse violation tracking triggering CAPTCHA / Turnstile challenge flags
 * - Atomic Redis/Valkey Lua script + bounded LRU InMemoryQuotaStore
 */

export type UserQuotaTier = 'anonymous' | 'authenticated' | 'vip';

export type QuotaRejectionReason =
  | 'ALLOWED'
  | 'SINGLE_PROMPT_TOO_LARGE'
  | 'MINUTE_RPM_EXCEEDED'
  | 'DAY_RPD_EXCEEDED'
  | 'MINUTE_TPM_EXCEEDED'
  | 'DAY_TPD_EXCEEDED';

export interface PerUserQuotaPolicy {
  maxRequestsPerMinute: number;
  maxRequestsPerDay: number;
  maxTokensPerMinute: number;
  maxTokensPerDay: number;
  maxSinglePromptTokens: number;
  abuseViolationThreshold: number;
}

export interface QuotaConsumeRequest {
  subjectId: string;
  tier?: UserQuotaTier;
  estimatedInputTokens: number;
  nowMs?: number;
}

export interface QuotaDecision {
  allowed: boolean;
  reason: QuotaRejectionReason;
  httpStatus: 200 | 413 | 429;
  retryAfterSeconds: number;
  remainingRequestsMinute: number;
  remainingRequestsDay: number;
  remainingTokensMinute: number;
  remainingTokensDay: number;
  requiresChallenge: boolean;
  headers: Record<string, string>;
}

export interface QuotaSubjectState {
  minuteBucket: number; dayBucket: number;
  requestsMinute: number; requestsDay: number;
  tokensMinute: number; tokensDay: number;
  violations: number; lastAccessMs: number;
}

export interface QuotaSubjectSnapshot {
  subjectId: string; tier: UserQuotaTier;
  requestsMinute: number; requestsDay: number;
  tokensMinute: number; tokensDay: number;
  remainingRequestsMinute: number; remainingRequestsDay: number;
  remainingTokensMinute: number; remainingTokensDay: number;
  violations: number; requiresChallenge: boolean;
  minuteBucket: number; dayBucket: number;
}

export interface CompletionTokenReconciliation {
  subjectId: string;
  completionTokens: number;
  tier?: UserQuotaTier;
  estimatedInputTokens?: number;
  actualInputTokens?: number;
  nowMs?: number;
}

export interface QuotaStoreAdapter {
  get(subjectId: string): QuotaSubjectState | undefined;
  set(subjectId: string, state: QuotaSubjectState): void;
  delete(subjectId: string): boolean;
  clear(): void;
  size(): number;
}

export interface PerUserQuotaManagerOptions {
  policy?: Partial<PerUserQuotaPolicy>;
  tierOverrides?: Partial<Record<UserQuotaTier, Partial<PerUserQuotaPolicy>>>;
  defaultTier?: UserQuotaTier;
  store?: QuotaStoreAdapter;
  maxEntries?: number;
  now?: () => number;
}

export const DEFAULT_PER_USER_QUOTA_POLICY: PerUserQuotaPolicy = {
  maxRequestsPerMinute: 12, maxRequestsPerDay: 50,
  maxTokensPerMinute: 4000, maxTokensPerDay: 20000,
  maxSinglePromptTokens: 2000, abuseViolationThreshold: 3,
};

export const DEFAULT_TIER_POLICIES: Record<UserQuotaTier, PerUserQuotaPolicy> = {
  anonymous: { maxRequestsPerMinute: 6, maxRequestsPerDay: 25, maxTokensPerMinute: 2000, maxTokensPerDay: 10000, maxSinglePromptTokens: 1500, abuseViolationThreshold: 3 },
  authenticated: { ...DEFAULT_PER_USER_QUOTA_POLICY },
  vip: { maxRequestsPerMinute: 30, maxRequestsPerDay: 250, maxTokensPerMinute: 12000, maxTokensPerDay: 100000, maxSinglePromptTokens: 4000, abuseViolationThreshold: 5 },
};

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/**
 * Atomic Redis/Valkey Lua script enforcing minute + day request and token windows with PEXPIRE.
 * KEYS: [reqMinKey, reqDayKey, tokMinKey, tokDayKey, violationsKey]
 * ARGV: [estTokens, maxSinglePrompt, maxRpm, maxRpd, maxTpm, maxTpd, minTtlMs, dayTtlMs, violTtlMs, violThreshold]
 */
export const VALKEY_PER_USER_QUOTA_LUA = `
local estTokens, maxSingle = tonumber(ARGV[1]), tonumber(ARGV[2])
local maxRpm, maxRpd = tonumber(ARGV[3]), tonumber(ARGV[4])
local maxTpm, maxTpd = tonumber(ARGV[5]), tonumber(ARGV[6])
local minTtlMs, dayTtlMs = tonumber(ARGV[7]), tonumber(ARGV[8])
local violTtlMs, violThreshold = tonumber(ARGV[9]), tonumber(ARGV[10])
local reqM = tonumber(redis.call('GET', KEYS[1]) or '0')
local reqD = tonumber(redis.call('GET', KEYS[2]) or '0')
local tokM = tonumber(redis.call('GET', KEYS[3]) or '0')
local tokD = tonumber(redis.call('GET', KEYS[4]) or '0')
local viol = tonumber(redis.call('GET', KEYS[5]) or '0')
local function reject(reason, status, retrySec)
  local nextV = redis.call('INCR', KEYS[5])
  if redis.call('PTTL', KEYS[5]) < 0 then redis.call('PEXPIRE', KEYS[5], violTtlMs) end
  return {0, reason, status, retrySec, math.max(0, maxRpm - reqM), math.max(0, maxRpd - reqD), math.max(0, maxTpm - tokM), math.max(0, maxTpd - tokD), nextV >= violThreshold and 1 or 0}
end
if estTokens > maxSingle then return reject('SINGLE_PROMPT_TOO_LARGE', 413, 0) end
if (reqM + 1) > maxRpm then return reject('MINUTE_RPM_EXCEEDED', 429, math.max(1, math.ceil(minTtlMs / 1000))) end
if (reqD + 1) > maxRpd then return reject('DAY_RPD_EXCEEDED', 429, math.max(1, math.ceil(dayTtlMs / 1000))) end
if (tokM + estTokens) > maxTpm then return reject('MINUTE_TPM_EXCEEDED', 429, math.max(1, math.ceil(minTtlMs / 1000))) end
if (tokD + estTokens) > maxTpd then return reject('DAY_TPD_EXCEEDED', 429, math.max(1, math.ceil(dayTtlMs / 1000))) end
local newReqM = redis.call('INCR', KEYS[1])
if redis.call('PTTL', KEYS[1]) < 0 then redis.call('PEXPIRE', KEYS[1], minTtlMs) end
local newReqD = redis.call('INCR', KEYS[2])
if redis.call('PTTL', KEYS[2]) < 0 then redis.call('PEXPIRE', KEYS[2], dayTtlMs) end
local newTokM = redis.call('INCRBY', KEYS[3], estTokens)
if redis.call('PTTL', KEYS[3]) < 0 then redis.call('PEXPIRE', KEYS[3], minTtlMs) end
local newTokD = redis.call('INCRBY', KEYS[4], estTokens)
if redis.call('PTTL', KEYS[4]) < 0 then redis.call('PEXPIRE', KEYS[4], dayTtlMs) end
return {1, 'ALLOWED', 200, 0, math.max(0, maxRpm - newReqM), math.max(0, maxRpd - newReqD), math.max(0, maxTpm - newTokM), math.max(0, maxTpd - newTokD), viol >= violThreshold and 1 or 0}
`.trim();

/** Bounded-capacity in-memory quota store with O(1) LRU eviction. */
export class InMemoryQuotaStore implements QuotaStoreAdapter {
  private readonly store = new Map<string, QuotaSubjectState>();
  public readonly maxEntries: number;

  constructor(options: number | { maxEntries?: number } = {}) {
    const rawMax = typeof options === 'number' ? options : options.maxEntries;
    this.maxEntries = Math.max(1, Math.floor(rawMax ?? 10_000));
  }

  public get(subjectId: string): QuotaSubjectState | undefined {
    const existing = this.store.get(subjectId);
    if (!existing) return undefined;
    this.store.delete(subjectId);
    this.store.set(subjectId, existing);
    return existing;
  }

  public set(subjectId: string, state: QuotaSubjectState): void {
    if (this.store.has(subjectId)) this.store.delete(subjectId);
    else if (this.store.size >= this.maxEntries) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) this.store.delete(oldestKey);
    }
    this.store.set(subjectId, state);
  }

  public delete(subjectId: string): boolean { return this.store.delete(subjectId); }
  public clear(): void { this.store.clear(); }
  public size(): number { return this.store.size; }
  public has(subjectId: string): boolean { return this.store.has(subjectId); }
}

function buildDecision(
  allowed: boolean, reason: QuotaRejectionReason, httpStatus: 200 | 413 | 429,
  retryAfterSeconds: number, state: QuotaSubjectState, policy: PerUserQuotaPolicy, tier: UserQuotaTier
): QuotaDecision {
  const remainingRequestsMinute = Math.max(0, policy.maxRequestsPerMinute - state.requestsMinute);
  const remainingRequestsDay = Math.max(0, policy.maxRequestsPerDay - state.requestsDay);
  const remainingTokensMinute = Math.max(0, policy.maxTokensPerMinute - state.tokensMinute);
  const remainingTokensDay = Math.max(0, policy.maxTokensPerDay - state.tokensDay);
  const requiresChallenge = state.violations >= policy.abuseViolationThreshold;

  const headers: Record<string, string> = {
    'X-Quota-Blocked': allowed ? '0' : '1',
    'X-Quota-Reason': reason,
    'X-Quota-Tier': tier,
    'X-Quota-Remaining-Requests': String(Math.min(remainingRequestsMinute, remainingRequestsDay)),
    'X-Quota-Remaining-Requests-Day': String(remainingRequestsDay),
    'X-Quota-Remaining-Tokens': String(Math.min(remainingTokensMinute, remainingTokensDay)),
    'X-Quota-Remaining-Tokens-Day': String(remainingTokensDay),
  };
  if (!allowed && retryAfterSeconds > 0) headers['Retry-After'] = String(retryAfterSeconds);
  if (requiresChallenge) headers['X-Quota-Challenge-Required'] = '1';

  return {
    allowed, reason, httpStatus, retryAfterSeconds,
    remainingRequestsMinute, remainingRequestsDay, remainingTokensMinute, remainingTokensDay,
    requiresChallenge, headers,
  };
}

/** Per-User Token Quota Manager with 413 pre-flight guard, minute+day windows, and token reconciliation. */
export class PerUserTokenQuotaManager {
  private readonly store: QuotaStoreAdapter;
  private readonly policyOverrides: Partial<PerUserQuotaPolicy>;
  private readonly tierOverrides: Partial<Record<UserQuotaTier, Partial<PerUserQuotaPolicy>>>;
  private readonly defaultTier: UserQuotaTier;
  private readonly now: () => number;

  constructor(options: PerUserQuotaManagerOptions = {}) {
    this.store = options.store ?? new InMemoryQuotaStore({ maxEntries: options.maxEntries ?? 10_000 });
    this.policyOverrides = options.policy ? { ...options.policy } : {};
    this.tierOverrides = options.tierOverrides ? { ...options.tierOverrides } : {};
    this.defaultTier = options.defaultTier ?? 'authenticated';
    this.now = options.now ?? (() => Date.now());
  }

  public resolvePolicy(tier?: UserQuotaTier): PerUserQuotaPolicy {
    const resolvedTier = tier ?? this.defaultTier;
    return { ...DEFAULT_TIER_POLICIES[resolvedTier], ...this.policyOverrides, ...(this.tierOverrides[resolvedTier] ?? {}) };
  }

  public getStore(): QuotaStoreAdapter { return this.store; }

  public checkAndConsume(request: QuotaConsumeRequest): QuotaDecision {
    const nowMs = request.nowMs ?? this.now();
    const tier = request.tier ?? this.defaultTier;
    const policy = this.resolvePolicy(tier);
    const tokens = Math.max(0, Math.ceil(Number.isFinite(request.estimatedInputTokens) ? request.estimatedInputTokens : 0));

    const record = this.getOrRolloverState(request.subjectId, nowMs);
    const minuteRetry = Math.max(1, Math.ceil(((record.minuteBucket + 1) * MINUTE_MS - nowMs) / 1000));
    const dayRetry = Math.max(1, Math.ceil(((record.dayBucket + 1) * DAY_MS - nowMs) / 1000));

    const reject = (reason: Exclude<QuotaRejectionReason, 'ALLOWED'>, status: 413 | 429, retrySec: number): QuotaDecision => {
      record.violations += 1;
      record.lastAccessMs = nowMs;
      this.store.set(request.subjectId, record);
      return buildDecision(false, reason, status, retrySec, record, policy, tier);
    };

    if (tokens > policy.maxSinglePromptTokens) return reject('SINGLE_PROMPT_TOO_LARGE', 413, 0);
    if (record.requestsMinute + 1 > policy.maxRequestsPerMinute) return reject('MINUTE_RPM_EXCEEDED', 429, minuteRetry);
    if (record.requestsDay + 1 > policy.maxRequestsPerDay) return reject('DAY_RPD_EXCEEDED', 429, dayRetry);
    if (record.tokensMinute + tokens > policy.maxTokensPerMinute) return reject('MINUTE_TPM_EXCEEDED', 429, minuteRetry);
    if (record.tokensDay + tokens > policy.maxTokensPerDay) return reject('DAY_TPD_EXCEEDED', 429, dayRetry);

    record.requestsMinute += 1;
    record.requestsDay += 1;
    record.tokensMinute += tokens;
    record.tokensDay += tokens;
    record.lastAccessMs = nowMs;
    this.store.set(request.subjectId, record);
    return buildDecision(true, 'ALLOWED', 200, 0, record, policy, tier);
  }

  public recordCompletionTokens(
    subjectOrParams: string | CompletionTokenReconciliation,
    completionTokens?: number,
    reconciliation?: { tier?: UserQuotaTier; estimatedInputTokens?: number; actualInputTokens?: number; nowMs?: number }
  ): QuotaSubjectSnapshot {
    const params: CompletionTokenReconciliation =
      typeof subjectOrParams === 'string'
        ? { subjectId: subjectOrParams, completionTokens: completionTokens ?? 0, ...reconciliation }
        : subjectOrParams;

    const nowMs = params.nowMs ?? this.now();
    const record = this.getOrRolloverState(params.subjectId, nowMs);
    const outTokens = Math.max(0, Math.ceil(Number.isFinite(params.completionTokens) ? params.completionTokens : 0));
    const inputDelta =
      params.actualInputTokens !== undefined && params.estimatedInputTokens !== undefined
        ? Math.round(params.actualInputTokens - params.estimatedInputTokens)
        : 0;

    record.tokensMinute = Math.max(0, record.tokensMinute + outTokens + inputDelta);
    record.tokensDay = Math.max(0, record.tokensDay + outTokens + inputDelta);
    record.lastAccessMs = nowMs;
    this.store.set(params.subjectId, record);
    return this.getSnapshot(params.subjectId, { tier: params.tier, nowMs });
  }

  public getSnapshot(subjectId: string, options?: number | { tier?: UserQuotaTier; nowMs?: number }): QuotaSubjectSnapshot {
    const nowMs = typeof options === 'number' ? options : (options?.nowMs ?? this.now());
    const tier = (typeof options === 'object' ? options?.tier : undefined) ?? this.defaultTier;
    const policy = this.resolvePolicy(tier);
    const s = this.getOrRolloverState(subjectId, nowMs, false);

    return {
      subjectId, tier,
      requestsMinute: s.requestsMinute, requestsDay: s.requestsDay,
      tokensMinute: s.tokensMinute, tokensDay: s.tokensDay,
      remainingRequestsMinute: Math.max(0, policy.maxRequestsPerMinute - s.requestsMinute),
      remainingRequestsDay: Math.max(0, policy.maxRequestsPerDay - s.requestsDay),
      remainingTokensMinute: Math.max(0, policy.maxTokensPerMinute - s.tokensMinute),
      remainingTokensDay: Math.max(0, policy.maxTokensPerDay - s.tokensDay),
      violations: s.violations, requiresChallenge: s.violations >= policy.abuseViolationThreshold,
      minuteBucket: s.minuteBucket, dayBucket: s.dayBucket,
    };
  }

  public reset(subjectId?: string): void {
    if (subjectId !== undefined) this.store.delete(subjectId);
    else this.store.clear();
  }

  private getOrRolloverState(subjectId: string, nowMs: number, persistNew = true): QuotaSubjectState {
    const minuteBucket = Math.floor(nowMs / MINUTE_MS);
    const dayBucket = Math.floor(nowMs / DAY_MS);
    const existing = this.store.get(subjectId);

    if (!existing) {
      const fresh: QuotaSubjectState = {
        minuteBucket, dayBucket, requestsMinute: 0, requestsDay: 0,
        tokensMinute: 0, tokensDay: 0, violations: 0, lastAccessMs: nowMs,
      };
      if (persistNew) this.store.set(subjectId, fresh);
      return fresh;
    }

    const updated = { ...existing };
    if (updated.dayBucket !== dayBucket) {
      updated.dayBucket = dayBucket; updated.minuteBucket = minuteBucket;
      updated.requestsDay = 0; updated.tokensDay = 0;
      updated.requestsMinute = 0; updated.tokensMinute = 0; updated.violations = 0;
    } else if (updated.minuteBucket !== minuteBucket) {
      updated.minuteBucket = minuteBucket;
      updated.requestsMinute = 0; updated.tokensMinute = 0;
    }
    return updated;
  }
}
