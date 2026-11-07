import { FxFloorParams, FxFloorResult } from './types';

/**
 * Calculate FX Floor exchange rate to protect system profit margin and hedge against currency volatility.
 */
export function calculateFxFloor(params: FxFloorParams): FxFloorResult {
  const {
    marketRate,
    direction,
    spreadPercent = 1.5,
    safetyBufferPercent = 0.5,
    minFloorRate,
    maxCeilingRate,
    roundDecimals = 0,
  } = params;

  if (marketRate <= 0) {
    throw new Error(`Invalid marketRate: ${marketRate}. Must be a strictly positive number.`);
  }

  const totalSpread = spreadPercent + safetyBufferPercent;
  let rawRate: number;

  if (direction === 'DEPOSIT') {
    // When user deposits foreign currency (e.g. USDT) to receive local balance (e.g. VND),
    // system applies spread discount: rate = marketRate * (1 - spread)
    rawRate = marketRate * (1 - totalSpread / 100);
  } else {
    // When user withdraws local earnings (e.g. VND) to foreign currency (e.g. USDT),
    // or when converting USD to local fiat payout:
    // If payout is in local currency: rate = marketRate * (1 - spread)
    // If pricing foreign asset: rate = marketRate * (1 + spread)
    rawRate = marketRate * (1 - totalSpread / 100);
  }

  let isFloorTriggered = false;
  let isCeilingTriggered = false;

  // Apply minimum floor constraint
  if (minFloorRate !== undefined && rawRate < minFloorRate) {
    rawRate = minFloorRate;
    isFloorTriggered = true;
  }

  // Apply maximum ceiling constraint
  if (maxCeilingRate !== undefined && rawRate > maxCeilingRate) {
    rawRate = maxCeilingRate;
    isCeilingTriggered = true;
  }

  // Round according to specified decimal precision
  const factor = Math.pow(10, roundDecimals);
  const effectiveRate = Math.round(rawRate * factor) / factor;

  return {
    effectiveRate,
    marketRate,
    direction,
    appliedSpreadPercent: totalSpread,
    isFloorTriggered,
    isCeilingTriggered,
    convert: (amount: number) => {
      if (amount < 0) {
        throw new Error(`Cannot convert negative amount: ${amount}`);
      }
      const rawConverted = amount * effectiveRate;
      const convertedAmount = Math.round(rawConverted * factor) / factor;

      const idealConverted = amount * marketRate;
      const spreadFeeAmount = Math.max(0, Math.round(Math.abs(idealConverted - convertedAmount) * factor) / factor);

      return {
        convertedAmount,
        spreadFeeAmount,
      };
    },
  };
}
