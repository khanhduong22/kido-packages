import { describe, expect, test } from 'bun:test';
import * as crypto from 'node:crypto';
import {
  ALLOWED_TRANSITIONS,
  CheckoutValidationError,
  InMemoryIdempotencyStore,
  PlanPriceConfig,
  PlanQuotaReconciler,
  ResourceItem,
  ResourceQuotaRule,
  StripeWebhookEvent,
  StripeWebhookRouter,
  SubscriptionCancellationManager,
  SubscriptionLifecycleError,
  SubscriptionRecord,
  SubscriptionStateMachine,
  SubscriptionTrialResolver,
  WebhookSignatureError,
  buildCheckoutSessionParams,
  buildCustomerPortalSessionParams,
  calculateProration,
  computeStripeSignature,
  formatCurrency,
  interpolateSessionId,
  parseStripeSignatureHeader,
  previewPlanSwitch,
  sanitizeStripeMetadata,
  toUnixSeconds,
  verifyStripeWebhook,
  validateSubscriptionCoupon,
  calculateDiscountedProration,
  buildStripeDiscountPayload,
  evaluateCouponCoverEnded,
  type SubscriptionCoupon,
  type ProrationResult,
} from './index';

describe('@kido/payment-stripe Test Suite', () => {
  const TEST_SECRET = 'whsec_test_secret_key_1234567890abcdef';

  // Helper to generate valid Stripe signature header
  function createStripeSignatureHeader(
    payload: string,
    secret: string,
    timestamp: number = Math.floor(Date.now() / 1000)
  ): string {
    const signature = computeStripeSignature(payload, secret, timestamp);
    return `t=${timestamp},v1=${signature}`;
  }

  // ==========================================================================
  // 1. STRIPE WEBHOOK SIGNATURE & TOLERANCE
  // ==========================================================================
  describe('Stripe Webhook Signature Verification', () => {
    const sampleEvent = {
      id: 'evt_test_123',
      object: 'event',
      type: 'checkout.session.completed',
      created: 1700000000,
      livemode: false,
      data: {
        object: {
          id: 'cs_test_abc',
          customer: 'cus_123',
        },
      },
    };
    const samplePayload = JSON.stringify(sampleEvent);

    test('verifies valid signature successfully', () => {
      const now = Math.floor(Date.now() / 1000);
      const header = createStripeSignatureHeader(samplePayload, TEST_SECRET, now);

      const event = verifyStripeWebhook(samplePayload, header, TEST_SECRET, {
        referenceTime: now,
      });

      expect(event.id).toBe('evt_test_123');
      expect(event.type).toBe('checkout.session.completed');
      expect(event.data.object.customer).toBe('cus_123');
    });

    test('rejects forged signature with wrong secret', () => {
      const now = Math.floor(Date.now() / 1000);
      const header = createStripeSignatureHeader(samplePayload, 'wrong_secret', now);

      expect(() => {
        verifyStripeWebhook(samplePayload, header, TEST_SECRET, {
          referenceTime: now,
        });
      }).toThrow(WebhookSignatureError);
    });

    test('rejects tampered payload', () => {
      const now = Math.floor(Date.now() / 1000);
      const header = createStripeSignatureHeader(samplePayload, TEST_SECRET, now);
      const tamperedPayload = samplePayload + ' ';

      expect(() => {
        verifyStripeWebhook(tamperedPayload, header, TEST_SECRET, {
          referenceTime: now,
        });
      }).toThrow(WebhookSignatureError);
    });

    test('rejects replay attack outside 300s tolerance window', () => {
      const now = 1700000500;
      const oldTimestamp = now - 301; // 301s ago (> 300s tolerance)
      const header = createStripeSignatureHeader(samplePayload, TEST_SECRET, oldTimestamp);

      expect(() => {
        verifyStripeWebhook(samplePayload, header, TEST_SECRET, {
          toleranceInSeconds: 300,
          referenceTime: now,
        });
      }).toThrow(/tolerance window/i);
    });

    test('accepts signature within tolerance window (e.g. 120s old)', () => {
      const now = 1700000500;
      const validTimestamp = now - 120; // 120s ago (<= 300s)
      const header = createStripeSignatureHeader(samplePayload, TEST_SECRET, validTimestamp);

      const event = verifyStripeWebhook(samplePayload, header, TEST_SECRET, {
        toleranceInSeconds: 300,
        referenceTime: now,
      });
      expect(event.id).toBe('evt_test_123');
    });

    test('supports rolled secrets with multiple v1 signatures in header', () => {
      const now = Math.floor(Date.now() / 1000);
      const sig1 = computeStripeSignature(samplePayload, 'old_secret', now);
      const sig2 = computeStripeSignature(samplePayload, TEST_SECRET, now);
      const header = `t=${now},v1=${sig1},v1=${sig2}`;

      const event = verifyStripeWebhook(samplePayload, header, TEST_SECRET, {
        referenceTime: now,
      });
      expect(event.id).toBe('evt_test_123');
    });

    test('rejects malformed header', () => {
      expect(() => parseStripeSignatureHeader('')).toThrow(WebhookSignatureError);
      expect(() => parseStripeSignatureHeader('t=123')).toThrow(WebhookSignatureError);
      expect(() => parseStripeSignatureHeader('v1=abcdef')).toThrow(WebhookSignatureError);
    });
  });

  // ==========================================================================
  // 2. WEBHOOK ROUTING & IDEMPOTENCY
  // ==========================================================================
  describe('StripeWebhookRouter & Idempotency', () => {
    test('routes events to specific and onAny handlers', async () => {
      const router = new StripeWebhookRouter({ secret: TEST_SECRET });

      let createdCalled = false;
      let paidCalled = false;
      let anyCount = 0;

      router.onSubscriptionCreated((event) => {
        createdCalled = true;
        return { subId: event.data.object.id };
      });

      router.onInvoicePaid(() => {
        paidCalled = true;
      });

      router.onAny(() => {
        anyCount++;
      });

      const subEvent: StripeWebhookEvent = {
        id: 'evt_sub_create_1',
        object: 'event',
        type: 'customer.subscription.created',
        created: 1700000000,
        livemode: false,
        data: { object: { id: 'sub_xyz123' } },
      };

      const result = await router.dispatchEvent(subEvent);

      expect(result.handled).toBe(true);
      expect(result.duplicate).toBe(false);
      expect(createdCalled).toBe(true);
      expect(paidCalled).toBe(false);
      expect(anyCount).toBe(1);
      expect(result.handlerResults).toEqual([{ subId: 'sub_xyz123' }, undefined]);
    });

    test('prevents duplicate processing via IdempotencyStore', async () => {
      const router = new StripeWebhookRouter({ secret: TEST_SECRET });
      let executionCount = 0;

      router.onSubscriptionUpdated(() => {
        executionCount++;
      });

      const event: StripeWebhookEvent = {
        id: 'evt_idempotent_test_999',
        object: 'event',
        type: 'customer.subscription.updated',
        created: 1700000000,
        livemode: false,
        data: { object: { id: 'sub_123' } },
      };

      // First dispatch
      const res1 = await router.dispatchEvent(event);
      expect(res1.duplicate).toBe(false);
      expect(res1.handled).toBe(true);
      expect(executionCount).toBe(1);

      // Second dispatch (identical eventId)
      const res2 = await router.dispatchEvent(event);
      expect(res2.duplicate).toBe(true);
      expect(res2.handled).toBe(false);
      expect(executionCount).toBe(1); // handler NOT executed again!
    });

    test('in-memory store pruning and TTL expiration', () => {
      const store = new InMemoryIdempotencyStore();
      store.set('evt_normal', 3600); // 1 hour
      store.set('evt_expired', -10); // already expired

      expect(store.has('evt_normal')).toBe(true);
      expect(store.has('evt_expired')).toBe(false);

      const pruned = store.pruneExpired();
      expect(pruned).toBe(0); // evt_expired was pruned on check
    });

    test('handleWebhook full pipeline with signature verification', async () => {
      const router = new StripeWebhookRouter({ secret: TEST_SECRET });
      let sessionCompletedId = '';

      router.onCheckoutSessionCompleted((event) => {
        sessionCompletedId = event.data.object.id;
      });

      const payload = JSON.stringify({
        id: 'evt_cs_completed_1',
        object: 'event',
        type: 'checkout.session.completed',
        created: 1700000000,
        livemode: false,
        data: { object: { id: 'cs_test_success' } },
      });

      const now = Math.floor(Date.now() / 1000);
      const sigHeader = createStripeSignatureHeader(payload, TEST_SECRET, now);

      const result = await router.handleWebhook(payload, sigHeader, TEST_SECRET, {
        referenceTime: now,
      });

      expect(result.duplicate).toBe(false);
      expect(sessionCompletedId).toBe('cs_test_success');
    });
  });

  // ==========================================================================
  // 3. PRORATION MATH
  // ==========================================================================
  describe('Proration Math Algorithm', () => {
    const planStarterMonthly: PlanPriceConfig = {
      id: 'price_starter_monthly',
      name: 'Starter Monthly',
      amount: 3000, // $30.00
      interval: 'month',
    };

    const planProMonthly: PlanPriceConfig = {
      id: 'price_pro_monthly',
      name: 'Pro Monthly',
      amount: 6000, // $60.00
      interval: 'month',
    };

    test('calculates exact mid-cycle upgrade (50% remaining)', () => {
      // 30 days total period (0 to 3000 seconds for clean testing)
      const periodStart = 10000;
      const periodEnd = 13000;
      const effectiveTime = 11500; // exact 50% midpoint

      const result = calculateProration({
        oldPlan: planStarterMonthly,
        newPlan: planProMonthly,
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        effectiveTime,
      });

      expect(result.totalPeriodSeconds).toBe(3000);
      expect(result.remainingSeconds).toBe(1500);
      expect(result.remainingRatio).toBe(0.5);

      // Unused credit for old plan ($30 * 50% = $15 = 1500 cents)
      expect(result.unusedCredit).toBe(1500);
      // Prorated cost for new plan ($60 * 50% = $30 = 3000 cents)
      expect(result.proratedCost).toBe(3000);
      // Net amount = 3000 - 1500 = 1500 cents ($15.00)
      expect(result.netAmount).toBe(1500);
      expect(result.amountDue).toBe(1500);
      expect(result.creditRolloverBalance).toBe(0);
      expect(result.isUpgrade).toBe(true);
      expect(result.isDowngrade).toBe(false);
    });

    test('calculates exact mid-cycle downgrade with credit rollover balance', () => {
      const periodStart = 10000;
      const periodEnd = 13000;
      const effectiveTime = 11500; // 50% midpoint

      // Downgrading from Pro ($60) to Starter ($30)
      const result = calculateProration({
        oldPlan: planProMonthly,
        newPlan: planStarterMonthly,
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        effectiveTime,
      });

      // Unused credit for old plan ($60 * 50% = 3000 cents)
      expect(result.unusedCredit).toBe(3000);
      // Prorated cost for new plan ($30 * 50% = 1500 cents)
      expect(result.proratedCost).toBe(1500);
      // Net amount = 1500 - 3000 = -1500 cents
      expect(result.netAmount).toBe(-1500);
      // Customer pays 0 immediately
      expect(result.amountDue).toBe(0);
      // 1500 cents ($15.00) credit is rolled over to customer balance
      expect(result.creditRolloverBalance).toBe(1500);
      expect(result.isUpgrade).toBe(false);
      expect(result.isDowngrade).toBe(true);
    });

    test('handles same price switch', () => {
      const planProAlternative: PlanPriceConfig = {
        id: 'price_pro_alt',
        name: 'Pro Alt',
        amount: 6000,
        interval: 'month',
      };

      const result = calculateProration({
        oldPlan: planProMonthly,
        newPlan: planProAlternative,
        currentPeriodStart: 1000,
        currentPeriodEnd: 2000,
        effectiveTime: 1500,
      });

      expect(result.unusedCredit).toBe(3000);
      expect(result.proratedCost).toBe(3000);
      expect(result.netAmount).toBe(0);
      expect(result.amountDue).toBe(0);
      expect(result.creditRolloverBalance).toBe(0);
      expect(result.isSamePrice).toBe(true);
    });

    test('handles upgrade from free plan ($0)', () => {
      const planFree: PlanPriceConfig = {
        id: 'free',
        amount: 0,
        interval: 'month',
      };

      const result = calculateProration({
        oldPlan: planFree,
        newPlan: planStarterMonthly, // $30
        currentPeriodStart: 1000,
        currentPeriodEnd: 2000,
        effectiveTime: 1500,
      });

      expect(result.unusedCredit).toBe(0);
      expect(result.proratedCost).toBe(1500);
      expect(result.amountDue).toBe(1500);
      expect(result.creditRolloverBalance).toBe(0);
    });

    test('handles month-to-annual upgrade with restart_cycle mode', () => {
      const planAnnual: PlanPriceConfig = {
        id: 'price_pro_annual',
        amount: 60000, // $600.00 / year
        interval: 'year',
      };

      // 1/3 of month remaining (remainingRatio = 0.3333...)
      const periodStart = 0;
      const periodEnd = 3000;
      const effectiveTime = 2000; // 1000s remaining

      const result = calculateProration({
        oldPlan: planStarterMonthly, // $30/mo
        newPlan: planAnnual, // $600/yr
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        effectiveTime,
        crossIntervalMode: 'restart_cycle',
      });

      // Unused credit = $30 * (1000/3000) = $10 = 1000 cents
      expect(result.unusedCredit).toBe(1000);
      // New annual charge starts full immediately
      expect(result.proratedCost).toBe(60000);
      // Amount due = 60000 - 1000 = 59000 cents ($590.00)
      expect(result.amountDue).toBe(59000);
      expect(result.creditRolloverBalance).toBe(0);
    });

    test('previewPlanSwitch accepts Date instances', () => {
      const now = new Date();
      const start = new Date(now.getTime() - 10 * 86400000);
      const end = new Date(now.getTime() + 20 * 86400000);

      const preview = previewPlanSwitch(planStarterMonthly, planProMonthly, start, end, now);
      expect(preview.totalPeriodSeconds).toBeGreaterThan(0);
      expect(preview.amountDue).toBeGreaterThan(0);
    });

    test('formatCurrency formats zero decimal currencies properly', () => {
      expect(formatCurrency(1000, 'usd')).toContain('10.00');
      expect(formatCurrency(500000, 'vnd')).toContain('500,000');
    });
  });

  // ==========================================================================
  // 4. SUBSCRIPTION LIFECYCLE & STATE MACHINE
  // ==========================================================================
  describe('Subscription Lifecycle State Machine', () => {
    test('validates permitted transitions', () => {
      expect(SubscriptionStateMachine.canTransition('trialing', 'active')).toBe(true);
      expect(SubscriptionStateMachine.canTransition('active', 'past_due')).toBe(true);
      expect(SubscriptionStateMachine.canTransition('past_due', 'unpaid')).toBe(true);
      expect(SubscriptionStateMachine.canTransition('unpaid', 'canceled')).toBe(true);
      expect(SubscriptionStateMachine.canTransition('active', 'canceled')).toBe(true);
      expect(SubscriptionStateMachine.canTransition('active', 'active')).toBe(true); // renewal
    });

    test('rejects invalid transitions from terminal states', () => {
      expect(SubscriptionStateMachine.canTransition('canceled', 'active')).toBe(false);
      expect(SubscriptionStateMachine.canTransition('incomplete_expired', 'active')).toBe(false);
      expect(SubscriptionStateMachine.isTerminal('canceled')).toBe(true);
      expect(SubscriptionStateMachine.isTerminal('incomplete_expired')).toBe(true);
      expect(SubscriptionStateMachine.isTerminal('active')).toBe(false);

      expect(() => {
        SubscriptionStateMachine.assertValidTransition('canceled', 'active');
      }).toThrow(SubscriptionLifecycleError);
    });

    test('determines entitlement for active, trialing, past_due', () => {
      expect(SubscriptionStateMachine.isEntitled('active')).toBe(true);
      expect(SubscriptionStateMachine.isEntitled('trialing')).toBe(true);
      expect(SubscriptionStateMachine.isEntitled('past_due', { allowPastDueGracePeriod: true })).toBe(true);
      expect(SubscriptionStateMachine.isEntitled('past_due', { allowPastDueGracePeriod: false })).toBe(false);
      expect(SubscriptionStateMachine.isEntitled('canceled')).toBe(false);
      expect(SubscriptionStateMachine.isEntitled('unpaid')).toBe(false);
    });
  });

  // ==========================================================================
  // 5. TRIAL EXPIRATION RESOLVER
  // ==========================================================================
  describe('SubscriptionTrialResolver', () => {
    test('blocks user who previously consumed trial', () => {
      const historyWithTrial = {
        userId: 1,
        trialUsedAt: new Date('2025-01-01'),
      };
      const priceConfig = {
        allowTrial: true,
        mode: 'days' as const,
        trialDays: 14,
      };

      const canStart = SubscriptionTrialResolver.canUserStartTrial(historyWithTrial, priceConfig);
      expect(canStart).toBe(false);
    });

    test('allows eligible first-time user for active trial', () => {
      const cleanUser = {
        userId: 2,
        trialUsedAt: null,
      };
      const priceConfig = {
        allowTrial: true,
        mode: 'days' as const,
        trialDays: 7,
      };

      const canStart = SubscriptionTrialResolver.canUserStartTrial(cleanUser, priceConfig);
      expect(canStart).toBe(true);
    });

    test('calculates trial end date in days mode', () => {
      const now = new Date('2026-10-01T12:00:00Z');
      const endsAt = SubscriptionTrialResolver.resolveTrialEndsAt(
        { allowTrial: true, mode: 'days', trialDays: 7 },
        now
      );
      expect(endsAt).not.toBeNull();
      expect(endsAt!.toISOString()).toBe('2026-10-08T12:00:00.000Z');
    });

    test('handles campaign until-mode expiration', () => {
      const now = new Date('2026-10-05T00:00:00Z');
      // Expired campaign
      const expiredCampaign = SubscriptionTrialResolver.resolveTrialEndsAt(
        { allowTrial: true, mode: 'until', trialEndsOn: '2026-09-30T23:59:59Z' },
        now
      );
      expect(expiredCampaign).toBeNull();

      // Future campaign
      const activeCampaign = SubscriptionTrialResolver.resolveTrialEndsAt(
        { allowTrial: true, mode: 'until', trialEndsOn: '2026-12-31T23:59:59Z' },
        now
      );
      expect(activeCampaign).not.toBeNull();
      expect(activeCampaign!.getUTCFullYear()).toBe(2026);
    });

    test('checks isTrialExpired', () => {
      const end = 1700000000;
      expect(SubscriptionTrialResolver.isTrialExpired(end, 1699999999)).toBe(false);
      expect(SubscriptionTrialResolver.isTrialExpired(end, 1700000000)).toBe(true);
      expect(SubscriptionTrialResolver.isTrialExpired(end, 1700000001)).toBe(true);
    });
  });

  // ==========================================================================
  // 6. CANCELLATION WORKFLOWS
  // ==========================================================================
  describe('SubscriptionCancellationManager', () => {
    const activeSub: SubscriptionRecord = {
      id: 'sub_active_123',
      customerId: 'cus_123',
      status: 'active',
      planId: 'pro',
      priceId: 'price_pro',
      currentPeriodStart: 1700000000,
      currentPeriodEnd: 1702592000,
      cancelAtPeriodEnd: false,
      canceledAt: null,
      cancelAt: null,
      trialStart: null,
      trialEnd: null,
    };

    test('applies graceful cancellation (cancel_at_period_end)', () => {
      const result = SubscriptionCancellationManager.applyCancellation(activeSub, {
        mode: 'period_end',
        cancelReason: 'Too expensive',
      });

      expect(result.status).toBe('active'); // status stays active!
      expect(result.cancelAtPeriodEnd).toBe(true);
      expect(result.cancelAt).toBe(1702592000);
      expect(result.metadata?.cancelReason).toBe('Too expensive');
    });

    test('applies immediate hard cancellation', () => {
      const nowSec = 1701000000;
      const result = SubscriptionCancellationManager.applyCancellation(activeSub, {
        mode: 'immediate',
        referenceTime: nowSec,
      });

      expect(result.status).toBe('canceled');
      expect(result.cancelAtPeriodEnd).toBe(false);
      expect(result.canceledAt).toBe(nowSec);
    });

    test('reverts scheduled cancellation before period ends', () => {
      const scheduledSub: SubscriptionRecord = {
        ...activeSub,
        cancelAtPeriodEnd: true,
        cancelAt: 1702592000,
      };

      const reverted = SubscriptionCancellationManager.revertCancellation(scheduledSub);
      expect(reverted.cancelAtPeriodEnd).toBe(false);
      expect(reverted.cancelAt).toBeNull();
    });

    test('throws when attempting to revert an already canceled subscription', () => {
      const canceledSub: SubscriptionRecord = {
        ...activeSub,
        status: 'canceled',
        canceledAt: 1701000000,
      };

      expect(() => {
        SubscriptionCancellationManager.revertCancellation(canceledSub);
      }).toThrow(SubscriptionLifecycleError);
    });
  });

  // ==========================================================================
  // 7. PLAN QUOTA RECONCILER
  // ==========================================================================
  describe('PlanQuotaReconciler (Resource Soft-Locking)', () => {
    interface TestDomain extends ResourceItem {
      domainName: string;
    }

    const domains: TestDomain[] = [
      { id: 'dom_1', domainName: 'link1.com', createdAt: 1000, status: 'active', priority: 1 },
      { id: 'dom_2', domainName: 'link2.com', createdAt: 2000, status: 'active', priority: 5 },
      { id: 'dom_3', domainName: 'link3.com', createdAt: 3000, status: 'active', priority: 2 },
      { id: 'dom_4', domainName: 'link4.com', createdAt: 4000, status: 'active', priority: 4 },
      { id: 'dom_5', domainName: 'link5.com', createdAt: 5000, status: 'active', priority: 3 },
    ];

    test('soft-locks excess items using newest strategy (default)', () => {
      // Downgrade to 2 domains allowed. Excess = 3.
      // Newest strategy preserves oldest created (dom_1, dom_2) and freezes dom_5, dom_4, dom_3
      const rule: ResourceQuotaRule<TestDomain> = {
        resourceType: 'domains',
        allowedLimit: 2,
        strategy: 'newest',
      };

      const result = PlanQuotaReconciler.reconcileCollection(domains, rule);

      expect(result.hasExcess).toBe(true);
      expect(result.excessCount).toBe(3);
      expect(result.softLockedIds).toEqual(['dom_5', 'dom_4', 'dom_3']);
      expect(result.activeItems.map((i) => i.id)).toEqual(['dom_2', 'dom_1']);
      expect(result.softLockedItems.every((i) => i.status === 'frozen')).toBe(true);
    });

    test('soft-locks excess items using oldest strategy', () => {
      const rule: ResourceQuotaRule<TestDomain> = {
        resourceType: 'domains',
        allowedLimit: 2,
        strategy: 'oldest',
      };

      const result = PlanQuotaReconciler.reconcileCollection(domains, rule);

      expect(result.excessCount).toBe(3);
      // Oldest first -> freezes dom_1, dom_2, dom_3; preserves dom_4, dom_5
      expect(result.softLockedIds).toEqual(['dom_1', 'dom_2', 'dom_3']);
      expect(result.activeItems.map((i) => i.id)).toEqual(['dom_4', 'dom_5']);
    });

    test('soft-locks excess items using priority_low strategy', () => {
      const rule: ResourceQuotaRule<TestDomain> = {
        resourceType: 'domains',
        allowedLimit: 2,
        strategy: 'priority_low',
      };

      const result = PlanQuotaReconciler.reconcileCollection(domains, rule);

      // Priorities: dom_1 (1), dom_3 (2), dom_5 (3), dom_4 (4), dom_2 (5)
      // Lowest 3 are dom_1, dom_3, dom_5
      expect(result.softLockedIds).toEqual(['dom_1', 'dom_3', 'dom_5']);
      expect(result.activeItems.map((i) => i.id)).toEqual(['dom_4', 'dom_2']);
    });

    test('handles zero excess when within quota', () => {
      const rule: ResourceQuotaRule<TestDomain> = {
        resourceType: 'domains',
        allowedLimit: 10,
      };

      const result = PlanQuotaReconciler.reconcileCollection(domains, rule);

      expect(result.hasExcess).toBe(false);
      expect(result.excessCount).toBe(0);
      expect(result.softLockedIds).toHaveLength(0);
      expect(result.activeItems).toHaveLength(5);
    });

    test('reactivates frozen items upon plan upgrade (reconcileUpgrade)', () => {
      const mixedDomains: TestDomain[] = [
        { id: 'dom_1', domainName: 'link1.com', createdAt: 1000, status: 'active', priority: 1 },
        { id: 'dom_2', domainName: 'link2.com', createdAt: 2000, status: 'active', priority: 2 },
        { id: 'dom_3', domainName: 'link3.com', createdAt: 3000, status: 'frozen', priority: 5 },
        { id: 'dom_4', domainName: 'link4.com', createdAt: 4000, status: 'frozen', priority: 3 },
      ];

      // Upgrade to 3 allowed domains. 2 currently active -> 1 slot available.
      // dom_3 has higher priority (5 > 3), so dom_3 should be reactivated!
      const rule: ResourceQuotaRule<TestDomain> = {
        resourceType: 'domains',
        allowedLimit: 3,
      };

      const upgradeResult = PlanQuotaReconciler.reconcileUpgrade(mixedDomains, rule);

      expect(upgradeResult.reactivatedIds).toEqual(['dom_3']);
      expect(upgradeResult.activeItems).toHaveLength(3);
      expect(upgradeResult.frozenRemainingCount).toBe(1);
    });

    test('reconcileMulti processes multiple resource types simultaneously', () => {
      const collections: Record<string, ResourceItem[]> = {
        domains,
        team_seats: [
          { id: 'seat_1', createdAt: 100, status: 'active' as const },
          { id: 'seat_2', createdAt: 200, status: 'active' as const },
          { id: 'seat_3', createdAt: 300, status: 'active' as const },
        ],
      };

      const rules: Record<string, ResourceQuotaRule<ResourceItem>> = {
        domains: { resourceType: 'domains', allowedLimit: 2 },
        team_seats: { resourceType: 'team_seats', allowedLimit: 1 },
      };

      const summary = PlanQuotaReconciler.reconcileMulti(collections, rules);

      expect(summary.hasViolations).toBe(true);
      expect(summary.totalExcess).toBe(3 + 2); // 3 domains + 2 seats
      expect(summary.reconciled.domains.excessCount).toBe(3);
      expect(summary.reconciled.team_seats.excessCount).toBe(2);
    });
  });

  // ==========================================================================
  // 8. CHECKOUT & CUSTOMER PORTAL BUILDERS
  // ==========================================================================
  describe('Checkout & Customer Portal Parameter Builders', () => {
    test('builds valid hosted checkout session params', () => {
      const payload = buildCheckoutSessionParams({
        mode: 'subscription',
        checkoutMode: 'hosted',
        customerId: 'cus_client_1',
        lineItems: [{ priceId: 'price_pro_monthly', quantity: 1 }],
        successUrl: 'https://example.com/success?session_id={CHECKOUT_SESSION_ID}',
        cancelUrl: 'https://example.com/cancel',
        allowPromotionCodes: true,
        trialPeriodDays: 14,
        metadata: {
          userId: 101,
          tier: 'pro',
        },
      });

      expect(payload.mode).toBe('subscription');
      expect(payload.ui_mode).toBe('hosted');
      expect(payload.customer).toBe('cus_client_1');
      expect(payload.success_url).toBe('https://example.com/success?session_id={CHECKOUT_SESSION_ID}');
      expect(payload.cancel_url).toBe('https://example.com/cancel');
      expect(payload.allow_promotion_codes).toBe(true);
      expect(payload.subscription_data?.trial_period_days).toBe(14);
      expect(payload.metadata).toEqual({ userId: '101', tier: 'pro' });
    });

    test('builds valid embedded checkout session params with returnUrl', () => {
      const payload = buildCheckoutSessionParams({
        mode: 'subscription',
        checkoutMode: 'embedded',
        customerEmail: 'dev@kt.com',
        lineItems: [{ priceId: 'price_starter', quantity: 2 }],
        returnUrl: 'https://example.com/return?session_id={CHECKOUT_SESSION_ID}',
        clientReferenceId: 'ref_order_456',
      });

      expect(payload.ui_mode).toBe('embedded');
      expect(payload.customer_email).toBe('dev@kt.com');
      expect(payload.return_url).toBe('https://example.com/return?session_id={CHECKOUT_SESSION_ID}');
      expect(payload.line_items[0].quantity).toBe(2);
      expect(payload.client_reference_id).toBe('ref_order_456');
    });

    test('validates required URLs based on checkoutMode', () => {
      expect(() => {
        buildCheckoutSessionParams({
          checkoutMode: 'hosted',
          lineItems: [{ priceId: 'price_123' }],
          // missing successUrl and cancelUrl
        });
      }).toThrow(CheckoutValidationError);

      expect(() => {
        buildCheckoutSessionParams({
          checkoutMode: 'embedded',
          lineItems: [{ priceId: 'price_123' }],
          // missing returnUrl
        });
      }).toThrow(CheckoutValidationError);
    });

    test('builds customer portal params', () => {
      const portal = buildCustomerPortalSessionParams({
        customerId: 'cus_xyz_789',
        returnUrl: 'https://app.kt.com/billing',
        flowData: {
          type: 'subscription_cancel',
          subscription_cancel: {
            subscription: 'sub_12345',
          },
        },
      });

      expect(portal.customer).toBe('cus_xyz_789');
      expect(portal.return_url).toBe('https://app.kt.com/billing');
      expect(portal.flow_data?.type).toBe('subscription_cancel');
    });

    test('utilities: interpolateSessionId & sanitizeStripeMetadata', () => {
      const url = 'https://kt.com/success?sess={CHECKOUT_SESSION_ID}';
      expect(interpolateSessionId(url, 'cs_123')).toBe('https://kt.com/success?sess=cs_123');

      const sanitized = sanitizeStripeMetadata({
        id: 123,
        active: true,
        nil: null,
        empty: undefined,
        nested: { a: 1 },
      });
      expect(sanitized).toEqual({
        id: '123',
        active: 'true',
        nested: '{"a":1}',
      });
    });
  });

  // ==========================================================================
  // 9. SAAS RECURRING COUPON & PROMOTION CODE ENGINE
  // ==========================================================================
  describe('SaaS Subscription Recurring Coupon Engine', () => {
    const baseCoupon: SubscriptionCoupon = {
      id: 'coup_pro_20',
      code: 'PRO20',
      discountType: 'percentage',
      discountValue: 20,
      duration: 'repeating',
      durationInMonths: 3,
      applicableIntervals: ['month', 'year'],
      maxRedemptions: 100,
      timesRedeemed: 10,
      maxRedemptionsPerUser: 1,
      minimumAmount: 1000, // $10.00
      isActive: true,
      stripeCouponId: 'stripe_coup_20_pct',
    };

    test('validates and applies percentage coupon accurately', () => {
      const result = validateSubscriptionCoupon(baseCoupon, {
        planPriceId: 'price_pro_monthly',
        interval: 'month',
        amount: 5000, // $50.00
        userRedemptionCount: 0,
      });

      expect(result.isValid).toBe(true);
      expect(result.discountAmount).toBe(1000); // 20% of 5000
      expect(result.finalAmount).toBe(4000);
    });

    test('validates fixed amount coupon capping at order total', () => {
      const fixedCoupon: SubscriptionCoupon = {
        ...baseCoupon,
        discountType: 'fixed',
        discountValue: 1500, // $15.00
      };

      const result = validateSubscriptionCoupon(fixedCoupon, {
        planPriceId: 'price_pro_monthly',
        interval: 'month',
        amount: 2000, // $20.00
      });

      expect(result.isValid).toBe(true);
      expect(result.discountAmount).toBe(1500);
      expect(result.finalAmount).toBe(500);
    });

    test('rejects coupon when below minimumAmount', () => {
      const result = validateSubscriptionCoupon(baseCoupon, {
        planPriceId: 'price_starter',
        interval: 'month',
        amount: 500, // Below minimum 1000
      });

      expect(result.isValid).toBe(false);
      expect(result.reason).toContain('Minimum order amount');
    });

    test('rejects coupon when user redemption limit exceeded', () => {
      const result = validateSubscriptionCoupon(baseCoupon, {
        planPriceId: 'price_pro_monthly',
        interval: 'month',
        amount: 5000,
        userRedemptionCount: 1, // User already used once
      });

      expect(result.isValid).toBe(false);
      expect(result.reason).toContain('User has already redeemed');
    });

    test('rejects coupon when interval restriction does not match', () => {
      const yearlyOnlyCoupon: SubscriptionCoupon = {
        ...baseCoupon,
        applicableIntervals: ['year'],
      };

      const result = validateSubscriptionCoupon(yearlyOnlyCoupon, {
        planPriceId: 'price_pro_monthly',
        interval: 'month',
        amount: 5000,
      });

      expect(result.isValid).toBe(false);
      expect(result.reason).toContain('Coupon is only valid for intervals');
    });

    test('calculates discounted proration amount during subscription upgrade', () => {
      const proration: ProrationResult = {
        currentPlanId: 'starter',
        newPlanId: 'pro',
        amountDue: 3000, // $30.00 proration fee
        unusedCredit: 1000,
        proratedNewCost: 4000,
        creditRolloverBalance: 0,
        currency: 'usd',
        isUpgrade: true,
        calculationDetails: {
          daysRemaining: 15,
          totalDaysInCycle: 30,
          unusedRatio: 0.5,
          oldDailyRate: 33.33,
          newDailyRate: 133.33,
        },
      };

      const discounted = calculateDiscountedProration(proration, baseCoupon);
      expect(discounted.couponDiscount).toBe(600); // 20% of 3000
      expect(discounted.discountedAmountDue).toBe(2400); // 3000 - 600
    });

    test('evaluates coupon cover ended for repeating and once coupons', () => {
      // 3-month repeating coupon
      expect(evaluateCouponCoverEnded(baseCoupon, 1)).toEqual({ isEnded: false, remainingCycles: 2 });
      expect(evaluateCouponCoverEnded(baseCoupon, 2)).toEqual({ isEnded: false, remainingCycles: 1 });
      expect(evaluateCouponCoverEnded(baseCoupon, 3)).toEqual({ isEnded: true, remainingCycles: 0 });

      // Forever coupon
      const foreverCoupon: SubscriptionCoupon = { ...baseCoupon, duration: 'forever' };
      expect(evaluateCouponCoverEnded(foreverCoupon, 10)).toEqual({ isEnded: false, remainingCycles: Infinity });
    });

    test('builds Stripe discount payload with coupon ID', () => {
      const payload = buildStripeDiscountPayload(baseCoupon);
      expect(payload).toEqual({
        discounts: [{ coupon: 'stripe_coup_20_pct' }],
      });
    });
  });
});
