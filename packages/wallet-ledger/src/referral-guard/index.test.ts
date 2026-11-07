import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  ReferralFraudGuard,
  ReferralNetRevenueResolver,
  ReferralClawbackManager,
  ReferrerLoginHistory,
  ReferralRegistration,
} from './index';

describe('@kido/referral-guard Test Suite', () => {
  // -------------------------------------------------------------
  // Group 1: ReferralFraudGuard & Anti-Fraud Detection
  // -------------------------------------------------------------
  describe('1. ReferralFraudGuard', () => {
    let guard: ReferralFraudGuard;

    const baseReferrerHistory: ReferrerLoginHistory = {
      referrerId: 'ref_user_01',
      loginIps: [
        { ip: '14.161.22.45', timestamp: Date.now() - 2 * 86400000 },
        { ip: '118.69.182.10', timestamp: Date.now() - 15 * 86400000 },
      ],
      knownFingerprints: ['fp_macbook_user_01'],
    };

    beforeEach(() => {
      guard = new ReferralFraudGuard({
        maxRegistrationsPerHour: 3,
        maxRegistrationsPerDay: 10,
        lookbackDays: 30,
      });
    });

    it('1.1 should detect self-referral when referee IP exactly matches referrer login history', () => {
      const reg: ReferralRegistration = {
        referralCode: 'REF_TEST',
        referrerId: 'ref_user_01',
        refereeId: 'referee_clone',
        refereeEmail: 'clean.user@company.com',
        ipAddress: '14.161.22.45', // Exact match with referrer IP
      };

      const result = guard.evaluateRegistration(reg, baseReferrerHistory);

      assert.strictEqual(result.isAllowed, false);
      assert.strictEqual(result.action, 'BLOCK');
      assert.ok(result.reasons.includes('EXACT_IP_MATCH_WITH_REFERRER'));
      assert.strictEqual(result.details.matchedIp, '14.161.22.45');
      assert.ok(result.riskScore >= 70);
    });

    it('1.2 should detect suspicious subnet match (/24) within same local network', () => {
      const reg: ReferralRegistration = {
        referralCode: 'REF_TEST',
        referrerId: 'ref_user_01',
        refereeId: 'referee_neighbor',
        refereeEmail: 'legit.worker@company.com',
        ipAddress: '14.161.22.88', // Same /24 subnet as 14.161.22.45
      };

      const result = guard.evaluateRegistration(reg, baseReferrerHistory);

      assert.ok(result.reasons.includes('SUBNET_MATCH_WITH_REFERRER'));
      assert.strictEqual(result.details.matchedSubnet, '14.161.22.45');
      assert.ok(result.riskScore >= 35);
    });

    it('1.3 should block disposable / temporary email domains', () => {
      const reg: ReferralRegistration = {
        referralCode: 'REF_TEST',
        referrerId: 'ref_user_01',
        refereeId: 'referee_temp',
        refereeEmail: 'spammer123@mailinator.com',
        ipAddress: '203.113.152.1', // Non-matching IP
      };

      const result = guard.evaluateRegistration(reg, baseReferrerHistory);

      assert.strictEqual(result.isAllowed, false);
      assert.strictEqual(result.action, 'BLOCK');
      assert.ok(result.reasons.includes('DISPOSABLE_EMAIL_DOMAIN'));
    });

    it('1.4 should detect Gmail +alias tricks and normalize email', () => {
      const email = 'My.Name+affiliateBonus1@gmail.com';
      const { normalized, isAliased } = guard.normalizeEmail(email);

      assert.strictEqual(normalized, 'myname@gmail.com');
      assert.strictEqual(isAliased, true);

      const reg: ReferralRegistration = {
        referralCode: 'REF_TEST',
        referrerId: 'ref_user_01',
        refereeId: 'referee_alias',
        refereeEmail: email,
        ipAddress: '203.113.152.1',
      };

      const result = guard.evaluateRegistration(reg, baseReferrerHistory);
      assert.ok(result.reasons.includes('GMAIL_ALIAS_ABUSE'));
      assert.strictEqual(result.details.normalizedEmail, 'myname@gmail.com');
    });

    it('1.5 should flag velocity limit when registrations exceed hourly threshold', () => {
      const cleanIp = '172.56.21.99';
      const makeReg = (idx: number): ReferralRegistration => ({
        referralCode: 'REF_TEST',
        referrerId: 'ref_user_01',
        refereeId: `referee_${idx}`,
        refereeEmail: `user${idx}@realdomain.vn`,
        ipAddress: cleanIp,
        timestamp: Date.now(),
      });

      // Max hourly is 3. Record 3 successful registrations
      guard.recordSuccessfulRegistration(makeReg(1));
      guard.recordSuccessfulRegistration(makeReg(2));
      guard.recordSuccessfulRegistration(makeReg(3));

      // 4th registration should trigger velocity limit
      const result = guard.evaluateRegistration(makeReg(4), baseReferrerHistory);
      assert.ok(result.reasons.includes('VELOCITY_LIMIT_EXCEEDED_HOURLY'));
      assert.ok(result.riskScore >= 40);
    });

    it('1.6 should allow legitimate clean registration with zero risk score', () => {
      const reg: ReferralRegistration = {
        referralCode: 'REF_TEST',
        referrerId: 'ref_user_01',
        refereeId: 'referee_clean',
        refereeEmail: 'nguyenvana@gmail.com',
        ipAddress: '203.162.0.100', // Unique IP
      };

      const result = guard.evaluateRegistration(reg, baseReferrerHistory);

      assert.strictEqual(result.isAllowed, true);
      assert.strictEqual(result.action, 'ALLOW');
      assert.strictEqual(result.riskScore, 0);
      assert.strictEqual(result.reasons.length, 0);
    });
  });

  // -------------------------------------------------------------
  // Group 2: ReferralNetRevenueResolver & Commission Calculations
  // -------------------------------------------------------------
  describe('2. ReferralNetRevenueResolver', () => {
    it('2.1 should deduct gateway fee, discount, and tax to calculate accurate net revenue', () => {
      // Gross: 1,000,000 VND
      // Discount: 100,000 VND -> Payable = 900,000 VND
      // Gateway Fee 2.5% on 900,000 = 22,500 VND
      // Tax VAT 8% on 900,000 = 72,000 VND
      // Net Revenue = 900,000 - 22,500 - 72,000 = 805,500 VND
      const breakdown = ReferralNetRevenueResolver.calculateNetRevenue({
        grossAmount: 1_000_000,
        discountAmount: 100_000,
        gatewayFeePercent: 2.5,
        taxPercent: 8,
      });

      assert.strictEqual(breakdown.grossAmount, 1_000_000);
      assert.strictEqual(breakdown.discountAmount, 100_000);
      assert.strictEqual(breakdown.gatewayFee, 22_500);
      assert.strictEqual(breakdown.taxAmount, 72_000);
      assert.strictEqual(breakdown.netRevenue, 805_500);
    });

    it('2.2 should resolve commission on net revenue rather than gross', () => {
      const calculation = ReferralNetRevenueResolver.resolveCommission({
        orderId: 'ORD_100',
        referrerId: 'ref_01',
        grossAmount: 2_000_000,
        discountAmount: 200_000,
        gatewayFeePercent: 2.5,
        taxPercent: 8,
        commissionRate: 10, // 10%
        currency: 'VND',
      });

      // Payable: 1,800,000
      // Fee (2.5%): 45,000
      // Tax (8%): 144,000
      // Net: 1,611,000
      // Commission 10% on Net = 161,100 (instead of 200,000 on gross!)
      assert.strictEqual(calculation.breakdown.netRevenue, 1_611_000);
      assert.strictEqual(calculation.commissionAmount, 161_100);
      assert.strictEqual(calculation.commissionRate, 10);
      assert.strictEqual(calculation.currency, 'VND');
    });

    it('2.3 should resolve commission using tiered volume ladder', () => {
      const tiers = [
        { tierId: 'T1', name: 'Bronze', percentage: 10, minNetRevenue: 0 },
        { tierId: 'T2', name: 'Silver', percentage: 15, minNetRevenue: 1_000_000 },
        { tierId: 'T3', name: 'Gold', percentage: 20, minNetRevenue: 5_000_000 },
      ];

      // Net revenue ~ 2,000,000 -> Should match Silver tier (15%)
      const calc = ReferralNetRevenueResolver.resolveCommission({
        orderId: 'ORD_200',
        referrerId: 'ref_02',
        grossAmount: 2_000_000,
        tiers,
      });

      assert.strictEqual(calc.tierName, 'Silver');
      assert.strictEqual(calc.commissionRate, 15);
      assert.strictEqual(calc.commissionAmount, 300_000);
    });

    it('2.4 should resolve multi-tier split commission for direct and parent affiliates', () => {
      const result = ReferralNetRevenueResolver.resolveMultiTierSplit({
        orderId: 'ORD_SPLIT',
        grossAmount: 1_000_000,
        gatewayFeePercent: 2.0,
        taxPercent: 10,
        splits: [
          { referrerId: 'ref_direct_tier1', tierLevel: 1, percentage: 12 },
          { referrerId: 'ref_parent_tier2', tierLevel: 2, percentage: 3 },
        ],
      });

      // Net revenue = 1,000,000 - 20,000 (fee) - 100,000 (tax) = 880,000
      assert.strictEqual(result.breakdown.netRevenue, 880_000);
      assert.strictEqual(result.splits.length, 2);

      // Tier 1: 12% of 880,000 = 105,600
      assert.strictEqual(result.splits[0].commissionAmount, 105_600);
      // Tier 2: 3% of 880,000 = 26,400
      assert.strictEqual(result.splits[1].commissionAmount, 26_400);

      assert.strictEqual(result.totalCommissionPayout, 132_000);
    });
  });

  // -------------------------------------------------------------
  // Group 3: ReferralClawbackManager & Hold Window
  // -------------------------------------------------------------
  describe('3. ReferralClawbackManager', () => {
    let clawback: ReferralClawbackManager;

    beforeEach(() => {
      clawback = new ReferralClawbackManager();
    });

    it('3.1 should create pending reward with accurate holdUntil timestamp', () => {
      const now = 1700000000000;
      const holdDays = 14;

      const reward = clawback.createPendingReward({
        orderId: 'ORD_HOLD_1',
        referrerId: 'ref_usr_01',
        amount: 250_000,
        currency: 'VND',
        holdDays,
        createdAt: now,
      });

      assert.strictEqual(reward.status, 'PENDING_HOLD');
      assert.strictEqual(reward.amount, 250_000);
      assert.strictEqual(reward.holdDays, 14);
      assert.strictEqual(reward.holdUntil, now + 14 * 24 * 60 * 60 * 1000);
    });

    it('3.2 should identify clearable rewards when hold period elapses', () => {
      const now = 1700000000000;
      const reward = clawback.createPendingReward({
        orderId: 'ORD_HOLD_2',
        referrerId: 'ref_usr_01',
        amount: 150_000,
        holdDays: 14,
        createdAt: now,
      });

      // Before 14 days
      const clearableBefore = clawback.getClearableRewards(now + 10 * 86400000);
      assert.strictEqual(clearableBefore.length, 0);

      // After 15 days
      const clearableAfter = clawback.getClearableRewards(now + 15 * 86400000);
      assert.strictEqual(clearableAfter.length, 1);
      assert.strictEqual(clearableAfter[0].rewardId, reward.rewardId);

      // Clear the reward
      const cleared = clawback.clearReward(reward.rewardId, now + 15 * 86400000);
      assert.strictEqual(cleared.status, 'CLEARED');
    });

    it('3.3 should cancel pending reward when customer refunds during hold window', async () => {
      clawback.createPendingReward({
        orderId: 'ORD_REFUND_HOLD',
        referrerId: 'ref_usr_02',
        amount: 300_000,
        holdDays: 14,
      });

      const results = await clawback.processClawback({
        orderId: 'ORD_REFUND_HOLD',
        reason: 'Customer requested refund within 7-day money-back guarantee',
      });

      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].success, true);
      assert.strictEqual(results[0].action, 'CANCELLED_PENDING');
      assert.strictEqual(results[0].amount, 300_000);

      const updated = clawback.getRewardsByOrderId('ORD_REFUND_HOLD')[0];
      assert.strictEqual(updated.status, 'CANCELLED_CLAWBACK');
      assert.ok(updated.clawedBackAt !== undefined);
    });

    it('3.4 should trigger Earn wallet debit when refund occurs after commission clearance', async () => {
      const reward = clawback.createPendingReward({
        orderId: 'ORD_CLEARED_REFUND',
        referrerId: 'ref_usr_03',
        amount: 450_000,
        holdDays: 14,
      });

      // Manually clear reward as if 14 days passed
      clawback.clearReward(reward.rewardId);

      let debitedWalletUser: string | null = null;
      let debitedAmount: number = 0;

      const results = await clawback.processClawback({
        orderId: 'ORD_CLEARED_REFUND',
        reason: 'Credit card chargeback disputed by bank',
        earnWalletDebitor: (referrerId, amount) => {
          debitedWalletUser = referrerId;
          debitedAmount = amount;
          return true; // debit succeeded
        },
      });

      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].success, true);
      assert.strictEqual(results[0].action, 'DEBITED_EARN_WALLET');
      assert.strictEqual(debitedWalletUser, 'ref_usr_03');
      assert.strictEqual(debitedAmount, 450_000);

      const updated = clawback.getReward(reward.rewardId)!;
      assert.strictEqual(updated.status, 'RECOVERED_CLAWBACK');
    });

    it('3.5 should handle repeated clawback gracefully as NOT_ELIGIBLE', async () => {
      clawback.createPendingReward({
        orderId: 'ORD_DOUBLE_CLAW',
        referrerId: 'ref_01',
        amount: 100_000,
      });

      // First clawback
      await clawback.processClawback({
        orderId: 'ORD_DOUBLE_CLAW',
        reason: 'Refund',
      });

      // Second clawback attempt on same order
      const second = await clawback.processClawback({
        orderId: 'ORD_DOUBLE_CLAW',
        reason: 'Refund again',
      });

      assert.strictEqual(second.length, 1);
      assert.strictEqual(second[0].action, 'NOT_ELIGIBLE');
      assert.ok(second[0].notes.includes('already clawed back'));
    });
  });
});
