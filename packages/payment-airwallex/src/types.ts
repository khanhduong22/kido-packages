/**
 * Supported Airwallex settlement and payment currencies
 */
export type AirwallexCurrency =
  | 'USD'
  | 'EUR'
  | 'GBP'
  | 'AUD'
  | 'CAD'
  | 'SGD'
  | 'HKD'
  | 'JPY';

/**
 * Supported global payment methods
 */
export type AirwallexPaymentMethod =
  | 'card'
  | 'applepay'
  | 'googlepay'
  | 'klarna'
  | 'paypal'
  | 'wechatpay'
  | 'alipay';

export type PaymentMethodCategory =
  | 'card'
  | 'wallet'
  | 'bnpl'
  | 'bank_transfer'
  | 'qr';

export interface LocalPaymentMethod {
  id: string;
  name: string;
  category: PaymentMethodCategory;
  badge?: string;
  tagline: string;
  iconName: string;
  supportedCurrencies: string[];
  popularIn: string[];
  feePercent?: number;
}

/**
 * Customer profile for payments
 */
export interface AirwallexCustomer {
  fullName?: string;
  email?: string;
  phone?: string;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
}

/**
 * Configuration payload for creating an Airwallex Payment Intent
 */
export interface AirwallexIntentConfig {
  amount: number;
  currency: AirwallexCurrency;
  merchantOrderId: string;
  customerEmail?: string;
  customerName?: string;
  metadata?: Record<string, any>;
}

/**
 * Status of an Airwallex Payment Intent (both uppercase Golden Standard and lowercase API values)
 */
export type AirwallexIntentStatus =
  | 'REQUIRES_PAYMENT_METHOD'
  | 'SUCCEEDED'
  | 'CANCELLED'
  | 'requires_payment_method'
  | 'processing'
  | 'succeeded'
  | 'failed';

/**
 * Airwallex Payment Intent returned from client or API
 */
export interface AirwallexPaymentIntent {
  id: string;
  amount: number;
  currency: AirwallexCurrency | string;
  status: AirwallexIntentStatus;
  clientSecret: string;
  merchantOrderId?: string;
  createdAt?: string;
  created?: number;
  metadata?: Record<string, any>;
}

/**
 * Card input for direct frontend validation / drop-in components
 * Supports both split fields (expMonth, expYear, name) and compound fields (expiry, cardholderName)
 */
export interface AirwallexCardInput {
  cardNumber: string;
  expMonth?: string;
  expYear?: string;
  expiry?: string; // MM / YY
  cvc: string;
  name?: string;
  cardholderName?: string;
}

/**
 * Recognized credit/debit card brands
 */
export type CardBrand =
  | 'visa'
  | 'mastercard'
  | 'amex'
  | 'jcb'
  | 'discover'
  | 'diners'
  | 'unionpay'
  | 'unknown';

/**
 * Result returned by card validation
 */
export interface CardValidationResult {
  isValid: boolean;
  brand: CardBrand;
  errors: Record<string, string>;
}

/**
 * Result returned by payment confirmation
 */
export interface AirwallexPaymentResult {
  success: boolean;
  transactionId: string;
  intentId: string;
  method: string;
  brand?: CardBrand;
  last4?: string;
  amount: number;
  currency: string;
  status: 'succeeded' | 'requires_action' | 'failed';
  message: string;
  timestamp: string;
}

/**
 * Webhook event payload from Airwallex
 */
export interface AirwallexWebhookEvent<T = any> {
  id: string;
  name: string;
  accountId?: string;
  data: {
    object: T;
  };
  createdAt: string;
}

/**
 * Options for client calls
 */
export interface AirwallexClientOptions {
  baseUrl?: string;
  isDemo?: boolean;
  timeoutMs?: number;
}
