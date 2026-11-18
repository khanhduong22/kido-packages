/**
 * @kido/ai-stream/rag-security-guard - Fail-Closed Scope ACL & Zero-Cost Intent Gate
 *
 * Prevents cross-channel/cross-tenant RAG data leakage via fail-closed membership
 * resolution, channel pinning (anti-keyword hijack), and zero-cost greeting guards.
 */

export interface ScopeVerifierContext<TScope extends string = string> {
  userId: string;
  scope: TScope;
}

export interface FailClosedScopeResolverOptions<TScope extends string = string> {
  allowedScopes: ReadonlyMap<TScope, string> | ReadonlySet<TScope> | readonly TScope[];
  ownerIds?: ReadonlySet<string> | readonly string[];
  isMember: (ctx: ScopeVerifierContext<TScope>) => Promise<boolean> | boolean;
  cacheTtlMs?: number;
  nowFn?: () => number;
  pinToCurrentScope?: boolean;
  narrowWithinAuthorized?: (
    query: string,
    authorizedScopes: readonly TScope[]
  ) => readonly TScope[] | null | undefined;
}

export interface ScopeResolutionInput<TScope extends string = string> {
  userId?: string | null;
  currentScope?: TScope | null;
  isDirectMessage?: boolean;
  query?: string;
}

export interface ScopeResolutionResult<TScope extends string = string> {
  allowed: boolean;
  scopes: TScope[];
  reason: string;
  usedOwnerAllowlist: boolean;
}

interface CacheEntry {
  member: boolean;
  expiresAt: number;
}

/**
 * Fail-closed authorization resolver with TTL membership caching, strict channel
 * pinning against keyword hijacking, and bounded query narrowing.
 */
export class FailClosedScopeResolver<TScope extends string = string> {
  private readonly whitelistedScopes: Set<TScope>;
  private readonly ownerIds: Set<string>;
  private readonly isMemberFn: (ctx: ScopeVerifierContext<TScope>) => Promise<boolean> | boolean;
  private readonly cacheTtlMs: number;
  private readonly nowFn: () => number;
  private readonly pinToCurrentScope: boolean;
  private readonly narrowWithinAuthorized?: (
    query: string,
    authorizedScopes: readonly TScope[]
  ) => readonly TScope[] | null | undefined;
  private readonly membershipCache = new Map<string, CacheEntry>();

  constructor(options: FailClosedScopeResolverOptions<TScope>) {
    if (options.allowedScopes instanceof Map) {
      this.whitelistedScopes = new Set<TScope>(options.allowedScopes.keys());
    } else if (options.allowedScopes instanceof Set || Array.isArray(options.allowedScopes)) {
      this.whitelistedScopes = new Set<TScope>(options.allowedScopes as Iterable<TScope>);
    } else {
      this.whitelistedScopes = new Set<TScope>(
        (options.allowedScopes as ReadonlyMap<TScope, string>).keys()
      );
    }
    this.ownerIds = new Set<string>(options.ownerIds ?? []);
    this.isMemberFn = options.isMember;
    this.cacheTtlMs = Math.max(0, options.cacheTtlMs ?? 5 * 60 * 1000);
    this.nowFn = options.nowFn ?? (() => Date.now());
    this.pinToCurrentScope = options.pinToCurrentScope ?? true;
    this.narrowWithinAuthorized = options.narrowWithinAuthorized;
  }

  public clearCache(userId?: string): void {
    if (!userId) {
      this.membershipCache.clear();
      return;
    }
    const prefix = `${userId}::`;
    for (const key of this.membershipCache.keys()) {
      if (key.startsWith(prefix)) this.membershipCache.delete(key);
    }
  }

  private async verifyMembership(userId: string, scope: TScope): Promise<boolean> {
    if (!this.whitelistedScopes.has(scope)) return false;

    const cacheKey = `${userId}::${scope}`;
    const now = this.nowFn();
    const cached = this.membershipCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.member;
    }

