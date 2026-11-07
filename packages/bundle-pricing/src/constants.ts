import type { BundleTierConfig, VariantOption } from './types';

/**
 * Standard Picksho 4-Tier Flashlight Bundle Configuration:
 * - 1 Flashlight: $24.99 each (31% OFF vs $35.99)
 * - 2 Flashlights: $19.99 each (44% OFF vs $35.99)
 * - 3 Flashlights: $18.33 each (49% OFF vs $35.99, BEST VALUE)
 * - 4 Flashlights: $18.00 each (50% OFF vs $35.99, STOCK UP & SAVE, FREE Shipping)
 */
export const PICKSHO_FLASH_LIGHT_TIERS: readonly BundleTierConfig[] = [
  {
    id: 'picksho-tier-1',
    name: 'Buy 1 Flashlight',
    quantity: 1,
    unitPrice: 24.99,
    compareAtUnitPrice: 35.99,
    discountPercent: 31,
    badgeText: undefined,
    isDefault: false,
    freeShippingEligible: false,
  },
  {
    id: 'picksho-tier-2',
    name: 'Buy 2 Flashlights',
    quantity: 2,
    unitPrice: 19.99,
    compareAtUnitPrice: 35.99,
    discountPercent: 44,
    badgeText: 'BUY 2 GET 44% OFF',
    isDefault: false,
    freeShippingEligible: false,
  },
  {
    id: 'picksho-tier-3',
    name: 'Buy 3 Flashlights',
    quantity: 3,
    unitPrice: 18.33,
    compareAtUnitPrice: 35.99,
    discountPercent: 49,
    badgeText: 'BEST VALUE',
    isDefault: true,
    freeShippingEligible: false,
  },
  {
    id: 'picksho-tier-4',
    name: 'Buy 4 Flashlights',
    quantity: 4,
    unitPrice: 18.00,
    compareAtUnitPrice: 35.99,
    discountPercent: 50,
    badgeText: 'STOCK UP & SAVE',
    isDefault: false,
    freeShippingEligible: true,
  },
] as const;

/**
 * High-grade tactical flashlight color variants for Picksho bundle
 */
export const DEFAULT_PICKSHO_VARIANTS: readonly VariantOption[] = [
  {
    id: 'tactical-black',
    name: 'Tactical Black',
    hexColor: '#1F2937',
    inStock: true,
  },
  {
    id: 'matte-silver',
    name: 'Matte Titanium Silver',
    hexColor: '#9CA3AF',
    inStock: true,
  },
  {
    id: 'military-olive',
    name: 'Military Olive Green',
    hexColor: '#4B5320',
    inStock: true,
  },
  {
    id: 'coyote-tan',
    name: 'Coyote Desert Tan',
    hexColor: '#C2B280',
    inStock: true,
  },
] as const;

/**
 * Default Free Shipping & Cart Goal Threshold in USD
 */
export const DEFAULT_FREE_SHIPPING_THRESHOLD = 80.0;
