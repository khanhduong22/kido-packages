import { hashContent } from './heuristics';
import {
  DuplicateCheckResult,
  ISpamVelocityGuard,
  IVelocityCacheAdapter,
  SpamVelocityGuardOptions,
  VelocityCheckResult,
  VelocityLimitConfig,
} from './types';

/**
 * Default zero-dependency in-memory cache adapter with automatic TTL expiration.
 */
export class MemoryVelocityCacheAdapter implements IVelocityCacheAdapter {
  private readonly store = new Map<string, { value: any; expiresAt: number }>();
  private cleanupTimer?: ReturnType<typeof setInterval>;

  constructor(autoCleanup = true, cleanupIntervalMs = 60_000) {
    if (autoCleanup && typeof setInterval !== 'undefined') {
      this.cleanupTimer = setInterval(() => this.cleanup(), cleanupIntervalMs);
      if (
        this.cleanupTimer &&
        typeof (this.cleanupTimer as any).unref === 'function'
      ) {
        (this.cleanupTimer as any).unref();
      }
    }
  }

  get<T>(key: string): T | null {
    const item = this.store.get(key);
    if (!item) return null;

    if (Date.now() > item.expiresAt) {
      this.store.delete(key);
      return null;
    }

    return item.value as T;
  }

  set<T>(key: string, value: T, ttlMs: number): void {
    this.store.set(key, {
      value,
      expiresAt: Date.now() + ttlMs,
    });
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  cleanup(): void {
    const now = Date.now();
    for (const [key, item] of this.store.entries()) {
      if (now > item.expiresAt) {
        this.store.delete(key);
      }
    }
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    this.clear();
  }
}

/**
 * SpamVelocityGuard
 * Layer 2 Rate Limiter & Repetitive Content Duplicate Guard
 * Detects spam frequency violations and cross-target copy-paste bot floods.
 */
export class SpamVelocityGuard implements ISpamVelocityGuard {
  private readonly cacheAdapter: IVelocityCacheAdapter;
  public readonly commentLimit: number;
  public readonly commentWindowSec: number;
  public readonly postLimit: number;
  public readonly postWindowSec: number;
  public readonly duplicateWindowSec: number;
  public readonly duplicateThreshold: number;

  constructor(options?: SpamVelocityGuardOptions) {
    this.cacheAdapter = options?.cacheAdapter ?? new MemoryVelocityCacheAdapter();
    this.commentLimit = options?.commentLimit ?? 10; // max 10 comments
    this.commentWindowSec = options?.commentWindowSec ?? 60; // in 60s
    this.postLimit = options?.postLimit ?? 3; // max 3 posts
    this.postWindowSec = options?.postWindowSec ?? 300; // in 5 mins
    this.duplicateWindowSec = options?.duplicateWindowSec ?? 300; // 5 mins
    this.duplicateThreshold = options?.duplicateThreshold ?? 3; // 3 distinct targets
  }

  /**
   * Get underlying cache adapter.
   */
  getCacheAdapter(): IVelocityCacheAdapter {
    return this.cacheAdapter;
  }

  /**
   * Checks if user exceeds velocity thresholds (rate of posting/commenting).
   * Fail-open: returns allowed on cache error to avoid blocking legitimate users.
   */
  async checkVelocity(
    userId: string | number,
    actionType: 'post' | 'comment' | string = 'comment',
    limits?: Partial<VelocityLimitConfig>,
  ): Promise<VelocityCheckResult> {
    if (!userId) {
      return { isAllowed: true };
    }

    const maxCount =
      limits?.maxCount ??
      (actionType === 'post' ? this.postLimit : this.commentLimit);
    const windowSec =
      limits?.windowSec ??
      (actionType === 'post' ? this.postWindowSec : this.commentWindowSec);

    const key = `anti-spam:velocity:${actionType}:${userId}`;

    try {
      const currentCount =
        ((await this.cacheAdapter.get<number>(key)) as number) || 0;

      if (currentCount >= maxCount) {
        return {
          isAllowed: false,
          retryAfterSec: windowSec,
          currentCount,
        };
      }

      const nextCount = currentCount + 1;
      await this.cacheAdapter.set(key, nextCount, windowSec * 1000);

      return {
        isAllowed: true,
        currentCount: nextCount,
      };
    } catch {
      // Fail-open
      return { isAllowed: true };
    }
  }

  /**
   * Checks if user is posting the identical text across different targets (bot flood pattern).
   * Flags duplicate spam when the same content is posted across >= 3 distinct targets within the window.
   */
  async checkDuplicateContent(
    userId: string | number,
    normalizedText: string,
    targetId: string | number,
    windowMs?: number,
  ): Promise<DuplicateCheckResult> {
    if (!userId || !normalizedText || normalizedText.trim().length < 10 || !targetId) {
      return { isDuplicateSpam: false };
    }

    const ttlMs = windowMs ?? this.duplicateWindowSec * 1000;
    const contentHash = hashContent(normalizedText.trim().toLowerCase());
    const key = `anti-spam:duplicate:${userId}:${contentHash}`;

    try {
      const existingTargets =
        ((await this.cacheAdapter.get<string[]>(key)) as string[]) || [];
      const targetStr = String(targetId);

      if (existingTargets.includes(targetStr)) {
        return {
          isDuplicateSpam: existingTargets.length >= this.duplicateThreshold,
          targetCount: existingTargets.length,
        };
      }

      const updatedTargets = [...existingTargets, targetStr];
      await this.cacheAdapter.set(key, updatedTargets, ttlMs);

      const isDuplicateSpam = updatedTargets.length >= this.duplicateThreshold;
      return {
        isDuplicateSpam,
        targetCount: updatedTargets.length,
      };
    } catch {
      // Fail-open
      return { isDuplicateSpam: false };
    }
  }
}