    try {
      const ok = Boolean(await this.isMemberFn({ userId, scope }));
      if (this.cacheTtlMs > 0) {
        this.membershipCache.set(cacheKey, {
          member: ok,
          expiresAt: now + this.cacheTtlMs,
        });
      }
      return ok;
    } catch {
      // Fail closed on API errors or transient failures; do not cache error states.
      return false;
    }
  }

  public async resolve(
    input: ScopeResolutionInput<TScope>
  ): Promise<ScopeResolutionResult<TScope>> {
    const userId = input.userId?.trim();
    if (!userId) {
      return {
        allowed: false,
        scopes: [],
        reason: 'missing_user_id',
        usedOwnerAllowlist: false,
      };
    }

    const isOwner = this.ownerIds.has(userId);

    if (!input.isDirectMessage) {
      const currentScope = input.currentScope ?? null;
      if (!currentScope || !this.whitelistedScopes.has(currentScope)) {
        return {
          allowed: false,
          scopes: [],
          reason: 'scope_not_whitelisted',
          usedOwnerAllowlist: false,
        };
      }

      if (!isOwner) {
        const isMember = await this.verifyMembership(userId, currentScope);
        if (!isMember) {
          return {
            allowed: false,
            scopes: [],
            reason: 'membership_denied',
            usedOwnerAllowlist: false,
          };
        }
      }

      if (this.pinToCurrentScope) {
        return {
          allowed: true,
          scopes: [currentScope],
          reason: 'pinned_to_current_scope',
          usedOwnerAllowlist: isOwner,
        };
      }
    }

    let authorized: TScope[];
    if (isOwner) {
      authorized = Array.from(this.whitelistedScopes);
    } else {
      const checks = await Promise.all(
        Array.from(this.whitelistedScopes).map(async (scope) => ({
          scope,
          ok: await this.verifyMembership(userId, scope),
        }))
      );
      authorized = checks.filter((c) => c.ok).map((c) => c.scope);
    }

    if (authorized.length === 0) {
      return {
        allowed: false,
        scopes: [],
        reason: 'no_authorized_scopes',
        usedOwnerAllowlist: false,
      };
    }

    if (this.narrowWithinAuthorized && input.query) {
      const candidate = this.narrowWithinAuthorized(input.query, authorized);
      if (candidate && candidate.length > 0) {
        const authSet = new Set<TScope>(authorized);
        const safeNarrowed = candidate.filter((s) => authSet.has(s));
        if (safeNarrowed.length === 0) {
          return {
            allowed: false,
            scopes: [],
            reason: 'narrow_outside_authorized_scopes',
            usedOwnerAllowlist: isOwner,
          };
        }
        return {
          allowed: true,
          scopes: Array.from(new Set(safeNarrowed)),
          reason: isOwner ? 'owner_narrowed' : 'member_narrowed',
          usedOwnerAllowlist: isOwner,
        };
      }
    }

    return {
      allowed: true,
      scopes: authorized,
      reason: isOwner ? 'owner_allowlist' : 'verified_membership',
      usedOwnerAllowlist: isOwner,
    };
  }
}

export interface ZeroCostIntentOptions {
  maxGreetingLength?: number;
  interactiveFallbacks?: readonly string[];
  greetingPatterns?: readonly RegExp[];
}

export type ZeroCostIntentKind =
  | 'empty'
  | 'interactive_fallback'
  | 'greeting_or_capability'
  | 'inquiry';

export interface ZeroCostIntentResult {
  shortCircuit: boolean;
  kind: ZeroCostIntentKind;
  normalizedQuery: string;
}

const DEFAULT_INTERACTIVE_FALLBACKS = [
  'this message contains interactive elements.',
  'this message contains interactive elements',
];

const DEFAULT_GREETING_PATTERNS: readonly RegExp[] = [
  /^(?:hi|hello|hey|yo|ping|test|help|alo|chào(?:\s+bot|\s+bạn|\s+em|\s+anh)?|xin\s*chào|bot\s*(?:ơi|à)|bạn\s*là\s*ai|mày\s*là\s*ai|hướng\s*dẫn(?:\s*sử\s*dụng)?|what\s+can\s+you\s+do|who\s+are\s+you|làm\s*được\s*gì(?:\s*thế|\s*vậy|\s*nhỉ|\s*nào)?(?:\s*bot|\s*bro|\s*em|\s*bạn)?|có\s*tác\s*dụng\s*gì)[!?.…\s]*$/i,
];

/**
 * Classifies trivial greetings, capability probes, empty strings, and platform
 * interactive-element placeholders so they return static help with zero RAG/LLM calls.
 */
export function classifyZeroCostIntent(
  query: string,
  options: ZeroCostIntentOptions = {}
): ZeroCostIntentResult {
  const normalizedQuery = (query ?? '').trim();
  if (!normalizedQuery) {
    return { shortCircuit: true, kind: 'empty', normalizedQuery };
  }

  const lower = normalizedQuery.toLowerCase();
  const fallbacks = (options.interactiveFallbacks ?? DEFAULT_INTERACTIVE_FALLBACKS).map((s) =>
    s.trim().toLowerCase()
  );
  if (fallbacks.includes(lower)) {
    return {
      shortCircuit: true,
      kind: 'interactive_fallback',
      normalizedQuery,
    };
  }

  const maxLen = Math.max(1, options.maxGreetingLength ?? 45);
  const patterns = options.greetingPatterns ?? DEFAULT_GREETING_PATTERNS;
  if (
    normalizedQuery.length <= maxLen &&
    patterns.some((rx) => rx.test(normalizedQuery))
  ) {
    return {
      shortCircuit: true,
      kind: 'greeting_or_capability',
      normalizedQuery,
    };
  }

  return { shortCircuit: false, kind: 'inquiry', normalizedQuery };
}
