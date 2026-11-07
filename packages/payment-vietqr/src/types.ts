import { z } from 'zod';

// ==========================================
// 1. Core Bank Types
// ==========================================
export interface BankInfo {
  bin: string;
  code: string;
  shortName: string;
  name: string;
  supportVietQr?: boolean;
}

// ==========================================
// 2. VietQR Options & Schemas
// ==========================================
export const PaymentRequestSchema = z.object({
  bank: z.string().min(1, 'Bank code or BIN is required'),
  accountNumber: z.string().min(1, 'Account number is required'),
  accountName: z.string().optional(),
  amount: z.number().nonnegative().optional(),
  description: z.string().optional(),
  orderCode: z.union([z.string(), z.number()]).optional(),
  template: z.enum(['compact', 'compact2', 'qr_only', 'print']).default('compact2').optional(),
});

export type PaymentRequest = z.infer<typeof PaymentRequestSchema>;

export interface VietQrOptions {
  bank: string; // BIN or Bank code (e.g., '970422' or 'MB')
  accountNumber: string;
  accountName?: string;
  amount?: number;
  description?: string;
  template?: 'compact' | 'compact2' | 'qr_only' | 'print';
}

export interface PaymentQrResult {
  emvco: string;
  vietQrUrl: string;
  sepayQrUrl: string;
  bank: BankInfo;
  accountNumber: string;
  accountName?: string;
  amount?: number;
  description?: string;
}

// ==========================================
// 3. SePay Webhook Payload Schema
// ==========================================
export const SepayWebhookPayloadSchema = z.object({
  id: z.union([z.number(), z.string()]).transform((val) => Number(val)),
  gateway: z.string(),
  transactionDate: z.string(),
  accountNumber: z.string(),
  code: z.string().nullable().optional(),
  content: z.string(),
  transferType: z.enum(['in', 'out']),
  transferAmount: z.number(),
  accumulated: z.number().optional().default(0),
  subAccount: z.string().nullable().optional(),
  referenceCode: z.string().nullable().optional(),
  description: z.string().optional(),
});

export type SepayWebhookPayload = z.infer<typeof SepayWebhookPayloadSchema>;

// ==========================================
// 4. PayOS Webhook Payload Schema
// ==========================================
export const PayosWebhookDataSchema = z.object({
  orderCode: z.number(),
  amount: z.number(),
  description: z.string(),
  accountNumber: z.string(),
  reference: z.string(),
  transactionDateTime: z.string(),
  currency: z.string().default('VND'),
  paymentLinkId: z.string().optional(),
  code: z.string(),
  desc: z.string(),
  counterAccountBankId: z.string().nullable().optional(),
  counterAccountBankName: z.string().nullable().optional(),
  counterAccountName: z.string().nullable().optional(),
  counterAccountNumber: z.string().nullable().optional(),
  virtualAccountName: z.string().nullable().optional(),
  virtualAccountNumber: z.string().nullable().optional(),
});

export type PayosWebhookData = z.infer<typeof PayosWebhookDataSchema>;

export const PayosWebhookPayloadSchema = z.object({
  code: z.string(),
  desc: z.string(),
  data: PayosWebhookDataSchema,
  signature: z.string(),
});

export type PayosWebhookPayload = z.infer<typeof PayosWebhookPayloadSchema>;

// ==========================================
// 5. Normalized Transaction & Parsed Webhook
// ==========================================
export const TransactionSchema = z.object({
  transactionId: z.string(),
  provider: z.enum(['sepay', 'payos', 'vietqr', 'manual']),
  orderCode: z.string().nullable(),
  amount: z.number().positive(),
  content: z.string(),
  bank: z.string(),
  accountNumber: z.string(),
  transactionDate: z.string(),
  referenceCode: z.string().nullable().optional(),
  raw: z.unknown(),
});

export type Transaction = z.infer<typeof TransactionSchema>;

export interface ParsedWebhookResult {
  isValid: boolean;
  provider: 'sepay' | 'payos' | 'unknown';
  orderCode: string | null;
  amount: number;
  content: string;
  transactionId: string;
  bank: string;
  accountNumber: string;
  transactionDate: string;
  raw: unknown;
  error?: string;
}
