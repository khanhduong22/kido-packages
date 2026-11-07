import type {
  EvictionStrategy,
  MultiQuotaSummary,
  QuotaReconcileResult,
  ResourceItem,
  ResourceQuotaRule,
  UpgradeReconcileResult,
} from './types';
import { toUnixSeconds } from './proration';

/**
 * Plan Quota Reconciler: Soft-locks excess resources during plan downgrades
 * and reactivates frozen resources during upgrades without destroying customer data.
 *
 * Implements standard eviction strategies:
 * - 'newest' (default): Deactivates newest created resources first, preserving established older items.
 * - 'oldest': Deactivates oldest created resources first.
 * - 'priority_low': Deactivates items with the lowest priority value first.
 * - 'priority_high': Deactivates items with the highest priority value first.
 * - 'custom': User-defined comparator function.
 */
export class PlanQuotaReconciler {
  /**
   * Sorts items according to the requested eviction strategy to identify excess candidates.
   * The first N items in the sorted array are the ones to be soft-locked.
   */
  public static sortForEviction<T extends ResourceItem>(
    items: T[],
    strategy: EvictionStrategy = 'newest',
    customComparator?: (a: T, b: T) => number
  ): T[] {
    const list = [...items];

    if (strategy === 'custom' && customComparator) {
      return list.sort(customComparator);
    }

    switch (strategy) {
      case 'oldest':
        // Oldest first -> smallest createdAt first
        return list.sort((a, b) => toUnixSeconds(a.createdAt) - toUnixSeconds(b.createdAt));

      case 'priority_low':
        // Lowest priority first
        return list.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));

      case 'priority_high':
        // Highest priority first
        return list.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

      case 'newest':
      default:
        // Newest first -> highest createdAt first
        return list.sort((a, b) => toUnixSeconds(b.createdAt) - toUnixSeconds(a.createdAt));
    }
  }

  /**
   * Reconciles a single resource collection against a quota rule.
   * If active items exceed allowed limit, excess items are soft-locked (frozen).
   */
  public static reconcileCollection<T extends ResourceItem>(
    items: T[],
    rule: ResourceQuotaRule<T>
  ): QuotaReconcileResult<T> {
    const activeItems = items.filter((item) => item.status === 'active');
    const total = items.length;
    const activeCount = activeItems.length;

    // Check if unlimited
    const isUnlimited = rule.isUnlimited === true || rule.allowedLimit < 0;
    if (isUnlimited) {
      return {
        resourceType: rule.resourceType,
        total,
        activeCount,
        allowedLimit: rule.allowedLimit,
        excessCount: 0,
        softLockedIds: [],
        softLockedItems: [],
        activeItems,
        hasExcess: false,
        action: 'none',
      };
    }

    const limit = Math.max(0, rule.allowedLimit);

    if (activeCount <= limit) {
      return {
        resourceType: rule.resourceType,
        total,
        activeCount,
        allowedLimit: limit,
        excessCount: 0,
        softLockedIds: [],
        softLockedItems: [],
        activeItems,
        hasExcess: false,
        action: 'none',
      };
    }

    const excessCount = activeCount - limit;
    const sorted = this.sortForEviction(
      activeItems,
      rule.strategy ?? 'newest',
      rule.customComparator
    );

    // Pick top `excessCount` items to soft-lock
    const itemsToLock = sorted.slice(0, excessCount);
    const softLockedIds = itemsToLock.map((item) => item.id);
    const remainingActive = sorted.slice(excessCount);

    // Clone items and update status to 'frozen'
    const softLockedItems: T[] = itemsToLock.map((item) => ({
      ...item,
      status: 'frozen' as const,
      softLockedAt: new Date(),
    }));

    return {
      resourceType: rule.resourceType,
      total,
      activeCount: limit,
      allowedLimit: limit,
      excessCount,
      softLockedIds,
      softLockedItems,
      activeItems: remainingActive,
      hasExcess: true,
      action: 'soft_locked',
    };
  }

  /**
   * Reconciles an upgrade: reactivates previously frozen resources up to the new quota limit.
   */
  public static reconcileUpgrade<T extends ResourceItem>(
    items: T[],
    rule: ResourceQuotaRule<T>
  ): UpgradeReconcileResult<T> {
    const activeItems = items.filter((item) => item.status === 'active');
    const frozenItems = items.filter(
      (item) => item.status === 'frozen' || item.status === 'locked'
    );

    const isUnlimited = rule.isUnlimited === true || rule.allowedLimit < 0;
    const limit = isUnlimited ? Infinity : Math.max(0, rule.allowedLimit);

    const availableSlots = Math.max(0, limit - activeItems.length);

    if (availableSlots <= 0 || frozenItems.length === 0) {
      return {
        resourceType: rule.resourceType,
        allowedLimit: rule.allowedLimit,
        reactivatedIds: [],
        reactivatedItems: [],
        activeItems,
        frozenRemainingCount: frozenItems.length,
      };
    }

    // Unfreeze items (e.g. oldest frozen first, or highest priority first)
    const sortedToReactivate = [...frozenItems].sort((a, b) => {
      // Highest priority first, then oldest created
      if (a.priority !== undefined && b.priority !== undefined && a.priority !== b.priority) {
        return b.priority - a.priority;
      }
      return toUnixSeconds(a.createdAt) - toUnixSeconds(b.createdAt);
    });

    const itemsToUnfreeze = sortedToReactivate.slice(0, availableSlots);
    const reactivatedIds = itemsToUnfreeze.map((item) => item.id);

    const reactivatedItems: T[] = itemsToUnfreeze.map((item) => ({
      ...item,
      status: 'active' as const,
      reactivatedAt: new Date(),
    }));

    const remainingFrozenCount = frozenItems.length - itemsToUnfreeze.length;

    return {
      resourceType: rule.resourceType,
      allowedLimit: rule.allowedLimit,
      reactivatedIds,
      reactivatedItems,
      activeItems: [...activeItems, ...reactivatedItems],
      frozenRemainingCount: remainingFrozenCount,
    };
  }

  /**
   * Reconciles multiple resource categories across an account simultaneously.
   */
  public static reconcileMulti<T extends ResourceItem = ResourceItem>(
    collections: Record<string, T[]>,
    rules: Record<string, ResourceQuotaRule<T>>
  ): MultiQuotaSummary {
    const reconciled: Record<string, QuotaReconcileResult<T>> = {};
    let totalExcess = 0;
    let totalSoftLocked = 0;
    let hasViolations = false;

    for (const [key, rule] of Object.entries(rules)) {
      const items = collections[key] || [];
      const result = this.reconcileCollection(items, rule);
      reconciled[key] = result;

      if (result.hasExcess) {
        hasViolations = true;
        totalExcess += result.excessCount;
        totalSoftLocked += result.softLockedIds.length;
      }
    }

    return {
      success: true,
      reconciled,
      totalExcess,
      totalSoftLocked,
      hasViolations,
    };
  }
}
