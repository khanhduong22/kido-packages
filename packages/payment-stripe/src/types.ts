/**
 * Types & Domain Models for @kido/payment-stripe
 */

// ============================================================================
// 1. WEBHOOK & EVENT TYPES
// ============================================================================

export type StripeStandardEventType =
  | 'checkout.session.completed'
  | 'customer.subscription.created'
  | 'customer.subscription.updated'
  | 'customer.subscription.deleted'
  | 'invoice.paid'
  | 'invoice.payment_failed'
  | 'invoice.payment_action_required'
  | 'customer.subscription.trial_will_end';

export type StripeEventType = StripeStandardEventType | (string & {});

export interface StripeEventData<T = Record<string, any>> {
  object: T;
  previous_attributes?: Partial<T>;
}

export interface StripeWebhookEvent<T = Record<string, any>> {
  id: string;
  object: 'event';
  api_version?: string;
  created: number;
  data: StripeEventData<T>;
  type: StripeEventType;
  livemode: boolean;
  pending_webhooks?: number;
  request?: {
    id: string | null;
    idempotency_key: string | null;
  } | null;
}

export interface WebhookVerificationOptions {
  /**
   * Signature tolerance window in seconds (default: 300s = 5 minutes).
   * Prevents replay attacks by rejecting timestamps outside this window.
   */
  toleranceInSeconds?: number;
  /**
   * Enforce tolerance check against current time (default: true).
   */
  enforceTolerance?: boolean;
  /**
   * Mock or current reference time for testing (unix timestamp seconds).
   */
  referenceTime?: number;
}

export interface IdempotencyStore {
  has(eventId: string): Promise<boolean> | boolean;
  set(eventId: string, ttlSeconds?: number): Promise<void> | void;
  delete?(eventId: string): Promise<void> | void;
  clear?(): Promise<void> | void;
}

export type WebhookHandlerFn<T = any> = (
  event: StripeWebhookEvent<T>
) => Promise<any> | any;

export interface WebhookDispatchResult<T = any> {
  eventId: string;
  eventType: StripeEventType;
  duplicate: boolean;
  handled: boolean;
  handlerResults: any[];
  event: StripeWebhookEvent<T>;
}

// ============================================================================
// 2. PRORATION MATH TYPES
// ============================================================================

export type BillingInterval = 'day' | 'week' | 'month' | 'year';

export interface PlanPriceConfig {
  id: string | number;
  name?: string;
  amount: number; // in smallest currency unit, e.g. cents ($10 = 1000)
  currency?: string;
  interval: BillingInterval;
  intervalCount?: number; // default 1
}

export interface ProrationInput {
  /**
   * Start timestamp of current cycle (seconds or Date).
   */
  currentPeriodStart: number | Date;
  /**
   * End timestamp of current cycle (seconds or Date).
   */
  currentPeriodEnd: number | Date;
  /**
   * Timestamp when the plan change takes effect (seconds or Date, defaults to now).
   */
  effectiveTime?: number | Date;
  /**
   * Existing active plan pricing.
   */
  oldPlan: PlanPriceConfig;
  /**
   * Target new plan pricing.
   */
  newPlan: PlanPriceConfig;
  /**
   * Cross-interval conversion strategy when changing intervals (e.g. month -> year):
   * - 'align_period': prorates new plan over remaining time of current cycle
   * - 'restart_cycle': credits unused time of old plan, immediately starts full cycle of new plan (default for different intervals)
   */
  crossIntervalMode?: 'align_period' | 'restart_cycle';
}

export interface ProrationResult {
  totalPeriodSeconds: number;
  remainingSeconds: number;
  elapsedSeconds: number;
  remainingRatio: number;
  /**
   * Credit value of the unconsumed portion of the old plan (cents, >= 0).
   */
  unusedCredit: number;
  /**
   * Prorated cost of the new plan for the remaining time (cents, >= 0).
   */
  proratedCost: number;
  /**
   * Net difference: proratedCost - unusedCredit (can be positive, negative, or zero).
   */
  netAmount: number;
  /**
   * Immediate amount customer must pay now (max(0, netAmount)).
   */
  amountDue: number;
  /**
   * Remaining credit balance rolled over to customer account if downgrade or negative net (max(0, -netAmount)).
   */
  creditRolloverBalance: number;
  isUpgrade: boolean;
  isDowngrade: boolean;
  isSamePrice: boolean;
  breakdown: {
    oldPlanAmount: number;
    newPlanAmount: number;
    oldPlanDailyRate: number;
    newPlanDailyRate: number;
    unusedCreditFormatted: string;
    proratedCostFormatted: string;
    amountDueFormatted: string;
    creditRolloverFormatted: string;
  };
}

// ============================================================================
// 3. SUBSCRIPTION LIFECYCLE & STATE MACHINE TYPES
// ============================================================================

export type SubscriptionStatus =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'unpaid'
  | 'incomplete'
  | 'incomplete_expired'
  | 'paused';

export interface SubscriptionRecord {
  id: string;
  customerId: string;
  status: SubscriptionStatus;
  planId: string | number;
  priceId: string | number;
  currentPeriodStart: number;
  currentPeriodEnd: number;
  cancelAtPeriodEnd: boolean;
  canceledAt: number | null;
  cancelAt: number | null;
  trialStart: number | null;
  trialEnd: number | null;
  metadata?: Record<string, any>;
}

