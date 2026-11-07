import { AirwallexCardInput, AirwallexCurrency, AirwallexPaymentMethod } from './types';

export const AIRWALLEX_MARKETS_COUNT = 180;
export const AIRWALLEX_LOCAL_METHODS_COUNT = 160;
export const AIRWALLEX_CURRENCIES_COUNT = 20;

/**
 * All supported settlement and payment currencies
 */
export const AIRWALLEX_SUPPORTED_CURRENCIES: readonly AirwallexCurrency[] = [
  'USD',
  'EUR',
  'GBP',
  'AUD',
  'CAD',
  'SGD',
  'HKD',
  'JPY',
] as const;

/**
 * All supported payment methods
 */
export const AIRWALLEX_SUPPORTED_METHODS: readonly AirwallexPaymentMethod[] = [
  'card',
  'applepay',
  'googlepay',
  'klarna',
  'paypal',
  'wechatpay',
  'alipay',
] as const;

/**
 * Human-readable localized labels for payment methods
 */
export const AIRWALLEX_METHOD_LABELS: Record<AirwallexPaymentMethod, string> = {
  card: 'Credit / Debit Card',
  applepay: 'Apple Pay',
  googlepay: 'Google Pay',
  klarna: 'Klarna Pay Later',
  paypal: 'PayPal',
  wechatpay: 'WeChat Pay',
  alipay: 'Alipay',
};

/**
 * Symbol prefixes for supported currencies
 */
export const AIRWALLEX_CURRENCY_SYMBOLS: Record<AirwallexCurrency, string> = {
  USD: '$',
  EUR: '€',
  GBP: '£',
  AUD: 'A$',
  CAD: 'CA$',
  SGD: 'S$',
  HKD: 'HK$',
  JPY: '¥',
};

/**
 * Currencies that do not use fractional/decimal sub-units
 */
export const AIRWALLEX_ZERO_DECIMAL_CURRENCIES: readonly AirwallexCurrency[] = [
  'JPY',
] as const;

/**
 * Default SDK and client configurations
 */
export const AIRWALLEX_DEFAULT_CONFIG = {
  defaultCurrency: 'USD' as AirwallexCurrency,
  defaultMethods: ['card', 'applepay', 'googlepay'] as readonly AirwallexPaymentMethod[],
  apiVersion: 'v1',
  env: 'production' as const,
  endpoints: {
    demo: 'https://api-demo.airwallex.com',
    production: 'https://api.airwallex.com',
  },
};

/**
 * Map of supported payment methods per currency
 */
export const AIRWALLEX_CURRENCY_METHODS_MAP: Record<
  AirwallexCurrency,
  AirwallexPaymentMethod[]
> = {
  USD: ['card', 'applepay', 'googlepay', 'paypal', 'klarna'],
  EUR: ['card', 'applepay', 'googlepay', 'klarna', 'paypal'],
  GBP: ['card', 'applepay', 'googlepay', 'klarna', 'paypal'],
  AUD: ['card', 'applepay', 'googlepay', 'paypal', 'klarna'],
  CAD: ['card', 'applepay', 'googlepay', 'paypal', 'klarna'],
  SGD: ['card', 'applepay', 'googlepay', 'alipay', 'wechatpay'],
  HKD: ['card', 'applepay', 'googlepay', 'alipay', 'wechatpay'],
  JPY: ['card', 'applepay', 'googlepay', 'alipay', 'wechatpay', 'paypal'],
};

/**
 * Retrieves payment methods applicable for a given currency
 */
export function getSupportedMethodsByCurrency(
  currency: AirwallexCurrency
): AirwallexPaymentMethod[] {
  return AIRWALLEX_CURRENCY_METHODS_MAP[currency] ?? ['card', 'applepay', 'googlepay'];
}

/**
 * Formats monetary amounts consistently according to currency standards
 * (e.g. $100.00 for USD, ¥100 for JPY)
 */
export function formatAirwallexAmount(
  amount: number,
  currency: AirwallexCurrency
): string {
  const isZeroDecimal = AIRWALLEX_ZERO_DECIMAL_CURRENCIES.includes(currency);
  const symbol = AIRWALLEX_CURRENCY_SYMBOLS[currency] ?? `${currency} `;

  if (isZeroDecimal) {
    const formatted = Math.round(amount).toLocaleString('en-US');
    return `${symbol}${formatted}`;
  }

  const formatted = amount.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${symbol}${formatted}`;
}

export interface AirwallexSandboxPreset {
  id: string;
  label: string;
  description: string;
  card: AirwallexCardInput;
}

export const AIRWALLEX_SANDBOX_CARDS: readonly AirwallexSandboxPreset[] = [
  {
    id: 'visa_success',
    label: '⚡ Visa (Default Test Card)',
    description: 'Instant success test card for general checkout',
    card: {
      cardNumber: '4111 1111 1111 1111',
      expMonth: '12',
      expYear: '2028',
      cvc: '123',
      name: 'John Doe',
    },
  },
  {
    id: 'mastercard_success',
    label: 'Mastercard 3D-Secure',
    description: 'Mastercard high-tier test credential',
    card: {
      cardNumber: '5500 0000 0000 0004',
      expMonth: '10',
      expYear: '2027',
      cvc: '456',
      name: 'Jane Smith',
    },
  },
  {
    id: 'amex_success',
    label: 'American Express EDC',
    description: 'Amex corporate test card (4-digit CVC)',
    card: {
      cardNumber: '3782 822463 10005',
      expMonth: '11',
      expYear: '2026',
      cvc: '1234',
      name: 'Alex Vance',
    },
  },
  {
    id: 'jcb_success',
    label: 'JCB International',
    description: 'JCB Japan & Asia-Pacific regional test card',
    card: {
      cardNumber: '3530 1113 3330 0000',
      expMonth: '08',
      expYear: '2029',
      cvc: '789',
      name: 'Kenji Sato',
    },
  },
] as const;
