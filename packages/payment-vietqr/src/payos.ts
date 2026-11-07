import { createHmac } from 'crypto';
import { extractOrderCode } from './sepay';
import { ParsedWebhookResult, PayosWebhookData, PayosWebhookPayload, PayosWebhookPayloadSchema } from './types';

export interface PayosWebhookOptions {
  /** PayOS Checksum Key from Developer Portal */
  checksumKey?: string;
  /** Custom regex pattern to match order code inside transfer description */
  orderPattern?: RegExp;
}

/**
 * Creates PayOS signature from data object sorted alphabetically
 */
export function createPayosSignature(data: Record<string, any>, checksumKey: string): string {
  const sortedKeys = Object.keys(data).sort();
  const pairs: string[] = [];

  for (const key of sortedKeys) {
    let val = data[key];
    if (val === undefined || val === null) {
      val = '';
    } else if (typeof val === 'object') {
      val = JSON.stringify(val);
    }
    pairs.push(`${key}=${val}`);
  }

  const signData = pairs.join('&');
  return createHmac('sha256', checksumKey).update(signData).digest('hex');
}

/**
 * Verifies PayOS webhook signature
 */
export function verifyPayosSignature(
  data: Record<string, any>,
  signature: string,
  checksumKey: string
): boolean {
  if (!signature || !checksumKey) return false;
  const calculated = createPayosSignature(data, checksumKey);
  return calculated.toLowerCase() === signature.trim().toLowerCase();
}

/**
 * Parses and verifies PayOS Webhook Payload
 */
export function parsePayosWebhook(
  rawBody: unknown,
  options: PayosWebhookOptions = {}
): ParsedWebhookResult {
  const parseResult = PayosWebhookPayloadSchema.safeParse(rawBody);
  if (!parseResult.success) {
    return {
      isValid: false,
      provider: 'payos',
      orderCode: null,
      amount: 0,
      content: '',
      transactionId: '',
      bank: '',
      accountNumber: '',
      transactionDate: '',
      raw: rawBody,
      error: `Invalid PayOS webhook payload: ${parseResult.error.message}`
    };
  }

  const payload: PayosWebhookPayload = parseResult.data;
  const data: PayosWebhookData = payload.data;

  // Verify signature if checksumKey provided
  if (options.checksumKey) {
    const isValidSignature = verifyPayosSignature(data, payload.signature, options.checksumKey);
    if (!isValidSignature) {
      return {
        isValid: false,
        provider: 'payos',
        orderCode: String(data.orderCode),
        amount: data.amount,
        content: data.description,
        transactionId: data.reference,
        bank: data.counterAccountBankName || 'Unknown Bank',
        accountNumber: data.accountNumber,
        transactionDate: data.transactionDateTime,
        raw: rawBody,
        error: 'Invalid PayOS HMAC signature'
      };
    }
  }

  // Check if status is success
  if (payload.code !== '00' || data.code !== '00') {
    return {
      isValid: false,
      provider: 'payos',
      orderCode: String(data.orderCode),
      amount: data.amount,
      content: data.description,
      transactionId: data.reference,
      bank: data.counterAccountBankName || '',
      accountNumber: data.accountNumber,
      transactionDate: data.transactionDateTime,
      raw: payload,
      error: `PayOS transaction failed with code: ${payload.code} - ${payload.desc}`
    };
  }

  // Extract order code (payos already provides numeric orderCode, or parse string description)
  const orderCode = String(data.orderCode) || extractOrderCode(data.description, options.orderPattern);

  return {
    isValid: true,
    provider: 'payos',
    orderCode,
    amount: data.amount,
    content: data.description,
    transactionId: data.reference,
    bank: data.counterAccountBankName || 'PayOS Gateway',
    accountNumber: data.accountNumber,
    transactionDate: data.transactionDateTime,
    raw: payload
  };
}
