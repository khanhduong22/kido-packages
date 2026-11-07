import {
  CommissionCalculation,
  CommissionTier,
  RevenueBreakdown,
} from './types';

export interface NetRevenueInput {
  orderId: string;
  referrerId: string;
  grossAmount: number;
  gatewayFeePercent?: number; // e.g. 2.5%
  gatewayFixedFee?: number; // e.g. 2000 VND
  discountAmount?: number; // e.g. 50,000 VND
  taxPercent?: number; // e.g. 8 or 10 for VAT
  taxAmount?: number;
  currency?: string;
  commissionRate?: number; // e.g. 10 for 10%
  tier?: CommissionTier;
  tiers?: CommissionTier[];
}

export class ReferralNetRevenueResolver {
  /**
   * Calculate pure net revenue deducting gateway fees, discounts, and taxes.
   */
  public static calculateNetRevenue(params: {
    grossAmount: number;
    gatewayFeePercent?: number;
    gatewayFixedFee?: number;
    discountAmount?: number;
    taxPercent?: number;
    taxAmount?: number;
  }): RevenueBreakdown {
    const gross = Math.max(0, params.grossAmount);
    const discount = Math.max(0, params.discountAmount || 0);

    // Amount subject to payment gateway fee
    const payableGross = Math.max(0, gross - discount);

    const feePercent = params.gatewayFeePercent || 0;
    const fixedFee = params.gatewayFixedFee || 0;
    const gatewayFee = Math.round(((payableGross * feePercent) / 100 + fixedFee) * 100) / 100;

    let tax = 0;
    if (params.taxAmount !== undefined) {
      tax = Math.max(0, params.taxAmount);
    } else if (params.taxPercent !== undefined && params.taxPercent > 0) {
      tax = Math.round(((payableGross * params.taxPercent) / 100) * 100) / 100;
    }

    // Net Revenue = Gross - Discount - Gateway Fee - Tax
    const netRevenue = Math.max(0, Math.round((payableGross - gatewayFee - tax) * 100) / 100);

    return {
      grossAmount: gross,
      discountAmount: discount,
      gatewayFee,
      taxAmount: tax,
      netRevenue,
    };
  }

  /**
   * Determine matching tier from a tiered commission ladder based on net revenue
   */
  public static resolveTier(
    netRevenue: number,
    tiers?: CommissionTier[]
  ): CommissionTier | undefined {
    if (!tiers || tiers.length === 0) return undefined;

    // Sort descending by minNetRevenue
    const sorted = [...tiers].sort((a, b) => (b.minNetRevenue || 0) - (a.minNetRevenue || 0));

    for (const tier of sorted) {
      if (netRevenue >= (tier.minNetRevenue || 0)) {
        return tier;
      }
    }

    return tiers[0];
  }

  /**
   * Resolve and calculate the exact commission payout based strictly on Net Revenue.
   */
  public static resolveCommission(input: NetRevenueInput): CommissionCalculation {
    if (input.grossAmount < 0) {
      throw new Error(`Gross amount cannot be negative: ${input.grossAmount}`);
    }

    const breakdown = this.calculateNetRevenue({
      grossAmount: input.grossAmount,
      gatewayFeePercent: input.gatewayFeePercent,
      gatewayFixedFee: input.gatewayFixedFee,
      discountAmount: input.discountAmount,
      taxPercent: input.taxPercent,
      taxAmount: input.taxAmount,
    });

    let effectiveRate = input.commissionRate ?? 10;
    let tierName: string | undefined;

    if (input.tier) {
      effectiveRate = input.tier.percentage;
      tierName = input.tier.name;
    } else if (input.tiers && input.tiers.length > 0) {
      const matchedTier = this.resolveTier(breakdown.netRevenue, input.tiers);
      if (matchedTier) {
        effectiveRate = matchedTier.percentage;
        tierName = matchedTier.name;
      }
    }

    if (effectiveRate < 0) {
      throw new Error(`Commission rate cannot be negative: ${effectiveRate}`);
    }

    const rawCommission = (breakdown.netRevenue * effectiveRate) / 100;
    const commissionAmount = Math.round(rawCommission * 100) / 100;

    return {
      orderId: input.orderId,
      referrerId: input.referrerId,
      grossAmount: input.grossAmount,
      breakdown,
      commissionRate: effectiveRate,
      commissionAmount,
      tierName,
      currency: (input.currency || 'VND').toUpperCase(),
    };
  }

  /**
   * Calculate multi-tier split commission (e.g. Direct Tier-1: 10%, Indirect Tier-2: 3%)
   */
  public static resolveMultiTierSplit(params: {
    orderId: string;
    grossAmount: number;
    currency?: string;
    gatewayFeePercent?: number;
    discountAmount?: number;
    taxPercent?: number;
    splits: Array<{
      referrerId: string;
      tierLevel: number;
      percentage: number;
    }>;
  }): {
    breakdown: RevenueBreakdown;
    splits: Array<CommissionCalculation & { tierLevel: number }>;
    totalCommissionPayout: number;
  } {
    const breakdown = this.calculateNetRevenue({
      grossAmount: params.grossAmount,
      gatewayFeePercent: params.gatewayFeePercent,
      discountAmount: params.discountAmount,
      taxPercent: params.taxPercent,
    });

    let totalPayout = 0;
    const splitsResult: Array<CommissionCalculation & { tierLevel: number }> = [];

    for (const s of params.splits) {
      const commAmount = Math.round(((breakdown.netRevenue * s.percentage) / 100) * 100) / 100;
      totalPayout += commAmount;

      splitsResult.push({
        orderId: params.orderId,
        referrerId: s.referrerId,
        grossAmount: params.grossAmount,
        breakdown,
        commissionRate: s.percentage,
        commissionAmount: commAmount,
        tierName: `Tier-${s.tierLevel}`,
        tierLevel: s.tierLevel,
        currency: (params.currency || 'VND').toUpperCase(),
      });
    }

    return {
      breakdown,
      splits: splitsResult,
      totalCommissionPayout: Math.round(totalPayout * 100) / 100,
    };
  }
}
