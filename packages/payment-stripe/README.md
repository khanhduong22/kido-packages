# @kido/payment-stripe

Production-grade Stripe Subscription & SaaS Billing Engine for Kido Packages.

Standardized from high-throughput production systems, this package provides a 0-external-runtime-dependency TypeScript engine covering the entire SaaS billing lifecycle: HMAC-SHA256 webhook signature verification with 300s replay attack defense, event routing with idempotency deduplication, proration math (unused credit vs prorated cost & credit rollover), subscription lifecycle state machine, plan quota reconciler (non-destructive resource soft-locking), and Checkout / Customer Portal parameter builders.

---

## Features

1. **Stripe Webhook Signature Verification (`src/webhook.ts`)**:
   - RFC-compliant HMAC-SHA256 signature verification (`t=...,v1=...`).
   - Replay Attack protection: 300-second (5 min) tolerance window check using `crypto.timingSafeEqual` to prevent timing attacks.
   - Support for secret rotation with multiple `v1` signatures.

2. **Webhook Router & Idempotency Engine (`src/webhook.ts`)**:
   - Dedicated event routing for core events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`.
   - In-memory idempotency store with TTL (default 24h) and pluggable adapter interface (`IdempotencyStore`).
   - Prevents duplicate execution on webhook retries.

3. **Proration Math Algorithm (`src/proration.ts`)**:
   - Calculates exact Unused Credit (unconsumed value of old plan) and Prorated Cost (cost of new plan for remaining period).
   - Determines immediate `amountDue` (for upgrades) or `creditRolloverBalance` (for downgrades/credit surplus).
   - Cross-interval support: `align_period` (same cycle) vs `restart_cycle` (e.g. Month -> Annual).

4. **Subscription Lifecycle State Machine (`src/lifecycle.ts`)**:
   - Explicit state transitions: `incomplete`, `incomplete_expired`, `trialing`, `active`, `past_due`, `canceled`, `unpaid`, `paused`.
   - Terminal state enforcement and service entitlement checks (`isEntitled`).
   - Trial Expiration Resolver: `days` mode vs `until` campaign date mode, lifetime `trialUsedAt` checks.
   - Dual-mode cancellation: graceful `cancel_at_period_end` with revert capability vs immediate `canceled`.

5. **Plan Quota Reconciler (`src/quota-reconciler.ts`)**:
   - Soft-locks excess resources upon plan downgrade (e.g., Pro: 10 domains -> Starter: 2 domains).
   - Preserves customer data intact (no destructive deletes; marks status as `'frozen'`).
   - Eviction strategies: `newest` (default: keeps oldest active), `oldest`, `priority_low`, `priority_high`, `custom`.
   - Upgrade unfreezing: automatically reactivates frozen items up to new quota.
   - Multi-resource batch reconciliation (domains, shortlinks, seats, API keys).

6. **Checkout & Customer Portal Builders (`src/checkout.ts`)**:
   - Hosted & Embedded Checkout Session parameter builder.
   - URL validation, metadata sanitization (500 char limits, strings), and `{CHECKOUT_SESSION_ID}` placeholder helpers.
   - Stripe Customer Billing Portal session builder with cancellation & update flows.

---

## Quick Start

### 1. Webhook Verification & Routing

```typescript
import { StripeWebhookRouter } from '@kido/payment-stripe';

const router = new StripeWebhookRouter({
  secret: process.env.STRIPE_WEBHOOK_SECRET,
  toleranceInSeconds: 300,
});

router.onSubscriptionCreated(async (event) => {
  const subscription = event.data.object;
  console.log('Subscription created:', subscription.id);
});

router.onInvoicePaymentFailed(async (event) => {
  const invoice = event.data.object;
  console.log('Payment failed for invoice:', invoice.id);
});

// Inside your HTTP handler (Hono, Express, Next.js, Bun.serve)
export async function handleStripeWebhook(req: Request) {
  const rawBody = await req.text();
  const signature = req.headers.get('stripe-signature') || '';

  const result = await router.handleWebhook(rawBody, signature);
  if (result.duplicate) {
    return new Response(JSON.stringify({ status: 'already_processed' }), { status: 200 });
  }

  return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
}
```

### 2. Proration Math

```typescript
import { calculateProration } from '@kido/payment-stripe';

const result = calculateProration({
  oldPlan: { id: 'starter', amount: 3000, interval: 'month' }, // $30/mo
  newPlan: { id: 'pro', amount: 6000, interval: 'month' },     // $60/mo
  currentPeriodStart: 1700000000,
  currentPeriodEnd: 1702592000,
  effectiveTime: 1701296000, // 50% through cycle
});

console.log('Amount due now:', result.amountDue); // 1500 ($15.00)
console.log('Unused credit:', result.unusedCredit); // 1500 ($15.00)
console.log('Credit rollover:', result.creditRolloverBalance); // 0
```

### 3. Plan Quota Reconciler

```typescript
import { PlanQuotaReconciler } from '@kido/payment-stripe';

const domains = [
  { id: 'd1', domain: 'a.com', createdAt: 1000, status: 'active' },
  { id: 'd2', domain: 'b.com', createdAt: 2000, status: 'active' },
  { id: 'd3', domain: 'c.com', createdAt: 3000, status: 'active' },
];

// Downgrade to 1 domain: soft-locks 2 newest domains (d3, d2), preserves oldest (d1)
const result = PlanQuotaReconciler.reconcileCollection(domains, {
  resourceType: 'domains',
  allowedLimit: 1,
  strategy: 'newest',
});

console.log('Soft-locked IDs:', result.softLockedIds); // ['d3', 'd2']
console.log('Active domains:', result.activeItems); // [d1]
```

### 4. Checkout Session Builder

```typescript
import { buildCheckoutSessionParams } from '@kido/payment-stripe';

const params = buildCheckoutSessionParams({
  mode: 'subscription',
  checkoutMode: 'hosted',
  customerId: 'cus_123',
  lineItems: [{ priceId: 'price_pro_monthly', quantity: 1 }],
  successUrl: 'https://app.kt.com/success?session_id={CHECKOUT_SESSION_ID}',
  cancelUrl: 'https://app.kt.com/cancel',
  trialPeriodDays: 14,
  allowPromotionCodes: true,
  metadata: { userId: 42, plan: 'pro' },
});
```

---

## Testing

```bash
bun test
```
