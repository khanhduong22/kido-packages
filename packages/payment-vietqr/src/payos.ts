import { createHmac, timingSafeEqual } from 'crypto';
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
 * Verifies PayOS webhook signature using timing-safe comparison
 */
export function verifyPayosSignature(
  data: Record<string, any>,
  signature: string,
  checksumKey: string
): boolean {
  if (!signature || !checksumKey || typeof checksumKey !== 'string' || !checksumKey.trim()) {
    return false;
  }
  const calculated = createPayosSignature(data, checksumKey);
  const calculatedBuf = Buffer.from(calculated.toLowerCase(), 'utf8');
  const signatureBuf = Buffer.from(signature.trim().toLowerCase(), 'utf8');

  if (calculatedBuf.length !== signatureBuf.length) {
    return false;
  }

  return timingSafeEqual(calculatedBuf, signatureBuf);
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

  // 1. Enforce fail-closed check: checksumKey is strictly required
  if (!options.checksumKey || typeof options.checksumKey !== 'string' || !options.checksumKey.trim()) {
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
      error: 'Missing required checksumKey: PayOS signature verification failed closed'
    };
  }

  // 2. Timing-safe signature verification
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
