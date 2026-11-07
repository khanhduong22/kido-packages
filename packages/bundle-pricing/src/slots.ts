import type { SlotValidationResult, VariantOption, VariantSlotAllocation } from './types';

/**
 * Allocates 1..N customizable variant slots for a bundle quantity.
 * Each slot is initialized with the specified defaultVariantId and available variant options.
 *
 * @param quantity The bundle quantity (number of physical items to pick)
 * @param defaultVariantId The initial variant selected for every slot
 * @param availableVariants The list of all selectable variants
 * @returns Array of VariantSlotAllocation with 1-based indexing (1..N)
 */
export function allocateVariantSlots(
  quantity: number,
  defaultVariantId: string,
  availableVariants: VariantOption[] = []
): VariantSlotAllocation[] {
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new Error(`Invalid bundle quantity: ${quantity}. Quantity must be an integer >= 1.`);
  }

  const slots: VariantSlotAllocation[] = [];
  for (let i = 1; i <= quantity; i++) {
    slots.push({
      slotIndex: i,
      selectedVariantId: defaultVariantId,
      availableOptions: [...availableVariants],
    });
  }

  return slots;
}

/**
 * Immutably updates the selected variant for a specific slot index (1..N).
 * Throws an error if the slot does not exist, the variant is invalid, or the variant is out of stock.
 *
 * @param slots Current slot allocations
 * @param slotIndex Target slot index (1-based)
 * @param newVariantId New variant ID to assign
 * @returns Fresh copy of slots with the updated selection
 */
export function updateSlotVariant(
  slots: VariantSlotAllocation[],
  slotIndex: number,
  newVariantId: string
): VariantSlotAllocation[] {
  const targetSlot = slots.find((s) => s.slotIndex === slotIndex);
  if (!targetSlot) {
    throw new Error(`Slot index ${slotIndex} not found in allocations.`);
  }

  if (targetSlot.availableOptions.length > 0) {
    const option = targetSlot.availableOptions.find((opt) => opt.id === newVariantId);
    if (!option) {
      throw new Error(`Variant "${newVariantId}" is not an available option for slot ${slotIndex}.`);
    }
    if (!option.inStock) {
      throw new Error(`Variant "${option.name}" (${newVariantId}) is currently out of stock.`);
    }
  }

  return slots.map((s) => (s.slotIndex === slotIndex ? { ...s, selectedVariantId: newVariantId } : s));
}

/**
 * Validates whether all slot allocations are complete, valid, and in stock.
 *
 * @param slots The slot allocations to validate
 * @returns Validation result with boolean flag and descriptive error messages
 */
export function validateSlotSelections(slots: VariantSlotAllocation[]): SlotValidationResult {
  const errors: string[] = [];

  if (!Array.isArray(slots) || slots.length === 0) {
    return {
      isValid: false,
      errors: ['Slot allocations array cannot be empty.'],
    };
  }

  const seenIndices = new Set<number>();

  for (const slot of slots) {
    if (!Number.isInteger(slot.slotIndex) || slot.slotIndex < 1) {
      errors.push(`Invalid slot index "${slot.slotIndex}". Slot indices must be positive integers.`);
      continue;
    }

    if (seenIndices.has(slot.slotIndex)) {
      errors.push(`Duplicate slot index ${slot.slotIndex} detected.`);
    }
    seenIndices.add(slot.slotIndex);

    if (!slot.selectedVariantId || slot.selectedVariantId.trim() === '') {
      errors.push(`Slot ${slot.slotIndex}: No variant selected.`);
      continue;
    }

    if (slot.availableOptions && slot.availableOptions.length > 0) {
      const selectedOption = slot.availableOptions.find((opt) => opt.id === slot.selectedVariantId);
      if (!selectedOption) {
        errors.push(
          `Slot ${slot.slotIndex}: Selected variant "${slot.selectedVariantId}" does not exist in available options.`
        );
      } else if (!selectedOption.inStock) {
        errors.push(
          `Slot ${slot.slotIndex}: Selected variant "${selectedOption.name}" (${slot.selectedVariantId}) is out of stock.`
        );
      }
    }
  }

  // Verify contiguous 1..N indexing
  for (let i = 1; i <= slots.length; i++) {
    if (!seenIndices.has(i)) {
      errors.push(`Missing slot index ${i}. Slots must be numbered sequentially from 1 to ${slots.length}.`);
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}