export type TrialMode = 'days' | 'until';

export interface TrialConfig {
  allowTrial: boolean;
  mode?: TrialMode;
  trialDays?: number;
  trialEndsOn?: string | Date; // Date or ISO string
}

export interface UserTrialHistory {
  userId?: string | number;
  trialUsedAt?: Date | number | string | null;
  hasUsedTrial?: boolean;
}

export type CancelMode = 'period_end' | 'immediate';

export interface CancelSubscriptionOptions {
  mode: CancelMode;
  cancelReason?: string;
  referenceTime?: Date | number;
}

// ============================================================================
// 4. PLAN QUOTA RECONCILER TYPES
// ============================================================================

export type EvictionStrategy =
  | 'newest'
  | 'oldest'
  | 'priority_high'
  | 'priority_low'
  | 'custom';

export interface ResourceItem {
  id: string | number;
  name?: string;
  createdAt: Date | number | string;
  priority?: number; // Higher number = higher priority
  status: 'active' | 'inactive' | 'frozen' | 'locked';
  [key: string]: any;
}

export interface ResourceQuotaRule<T extends ResourceItem = ResourceItem> {
  resourceType: string;
  /**
   * Allowed active quota limit.
   * If isUnlimited is true or allowedLimit <= -1, quota is unlimited.
   * In domain conventions where 0 means none allowed: allowedLimit = 0 means 0 active items allowed.
   */
  allowedLimit: number;
  isUnlimited?: boolean;
  strategy?: EvictionStrategy;
  customComparator?: (a: T, b: T) => number;
}

export interface QuotaReconcileResult<T extends ResourceItem = ResourceItem> {
  resourceType: string;
  total: number;
  activeCount: number;
  allowedLimit: number;
  excessCount: number;
  softLockedIds: (string | number)[];
  softLockedItems: T[];
  activeItems: T[];
  hasExcess: boolean;
  action: 'none' | 'soft_locked' | 'unlocked';
}

export interface UpgradeReconcileResult<T extends ResourceItem = ResourceItem> {
  resourceType: string;
  allowedLimit: number;
  reactivatedIds: (string | number)[];
  reactivatedItems: T[];
  activeItems: T[];
  frozenRemainingCount: number;
}

export interface MultiQuotaSummary {
  success: boolean;
  reconciled: Record<string, QuotaReconcileResult>;
  totalExcess: number;
  totalSoftLocked: number;
  hasViolations: boolean;
}

// ============================================================================
// 5. CHECKOUT & CUSTOMER PORTAL TYPES
// ============================================================================

export type CheckoutMode = 'hosted' | 'embedded';
export type CheckoutSessionMode = 'subscription' | 'payment' | 'setup';

export interface CheckoutLineItem {
  priceId: string;
  quantity?: number;
}

export interface CheckoutDiscountItem {
  coupon?: string;
  promotion_code?: string;
}

export interface CheckoutSessionParamsInput {
  customerId?: string;
  customerEmail?: string;
  mode?: CheckoutSessionMode;
  checkoutMode?: CheckoutMode;
  lineItems: CheckoutLineItem[];
  successUrl?: string;
  cancelUrl?: string;
  returnUrl?: string;
  metadata?: Record<string, string | number | boolean | null | undefined>;
  subscriptionMetadata?: Record<string, string | number | boolean | null | undefined>;
  allowPromotionCodes?: boolean;
  discounts?: CheckoutDiscountItem[];
  trialPeriodDays?: number;
  trialEnd?: number | Date;
  clientReferenceId?: string;
  billingAddressCollection?: 'auto' | 'required';
  taxIdCollection?: boolean;
}

export interface StripeCheckoutSessionPayload {
  mode: CheckoutSessionMode;
  ui_mode?: 'hosted' | 'embedded';
  customer?: string;
  customer_email?: string;
  line_items: Array<{ price: string; quantity: number }>;
  success_url?: string;
  cancel_url?: string;
  return_url?: string;
  metadata?: Record<string, string>;
  subscription_data?: {
    metadata?: Record<string, string>;
    trial_period_days?: number;
    trial_end?: number;
  };
  allow_promotion_codes?: boolean;
  discounts?: Array<{ coupon?: string; promotion_code?: string }>;
  client_reference_id?: string;
  billing_address_collection?: 'auto' | 'required';
  tax_id_collection?: { enabled: boolean };
}

export interface CustomerPortalFlowData {
  type: 'subscription_update' | 'subscription_cancel' | 'payment_method_update';
  subscription_update?: {
    subscription: string;
  };
  subscription_cancel?: {
    subscription: string;
    retention?: Record<string, any>;
  };
}

export interface CustomerPortalParamsInput {
  customerId: string;
  returnUrl: string;
  configuration?: string;
  flowData?: CustomerPortalFlowData;
}

export interface StripeCustomerPortalPayload {
  customer: string;
  return_url: string;
  configuration?: string;
  flow_data?: CustomerPortalFlowData;
}
