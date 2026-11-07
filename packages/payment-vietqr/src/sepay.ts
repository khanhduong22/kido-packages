import { ParsedWebhookResult, SepayWebhookPayload, SepayWebhookPayloadSchema } from './types';

export interface SepayWebhookOptions {
  /** Expected SePay API Key configured in SePay webhook settings */
  apiKey?: string;
  /** Custom regex pattern to match order code inside transfer content */
  orderPattern?: RegExp;
  /** Minimum transfer amount to accept */
  minAmount?: number;
}

/**
 * Extracts order code from payment transfer description / content
 * Supports patterns like: DH12345, ORD-12345, FF1002, SPA-99, or standalone order codes.
 */
export function extractOrderCode(
  content: string,
  pattern: RegExp = /(?:DH|ORD|ORDER|SPA|FF|INV|BILL)[\s\-_]?([A-Za-z0-9]+)/i
): string | null {
  if (!content) return null;
  const match = content.match(pattern);
  if (match && match[1]) {
    return match[1];
  }

  // Fallback: search for continuous digits preceded by letters or standalone uppercase alphanumeric token
  const fallbackMatch = content.match(/\b([A-Z]{2,4}\d{3,8})\b/i);
  if (fallbackMatch && fallbackMatch[1]) {
    return fallbackMatch[1];
  }

  return null;
}

/**
 * Verifies SePay Webhook Authorization Header
 * SePay sends header: "Authorization: Apikey <API_KEY>" or "Authorization: Bearer <API_KEY>"
 */
export function verifySepayAuthorization(
  authHeader: string | null | undefined,
  expectedApiKey: string
): boolean {
  if (!expectedApiKey) return true;
  if (!authHeader) return false;

  const cleanHeader = authHeader.trim();
  const token = cleanHeader.replace(/^(Apikey|Bearer)\s+/i, '').trim();

  return token === expectedApiKey.trim();
}

/**
 * Parses and validates incoming SePay webhook payload
 */
export function parseSepayWebhook(
  rawBody: unknown,
  authHeader?: string | null,
  options: SepayWebhookOptions = {}
): ParsedWebhookResult {
  // 1. Verify authorization header if API Key is configured
  if (options.apiKey) {
    const isAuthorized = verifySepayAuthorization(authHeader, options.apiKey);
    if (!isAuthorized) {
      return {
        isValid: false,
        provider: 'sepay',
        orderCode: null,
        amount: 0,
        content: '',
        transactionId: '',
        bank: '',
        accountNumber: '',
        transactionDate: '',
        raw: rawBody,
        error: 'Unauthorized: Invalid or missing SePay API Key'
      };
    }
  }

  // 2. Parse schema with Zod
  const parseResult = SepayWebhookPayloadSchema.safeParse(rawBody);
  if (!parseResult.success) {
    return {
      isValid: false,
      provider: 'sepay',
      orderCode: null,
      amount: 0,
      content: '',
      transactionId: '',
      bank: '',
      accountNumber: '',
      transactionDate: '',
      raw: rawBody,
      error: `Invalid SePay webhook payload: ${parseResult.error.message}`
    };
  }

  const payload: SepayWebhookPayload = parseResult.data;

  // 3. Filter only incoming transfers ("in")
  if (payload.transferType !== 'in') {
    return {
      isValid: false,
      provider: 'sepay',
      orderCode: null,
      amount: payload.transferAmount,
      content: payload.content,
      transactionId: String(payload.id),
      bank: payload.gateway,
      accountNumber: payload.accountNumber,
      transactionDate: payload.transactionDate,
      raw: rawBody,
      error: `Ignored outbound transaction type: ${payload.transferType}`
    };
  }

  // 4. Validate minimum amount if specified
  if (options.minAmount && payload.transferAmount < options.minAmount) {
    return {
      isValid: false,
      provider: 'sepay',
      orderCode: null,
      amount: payload.transferAmount,
      content: payload.content,
      transactionId: String(payload.id),
      bank: payload.gateway,
      accountNumber: payload.accountNumber,
      transactionDate: payload.transactionDate,
      raw: rawBody,
      error: `Amount ${payload.transferAmount} is below required minimum ${options.minAmount}`
    };
  }

  // 5. Extract order code
  const orderCode = extractOrderCode(payload.content, options.orderPattern);

  return {
    isValid: true,
    provider: 'sepay',
    orderCode,
    amount: payload.transferAmount,
    content: payload.content,
    transactionId: String(payload.id),
    bank: payload.gateway,
    accountNumber: payload.accountNumber,
    transactionDate: payload.transactionDate,
    raw: payload
  };
}
