# @kido/bundle-pricing

> **E-Commerce Tiered Bundle Pricing, Multi-Variant Slot Allocation, Cart Goal Unlocking & Urgency Scarcity Engine** (Engine tính toán giá combo, phân bổ slot chọn biến thể sản phẩm, thanh tiến trình mở khóa quà/freeship, và cơ chế khan hiếm khẩn cấp tối ưu tỷ lệ chuyển đổi cho SME Landing Page).

---

## 🌟 Key Features

1. **Tiered Bundle Economics (`calculateBundlePricing`)**
   - Automatically computes subtotal, compare-at retail price, cash savings, and exact discount percentage across multi-quantity tiers.
   - Built-in support for free shipping thresholds and tier-level perks.
   - Preserves high precision without floating-point drift.

2. **Multi-Variant Slot Allocation (`allocateVariantSlots`, `updateSlotVariant`, `validateSlotSelections`)**
   - Allocates 1..N independent customizable selection slots corresponding to the bundle tier quantity.
   - Enforces 1-based indexing (`slotIndex: 1..N`).
   - Immutable slot updates with out-of-stock and invalid option guards.
   - Strict validation preventing broken checkouts or invalid variant selections.

3. **Gamified Cart Goal Progress (`calculateCartGoal`)**
   - Calculates progress percentage and remaining spend required to unlock perks (e.g., $80 Free Shipping).
   - Generates motivating call-to-actions dynamically based on cart delta.

4. **FOMO & Urgency Scarcity Engine (`calculateScarcityDecay`)**
   - Real-time stock depletion model simulating active shopper claim rates.
   - Intelligent stock retention guard: keeps units available while promotion countdown has not expired.
   - Automated `isExpiringSoon` state trigger when stock drops below threshold or timer is under 3 minutes.

5. **Pre-configured High-Converting Presets (`PICKSHO_FLASH_LIGHT_TIERS`)**
   - Ready-to-use 4-tier configuration inspired by top-performing tactical flashlight landing pages:
     - **Buy 1 Flashlight**: $24.99 (31% OFF vs $35.99)
     - **Buy 2 Flashlights**: $19.99/ea (44% OFF vs $35.99, "BUY 2 GET 44% OFF")
     - **Buy 3 Flashlights**: $18.33/ea (49% OFF vs $35.99, "BEST VALUE" - Default)
     - **Buy 4 Flashlights**: $18.00/ea (50% OFF vs $35.99, "STOCK UP & SAVE", Free Shipping)

---

## 📦 Installation

```bash
pnpm add @kido/bundle-pricing
```

---

## 🚀 Quick Start

### 1. Bundle Pricing & Auto Slot Allocation

```typescript
import {
  calculateBundlePricing,
  PICKSHO_FLASH_LIGHT_TIERS,
  DEFAULT_PICKSHO_VARIANTS,
  formatUsd,
} from '@kido/bundle-pricing';

// Select the popular Tier 3 (Buy 3, $18.33 each)
const tier3 = PICKSHO_FLASH_LIGHT_TIERS.find((t) => t.isDefault)!;

const result = calculateBundlePricing(tier3, {
  availableVariants: DEFAULT_PICKSHO_VARIANTS,
  defaultVariantId: 'tactical-black',
  freeShippingThreshold: 80,
});

console.log(formatUsd(result.totalPrice)); // $54.99
console.log(formatUsd(result.totalSavings)); // $52.98
console.log(`${result.savingsPercent}% OFF`); // 49% OFF
console.log(result.slots.length); // 3 slots
```

### 2. Customizing Variant Slots

```typescript
import { updateSlotVariant, validateSlotSelections } from '@kido/bundle-pricing';

// Customer changes slot 2 to 'military-olive'
const updatedSlots = updateSlotVariant(result.slots, 2, 'military-olive');

const validation = validateSlotSelections(updatedSlots);
if (!validation.isValid) {
  console.error('Validation errors:', validation.errors);
}
```

### 3. Cart Goal & Free Shipping Progress

```typescript
import { calculateCartGoal } from '@kido/bundle-pricing';

const goal = calculateCartGoal(54.99, 80.0);
console.log(goal.progressPercent); // 68.7%
console.log(goal.remainingAmount); // 25.01
console.log(goal.motivationMessage); // "Add $25.01 more to unlock FREE Shipping!"
```

### 4. Urgency Scarcity & Countdown Decay

```typescript
import { calculateScarcityDecay } from '@kido/bundle-pricing';

// 8 minutes elapsed out of 15 minute timer
const scarcity = calculateScarcityDecay(50, 480, 1.5, 900);
console.log(scarcity.remainingStock); // 38 units left
console.log(scarcity.totalClaimedPercent); // 24% claimed
```

---

## 🧪 Testing

```bash
bun test test/bundle-pricing.test.ts
```
