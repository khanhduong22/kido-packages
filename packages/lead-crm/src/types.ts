import { z } from 'zod';

export const UtmParamsSchema = z.object({
  utm_source: z.string().optional().default(''),
  utm_medium: z.string().optional().default(''),
  utm_campaign: z.string().optional().default(''),
  utm_term: z.string().optional().default(''),
  utm_content: z.string().optional().default(''),
  fbclid: z.string().optional(),
  ttclid: z.string().optional(),
  gclid: z.string().optional(),
});

export type UtmParams = z.infer<typeof UtmParamsSchema>;

export const SalesAgentSchema = z.object({
  id: z.string().min(1, 'Agent ID is required'),
  name: z.string().min(1, 'Agent name is required'),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  isActive: z.boolean().default(true),
  weight: z.number().int().positive().default(1),
  maxDailyLeads: z.number().int().positive().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type SalesAgent = z.infer<typeof SalesAgentSchema>;

export const LeadStatusSchema = z.enum([
  'NEW',
  'ASSIGNED',
  'CONTACTED',
  'QUALIFIED',
  'WON',
  'LOST',
]);

export type LeadStatus = z.infer<typeof LeadStatusSchema>;

export const LeadInputSchema = z.object({
  fullName: z.string().min(1, 'Full name is required'),
  phone: z.string().min(9, 'Phone number must be at least 9 characters'),
  email: z.string().email().optional().or(z.literal('')),
  note: z.string().optional().default(''),
  productInterest: z.string().optional().default(''),
  source: z.string().optional().default(''),
  utm: UtmParamsSchema.optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type LeadInput = z.infer<typeof LeadInputSchema>;

export const LeadRecordSchema = z.object({
  id: z.string().min(1),
  fullName: z.string().min(1),
  phone: z.string().regex(/^0[35789]\d{8}$/, 'Must be a 10-digit standard VN mobile number'),
  phoneRaw: z.string(),
  phoneE164: z.string(),
  carrier: z.string().optional(),
  email: z.string().email().optional().or(z.literal('')),
  note: z.string().default(''),
  productInterest: z.string().default(''),
  source: z.string().default('direct'),
  utm: UtmParamsSchema,
  status: LeadStatusSchema.default('NEW'),
  assignedTo: z.string().optional(),
  assignedAgentName: z.string().optional(),
  assignedAt: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type LeadRecord = z.infer<typeof LeadRecordSchema>;

export const GoogleSheetPayloadSchema = z.object({
  action: z.string().default('APPEND_ROW'),
  sheetName: z.string().optional(),
  headers: z.array(z.string()).optional(),
  row: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])),
  rowData: z.record(z.unknown()).optional(),
  metadata: z.record(z.unknown()).optional(),
  timestamp: z.string().optional(),
});

export type GoogleSheetPayload = z.infer<typeof GoogleSheetPayloadSchema>;

export const GoogleSheetBatchPayloadSchema = z.object({
  action: z.string().default('APPEND_ROWS'),
  sheetName: z.string().optional(),
  headers: z.array(z.string()).optional(),
  rows: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))),
  count: z.number(),
  metadata: z.record(z.unknown()).optional(),
  timestamp: z.string().optional(),
});

export type GoogleSheetBatchPayload = z.infer<typeof GoogleSheetBatchPayloadSchema>;
