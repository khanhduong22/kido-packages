import { allocateVariantSlots } from './slots';
import type {
  BundleCalculationResult,
  BundleTierConfig,
  VariantOption,
  VariantSlotAllocation,
} from './types';

/**
 * Format any numeric value as standard USD currency format ($XX.XX or -$XX.XX)
 *
 * @param amount Numeric value to format
 * @returns Formatted USD string (e.g. "$24.99", "$1,250.00", "$0.00")
 */
export function formatUsd(amount: number): string {
  if (isNaN(amount) || !isFinite(amount)) {
    return '$0.00';
  }
  const isNegative = amount < 0;
  const absAmount = Math.abs(amount);
  const parts = absAmount.toFixed(2).split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const formatted = `$${parts.join('.')}`;
  return isNegative ? `-${formatted}` : formatted;
}

export interface BundlePricingOptions {
  /**
   * Pre-allocated slots. If not provided, slots will be auto-generated based on availableVariants.
   */
  slots?: VariantSlotAllocation[];
  /**
   * Available variant options to generate slots if slots are not explicitly passed.
   */
  availableVariants?: VariantOption[];
  /**
   * Default variant ID to preselect for each generated slot.
   */
  defaultVariantId?: string;
  /**
   * Free shipping cart subtotal threshold in USD. Defaults to 80.0 if not specified.
   */
  freeShippingThreshold?: number;
}

/**
 * Calculates end-to-end bundle economics, total discounts, savings, and variant slot states.
 *
 * @param tierConfig The tier configuration (quantity, unit price, compare-at price, discount %, etc.)
 * @param optionsOrSlots Optional array of allocated slots or options configuration
 * @returns Fully calculated bundle result
 */
export function calculateBundlePricing(
  tierConfig: BundleTierConfig,
  optionsOrSlots?: VariantSlotAllocation[] | BundlePricingOptions
): BundleCalculationResult {
  const options: BundlePricingOptions = Array.isArray(optionsOrSlots)
    ? { slots: optionsOrSlots }
    : optionsOrSlots || {};

  const quantity = tierConfig.quantity;
  const unitPrice = tierConfig.unitPrice;
  const totalPrice = Math.round(unitPrice * quantity * 100) / 100;
  const totalOriginalPrice = Math.round(tierConfig.compareAtUnitPrice * quantity * 100) / 100;
  const totalSavings = Math.max(0, Math.round((totalOriginalPrice - totalPrice) * 100) / 100);

  const savingsPercent =
    totalOriginalPrice > 0
      ? Math.round(((totalOriginalPrice - totalPrice) / totalOriginalPrice) * 100)
      : tierConfig.discountPercent;

  const isFreeShipping = Boolean(
    tierConfig.freeShippingEligible ||
      (options.freeShippingThreshold !== undefined && totalPrice >= options.freeShippingThreshold)
  );

  let slots: VariantSlotAllocation[];
  if (options.slots && options.slots.length > 0) {
    slots = options.slots;
  } else if (options.availableVariants && options.availableVariants.length > 0) {
    const defaultId =
      options.defaultVariantId ||
      options.availableVariants.find((v) => v.inStock)?.id ||
      options.availableVariants[0].id;
    slots = allocateVariantSlots(quantity, defaultId, options.availableVariants);
  } else {
    slots = Array.from({ length: quantity }, (_, idx) => ({
      slotIndex: idx + 1,
      selectedVariantId: options.defaultVariantId || 'default',
      availableOptions: [],
    }));
  }

  return {
    tierId: tierConfig.id,
    quantity,
    unitPrice,
    totalOriginalPrice,
    totalPrice,
    totalSavings,
    savingsPercent,
    slots,
    isFreeShipping,
  };
}
