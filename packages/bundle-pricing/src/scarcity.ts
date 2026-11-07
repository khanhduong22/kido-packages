import type { ScarcityState } from './types';

/**
 * Calculates real-time scarcity, stock depletion decay, and countdown urgency state.
 *
 * Implements high-converting FOMO / urgency mechanics:
 * - As time progresses, simulated or real units claimed gradually increment.
 * - Stock depletes progressively based on decayRatePerMinute.
 * - Keeps at least 1-2 units remaining while the active countdown timer has not expired.
 * - Flags isExpiringSoon when remaining time is <= 3 minutes or stock is <= 5 items.
 *
 * @param initialStock Starting stock inventory (e.g. 50 or 100)
 * @param elapsedTimeSeconds Number of seconds passed since promotion session began
 * @param decayRatePerMinute Claimed units per minute (default 1.5 units/min)
 * @param totalDurationSeconds Promotion countdown duration in seconds (default 900s = 15 minutes)
 * @returns ScarcityState object with remaining stock, percentage claimed, and urgency flags
 */
export function calculateScarcityDecay(
  initialStock: number,
  elapsedTimeSeconds: number,
  decayRatePerMinute: number = 1.5,
  totalDurationSeconds: number = 900
): ScarcityState {
  const safeInitialStock = Math.max(1, Math.round(initialStock));
  const safeElapsedSeconds = Math.max(0, elapsedTimeSeconds);
  const safeDurationSeconds = Math.max(1, totalDurationSeconds);

  const timerSecondsRemaining = Math.max(0, safeDurationSeconds - safeElapsedSeconds);
  const elapsedMinutes = safeElapsedSeconds / 60;
  const baseClaimed = Math.floor(elapsedMinutes * Math.max(0, decayRatePerMinute));

  let remainingStock: number;
  if (timerSecondsRemaining === 0) {
    remainingStock = Math.max(0, safeInitialStock - baseClaimed);
  } else {
    // Keep at least 1 unit in stock while timer is actively ticking
    remainingStock = Math.max(1, safeInitialStock - baseClaimed);
  }

  const totalClaimedPercent = Math.min(
    100,
    Math.max(0, Math.round(((safeInitialStock - remainingStock) / safeInitialStock) * 100))
  );

  const isExpiringSoon = timerSecondsRemaining <= 180 || remainingStock <= 5;

  return {
    remainingStock,
    initialStock: safeInitialStock,
    totalClaimedPercent,
    timerSecondsRemaining,
    isExpiringSoon,
  };
}
