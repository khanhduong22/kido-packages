import {
  DealerTier,
  ItemPricingBreakdown,
  OrderPricingRequest,
  OrderPricingResult,
  VolumeDiscountBracket,
} from './schemas';

/**
 * Default base discounts by Dealer Tier for FMCG Distribution
 */
export const DEFAULT_TIER_DISCOUNTS: Record<DealerTier, number> = {
  TIER_2: 15, // Đại lý Cấp 2: 15% chiết khấu cơ bản
  TIER_1: 20, // Đại lý Cấp 1: 20% chiết khấu cơ bản
  GOLD: 25,   // Đại lý Vàng (VIP FMCG Partner): 25% chiết khấu cơ bản
};

/**
 * Standard volume discount tiers based on order item quantity
 */
export const DEFAULT_VOLUME_BRACKETS: VolumeDiscountBracket[] = [
  { minQuantity: 1000, additionalDiscountPercent: 8 }, // 1000+ units: +8%
  { minQuantity: 500, additionalDiscountPercent: 5 },  // 500-999 units: +5%
  { minQuantity: 100, additionalDiscountPercent: 2 },  // 100-499 units: +2%
];

/**
 * Resolves additional volume discount percentage for a given quantity
 */
export function getVolumeDiscountPercent(
  quantity: number,
  brackets: VolumeDiscountBracket[] = DEFAULT_VOLUME_BRACKETS
): number {
  // Sort descending by minQuantity
  const sorted = [...brackets].sort((a, b) => b.minQuantity - a.minQuantity);
  for (const bracket of sorted) {
    if (quantity >= bracket.minQuantity) {
      return bracket.additionalDiscountPercent;
    }
  }
  return 0;
}

/**
 * FMCG B2B Tier Pricing & Credit Limit Guard
 *
 * 1. Computes tier-based wholesale pricing and tiered volume discounts per item.
 * 2. Aggregates gross order total, total discount savings, and net payable amount.
 * 3. Enforces automated credit limit guard: locks order if (currentDebt + netTotal) > creditLimit.
 */
export function calculateTierPricingAndCredit(
  request: OrderPricingRequest
): OrderPricingResult {
  const { dealer, items, customVolumeBrackets } = request;

  // Base tier discount or custom contract discount
  const baseTierDiscount =
    dealer.customDiscountPercent !== undefined
      ? dealer.customDiscountPercent
      : (DEFAULT_TIER_DISCOUNTS[dealer.tier] ?? 0);

  const brackets = customVolumeBrackets ?? DEFAULT_VOLUME_BRACKETS;

  // Itemized breakdown calculations
  const itemBreakdowns: ItemPricingBreakdown[] = items.map(item => {
    const grossSubtotal = Math.round(item.unitPrice * item.quantity);
    const volumeDiscount = getVolumeDiscountPercent(item.quantity, brackets);
    const totalDiscountPercent = Math.min(100, baseTierDiscount + volumeDiscount);

    const discountAmount = Math.round(grossSubtotal * (totalDiscountPercent / 100));
    const netSubtotal = grossSubtotal - discountAmount;

    return {
      productId: item.productId,
      productName: item.productName,
      unitPrice: item.unitPrice,
      quantity: item.quantity,
      grossSubtotal,
      baseTierDiscountPercent: baseTierDiscount,
      volumeDiscountPercent: volumeDiscount,
      totalDiscountPercent,
      discountAmount,
      netSubtotal,
    };
  });

  const grossTotal = itemBreakdowns.reduce((sum, item) => sum + item.grossSubtotal, 0);
  const totalDiscount = itemBreakdowns.reduce((sum, item) => sum + item.discountAmount, 0);
  const netTotal = itemBreakdowns.reduce((sum, item) => sum + item.netSubtotal, 0);

  // Credit Limit Enforcement
  const creditLimit = dealer.creditLimit;
  const currentDebt = dealer.currentDebt;
  const projectedDebt = currentDebt + netTotal;
  const availableCreditBeforeOrder = Math.max(0, creditLimit - currentDebt);
  const remainingCreditAfterOrder = creditLimit - projectedDebt;

  const isLocked = projectedDebt > creditLimit;
  const lockReason = isLocked ? 'CREDIT_LIMIT_EXCEEDED' : undefined;
  const excessDebtAmount = isLocked ? projectedDebt - creditLimit : 0;

  return {
    dealerId: dealer.id,
    dealerName: dealer.name,
    dealerTier: dealer.tier,
    items: itemBreakdowns,
    grossTotal,
    totalDiscount,
    netTotal,
    creditLimit,
    currentDebt,
    projectedDebt,
    availableCreditBeforeOrder,
    remainingCreditAfterOrder,
    isLocked,
    lockReason,
    excessDebtAmount,
    calculatedAt: new Date().toISOString(),
  };
}
