import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  VoucherSchema,
  LoyaltyAccountSchema,
  MemberTierSchema,
  DiscountResultSchema,
  VoucherEngine,
  calculateVoucherDiscount,
  validateVoucher,
  LoyaltyEngine,
  determineMemberTier,
  calculatePointsToEarn,
  calculateRedeemDiscount,
  processLoyaltyTransaction,
  DEFAULT_LOYALTY_CONFIG,
} from './index';

describe('@kido/discount-loyalty test suite', () => {
  describe('Voucher & Coupon Engine', () => {
    it('should calculate percentage discount with max discount cap (20% max 50k)', () => {
      const voucher = VoucherSchema.parse({
        id: 'vouch-1',
        code: 'SALE20',
        name: 'Giảm 20% tối đa 50k',
        type: 'PERCENTAGE',
        value: 20, // 20%
        maxDiscountAmount: 50_000, // max 50k cap
        minOrderValue: 100_000,
      });

      // Case A: 200,000đ order -> 20% = 40,000đ (under cap)
      const resA = calculateVoucherDiscount(voucher, {
        items: [{ id: 'item-1', name: 'Burger', price: 100_000, quantity: 2 }],
      });

      assert.strictEqual(resA.isValid, true);
      assert.strictEqual(resA.subtotal, 200_000);
      assert.strictEqual(resA.discountAmount, 40_000);
      assert.strictEqual(resA.finalTotal, 160_000);

      // Case B: 500,000đ order -> 20% = 100,000đ -> capped at 50,000đ
      const resB = calculateVoucherDiscount(voucher, {
        items: [{ id: 'item-1', name: 'Party Set', price: 500_000, quantity: 1 }],
      });

      assert.strictEqual(resB.isValid, true);
      assert.strictEqual(resB.subtotal, 500_000);
      assert.strictEqual(resB.discountAmount, 50_000);
      assert.strictEqual(resB.finalTotal, 450_000);
    });

    it('should calculate fixed cash discount with minimum order value (-30k for order from 200k)', () => {
      const voucher = VoucherSchema.parse({
        id: 'vouch-2',
        code: 'MINUS30K',
        name: 'Giảm 30k cho đơn từ 200k',
        type: 'FIXED_AMOUNT',
        value: 30_000,
        minOrderValue: 200_000,
      });

      // Under minimum order value (150k < 200k) -> Invalid
      const resUnder = calculateVoucherDiscount(voucher, {
        items: [{ id: 'item-1', name: 'Combo 1', price: 150_000, quantity: 1 }],
      });
      assert.strictEqual(resUnder.isValid, false);
      assert.strictEqual(resUnder.discountAmount, 0);
      assert.strictEqual(resUnder.finalTotal, 150_000);
      assert.match(resUnder.reason ?? '', /minimum order value/i);

      // Meets minimum order value (250k >= 200k) -> Valid
      const resValid = calculateVoucherDiscount(voucher, {
        items: [{ id: 'item-1', name: 'Combo 2', price: 250_000, quantity: 1 }],
      });
      assert.strictEqual(resValid.isValid, true);
      assert.strictEqual(resValid.discountAmount, 30_000);
      assert.strictEqual(resValid.finalTotal, 220_000);
    });

    it('should validate conditions: date validity, usage limit, category filtering, and member tier', () => {
      const now = new Date('2026-09-30T12:00:00Z');

      // 1. Expired voucher
      const expiredVoucher = VoucherSchema.parse({
        id: 'vouch-exp',
        code: 'EXPIRED',
        name: 'Hết hạn',
        type: 'FIXED_AMOUNT',
        value: 10_000,
        validTo: new Date('2026-09-01T00:00:00Z'),
      });
      const resExpired = validateVoucher(expiredVoucher, {
        items: [{ id: 'i1', price: 100_000, quantity: 1 }],
        currentDate: now,
      });
      assert.strictEqual(resExpired.isValid, false);
      assert.match(resExpired.reason ?? '', /expired/i);

      // 2. Usage limit reached
      const limitVoucher = VoucherSchema.parse({
        id: 'vouch-lim',
        code: 'LIMITED',
        name: 'Hết lượt',
        type: 'FIXED_AMOUNT',
        value: 10_000,
        usageLimit: 10,
        usedCount: 10,
      });
      const resLimit = validateVoucher(limitVoucher, {
        items: [{ id: 'i1', price: 100_000, quantity: 1 }],
        currentDate: now,
      });
      assert.strictEqual(resLimit.isValid, false);
      assert.match(resLimit.reason ?? '', /usage limit reached/i);

      // 3. Category restriction
      const foodVoucher = VoucherSchema.parse({
        id: 'vouch-food',
        code: 'FOODONLY',
        name: 'Chỉ áp dụng đồ ăn',
        type: 'PERCENTAGE',
        value: 50,
        applicableCategories: ['CATEGORY_FOOD'],
      });

      // Cart with only DRINK items -> invalid
      const resDrink = calculateVoucherDiscount(foodVoucher, {
        items: [{ id: 'drink-1', price: 50_000, quantity: 2, categoryId: 'CATEGORY_DRINK' }],
      });
      assert.strictEqual(resDrink.isValid, false);

      // Cart with 1 FOOD (100k) and 1 DRINK (50k) -> 50% discount applies ONLY to FOOD
      const resMixed = calculateVoucherDiscount(foodVoucher, {
        items: [
          { id: 'food-1', price: 100_000, quantity: 1, categoryId: 'CATEGORY_FOOD' },
          { id: 'drink-1', price: 50_000, quantity: 1, categoryId: 'CATEGORY_DRINK' },
        ],
      });
      assert.strictEqual(resMixed.isValid, true);
      assert.strictEqual(resMixed.subtotal, 150_000);
      assert.strictEqual(resMixed.eligibleAmount, 100_000); // only food
      assert.strictEqual(resMixed.discountAmount, 50_000); // 50% of 100k
      assert.strictEqual(resMixed.finalTotal, 100_000);

      // 4. Minimum tier requirement
      const vipVoucher = VoucherSchema.parse({
        id: 'vouch-vip',
        code: 'VIPGOLD',
        name: 'Chỉ cho GOLD',
        type: 'FIXED_AMOUNT',
        value: 50_000,
        minTier: 'GOLD',
      });

      const resBronze = validateVoucher(vipVoucher, {
        items: [{ id: 'i1', price: 200_000, quantity: 1 }],
        userTier: 'BRONZE',
      });
      assert.strictEqual(resBronze.isValid, false);
      assert.match(resBronze.reason ?? '', /minimum tier GOLD/i);

      const resGold = validateVoucher(vipVoucher, {
        items: [{ id: 'i1', price: 200_000, quantity: 1 }],
        userTier: 'GOLD',
      });
      assert.strictEqual(resGold.isValid, true);
    });

    it('should support VoucherEngine manager class and normalize voucher codes', () => {
      const engine = new VoucherEngine([
        {
          id: 'v1',
          code: 'welcome',
          name: 'Welcome New User',
          type: 'FIXED_AMOUNT',
          value: 20_000,
        },
      ]);

      // Code normalized to uppercase
      assert.ok(engine.getVoucher('WELCOME'));
      assert.ok(engine.getVoucher('welcome'));

      const result = engine.applyVoucherCode('  welcome  ', {
        items: [{ id: 'i1', price: 50_000, quantity: 1 }],
      });
      assert.strictEqual(result.isValid, true);
      assert.strictEqual(result.discountAmount, 20_000);
      assert.strictEqual(result.finalTotal, 30_000);
    });
  });

  describe('Loyalty Points & Membership Tier Engine', () => {
    it('should calculate earn points based on earn rate (10k = 1 pt) and tier multipliers', () => {
      // BRONZE (multiplier 1.0x) -> 100,000đ = 10 points
      const bronzePts = calculatePointsToEarn(100_000, 'BRONZE');
      assert.strictEqual(bronzePts, 10);

      // SILVER (multiplier 1.2x) -> 100,000đ = 10 * 1.2 = 12 points
      const silverPts = calculatePointsToEarn(100_000, 'SILVER');
      assert.strictEqual(silverPts, 12);

      // GOLD (multiplier 1.5x) -> 100,000đ = 10 * 1.5 = 15 points
      const goldPts = calculatePointsToEarn(100_000, 'GOLD');
      assert.strictEqual(goldPts, 15);

      // DIAMOND (multiplier 2.0x) -> 100,000đ = 10 * 2.0 = 20 points
      const diamondPts = calculatePointsToEarn(100_000, 'DIAMOND');
      assert.strictEqual(diamondPts, 20);
    });

    it('should calculate point redemption (1 pt = 1,000đ) and enforce caps', () => {
      const account = LoyaltyAccountSchema.parse({
        userId: 'user-123',
        balance: 100, // 100 points
      });

      // Order 200,000đ. Redeem 50 points = 50,000đ (<= 50% cap = 100k)
      const res = calculateRedeemDiscount(account, 50, 200_000);
      assert.strictEqual(res.success, true);
      assert.strictEqual(res.pointsRedeemed, 50);
      assert.strictEqual(res.discountAmount, 50_000);
      assert.strictEqual(res.remainingBalance, 50);

      // Exceed balance check
      const resOver = calculateRedeemDiscount(account, 150, 200_000);
      assert.strictEqual(resOver.success, false);
      assert.match(resOver.reason ?? '', /insufficient/i);

      // 50% max order value cap: Order 60,000đ -> max redeem 50% = 30,000đ (30 points)
      const resCapped = calculateRedeemDiscount(account, 50, 60_000);
      assert.strictEqual(resCapped.success, true);
      assert.strictEqual(resCapped.pointsRedeemed, 30);
      assert.strictEqual(resCapped.discountAmount, 30_000);
      assert.strictEqual(resCapped.remainingBalance, 70);
    });

    it('should determine membership tiers accurately by cumulative spend', () => {
      assert.strictEqual(determineMemberTier(0), 'BRONZE');
      assert.strictEqual(determineMemberTier(1_999_999), 'BRONZE');
      assert.strictEqual(determineMemberTier(2_000_000), 'SILVER');
      assert.strictEqual(determineMemberTier(4_999_999), 'SILVER');
      assert.strictEqual(determineMemberTier(5_000_000), 'GOLD');
      assert.strictEqual(determineMemberTier(14_999_999), 'GOLD');
      assert.strictEqual(determineMemberTier(15_000_000), 'DIAMOND');
      assert.strictEqual(determineMemberTier(50_000_000), 'DIAMOND');
    });

    it('should process order transaction with auto-tier upgrade and accurate balances', () => {
      const loyalty = new LoyaltyEngine();
      const initialAccount = loyalty.createAccount('cust-001', 0);

      assert.strictEqual(initialAccount.tier, 'BRONZE');
      assert.strictEqual(initialAccount.totalSpend, 0);

      // Transaction 1: Customer spends 2,500,000đ
      // At BRONZE: earns 2,500,000 / 10,000 * 1.0 = 250 points
      // New total spend = 2,500,000đ >= 2,000,000đ -> Auto upgraded to SILVER!
      const tx1 = loyalty.processOrder(initialAccount, 2_500_000);

      assert.strictEqual(tx1.previousTier, 'BRONZE');
      assert.strictEqual(tx1.currentTier, 'SILVER');
      assert.strictEqual(tx1.tierUpgraded, true);
      assert.strictEqual(tx1.pointsEarned, 250);
      assert.strictEqual(tx1.account.balance, 250);
      assert.strictEqual(tx1.account.totalSpend, 2_500_000);

      // Transaction 2: Customer spends 3,000,000đ and redeems 50 points (50k)
      // Net spend = 2,950,000đ
      // At SILVER (1.2x): earns floor(2,950,000 / 10,000 * 1.2) = 295 * 1.2 = 354 points
      // Points balance: 250 - 50 + 354 = 554 points
      // Total spend: 2,500,000 + 2,950,000 = 5,450,000đ >= 5,000,000đ -> Auto upgraded to GOLD!
      const tx2 = loyalty.processOrder(tx1.account, 3_000_000, 50);

      assert.strictEqual(tx2.previousTier, 'SILVER');
      assert.strictEqual(tx2.currentTier, 'GOLD');
      assert.strictEqual(tx2.tierUpgraded, true);
      assert.strictEqual(tx2.pointsRedeemed, 50);
      assert.strictEqual(tx2.pointsDiscountAmount, 50_000);
      assert.strictEqual(tx2.pointsEarned, 354);
      assert.strictEqual(tx2.account.balance, 554);
      assert.strictEqual(tx2.account.totalSpend, 5_450_000);
    });

    it('should validate Zod schemas with type-safety', () => {
      // Validate MemberTier
      assert.strictEqual(MemberTierSchema.parse('DIAMOND'), 'DIAMOND');
      assert.throws(() => MemberTierSchema.parse('PLATINUM'));

      // Validate Voucher code uppercase transform and required fields
      const parsed = VoucherSchema.parse({
        id: '1',
        code: '   promo10   ',
        name: 'Promo 10%',
        type: 'PERCENTAGE',
        value: 10,
      });
      assert.strictEqual(parsed.code, 'PROMO10');

      // Validate DiscountResult
      const discountRes = DiscountResultSchema.parse({
        isValid: true,
        voucherCode: 'PROMO10',
        discountAmount: 10000,
        finalTotal: 90000,
        subtotal: 100000,
        eligibleAmount: 100000,
      });
      assert.strictEqual(discountRes.finalTotal, 90000);
    });
  });
});
