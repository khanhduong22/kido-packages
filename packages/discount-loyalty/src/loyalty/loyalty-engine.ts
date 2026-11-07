import {
  LoyaltyAccount,
  LoyaltyAccountInput,
  LoyaltyAccountSchema,
  LoyaltyConfig,
  LoyaltyConfigInput,
  LoyaltyConfigSchema,
  LoyaltyRedeemResult,
  LoyaltyRedeemResultSchema,
  LoyaltyTransactionResult,
  LoyaltyTransactionResultSchema,
  MemberTier,
  TierConfig,
} from '../types/schemas';
import { TIER_RANKS } from '../voucher/voucher-engine';

export const DEFAULT_TIER_CONFIGS: TierConfig[] = [
  {
    tier: 'BRONZE',
    minSpend: 0,
    pointMultiplier: 1.0,
    tierDiscountPercent: 0,
    name: 'Thành viên Đồng',
  },
  {
    tier: 'SILVER',
    minSpend: 2_000_000,
    pointMultiplier: 1.2,
    tierDiscountPercent: 2,
    name: 'Thành viên Bạc',
  },
  {
    tier: 'GOLD',
    minSpend: 5_000_000,
    pointMultiplier: 1.5,
    tierDiscountPercent: 5,
    name: 'Thành viên Vàng',
  },
  {
    tier: 'DIAMOND',
    minSpend: 15_000_000,
    pointMultiplier: 2.0,
    tierDiscountPercent: 10,
    name: 'Thành viên Kim Cương',
  },
];

export const DEFAULT_LOYALTY_CONFIG: LoyaltyConfig = {
  earnRate: 10_000, // 10,000 VND = 1 point
  redeemRate: 1_000, // 1 point = 1,000 VND discount
  minRedeemPoints: 10,
  maxRedeemPercentPerOrder: 50, // max 50% order value can be paid with points
  tiers: DEFAULT_TIER_CONFIGS,
};

/**
 * Determines a customer's member tier based on their cumulative total spend.
 */
export function determineMemberTier(
  totalSpend: number,
  tiers: TierConfig[] = DEFAULT_TIER_CONFIGS
): MemberTier {
  const sortedTiers = [...tiers].sort((a, b) => b.minSpend - a.minSpend);

  for (const tierConfig of sortedTiers) {
    if (totalSpend >= tierConfig.minSpend) {
      return tierConfig.tier;
    }
  }

  return 'BRONZE';
}

/**
 * Calculates how many loyalty points will be earned from a given spending amount and tier.
 */
export function calculatePointsToEarn(
  orderAmount: number,
  tier: MemberTier,
  config: LoyaltyConfigInput = DEFAULT_LOYALTY_CONFIG
): number {
  const parsedConfig = LoyaltyConfigSchema.parse(config);
  if (orderAmount <= 0) return 0;

  const basePoints = Math.floor(orderAmount / parsedConfig.earnRate);
  const tierConfig = parsedConfig.tiers?.find((t) => t.tier === tier);
  const multiplier = tierConfig?.pointMultiplier ?? 1.0;

  return Math.floor(basePoints * multiplier);
}

/**
 * Calculates discount when redeeming loyalty points against an order subtotal.
 */
export function calculateRedeemDiscount(
  accountInput: LoyaltyAccountInput,
  requestedPoints: number,
  orderSubtotal: number,
  config: LoyaltyConfigInput = DEFAULT_LOYALTY_CONFIG
): LoyaltyRedeemResult {
  const account = LoyaltyAccountSchema.parse(accountInput);
  const parsedConfig = LoyaltyConfigSchema.parse(config);

  if (requestedPoints <= 0) {
    return LoyaltyRedeemResultSchema.parse({
      success: false,
      pointsRedeemed: 0,
      discountAmount: 0,
      remainingBalance: account.balance,
      reason: 'Requested points must be greater than 0',
    });
  }

  if (account.balance < requestedPoints) {
    return LoyaltyRedeemResultSchema.parse({
      success: false,
      pointsRedeemed: 0,
      discountAmount: 0,
      remainingBalance: account.balance,
      reason: `Insufficient points balance: requested ${requestedPoints}, but available ${account.balance}`,
    });
  }

  if (requestedPoints < parsedConfig.minRedeemPoints) {
    return LoyaltyRedeemResultSchema.parse({
      success: false,
      pointsRedeemed: 0,
      discountAmount: 0,
      remainingBalance: account.balance,
      reason: `Minimum redeem threshold is ${parsedConfig.minRedeemPoints} points`,
    });
  }

  // Calculate max allowable discount based on percentage cap
  const maxDiscountValue = Math.floor(
    orderSubtotal * (parsedConfig.maxRedeemPercentPerOrder / 100)
  );
  const maxPointsAllowed = Math.floor(maxDiscountValue / parsedConfig.redeemRate);

  if (maxPointsAllowed < parsedConfig.minRedeemPoints) {
    return LoyaltyRedeemResultSchema.parse({
      success: false,
      pointsRedeemed: 0,
      discountAmount: 0,
      remainingBalance: account.balance,
      reason: `Order subtotal (${orderSubtotal.toLocaleString()}đ) is too low to redeem the minimum ${parsedConfig.minRedeemPoints} points (max allowable discount is ${maxDiscountValue.toLocaleString()}đ)`,
    });
  }

  const actualPointsToUse = Math.min(requestedPoints, maxPointsAllowed);
  const discountAmount = actualPointsToUse * parsedConfig.redeemRate;
  const remainingBalance = account.balance - actualPointsToUse;

  return LoyaltyRedeemResultSchema.parse({
    success: true,
    pointsRedeemed: actualPointsToUse,
    discountAmount,
    remainingBalance,
  });
}

