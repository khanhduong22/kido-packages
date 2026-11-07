import { z } from 'zod';

export const MemberTierSchema = z.enum(['BRONZE', 'SILVER', 'GOLD', 'DIAMOND']);
export type MemberTier = z.infer<typeof MemberTierSchema>;

export const VoucherTypeSchema = z.enum(['PERCENTAGE', 'FIXED_AMOUNT']);
export type VoucherType = z.infer<typeof VoucherTypeSchema>;

export const CartItemSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  price: z.number().nonnegative(),
  quantity: z.number().int().positive(),
  categoryId: z.string().optional(),
});
export type CartItem = z.infer<typeof CartItemSchema>;

export const VoucherSchema = z.object({
  id: z.string(),
  code: z
    .string()
    .min(1)
    .transform((val) => val.trim().toUpperCase()),
  name: z.string(),
  description: z.string().optional(),
  type: VoucherTypeSchema,
  value: z.number().positive(),
  maxDiscountAmount: z.number().positive().optional(),
  minOrderValue: z.number().nonnegative().optional().default(0),
  validFrom: z.coerce.date().optional(),
  validTo: z.coerce.date().optional(),
  usageLimit: z.number().int().positive().optional(),
  usedCount: z.number().int().nonnegative().default(0),
  applicableCategories: z.array(z.string()).optional(),
  applicableItemIds: z.array(z.string()).optional(),
  minTier: MemberTierSchema.optional(),
  isActive: z.boolean().default(true),
});
export type Voucher = z.infer<typeof VoucherSchema>;
export type VoucherInput = z.input<typeof VoucherSchema>;

export const OrderContextSchema = z.object({
  items: z.array(CartItemSchema),
  subtotal: z.number().nonnegative().optional(),
  userTier: MemberTierSchema.optional(),
  userId: z.string().optional(),
  currentDate: z.coerce.date().optional(),
});
export type OrderContext = z.infer<typeof OrderContextSchema>;
export type OrderContextInput = z.input<typeof OrderContextSchema>;

export const DiscountResultSchema = z.object({
  isValid: z.boolean(),
  voucherCode: z.string(),
  discountAmount: z.number().nonnegative(),
  finalTotal: z.number().nonnegative(),
  subtotal: z.number().nonnegative(),
  eligibleAmount: z.number().nonnegative(),
  reason: z.string().optional(),
});
export type DiscountResult = z.infer<typeof DiscountResultSchema>;

export const TierConfigSchema = z.object({
  tier: MemberTierSchema,
  minSpend: z.number().nonnegative(),
  pointMultiplier: z.number().positive().default(1.0),
  tierDiscountPercent: z.number().min(0).max(100).default(0),
  name: z.string().optional(),
});
export type TierConfig = z.infer<typeof TierConfigSchema>;

export const LoyaltyConfigSchema = z.object({
  earnRate: z.number().positive().default(10000), // e.g. 10,000 VND = 1 point
  redeemRate: z.number().positive().default(1000), // e.g. 1 point = 1,000 VND
  minRedeemPoints: z.number().int().nonnegative().default(10),
  maxRedeemPercentPerOrder: z.number().min(0).max(100).default(50),
  tiers: z.array(TierConfigSchema).optional(),
});
export type LoyaltyConfig = z.infer<typeof LoyaltyConfigSchema>;
export type LoyaltyConfigInput = z.input<typeof LoyaltyConfigSchema>;

export const LoyaltyAccountSchema = z.object({
  userId: z.string(),
  balance: z.number().int().nonnegative().default(0),
  lifetimePoints: z.number().int().nonnegative().default(0),
  totalSpend: z.number().nonnegative().default(0),
  tier: MemberTierSchema.default('BRONZE'),
  createdAt: z.coerce.date().optional(),
  updatedAt: z.coerce.date().optional(),
});
export type LoyaltyAccount = z.infer<typeof LoyaltyAccountSchema>;
export type LoyaltyAccountInput = z.input<typeof LoyaltyAccountSchema>;

export const LoyaltyRedeemResultSchema = z.object({
  success: z.boolean(),
  pointsRedeemed: z.number().int().nonnegative(),
  discountAmount: z.number().nonnegative(),
  remainingBalance: z.number().int().nonnegative(),
  reason: z.string().optional(),
});
export type LoyaltyRedeemResult = z.infer<typeof LoyaltyRedeemResultSchema>;

export const LoyaltyTransactionResultSchema = z.object({
  account: LoyaltyAccountSchema,
  pointsEarned: z.number().int().nonnegative(),
  pointsRedeemed: z.number().int().nonnegative(),
  pointsDiscountAmount: z.number().nonnegative(),
  previousTier: MemberTierSchema,
  currentTier: MemberTierSchema,
  tierUpgraded: z.boolean(),
});
export type LoyaltyTransactionResult = z.infer<typeof LoyaltyTransactionResultSchema>;
