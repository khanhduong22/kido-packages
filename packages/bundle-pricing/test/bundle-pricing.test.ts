import { describe, expect, it } from 'bun:test';
import {
  BundleTierConfigSchema,
  CartGoalProgressSchema,
  DEFAULT_FREE_SHIPPING_THRESHOLD,
  DEFAULT_PICKSHO_VARIANTS,
  PICKSHO_FLASH_LIGHT_TIERS,
  ScarcityStateSchema,
  VariantOption,
  VariantOptionSchema,
  VariantSlotAllocation,
  allocateVariantSlots,
  calculateBundlePricing,
  calculateCartGoal,
  calculateScarcityDecay,
  formatUsd,
  updateSlotVariant,
  validateSlotSelections,
} from '../src';

describe('@kido/bundle-pricing', () => {
  describe('Constants & Presets (PICKSHO_FLASH_LIGHT_TIERS)', () => {
    it('should have exactly 4 tiers for Picksho tactical flashlight', () => {
      expect(PICKSHO_FLASH_LIGHT_TIERS.length).toBe(4);
    });

    it('should configure Tier 1: Buy 1 at $24.99 with 31% discount', () => {
      const tier1 = PICKSHO_FLASH_LIGHT_TIERS[0];
      expect(tier1.id).toBe('picksho-tier-1');
      expect(tier1.quantity).toBe(1);
      expect(tier1.unitPrice).toBe(24.99);
      expect(tier1.compareAtUnitPrice).toBe(35.99);
      expect(tier1.discountPercent).toBe(31);
      expect(tier1.isDefault).toBe(false);
      expect(tier1.freeShippingEligible).toBe(false);
    });

    it('should configure Tier 2: Buy 2 at $19.99 with 44% discount', () => {
      const tier2 = PICKSHO_FLASH_LIGHT_TIERS[1];
      expect(tier2.id).toBe('picksho-tier-2');
      expect(tier2.quantity).toBe(2);
      expect(tier2.unitPrice).toBe(19.99);
      expect(tier2.compareAtUnitPrice).toBe(35.99);
      expect(tier2.discountPercent).toBe(44);
      expect(tier2.badgeText).toBe('BUY 2 GET 44% OFF');
    });

    it('should configure Tier 3: Buy 3 at $18.33 with 49% discount as BEST VALUE & default', () => {
      const tier3 = PICKSHO_FLASH_LIGHT_TIERS[2];
      expect(tier3.id).toBe('picksho-tier-3');
      expect(tier3.quantity).toBe(3);
      expect(tier3.unitPrice).toBe(18.33);
      expect(tier3.compareAtUnitPrice).toBe(35.99);
      expect(tier3.discountPercent).toBe(49);
      expect(tier3.badgeText).toBe('BEST VALUE');
      expect(tier3.isDefault).toBe(true);
    });

    it('should configure Tier 4: Buy 4 at $18.00 with 50% discount and STOCK UP & SAVE badge', () => {
      const tier4 = PICKSHO_FLASH_LIGHT_TIERS[3];
      expect(tier4.id).toBe('picksho-tier-4');
      expect(tier4.quantity).toBe(4);
      expect(tier4.unitPrice).toBe(18.0);
      expect(tier4.compareAtUnitPrice).toBe(35.99);
      expect(tier4.discountPercent).toBe(50);
      expect(tier4.badgeText).toBe('STOCK UP & SAVE');
      expect(tier4.freeShippingEligible).toBe(true);
    });

    it('should have standard military color variants', () => {
      expect(DEFAULT_PICKSHO_VARIANTS.length).toBe(4);
      const black = DEFAULT_PICKSHO_VARIANTS.find((v) => v.id === 'tactical-black');
      expect(black).toBeDefined();
      expect(black?.inStock).toBe(true);
    });
  });

  describe('calculateBundlePricing', () => {
    it('should calculate accurate economics for Tier 1', () => {
      const result = calculateBundlePricing(PICKSHO_FLASH_LIGHT_TIERS[0]);
      expect(result.tierId).toBe('picksho-tier-1');
      expect(result.quantity).toBe(1);
      expect(result.unitPrice).toBe(24.99);
      expect(result.totalPrice).toBe(24.99);
      expect(result.totalOriginalPrice).toBe(35.99);
      expect(result.totalSavings).toBe(11.0);
      expect(result.savingsPercent).toBe(31);
      expect(result.isFreeShipping).toBe(false);
      expect(result.slots.length).toBe(1);
    });

    it('should calculate accurate economics for Tier 2', () => {
      const result = calculateBundlePricing(PICKSHO_FLASH_LIGHT_TIERS[1]);
      expect(result.quantity).toBe(2);
      expect(result.unitPrice).toBe(19.99);
      expect(result.totalPrice).toBe(39.98);
      expect(result.totalOriginalPrice).toBe(71.98);
      expect(result.totalSavings).toBe(32.0);
      expect(result.savingsPercent).toBe(44);
      expect(result.slots.length).toBe(2);
    });

    it('should calculate accurate economics for Tier 3 (Best Value)', () => {
      const result = calculateBundlePricing(PICKSHO_FLASH_LIGHT_TIERS[2]);
      expect(result.quantity).toBe(3);
      expect(result.unitPrice).toBe(18.33);
      expect(result.totalPrice).toBe(54.99);
      expect(result.totalOriginalPrice).toBe(107.97);
      expect(result.totalSavings).toBe(52.98);
      expect(result.savingsPercent).toBe(49);
      expect(result.slots.length).toBe(3);
    });

    it('should calculate accurate economics for Tier 4 (50% OFF + Free Shipping)', () => {
      const result = calculateBundlePricing(PICKSHO_FLASH_LIGHT_TIERS[3]);
      expect(result.quantity).toBe(4);
      expect(result.unitPrice).toBe(18.0);
      expect(result.totalPrice).toBe(72.0);
      expect(result.totalOriginalPrice).toBe(143.96);
      expect(result.totalSavings).toBe(71.96);
      expect(result.savingsPercent).toBe(50);
      expect(result.isFreeShipping).toBe(true);
      expect(result.slots.length).toBe(4);
    });

    it('should auto-populate slots when availableVariants option is passed', () => {
      const result = calculateBundlePricing(PICKSHO_FLASH_LIGHT_TIERS[2], {
        availableVariants: [...DEFAULT_PICKSHO_VARIANTS],
        defaultVariantId: 'matte-silver',
      });
      expect(result.slots.length).toBe(3);
      for (const slot of result.slots) {
        expect(slot.selectedVariantId).toBe('matte-silver');
        expect(slot.availableOptions.length).toBe(4);
      }
    });

    it('should preserve explicitly passed slots', () => {
      const customSlots: VariantSlotAllocation[] = [
        { slotIndex: 1, selectedVariantId: 'tactical-black', availableOptions: [] },
        { slotIndex: 2, selectedVariantId: 'military-olive', availableOptions: [] },
      ];
      const result = calculateBundlePricing(PICKSHO_FLASH_LIGHT_TIERS[1], customSlots);
      expect(result.slots).toBe(customSlots);
      expect(result.slots[1].selectedVariantId).toBe('military-olive');
    });

    it('should trigger free shipping when subtotal reaches freeShippingThreshold', () => {
      const resultOver = calculateBundlePricing(PICKSHO_FLASH_LIGHT_TIERS[2], {
        freeShippingThreshold: 50.0, // 54.99 >= 50.0
      });
      expect(resultOver.isFreeShipping).toBe(true);

      const resultUnder = calculateBundlePricing(PICKSHO_FLASH_LIGHT_TIERS[1], {
        freeShippingThreshold: 50.0, // 39.98 < 50.0
      });
      expect(resultUnder.isFreeShipping).toBe(false);
    });

    it('should handle custom tier with 0 compareAt price without divide-by-zero errors', () => {
      const customTier = {
        id: 'tier-sample',
        name: 'Sample Pack',
        quantity: 1,
        unitPrice: 15.0,
        compareAtUnitPrice: 0,
        discountPercent: 0,
        freeShippingEligible: false,
      };
      const result = calculateBundlePricing(customTier);
      expect(result.totalPrice).toBe(15.0);
      expect(result.totalOriginalPrice).toBe(0);
      expect(result.totalSavings).toBe(0);
      expect(result.savingsPercent).toBe(0);
    });
  });

  describe('allocateVariantSlots', () => {
    it('should allocate N contiguous slots starting from index 1', () => {
      const slots = allocateVariantSlots(3, 'tactical-black', [...DEFAULT_PICKSHO_VARIANTS]);
      expect(slots.length).toBe(3);
      expect(slots[0].slotIndex).toBe(1);
      expect(slots[1].slotIndex).toBe(2);
      expect(slots[2].slotIndex).toBe(3);
      expect(slots[0].selectedVariantId).toBe('tactical-black');
      expect(slots[1].selectedVariantId).toBe('tactical-black');
      expect(slots[2].selectedVariantId).toBe('tactical-black');
    });

    it('should throw an error for quantity less than 1 or non-integer', () => {
      expect(() => allocateVariantSlots(0, 'tactical-black', [])).toThrow();
      expect(() => allocateVariantSlots(-2, 'tactical-black', [])).toThrow();
      expect(() => allocateVariantSlots(2.5, 'tactical-black', [])).toThrow();
    });
  });

  describe('updateSlotVariant', () => {
    const initialSlots = allocateVariantSlots(3, 'tactical-black', [...DEFAULT_PICKSHO_VARIANTS]);

    it('should update the specified slot immutably', () => {
      const updated = updateSlotVariant(initialSlots, 2, 'coyote-tan');
      expect(updated).not.toBe(initialSlots);
      expect(updated[1].selectedVariantId).toBe('coyote-tan');
      // Other slots remain untouched
      expect(updated[0].selectedVariantId).toBe('tactical-black');
      expect(updated[2].selectedVariantId).toBe('tactical-black');
      // Original array preserved
      expect(initialSlots[1].selectedVariantId).toBe('tactical-black');
    });

    it('should throw error if slotIndex does not exist', () => {
      expect(() => updateSlotVariant(initialSlots, 99, 'coyote-tan')).toThrow(
        /Slot index 99 not found/
      );
    });

    it('should throw error if variant does not exist in available options', () => {
      expect(() => updateSlotVariant(initialSlots, 1, 'non-existent-color')).toThrow(
        /not an available option/
      );
    });

    it('should throw error if variant is out of stock', () => {
      const variantsWithOOS: VariantOption[] = [
        { id: 'v-instock', name: 'In Stock Color', inStock: true },
        { id: 'v-oos', name: 'Out Of Stock Color', inStock: false },
      ];
      const slots = allocateVariantSlots(2, 'v-instock', variantsWithOOS);
      expect(() => updateSlotVariant(slots, 1, 'v-oos')).toThrow(/currently out of stock/);
    });
  });

  describe('validateSlotSelections', () => {
    it('should validate successfully for properly configured slots', () => {
      const slots = allocateVariantSlots(3, 'tactical-black', [...DEFAULT_PICKSHO_VARIANTS]);
      const validation = validateSlotSelections(slots);
      expect(validation.isValid).toBe(true);
      expect(validation.errors.length).toBe(0);
    });

    it('should reject empty slot array', () => {
      const validation = validateSlotSelections([]);
      expect(validation.isValid).toBe(false);
      expect(validation.errors[0]).toContain('cannot be empty');
    });

    it('should detect duplicate slot indices', () => {
      const malformedSlots: VariantSlotAllocation[] = [
        { slotIndex: 1, selectedVariantId: 'tactical-black', availableOptions: [] },
        { slotIndex: 1, selectedVariantId: 'matte-silver', availableOptions: [] },
      ];
      const validation = validateSlotSelections(malformedSlots);
      expect(validation.isValid).toBe(false);
      expect(validation.errors.some((e) => e.includes('Duplicate slot index'))).toBe(true);
    });

    it('should detect non-contiguous or missing slot indices', () => {
      const malformedSlots: VariantSlotAllocation[] = [
        { slotIndex: 1, selectedVariantId: 'tactical-black', availableOptions: [] },
        { slotIndex: 3, selectedVariantId: 'matte-silver', availableOptions: [] },
      ];
      const validation = validateSlotSelections(malformedSlots);
      expect(validation.isValid).toBe(false);
      expect(validation.errors.some((e) => e.includes('Missing slot index 2'))).toBe(true);
    });

    it('should detect empty selectedVariantId', () => {
      const invalidSlots: VariantSlotAllocation[] = [
        { slotIndex: 1, selectedVariantId: '', availableOptions: [] },
      ];
      const validation = validateSlotSelections(invalidSlots);
      expect(validation.isValid).toBe(false);
      expect(validation.errors.some((e) => e.includes('No variant selected'))).toBe(true);
    });

    it('should detect unlisted variant selection', () => {
      const invalidSlots: VariantSlotAllocation[] = [
        {
          slotIndex: 1,
          selectedVariantId: 'unknown-id',
          availableOptions: [...DEFAULT_PICKSHO_VARIANTS],
        },
      ];
      const validation = validateSlotSelections(invalidSlots);
      expect(validation.isValid).toBe(false);
      expect(validation.errors.some((e) => e.includes('does not exist in available options'))).toBe(
        true
      );
    });

    it('should detect out-of-stock variant selection', () => {
      const oosVariants: VariantOption[] = [
        { id: 'v1', name: 'Tactical Red', inStock: false },
      ];
      const slots: VariantSlotAllocation[] = [
        { slotIndex: 1, selectedVariantId: 'v1', availableOptions: oosVariants },
      ];
      const validation = validateSlotSelections(slots);
      expect(validation.isValid).toBe(false);
      expect(validation.errors.some((e) => e.includes('out of stock'))).toBe(true);
    });
  });

  describe('calculateCartGoal', () => {
    it('should compute goal progress at $0.00 subtotal', () => {
      const goal = calculateCartGoal(0, 80.0);
      expect(goal.targetAmount).toBe(80.0);
      expect(goal.currentAmount).toBe(0.0);
      expect(goal.remainingAmount).toBe(80.0);
      expect(goal.progressPercent).toBe(0);
      expect(goal.isUnlocked).toBe(false);
      expect(goal.motivationMessage).toContain('Add $80.00 to unlock');
    });

    it('should compute partial progress for Tier 3 subtotal ($54.99 vs $80)', () => {
      const goal = calculateCartGoal(54.99, 80.0);
      expect(goal.targetAmount).toBe(80.0);
      expect(goal.currentAmount).toBe(54.99);
      expect(goal.remainingAmount).toBe(25.01);
      expect(goal.progressPercent).toBe(68.7);
      expect(goal.isUnlocked).toBe(false);
      expect(goal.motivationMessage).toBe('Add $25.01 more to unlock FREE Shipping!');
    });

    it('should unlock when reaching exact threshold ($80.00)', () => {
      const goal = calculateCartGoal(80.0, 80.0);
      expect(goal.remainingAmount).toBe(0);
      expect(goal.progressPercent).toBe(100);
      expect(goal.isUnlocked).toBe(true);
      expect(goal.motivationMessage).toContain('Congratulations! You unlocked FREE Shipping');
    });

    it('should cap progress at 100% when exceeding threshold ($120.00)', () => {
      const goal = calculateCartGoal(120.0, 80.0);
      expect(goal.remainingAmount).toBe(0);
      expect(goal.progressPercent).toBe(100);
      expect(goal.isUnlocked).toBe(true);
    });

    it('should use default $80.00 threshold when parameter omitted', () => {
      const goal = calculateCartGoal(40.0);
      expect(goal.targetAmount).toBe(DEFAULT_FREE_SHIPPING_THRESHOLD);
      expect(goal.progressPercent).toBe(50);
    });
  });

  describe('calculateScarcityDecay', () => {
    it('should return initial state when elapsed time is 0', () => {
      const state = calculateScarcityDecay(50, 0, 1.5, 900);
      expect(state.initialStock).toBe(50);
      expect(state.remainingStock).toBe(50);
      expect(state.totalClaimedPercent).toBe(0);
      expect(state.timerSecondsRemaining).toBe(900);
      expect(state.isExpiringSoon).toBe(false);
    });

    it('should decay stock as time passes (e.g. 5 minutes at 1.5 items/min = 7 claimed)', () => {
      const state = calculateScarcityDecay(50, 300, 1.5, 900);
      // 5 min * 1.5 = 7.5 -> Math.floor = 7 claimed -> remaining 43
      expect(state.remainingStock).toBe(43);
      expect(state.totalClaimedPercent).toBe(14); // (50-43)/50 = 14%
      expect(state.timerSecondsRemaining).toBe(600);
      expect(state.isExpiringSoon).toBe(false);
    });

    it('should flag isExpiringSoon when timer has <= 180 seconds (3 minutes) remaining', () => {
      const state = calculateScarcityDecay(50, 750, 1.5, 900); // 150s left
      expect(state.timerSecondsRemaining).toBe(150);
      expect(state.isExpiringSoon).toBe(true);
    });

    it('should flag isExpiringSoon when remaining stock is <= 5', () => {
      const state = calculateScarcityDecay(10, 240, 1.5, 900); // 4 min * 1.5 = 6 claimed -> 4 left
      expect(state.remainingStock).toBe(4);
      expect(state.isExpiringSoon).toBe(true);
    });

    it('should retain at least 1 unit while timer is actively counting down', () => {
      // 10 initial stock with extreme decay rate
      const state = calculateScarcityDecay(10, 600, 10, 900);
      expect(state.remainingStock).toBe(1);
      expect(state.timerSecondsRemaining).toBe(300);
    });

    it('should allow stock to deplete to 0 when countdown has reached 0', () => {
      const state = calculateScarcityDecay(10, 950, 2, 900);
      expect(state.timerSecondsRemaining).toBe(0);
      expect(state.remainingStock).toBe(0);
      expect(state.totalClaimedPercent).toBe(100);
    });
  });

  describe('formatUsd', () => {
    it('should format standard prices correctly', () => {
      expect(formatUsd(24.99)).toBe('$24.99');
      expect(formatUsd(19.99)).toBe('$19.99');
      expect(formatUsd(80)).toBe('$80.00');
      expect(formatUsd(0)).toBe('$0.00');
    });

    it('should format large amounts with comma separators', () => {
      expect(formatUsd(1250)).toBe('$1,250.00');
      expect(formatUsd(1000000.5)).toBe('$1,000,000.50');
    });

    it('should format negative numbers correctly', () => {
      expect(formatUsd(-15.5)).toBe('-$15.50');
    });

    it('should handle NaN and non-finite values safely', () => {
      expect(formatUsd(NaN)).toBe('$0.00');
      expect(formatUsd(Infinity)).toBe('$0.00');
    });
  });

  describe('Zod Schemas Validation', () => {
    it('should parse valid BundleTierConfig', () => {
      const tier = PICKSHO_FLASH_LIGHT_TIERS[2];
      const parsed = BundleTierConfigSchema.parse(tier);
      expect(parsed.id).toBe(tier.id);
      expect(parsed.quantity).toBe(3);
    });

    it('should reject invalid BundleTierConfig (e.g. negative price or discount > 100)', () => {
      expect(() =>
        BundleTierConfigSchema.parse({
          id: 'bad-tier',
          name: 'Bad Tier',
          quantity: -1,
          discountPercent: 120,
          unitPrice: -5,
          compareAtUnitPrice: 10,
          freeShippingEligible: false,
        })
      ).toThrow();
    });

    it('should parse valid VariantOption', () => {
      const option = VariantOptionSchema.parse({
        id: 'v1',
        name: 'Black',
        hexColor: '#000000',
        inStock: true,
      });
      expect(option.name).toBe('Black');
    });

    it('should parse CartGoalProgress and ScarcityState schemas', () => {
      const goal = calculateCartGoal(50, 80);
      expect(() => CartGoalProgressSchema.parse(goal)).not.toThrow();

      const scarcity = calculateScarcityDecay(50, 100);
      expect(() => ScarcityStateSchema.parse(scarcity)).not.toThrow();
    });
  });
});
