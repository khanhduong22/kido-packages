/**
 * SaaS Subscription Recurring Coupon & Promotion Code Engine
 * Enterprise promotional code and recurring coupon discounting architecture.
 */

import type { ProrationResult } from './types';

export type CouponDiscountType = 'percentage' | 'fixed';
export type CouponDuration = 'once' | 'repeating' | 'forever';
export type PlanInterval = 'day' | 'week' | 'month' | 'year';

export interface SubscriptionCoupon {
  id: string;
  code: string;
  name?: string;
  discountType: CouponDiscountType;
  /** Percentage (e.g. 20 for 20%) or fixed amount in cents/units (e.g. 500 for $5.00) */
  discountValue: number;
  /** Duration of discount: once (first cycle), repeating (n cycles), or forever */
  duration: CouponDuration;
  /** Required if duration === 'repeating' */
  durationInMonths?: number;
  /** If set, only applicable to these billing intervals (e.g. ['year']) */
  applicableIntervals?: PlanInterval[];
  /** If set, only applicable to these plan price IDs */
  applicablePlanPriceIds?: string[];
  /** Maximum global redemptions */
  maxRedemptions?: number;
  /** Current redemption count */
  timesRedeemed?: number;
  /** Max redemptions allowed per unique user (default: 1) */
  maxRedemptionsPerUser?: number;
  /** Minimum subtotal requirement (cents) */
  minimumAmount?: number;
  /** Optional gateway mapping (e.g. Stripe Coupon ID) */
  stripeCouponId?: string;
  validFrom?: Date | string | number;
  validTo?: Date | string | number;
  isActive?: boolean;
}

export interface CouponValidationContext {
  userId?: string;
  planPriceId: string;
  interval: PlanInterval;
  amount: number;
  userRedemptionCount?: number;
  currentDate?: Date | string | number;
}

export interface CouponValidationResult {
  isValid: boolean;
  reason?: string;
  discountAmount: number;
  finalAmount: number;
  coupon?: SubscriptionCoupon;
}

export interface DiscountedProrationResult {
  originalProration: ProrationResult;
  couponDiscount: number;
  discountedAmountDue: number;
  appliedCoupon: SubscriptionCoupon;
}

/**
 * Normalizes input date into timestamp ms.
 */
function toEpochMs(d?: Date | string | number): number | undefined {
  if (d === undefined || d === null) return undefined;
  if (d instanceof Date) return d.getTime();
  if (typeof d === 'number') return d > 1e11 ? d : d * 1000;
  const parsed = new Date(d).getTime();
  return isNaN(parsed) ? undefined : parsed;
}

/**
 * Validates whether a SaaS coupon is applicable for a specific subscription checkout/change.
 */
export function validateSubscriptionCoupon(
  coupon: SubscriptionCoupon,
  context: CouponValidationContext
): CouponValidationResult {
  if (coupon.isActive === false) {
    return { isValid: false, reason: 'Coupon is inactive', discountAmount: 0, finalAmount: context.amount };
  }

  const now = toEpochMs(context.currentDate) ?? Date.now();

  const from = toEpochMs(coupon.validFrom);
  if (from !== undefined && now < from) {
    return { isValid: false, reason: 'Coupon is not yet active', discountAmount: 0, finalAmount: context.amount };
  }

  const to = toEpochMs(coupon.validTo);
  if (to !== undefined && now > to) {
    return { isValid: false, reason: 'Coupon has expired', discountAmount: 0, finalAmount: context.amount };
  }

  if (coupon.maxRedemptions !== undefined && (coupon.timesRedeemed ?? 0) >= coupon.maxRedemptions) {
    return { isValid: false, reason: 'Coupon usage limit has been reached', discountAmount: 0, finalAmount: context.amount };
  }

  const maxPerUser = coupon.maxRedemptionsPerUser ?? 1;
  if ((context.userRedemptionCount ?? 0) >= maxPerUser) {
    return { isValid: false, reason: `User has already redeemed this coupon (${maxPerUser} time limit)`, discountAmount: 0, finalAmount: context.amount };
  }

  if (coupon.minimumAmount !== undefined && context.amount < coupon.minimumAmount) {
    return { isValid: false, reason: `Minimum order amount of ${coupon.minimumAmount} is required`, discountAmount: 0, finalAmount: context.amount };
  }

  if (coupon.applicableIntervals && coupon.applicableIntervals.length > 0) {
    if (!coupon.applicableIntervals.includes(context.interval)) {
      return {
        isValid: false,
        reason: `Coupon is only valid for intervals: ${coupon.applicableIntervals.join(', ')}`,
        discountAmount: 0,
        finalAmount: context.amount,
      };
    }
  }

  if (coupon.applicablePlanPriceIds && coupon.applicablePlanPriceIds.length > 0) {
    if (!coupon.applicablePlanPriceIds.includes(context.planPriceId)) {
      return { isValid: false, reason: 'Coupon is not applicable to the selected plan', discountAmount: 0, finalAmount: context.amount };
    }
  }

  // Calculate discount
  let discountAmount = 0;
  if (coupon.discountType === 'percentage') {
    const pct = Math.min(100, Math.max(0, coupon.discountValue));
    discountAmount = Math.round((context.amount * pct) / 100);
  } else {
    discountAmount = Math.min(context.amount, Math.max(0, coupon.discountValue));
  }

  const finalAmount = Math.max(0, context.amount - discountAmount);

  return {
    isValid: true,
    discountAmount,
    finalAmount,
    coupon,
  };
}

/**
 * Applies a verified coupon discount to a plan switch proration calculation.
 */
export function calculateDiscountedProration(
  proration: ProrationResult,
  coupon: SubscriptionCoupon
): DiscountedProrationResult {
  let discount = 0;

  if (coupon.discountType === 'percentage') {
    const pct = Math.min(100, Math.max(0, coupon.discountValue));
    discount = Math.round((proration.amountDue * pct) / 100);
  } else {
    discount = Math.min(proration.amountDue, Math.max(0, coupon.discountValue));
  }

  const discountedAmountDue = Math.max(0, proration.amountDue - discount);

  return {
    originalProration: proration,
    couponDiscount: discount,
    discountedAmountDue,
    appliedCoupon: coupon,
  };
}

/**
 * Builds the payload for attaching a coupon or promo code to a Stripe Checkout Session.
 */
export function buildStripeDiscountPayload(coupon: SubscriptionCoupon): { discounts?: Array<{ coupon?: string; promotion_code?: string }> } {
  if (coupon.stripeCouponId) {
    return {
      discounts: [{ coupon: coupon.stripeCouponId }],
    };
  }

  return {};
}

/**
 * Determines if a repeating coupon has completed its duration and should restore base pricing.
 */
export function evaluateCouponCoverEnded(
  coupon: SubscriptionCoupon,
  cyclesCompleted: number
): { isEnded: boolean; remainingCycles: number } {
  if (coupon.duration === 'forever') {
    return { isEnded: false, remainingCycles: Infinity };
  }

  if (coupon.duration === 'once') {
    const isEnded = cyclesCompleted >= 1;
    return { isEnded, remainingCycles: isEnded ? 0 : 1 };
  }

  const durationMonths = coupon.durationInMonths ?? 1;
  const isEnded = cyclesCompleted >= durationMonths;
  const remainingCycles = Math.max(0, durationMonths - cyclesCompleted);

  return { isEnded, remainingCycles };
}
