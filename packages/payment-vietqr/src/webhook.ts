import { parsePayosWebhook, PayosWebhookOptions } from './payos';
import { parseSepayWebhook, SepayWebhookOptions } from './sepay';
import { ParsedWebhookResult } from './types';

export interface UnifiedWebhookOptions {
  sepay?: SepayWebhookOptions;
  payos?: PayosWebhookOptions;
  authHeader?: string | null;
}

/**
 * Universal Webhook Dispatcher
 * Automatically detects whether incoming payload is from SePay or PayOS
 */
export function parseUnifiedWebhook(
  rawBody: unknown,
  options: UnifiedWebhookOptions = {}
): ParsedWebhookResult {
  if (!rawBody || typeof rawBody !== 'object') {
    return {
      isValid: false,
      provider: 'unknown',
      orderCode: null,
      amount: 0,
      content: '',
      transactionId: '',
      bank: '',
      accountNumber: '',
      transactionDate: '',
      raw: rawBody,
      error: 'Invalid body: Expected JSON object'
    };
  }

  const obj = rawBody as Record<string, unknown>;

  // Detect PayOS: contains data object and signature
  if ('data' in obj && 'signature' in obj && typeof obj.data === 'object') {
    return parsePayosWebhook(rawBody, options.payos);
  }

  // Detect SePay: contains gateway, transferType, transferAmount, accumulated
  if ('transferType' in obj || 'transferAmount' in obj || 'gateway' in obj) {
    return parseSepayWebhook(rawBody, options.authHeader, options.sepay);
  }

  return {
    isValid: false,
    provider: 'unknown',
    orderCode: null,
    amount: 0,
    content: '',
    transactionId: '',
    bank: '',
    accountNumber: '',
    transactionDate: '',
    raw: rawBody,
    error: 'Unrecognized webhook format: Neither SePay nor PayOS schema matched'
  };
}
