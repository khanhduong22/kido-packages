import type {
  PlanPriceConfig,
  ProrationInput,
  ProrationResult,
} from './types';

/**
 * Normalizes Date, string, or timestamp (in seconds or milliseconds) to Unix timestamp seconds.
 */
export function toUnixSeconds(val: number | Date | string): number {
  if (val instanceof Date) {
    return Math.floor(val.getTime() / 1000);
  }
  if (typeof val === 'string') {
    const parsed = Date.parse(val);
    if (!isNaN(parsed)) {
      return Math.floor(parsed / 1000);
    }
    const num = Number(val);
    if (!isNaN(num)) {
      return num > 100000000000 ? Math.floor(num / 1000) : Math.floor(num);
    }
    return Math.floor(Date.now() / 1000);
  }
  // If timestamp is in milliseconds (> 10^11, e.g. 1700000000000), convert to seconds
  if (val > 100000000000) {
    return Math.floor(val / 1000);
  }
  return Math.floor(val);
}

/**
 * Formats amount in cents to human readable currency string.
 */
export function formatCurrency(
  cents: number,
  currency = 'usd',
  locale = 'en-US'
): string {
  const isZeroDecimal = ['jpy', 'krw', 'vnd'].includes(currency.toLowerCase());
  const units = isZeroDecimal ? cents : cents / 100;

  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: currency.toUpperCase(),
    }).format(units);
  } catch {
    return `${currency.toUpperCase()} ${units.toFixed(isZeroDecimal ? 0 : 2)}`;
  }
}

/**
 * Calculates Stripe-standard subscription proration math.
 * 
 * Computes:
 * - Unused Credit: The remaining value of the old plan for unused time in current cycle.
 * - Prorated Cost: The cost of the new plan for the remaining time in current cycle.
 * - Net Amount: Prorated Cost - Unused Credit.
 * - Amount Due: Immediate charge (max(0, netAmount)).
 * - Credit Rollover Balance: Customer balance credit if downgrade/credit surplus (max(0, -netAmount)).
 */
export function calculateProration(input: ProrationInput): ProrationResult {
  const periodStartSec = toUnixSeconds(input.currentPeriodStart);
  const periodEndSec = toUnixSeconds(input.currentPeriodEnd);
  const effectiveSec = input.effectiveTime !== undefined
    ? toUnixSeconds(input.effectiveTime)
    : Math.floor(Date.now() / 1000);

  if (periodEndSec <= periodStartSec) {
    throw new Error('currentPeriodEnd must be greater than currentPeriodStart');
  }

  const totalPeriodSeconds = periodEndSec - periodStartSec;
  // Clamp effective time between start and end
  const clampedEffective = Math.max(periodStartSec, Math.min(periodEndSec, effectiveSec));
  const remainingSeconds = periodEndSec - clampedEffective;
  const elapsedSeconds = totalPeriodSeconds - remainingSeconds;
  const remainingRatio = totalPeriodSeconds > 0 ? remainingSeconds / totalPeriodSeconds : 0;

  const oldPlanAmount = Math.max(0, Math.round(input.oldPlan.amount));
  const newPlanAmount = Math.max(0, Math.round(input.newPlan.amount));

  // 1. Calculate Unused Credit for old plan
  const unusedCredit = Math.round(oldPlanAmount * remainingRatio);

  // 2. Calculate Prorated Cost for new plan
  const isDifferentInterval = input.oldPlan.interval !== input.newPlan.interval;
  const crossMode = input.crossIntervalMode ?? (isDifferentInterval ? 'restart_cycle' : 'align_period');

  let proratedCost: number;
  if (crossMode === 'restart_cycle') {
    // Starting a new cycle immediately (e.g. Month -> Annual)
    proratedCost = newPlanAmount;
  } else {
    // Aligning to the existing cycle
    proratedCost = Math.round(newPlanAmount * remainingRatio);
  }

  // 3. Compute Net difference
  const netAmount = proratedCost - unusedCredit;
  const amountDue = Math.max(0, netAmount);
  const creditRolloverBalance = Math.max(0, -netAmount);

  // 4. Direction flags
  const isUpgrade = netAmount > 0 || newPlanAmount > oldPlanAmount;
  const isDowngrade = netAmount < 0 || newPlanAmount < oldPlanAmount;
  const isSamePrice = oldPlanAmount === newPlanAmount && netAmount === 0;

  // 5. Daily rate calculations
  const totalDays = totalPeriodSeconds / 86400;
  const oldPlanDailyRate = totalDays > 0 ? Math.round((oldPlanAmount / totalDays) * 100) / 100 : 0;
  const newPlanDailyRate = totalDays > 0 ? Math.round((newPlanAmount / totalDays) * 100) / 100 : 0;

  const currency = input.newPlan.currency || input.oldPlan.currency || 'usd';

  return {
    totalPeriodSeconds,
    remainingSeconds,
    elapsedSeconds,
    remainingRatio,
    unusedCredit,
    proratedCost,
    netAmount,
    amountDue,
    creditRolloverBalance,
    isUpgrade,
    isDowngrade,
    isSamePrice,
    breakdown: {
      oldPlanAmount,
      newPlanAmount,
      oldPlanDailyRate,
      newPlanDailyRate,
      unusedCreditFormatted: formatCurrency(unusedCredit, currency),
      proratedCostFormatted: formatCurrency(proratedCost, currency),
      amountDueFormatted: formatCurrency(amountDue, currency),
      creditRolloverFormatted: formatCurrency(creditRolloverBalance, currency),
    },
  };
}

/**
 * Preview proration for an upcoming plan switch given plan prices and period bounds.
 */
export function previewPlanSwitch(
  oldPlan: PlanPriceConfig,
  newPlan: PlanPriceConfig,
  periodStart: number | Date,
  periodEnd: number | Date,
  effectiveDate: number | Date = new Date()
): ProrationResult {
  return calculateProration({
    oldPlan,
    newPlan,
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
    effectiveTime: effectiveDate,
  });
}
