import type {
  CancelMode,
  CancelSubscriptionOptions,
  SubscriptionRecord,
  SubscriptionStatus,
  TrialConfig,
  UserTrialHistory,
} from './types';
import { toUnixSeconds } from './proration';

export class SubscriptionLifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SubscriptionLifecycleError';
  }
}

/**
 * Valid transitions according to Stripe's subscription lifecycle.
 */
export const ALLOWED_TRANSITIONS: Record<SubscriptionStatus, readonly SubscriptionStatus[]> = {
  incomplete: ['active', 'incomplete_expired', 'canceled'],
  incomplete_expired: [], // terminal
  trialing: ['active', 'past_due', 'canceled', 'paused'],
  active: ['active', 'past_due', 'canceled', 'paused'],
  past_due: ['active', 'unpaid', 'canceled'],
  unpaid: ['active', 'canceled'],
  paused: ['active', 'canceled'],
  canceled: [], // terminal
};

/**
 * Subscription State Machine
 */
export class SubscriptionStateMachine {
  /**
   * Check whether a transition from current to target status is valid.
   */
  public static canTransition(
    current: SubscriptionStatus,
    target: SubscriptionStatus
  ): boolean {
    if (current === target) {
      return true; // no-op transition is allowed
    }
    const allowed = ALLOWED_TRANSITIONS[current] || [];
    return allowed.includes(target);
  }

  /**
   * Asserts valid transition, throws SubscriptionLifecycleError if invalid.
   */
  public static assertValidTransition(
    current: SubscriptionStatus,
    target: SubscriptionStatus
  ): void {
    if (!this.canTransition(current, target)) {
      throw new SubscriptionLifecycleError(
        `Invalid subscription state transition from '${current}' to '${target}'.`
      );
    }
  }

  /**
   * Checks whether a status is terminal (no further transitions allowed).
   */
  public static isTerminal(status: SubscriptionStatus): boolean {
    return ALLOWED_TRANSITIONS[status]?.length === 0;
  }

  /**
   * Checks whether the customer is currently entitled to product privileges.
   * - active & trialing: full access
   * - past_due: grace period access (optional policy parameter)
   */
  public static isEntitled(
    status: SubscriptionStatus,
    options: { allowPastDueGracePeriod?: boolean } = { allowPastDueGracePeriod: true }
  ): boolean {
    if (status === 'active' || status === 'trialing') {
      return true;
    }
    if (status === 'past_due' && options.allowPastDueGracePeriod) {
      return true;
    }
    return false;
  }
}

/**
 * Trial Expiration & Eligibility Resolver.
 * Robust subscription trial period resolver and anti-abuse validation.
 */
export class SubscriptionTrialResolver {
  /**
   * Check whether a user is eligible to start a trial on a given price.
   */
  public static canUserStartTrial(
    userHistory: UserTrialHistory,
    config: TrialConfig,
    referenceTime?: Date | number
  ): boolean {
    // 1. If user has ever used a trial in their lifetime, reject immediately
    if (this.hasUserUsedTrial(userHistory)) {
      return false;
    }

    // 2. Check if the price config currently offers an active trial window
    return this.resolveTrialEndsAt(config, referenceTime) !== null;
  }

  /**
   * Checks if user has already consumed a trial.
   */
  public static hasUserUsedTrial(userHistory: UserTrialHistory): boolean {
    if (userHistory.hasUsedTrial === true) {
      return true;
    }
    return userHistory.trialUsedAt !== null && userHistory.trialUsedAt !== undefined;
  }

  /**
   * Computes the absolute trial end date if active, or null if disabled/expired.
   */
  public static resolveTrialEndsAt(
    config: TrialConfig,
    referenceTime?: Date | number
  ): Date | null {
    if (!config.allowTrial) {
      return null;
    }

    const refDate = referenceTime instanceof Date
      ? referenceTime
      : referenceTime !== undefined
        ? new Date(toUnixSeconds(referenceTime) * 1000)
        : new Date();

    const mode = (config.mode || 'days').toLowerCase();

    if (mode === 'until') {
      if (!config.trialEndsOn) {
        return null;
      }
      const endsAt = config.trialEndsOn instanceof Date
        ? config.trialEndsOn
        : new Date(config.trialEndsOn);

      if (isNaN(endsAt.getTime()) || endsAt.getTime() <= refDate.getTime()) {
        return null;
      }
      return endsAt;
    }

    // mode === 'days'
    const days = config.trialDays ?? 3;
    if (days < 1) {
      return null;
    }

    const endsAt = new Date(refDate.getTime() + days * 24 * 60 * 60 * 1000);
    return endsAt;
  }

  /**
   * Checks if a trial end timestamp has passed.
   */
  public static isTrialExpired(
    trialEnd: Date | number,
    referenceTime?: Date | number
  ): boolean {
    const endSec = toUnixSeconds(trialEnd);
    const refSec = referenceTime !== undefined
      ? toUnixSeconds(referenceTime)
      : Math.floor(Date.now() / 1000);

    return refSec >= endSec;
  }
}

/**
 * Manages cancellation workflows: Graceful (cancel_at_period_end) vs Immediate.
 */
export class SubscriptionCancellationManager {
  /**
   * Applies cancellation to a subscription record.
   */
  public static applyCancellation(
    subscription: SubscriptionRecord,
    options: CancelSubscriptionOptions
  ): SubscriptionRecord {
    const nowSec = options.referenceTime !== undefined
      ? toUnixSeconds(options.referenceTime)
      : Math.floor(Date.now() / 1000);

    if (subscription.status === 'canceled') {
      throw new SubscriptionLifecycleError('Subscription is already canceled');
    }

    const updated: SubscriptionRecord = { ...subscription };

    if (options.mode === 'period_end') {
      // Graceful cancellation: active until current_period_end
      updated.cancelAtPeriodEnd = true;
      updated.cancelAt = subscription.currentPeriodEnd;
      // Status remains active or trialing
    } else {
      // Immediate cancellation
      SubscriptionStateMachine.assertValidTransition(subscription.status, 'canceled');
      updated.status = 'canceled';
      updated.canceledAt = nowSec;
      updated.cancelAtPeriodEnd = false;
      updated.cancelAt = null;
    }

    if (options.cancelReason) {
      updated.metadata = {
        ...(updated.metadata || {}),
        cancelReason: options.cancelReason,
      };
    }

    return updated;
  }

  /**
   * Reverts a scheduled cancellation if the cycle has not yet ended.
   */
  public static revertCancellation(subscription: SubscriptionRecord): SubscriptionRecord {
    if (subscription.status === 'canceled') {
      throw new SubscriptionLifecycleError('Cannot revert an immediately canceled subscription');
    }

    if (!subscription.cancelAtPeriodEnd) {
      throw new SubscriptionLifecycleError('Subscription is not scheduled for cancellation');
    }

    return {
      ...subscription,
      cancelAtPeriodEnd: false,
      cancelAt: null,
    };
  }
}
