import { DEFAULT_FREE_SHIPPING_THRESHOLD } from './constants';
import { formatUsd } from './pricing';
import type { CartGoalProgress } from './types';

/**
 * Calculates current progress towards a gamified cart goal threshold (e.g., $80 Free Shipping).
 *
 * @param currentTotal Current subtotal in cart
 * @param targetThreshold Goal threshold amount in USD (defaults to $80.00)
 * @returns CartGoalProgress with progress percentage, remaining balance, and motivation message
 */
export function calculateCartGoal(
  currentTotal: number,
  targetThreshold: number = DEFAULT_FREE_SHIPPING_THRESHOLD
): CartGoalProgress {
  const targetAmount = Math.max(0.01, Math.round(targetThreshold * 100) / 100);
  const currentAmount = Math.max(0, Math.round(currentTotal * 100) / 100);
  const remainingAmount = Math.max(0, Math.round((targetAmount - currentAmount) * 100) / 100);

  const isUnlocked = currentAmount >= targetAmount;
  const rawProgress = (currentAmount / targetAmount) * 100;
  const progressPercent = isUnlocked ? 100 : Math.min(100, Math.max(0, Math.round(rawProgress * 10) / 10));

  let motivationMessage: string;
  if (isUnlocked) {
    motivationMessage = '🎉 Congratulations! You unlocked FREE Shipping & VIP Priority Handling!';
  } else if (currentAmount === 0) {
    motivationMessage = `Add ${formatUsd(targetAmount)} to unlock FREE Shipping!`;
  } else {
    motivationMessage = `Add ${formatUsd(remainingAmount)} more to unlock FREE Shipping!`;
  }

  return {
    targetAmount,
    currentAmount,
    remainingAmount,
    progressPercent,
    isUnlocked,
    motivationMessage,
  };
}
