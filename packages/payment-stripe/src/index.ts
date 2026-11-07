/**
 * @kido/payment-stripe
 * Production-grade Stripe Subscription & SaaS Billing Engine for KT Portfolio
 */

// Export types
export * from './types';

// Export Webhook verification & routing
export {
  WebhookSignatureError,
  InMemoryIdempotencyStore,
  parseStripeSignatureHeader,
  computeStripeSignature,
  verifyStripeWebhook,
  StripeWebhookRouter,
} from './webhook';

// Export Proration math
export {
  toUnixSeconds,
  formatCurrency,
  calculateProration,
  previewPlanSwitch,
} from './proration';

// Export Subscription Lifecycle, State Machine, Trial, and Cancellation
export {
  SubscriptionLifecycleError,
  ALLOWED_TRANSITIONS,
  SubscriptionStateMachine,
  SubscriptionTrialResolver,
  SubscriptionCancellationManager,
} from './lifecycle';

// Export Plan Quota Reconciler
export {
  PlanQuotaReconciler,
} from './quota-reconciler';

// Export Checkout & Customer Portal builders
export {
  CheckoutValidationError,
  sanitizeStripeMetadata,
  interpolateSessionId,
  buildCheckoutSessionParams,
  buildCustomerPortalSessionParams,
} from './checkout';

// Export SaaS Subscription Recurring Coupon & Promotion Codes
export {
  validateSubscriptionCoupon,
  calculateDiscountedProration,
  buildStripeDiscountPayload,
  evaluateCouponCoverEnded,
} from './coupon';
export type {
  CouponDiscountType,
  CouponDuration,
  PlanInterval,
  SubscriptionCoupon,
  CouponValidationContext,
  CouponValidationResult,
  DiscountedProrationResult,
} from './coupon';
