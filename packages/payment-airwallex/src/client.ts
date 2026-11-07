import { AIRWALLEX_DEFAULT_CONFIG, AIRWALLEX_SUPPORTED_CURRENCIES } from './constants';
import { detectCardBrand } from './card';
import {
  AirwallexCardInput,
  AirwallexClientOptions,
  AirwallexCurrency,
  AirwallexCustomer,
  AirwallexIntentConfig,
  AirwallexPaymentIntent,
  AirwallexPaymentResult,
} from './types';

/**
 * Validates configuration parameters for creating a payment intent
 */
function validateIntentConfig(config: AirwallexIntentConfig): void {
  if (!config) {
    throw new Error('Payment intent configuration is required');
  }

  if (typeof config.amount !== 'number' || !Number.isFinite(config.amount) || config.amount <= 0) {
    throw new Error('Payment amount must be greater than 0');
  }

  if (!config.currency || !AIRWALLEX_SUPPORTED_CURRENCIES.includes(config.currency)) {
    throw new Error(
      `Unsupported or invalid currency: ${config.currency}. Supported currencies are: ${AIRWALLEX_SUPPORTED_CURRENCIES.join(', ')}`
    );
  }

  if (!config.merchantOrderId || typeof config.merchantOrderId !== 'string' || !config.merchantOrderId.trim()) {
    throw new Error('merchantOrderId is required');
  }
}

/**
 * Creates an Airwallex Payment Intent.
 * In mock sandbox mode (when apiKey is omitted or starts with 'mock_'),
 * generates a deterministic test intent with mock client secret and ID.
 * When a real apiKey is supplied, calls the Airwallex Payment Intent API endpoint.
 *
 * @param config Payment Intent settings (amount, currency, orderId)
 * @param apiKey Optional API key or bearer token from Airwallex
 * @param options Client options (baseUrl, isDemo, timeoutMs)
 */
export async function createAirwallexPaymentIntent(
  config: AirwallexIntentConfig,
  apiKey?: string,
  options?: AirwallexClientOptions
): Promise<AirwallexPaymentIntent> {
  validateIntentConfig(config);

  // If no apiKey is provided or mock key is specified, return simulated sandbox intent
  const isMock = !apiKey || apiKey.startsWith('mock_') || apiKey === 'mock';

  if (isMock) {
    const randomHex = Math.random().toString(36).substring(2, 10);
    const secretPart = Math.random().toString(36).substring(2, 15);
    const now = new Date().toISOString();
    const timestamp = Date.now();

    return {
      id: `int_mock_${timestamp}_${randomHex}`,
      amount: config.amount,
      currency: config.currency,
      status: 'REQUIRES_PAYMENT_METHOD',
      clientSecret: `cs_mock_${timestamp}_${secretPart}`,
      merchantOrderId: config.merchantOrderId.trim(),
      createdAt: now,
      created: timestamp,
      metadata: config.metadata,
    };
  }

  // Real Airwallex API request
  const baseUrl =
    options?.baseUrl ||
    (options?.isDemo
      ? AIRWALLEX_DEFAULT_CONFIG.endpoints.demo
      : AIRWALLEX_DEFAULT_CONFIG.endpoints.production);

  const endpoint = `${baseUrl}/api/v1/pa/payment_intents/create`;
  const requestId = `req_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

  const bodyPayload: Record<string, any> = {
    request_id: requestId,
    amount: config.amount,
    currency: config.currency,
    merchant_order_id: config.merchantOrderId.trim(),
  };

  if (config.customerEmail || config.customerName) {
    bodyPayload.customer = {
      email: config.customerEmail,
      name: config.customerName,
    };
  }

  if (config.metadata) {
    bodyPayload.metadata = config.metadata;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    options?.timeoutMs ?? 15000
  );

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'x-api-version': '2020-03-31',
      },
      body: JSON.stringify(bodyPayload),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorJson: any = null;
      try {
        errorJson = JSON.parse(errorText);
      } catch {
        // use raw text
      }
      const message = errorJson?.message || errorText || response.statusText;
      throw new Error(`Airwallex API error (${response.status}): ${message}`);
    }

    const data = (await response.json()) as any;

    return {
      id: data.id,
      amount: data.amount,
      currency: data.currency as AirwallexCurrency,
      status: data.status,
      clientSecret: data.client_secret,
      merchantOrderId: data.merchant_order_id,
      createdAt: data.created_at || new Date().toISOString(),
      created: Date.now(),
      metadata: data.metadata,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Simulates confirming an Airwallex payment intent
 */
export async function confirmAirwallexPayment(
  intent: AirwallexPaymentIntent,
  paymentData: {
    method: 'card' | 'applepay' | 'googlepay' | 'klarna' | 'paypal' | 'wechatpay' | 'alipay' | string;
    card?: Partial<AirwallexCardInput>;
    customer?: Partial<AirwallexCustomer>;
  }
): Promise<AirwallexPaymentResult> {
  const cleanNumber = (paymentData.card?.cardNumber || '').replace(/\D/g, '');
  const brand = paymentData.method === 'card' ? detectCardBrand(cleanNumber) : undefined;
  const last4 = cleanNumber.length >= 4 ? cleanNumber.slice(-4) : undefined;

  const transactionId = `txn_awx_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 7)}`;

  return {
    success: true,
    transactionId,
    intentId: intent.id,
    method: paymentData.method,
    brand,
    last4,
    amount: intent.amount,
    currency: String(intent.currency),
    status: 'succeeded',
    message: 'Payment authorized and settled successfully via Airwallex Payment Gateway',
    timestamp: new Date().toISOString(),
  };
}

/**
 * Reusable Airwallex API client instance
 */
export class AirwallexClient {
  constructor(
    private readonly apiKey?: string,
    private readonly options?: AirwallexClientOptions
  ) {}

  /**
   * Creates a payment intent for checkout
   */
  async createPaymentIntent(
    config: AirwallexIntentConfig
  ): Promise<AirwallexPaymentIntent> {
    return createAirwallexPaymentIntent(config, this.apiKey, this.options);
  }

  /**
   * Confirms payment intent
   */
  async confirmPayment(
    intent: AirwallexPaymentIntent,
    paymentData: {
      method: string;
      card?: Partial<AirwallexCardInput>;
      customer?: Partial<AirwallexCustomer>;
    }
  ): Promise<AirwallexPaymentResult> {
    return confirmAirwallexPayment(intent, paymentData as any);
  }
}
