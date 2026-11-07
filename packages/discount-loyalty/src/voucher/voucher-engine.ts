import {
  CartItem,
  DiscountResult,
  DiscountResultSchema,
  MemberTier,
  OrderContext,
  OrderContextSchema,
  OrderContextInput,
  Voucher,
  VoucherInput,
  VoucherSchema,
} from '../types/schemas';

export const TIER_RANKS: Record<MemberTier, number> = {
  BRONZE: 0,
  SILVER: 1,
  GOLD: 2,
  DIAMOND: 3,
};

export interface VoucherValidationResult {
  isValid: boolean;
  reason?: string;
  eligibleAmount: number;
  subtotal: number;
}

/**
 * Validates whether a voucher can be applied to a given order context.
 */
export function validateVoucher(
  voucherInput: VoucherInput,
  contextInput: OrderContextInput
): VoucherValidationResult {
  const voucher = VoucherSchema.parse(voucherInput);
  const context = OrderContextSchema.parse(contextInput);

  const calculatedSubtotal = context.items.reduce(
    (acc, item) => acc + item.price * item.quantity,
    0
  );
  const subtotal = context.subtotal ?? calculatedSubtotal;

  if (!voucher.isActive) {
    return {
      isValid: false,
      reason: 'Voucher is not active',
      eligibleAmount: 0,
      subtotal,
    };
  }

  const now = context.currentDate ?? new Date();

  if (voucher.validFrom && now < voucher.validFrom) {
    return {
      isValid: false,
      reason: 'Voucher is not valid yet',
      eligibleAmount: 0,
      subtotal,
    };
  }

  if (voucher.validTo && now > voucher.validTo) {
    return {
      isValid: false,
      reason: 'Voucher has expired',
      eligibleAmount: 0,
      subtotal,
    };
  }

  if (voucher.usageLimit !== undefined && voucher.usedCount >= voucher.usageLimit) {
    return {
      isValid: false,
      reason: 'Voucher usage limit reached',
      eligibleAmount: 0,
      subtotal,
    };
  }

  if (voucher.minTier) {
    const userTier = context.userTier ?? 'BRONZE';
    const userRank = TIER_RANKS[userTier] ?? 0;
    const requiredRank = TIER_RANKS[voucher.minTier] ?? 0;

    if (userRank < requiredRank) {
      return {
        isValid: false,
        reason: `Voucher requires minimum tier ${voucher.minTier} (user is ${userTier})`,
        eligibleAmount: 0,
        subtotal,
      };
    }
  }

  let matchingItems: CartItem[] = context.items;

  if (voucher.applicableCategories && voucher.applicableCategories.length > 0) {
    const categories = new Set(voucher.applicableCategories);
    matchingItems = matchingItems.filter(
      (item) => item.categoryId && categories.has(item.categoryId)
    );
  }

  if (voucher.applicableItemIds && voucher.applicableItemIds.length > 0) {
    const itemIds = new Set(voucher.applicableItemIds);
    matchingItems = matchingItems.filter((item) => itemIds.has(item.id));
  }

  const eligibleAmount = matchingItems.reduce(
    (acc, item) => acc + item.price * item.quantity,
    0
  );

  if (matchingItems.length === 0 || eligibleAmount <= 0) {
    return {
      isValid: false,
      reason: 'No applicable items in the order for this voucher',
      eligibleAmount: 0,
      subtotal,
    };
  }

  const minOrder = voucher.minOrderValue ?? 0;
  if (subtotal < minOrder) {
    return {
      isValid: false,
      reason: `Order subtotal (${subtotal.toLocaleString()}đ) does not meet minimum order value of ${minOrder.toLocaleString()}đ`,
      eligibleAmount,
      subtotal,
    };
  }

  return {
    isValid: true,
    eligibleAmount,
    subtotal,
  };
}

/**
 * Calculates discount amount and final total for a voucher and order context.
 */
export function calculateVoucherDiscount(
  voucherInput: VoucherInput,
  contextInput: OrderContextInput
): DiscountResult {
  const voucher = VoucherSchema.parse(voucherInput);
  const validation = validateVoucher(voucher, contextInput);

  if (!validation.isValid) {
    return DiscountResultSchema.parse({
      isValid: false,
      voucherCode: voucher.code,
      discountAmount: 0,
      finalTotal: validation.subtotal,
      subtotal: validation.subtotal,
      eligibleAmount: 0,
      reason: validation.reason,
    });
  }

  let discountAmount = 0;

  if (voucher.type === 'PERCENTAGE') {
    const rawDiscount = Math.round(validation.eligibleAmount * (voucher.value / 100));
    discountAmount = voucher.maxDiscountAmount
      ? Math.min(rawDiscount, voucher.maxDiscountAmount)
      : rawDiscount;
  } else {
    // FIXED_AMOUNT
    discountAmount = Math.min(voucher.value, validation.eligibleAmount);
  }

  // Discount can never exceed order subtotal
  discountAmount = Math.min(discountAmount, validation.subtotal);
  const finalTotal = Math.max(0, validation.subtotal - discountAmount);

  return DiscountResultSchema.parse({
    isValid: true,
    voucherCode: voucher.code,
    discountAmount,
    finalTotal,
    subtotal: validation.subtotal,
    eligibleAmount: validation.eligibleAmount,
  });
}

/**
 * High-level VoucherEngine class for managing and applying vouchers.
 */
export class VoucherEngine {
  private voucherMap = new Map<string, Voucher>();

  constructor(initialVouchers?: VoucherInput[]) {
    if (initialVouchers) {
      for (const v of initialVouchers) {
        this.registerVoucher(v);
      }
    }
  }

  public registerVoucher(voucherInput: VoucherInput): Voucher {
    const parsed = VoucherSchema.parse(voucherInput);
    this.voucherMap.set(parsed.code, parsed);
    return parsed;
  }

  public getVoucher(code: string): Voucher | undefined {
    return this.voucherMap.get(code.trim().toUpperCase());
  }

  public applyVoucherCode(code: string, context: OrderContextInput): DiscountResult {
    const voucher = this.getVoucher(code);
    if (!voucher) {
      const calculatedSubtotal = context.items.reduce(
        (acc, item) => acc + item.price * item.quantity,
        0
      );
      const subtotal = context.subtotal ?? calculatedSubtotal;
      return DiscountResultSchema.parse({
        isValid: false,
        voucherCode: code.trim().toUpperCase(),
        discountAmount: 0,
        finalTotal: subtotal,
        subtotal,
        eligibleAmount: 0,
        reason: `Voucher code '${code}' not found`,
      });
    }

    return calculateVoucherDiscount(voucher, context);
  }

  public static validate = validateVoucher;
  public static calculateDiscount = calculateVoucherDiscount;
}
