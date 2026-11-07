import type {
  CheckoutSessionParamsInput,
  CustomerPortalParamsInput,
  StripeCheckoutSessionPayload,
  StripeCustomerPortalPayload,
} from './types';
import { toUnixSeconds } from './proration';

export class CheckoutValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CheckoutValidationError';
  }
}

/**
 * Sanitizes metadata key-value pairs into Stripe-compliant strings.
 * Stripe requires string values with max 500 characters each.
 */
export function sanitizeStripeMetadata(
  meta?: Record<string, any>
): Record<string, string> {
  if (!meta || typeof meta !== 'object') {
    return {};
  }

  const clean: Record<string, string> = {};
  for (const [key, val] of Object.entries(meta)) {
    if (val === null || val === undefined) {
      continue;
    }
    const str = typeof val === 'object' ? JSON.stringify(val) : String(val);
    clean[key] = str.slice(0, 500);
  }
  return clean;
}

/**
 * Replaces the {CHECKOUT_SESSION_ID} template variable with actual Stripe session ID.
 */
export function interpolateSessionId(url: string, sessionId: string): string {
  return url.replace(/\{CHECKOUT_SESSION_ID\}/g, sessionId);
}

/**
 * Builds and validates parameter payload for creating a Stripe Checkout Session.
 */
export function buildCheckoutSessionParams(
  input: CheckoutSessionParamsInput
): StripeCheckoutSessionPayload {
  if (!input.lineItems || input.lineItems.length === 0) {
    throw new CheckoutValidationError('At least one line item is required');
  }

  const mode = input.mode || 'subscription';
  const checkoutMode = input.checkoutMode || 'hosted';

  // Validate URLs according to UI mode
  if (checkoutMode === 'embedded') {
    if (!input.returnUrl) {
      throw new CheckoutValidationError('returnUrl is required for embedded checkout mode');
    }
  } else {
    // hosted mode
    if (!input.successUrl || !input.cancelUrl) {
      throw new CheckoutValidationError('successUrl and cancelUrl are required for hosted checkout mode');
    }
  }

  const payload: StripeCheckoutSessionPayload = {
    mode,
    ui_mode: checkoutMode,
    line_items: input.lineItems.map((item) => {
      if (!item.priceId) {
        throw new CheckoutValidationError('Each line item must have a valid priceId');
      }
      return {
        price: item.priceId,
        quantity: Math.max(1, item.quantity ?? 1),
      };
    }),
  };

  if (checkoutMode === 'embedded') {
    payload.return_url = input.returnUrl;
  } else {
    payload.success_url = input.successUrl;
    payload.cancel_url = input.cancelUrl;
  }

  if (input.customerId) {
    payload.customer = input.customerId;
  } else if (input.customerEmail) {
    payload.customer_email = input.customerEmail;
  }

  if (input.metadata) {
    payload.metadata = sanitizeStripeMetadata(input.metadata);
  }

  // Subscription specific configuration
  if (mode === 'subscription') {
    const subData: NonNullable<StripeCheckoutSessionPayload['subscription_data']> = {};

    if (input.subscriptionMetadata) {
      subData.metadata = sanitizeStripeMetadata(input.subscriptionMetadata);
    }

    if (input.trialEnd !== undefined) {
      subData.trial_end = toUnixSeconds(input.trialEnd);
    } else if (input.trialPeriodDays !== undefined && input.trialPeriodDays > 0) {
      subData.trial_period_days = input.trialPeriodDays;
    }

    if (Object.keys(subData).length > 0) {
      payload.subscription_data = subData;
    }
  }

  if (input.allowPromotionCodes) {
    payload.allow_promotion_codes = true;
  } else if (input.discounts && input.discounts.length > 0) {
    payload.discounts = input.discounts.filter((d) => d.coupon || d.promotion_code);
  }

  if (input.clientReferenceId) {
    payload.client_reference_id = input.clientReferenceId;
  }

  if (input.billingAddressCollection) {
    payload.billing_address_collection = input.billingAddressCollection;
  }

  if (input.taxIdCollection !== undefined) {
    payload.tax_id_collection = { enabled: input.taxIdCollection };
  }

  return payload;
}

/**
 * Builds and validates parameter payload for creating a Stripe Customer Billing Portal Session.
 */
export function buildCustomerPortalSessionParams(
  input: CustomerPortalParamsInput
): StripeCustomerPortalPayload {
  if (!input.customerId) {
    throw new CheckoutValidationError('customerId is required for Customer Portal session');
  }
  if (!input.returnUrl) {
    throw new CheckoutValidationError('returnUrl is required for Customer Portal session');
  }

  const payload: StripeCustomerPortalPayload = {
    customer: input.customerId,
    return_url: input.returnUrl,
  };

  if (input.configuration) {
    payload.configuration = input.configuration;
  }

  if (input.flowData) {
    payload.flow_data = input.flowData;
  }

  return payload;
}
