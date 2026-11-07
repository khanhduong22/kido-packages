import { z } from 'zod';

export const VariantOptionSchema = z.object({
  id: z.string().min(1, 'Variant ID is required'),
  name: z.string().min(1, 'Variant name is required'),
  hexColor: z.string().optional(),
  inStock: z.boolean().default(true),
});
export type VariantOption = z.infer<typeof VariantOptionSchema>;

export const VariantSlotAllocationSchema = z.object({
  slotIndex: z.number().int().positive('Slot index must be 1..N'),
  selectedVariantId: z.string().min(1, 'Selected variant ID is required'),
  availableOptions: z.array(VariantOptionSchema),
});
export type VariantSlotAllocation = z.infer<typeof VariantSlotAllocationSchema>;

export const BundleTierConfigSchema = z.object({
  id: z.string().min(1, 'Tier ID is required'),
  name: z.string().min(1, 'Tier name is required'),
  quantity: z.number().int().positive('Quantity must be positive'),
  discountPercent: z.number().min(0).max(100, 'Discount percent must be between 0 and 100'),
  unitPrice: z.number().nonnegative('Unit price must be non-negative'),
  compareAtUnitPrice: z.number().nonnegative('Compare-at unit price must be non-negative'),
  badgeText: z.string().optional(),
  isDefault: z.boolean().optional(),
  freeShippingEligible: z.boolean().default(false),
});
export type BundleTierConfig = z.infer<typeof BundleTierConfigSchema>;

export const BundleCalculationResultSchema = z.object({
  tierId: z.string(),
  quantity: z.number().int().positive(),
  unitPrice: z.number().nonnegative(),
  totalOriginalPrice: z.number().nonnegative(),
  totalPrice: z.number().nonnegative(),
  totalSavings: z.number().nonnegative(),
  savingsPercent: z.number().min(0).max(100),
  slots: z.array(VariantSlotAllocationSchema),
  isFreeShipping: z.boolean(),
});
export type BundleCalculationResult = z.infer<typeof BundleCalculationResultSchema>;

export const CartGoalProgressSchema = z.object({
  targetAmount: z.number().positive(),
  currentAmount: z.number().nonnegative(),
  remainingAmount: z.number().nonnegative(),
  progressPercent: z.number().min(0).max(100),
  isUnlocked: z.boolean(),
  motivationMessage: z.string(),
});
export type CartGoalProgress = z.infer<typeof CartGoalProgressSchema>;

export const ScarcityStateSchema = z.object({
  remainingStock: z.number().int().nonnegative(),
  initialStock: z.number().int().positive(),
  totalClaimedPercent: z.number().min(0).max(100),
  timerSecondsRemaining: z.number().int().nonnegative(),
  isExpiringSoon: z.boolean(),
});
export type ScarcityState = z.infer<typeof ScarcityStateSchema>;

export interface SlotValidationResult {
  isValid: boolean;
  errors: string[];
}