/**
 * Processes a completed order transaction: handles point redemption, point accrual,
 * spend accumulation, and automated tier upgrades.
 */
export function processLoyaltyTransaction(
  accountInput: LoyaltyAccountInput,
  params: {
    orderSubtotal: number;
    pointsToRedeem?: number;
    config?: LoyaltyConfigInput;
  }
): LoyaltyTransactionResult {
  const account = LoyaltyAccountSchema.parse(accountInput);
  const config = LoyaltyConfigSchema.parse(params.config ?? DEFAULT_LOYALTY_CONFIG);

  let pointsRedeemed = 0;
  let pointsDiscountAmount = 0;
  let intermediateBalance = account.balance;

  if (params.pointsToRedeem && params.pointsToRedeem > 0) {
    const redeemRes = calculateRedeemDiscount(
      account,
      params.pointsToRedeem,
      params.orderSubtotal,
      config
    );
    if (redeemRes.success) {
      pointsRedeemed = redeemRes.pointsRedeemed;
      pointsDiscountAmount = redeemRes.discountAmount;
      intermediateBalance = redeemRes.remainingBalance;
    }
  }

  // Net amount the customer actually pays in cash/card (after points discount)
  const netPaidAmount = Math.max(0, params.orderSubtotal - pointsDiscountAmount);

  // Accrue points based on current tier
  const pointsEarned = calculatePointsToEarn(netPaidAmount, account.tier, config);

  const updatedTotalSpend = account.totalSpend + netPaidAmount;
  const updatedLifetimePoints = account.lifetimePoints + pointsEarned;
  const updatedBalance = intermediateBalance + pointsEarned;

  // Determine new tier
  const calculatedTier = determineMemberTier(updatedTotalSpend, config.tiers);
  const previousTier = account.tier;

  // Tier cannot downgrade during normal transaction processing
  const newTier =
    TIER_RANKS[calculatedTier] > TIER_RANKS[previousTier] ? calculatedTier : previousTier;
  const tierUpgraded = TIER_RANKS[newTier] > TIER_RANKS[previousTier];

  const updatedAccount: LoyaltyAccount = {
    userId: account.userId,
    balance: updatedBalance,
    lifetimePoints: updatedLifetimePoints,
    totalSpend: updatedTotalSpend,
    tier: newTier,
    createdAt: account.createdAt ?? new Date(),
    updatedAt: new Date(),
  };

  return LoyaltyTransactionResultSchema.parse({
    account: updatedAccount,
    pointsEarned,
    pointsRedeemed,
    pointsDiscountAmount,
    previousTier,
    currentTier: newTier,
    tierUpgraded,
  });
}

/**
 * High-level LoyaltyEngine class for managing loyalty rules, points, and tiers.
 */
export class LoyaltyEngine {
  private config: LoyaltyConfig;

  constructor(customConfig?: LoyaltyConfigInput) {
    this.config = LoyaltyConfigSchema.parse(customConfig ?? DEFAULT_LOYALTY_CONFIG);
  }

  public getConfig(): LoyaltyConfig {
    return this.config;
  }

  public createAccount(userId: string, initialBalance = 0): LoyaltyAccount {
    return LoyaltyAccountSchema.parse({
      userId,
      balance: initialBalance,
      lifetimePoints: initialBalance,
      totalSpend: 0,
      tier: 'BRONZE',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  public determineTier(totalSpend: number): MemberTier {
    return determineMemberTier(totalSpend, this.config.tiers);
  }

  public calculateEarn(orderAmount: number, tier: MemberTier): number {
    return calculatePointsToEarn(orderAmount, tier, this.config);
  }

  public redeem(
    account: LoyaltyAccountInput,
    points: number,
    orderSubtotal: number
  ): LoyaltyRedeemResult {
    return calculateRedeemDiscount(account, points, orderSubtotal, this.config);
  }

  public processOrder(
    account: LoyaltyAccountInput,
    orderSubtotal: number,
    pointsToRedeem?: number
  ): LoyaltyTransactionResult {
    return processLoyaltyTransaction(account, {
      orderSubtotal,
      pointsToRedeem,
      config: this.config,
    });
  }

  public static determineMemberTier = determineMemberTier;
  public static calculatePointsToEarn = calculatePointsToEarn;
  public static calculateRedeemDiscount = calculateRedeemDiscount;
  public static processLoyaltyTransaction = processLoyaltyTransaction;
}
