import { z } from 'zod';

// ==========================================
// 1. Enums and Basic Domain Literals
// ==========================================
export const PerishableCategorySchema = z.enum([
  'FOOD',
  'FLOWERS',
  'PASTRY',
  'BEVERAGE',
  'GENERAL',
]);
export type PerishableCategory = z.infer<typeof PerishableCategorySchema>;

export const ExpiryStatusSchema = z.enum(['FRESH', 'EXPIRING_SOON', 'EXPIRED']);
export type ExpiryStatus = z.infer<typeof ExpiryStatusSchema>;

export const StockStatusSchema = z.enum([
  'OPTIMAL',
  'LOW_STOCK',
  'CRITICAL_LOW',
  'OUT_OF_STOCK',
]);
export type StockStatus = z.infer<typeof StockStatusSchema>;

export const AlertSeveritySchema = z.enum(['INFO', 'WARN', 'ERROR', 'CRITICAL']);
export type AlertSeverity = z.infer<typeof AlertSeveritySchema>;

export const ShrinkageReasonSchema = z.enum([
  'EXPIRED',
  'DAMAGED_CRUSHED',
  'QUALITY_DEGRADED',
  'SAMPLE_TASTING',
  'THEFT_LOSS',
  'OTHER',
]);
export type ShrinkageReason = z.infer<typeof ShrinkageReasonSchema>;

// ==========================================
// 2. Batch Item Schema (Fresh / Perishables)
// ==========================================
export const BatchItemSchema = z.object({
  batchId: z.string().min(1, 'Mã lô hàng không được để trống'),
  productId: z.string().min(1, 'Mã sản phẩm không được để trống'),
  productName: z.string().min(1, 'Tên sản phẩm không được để trống'),
  category: PerishableCategorySchema.default('GENERAL'),
  importedAt: z.union([z.string(), z.date()]),
  expiresAt: z.union([z.string(), z.date()]),
  initialQuantity: z.number().positive('Số lượng nhập ban đầu phải lớn hơn 0'),
  currentQuantity: z.number().nonnegative('Số lượng tồn hiện tại không được âm'),
  unit: z.string().default('cái'),
  costPerUnit: z.number().nonnegative().default(0),
  supplier: z.string().optional(),
  storageCondition: z.string().optional(),
  note: z.string().optional(),
});
export type BatchItem = z.infer<typeof BatchItemSchema>;
export type BatchItemInput = z.input<typeof BatchItemSchema>;

// ==========================================
// 3. Stock Inventory Schema
// ==========================================
export const StockInventorySchema = z.object({
  productId: z.string().min(1, 'Mã sản phẩm không được để trống'),
  productName: z.string().min(1, 'Tên sản phẩm không được để trống'),
  sku: z.string().optional(),
  category: PerishableCategorySchema.optional().default('GENERAL'),
  unit: z.string().default('cái'),
  minStockThreshold: z.number().nonnegative('Ngưỡng cảnh báo min không được âm'),
  criticalThreshold: z.number().nonnegative().optional(),
  maxStockThreshold: z.number().nonnegative().optional(),
  reorderQuantity: z.number().positive().optional(),
  batches: z.array(BatchItemSchema).default([]),
  lastAuditAt: z.union([z.string(), z.date()]).optional(),
});
export type StockInventory = z.infer<typeof StockInventorySchema>;
export type StockInventoryInput = z.input<typeof StockInventorySchema>;

// ==========================================
// 4. Stock Alert Payload Schema (compatible with @kido/notify)
// ==========================================
export const StockAlertPayloadSchema = z.object({
  alertId: z.string(),
  productId: z.string(),
  productName: z.string(),
  sku: z.string().optional(),
  category: PerishableCategorySchema.optional(),
  unit: z.string(),
  currentStock: z.number(),
  usableStock: z.number(),
  expiredStock: z.number().default(0),
  minStockThreshold: z.number(),
  criticalThreshold: z.number().optional(),
  stockStatus: StockStatusSchema,
  expiringBatchesCount: z.number().default(0),
  recommendedReorderQty: z.number().default(0),
  severity: AlertSeveritySchema,
  message: z.string(),
  timestamp: z.union([z.string(), z.date()]),
  telegramHtml: z.string().optional(),
});
export type StockAlertPayload = z.infer<typeof StockAlertPayloadSchema>;

// Interface compatible with @kido/notify SystemAlertPayload
export interface NotifySystemAlertPayload {
  service: string;
  title: string;
  message: string;
  level: 'INFO' | 'WARN' | 'ERROR' | 'CRITICAL';
  context?: Record<string, unknown>;
  timestamp?: Date | string;
  stack?: string;
}

// ==========================================
// 5. Shrinkage & Wastage Logger Schema
// ==========================================
export const ShrinkageRecordSchema = z.object({
  id: z.string().min(1),
  productId: z.string().min(1),
  productName: z.string().min(1),
  batchId: z.string().optional(),
  quantity: z.number().positive('Số lượng thất thoát phải lớn hơn 0'),
  unit: z.string().default('cái'),
  unitCost: z.number().nonnegative().default(0),
  totalLossValue: z.number().nonnegative(),
  reason: ShrinkageReasonSchema,
  note: z.string().optional(),
  recordedBy: z.string().optional(),
  loggedAt: z.union([z.string(), z.date()]),
});
export type ShrinkageRecord = z.infer<typeof ShrinkageRecordSchema>;

const ReasonSummaryDetailSchema = z.object({
  quantity: z.number(),
  lossValue: z.number(),
  count: z.number(),
});

export const ShrinkageSummarySchema = z.object({
  totalRecords: z.number(),
  totalQuantityLoss: z.number(),
  totalValueLoss: z.number(),
  shrinkageRatePercent: z.number(),
  byReason: z.object({
    EXPIRED: ReasonSummaryDetailSchema,
    DAMAGED_CRUSHED: ReasonSummaryDetailSchema,
    QUALITY_DEGRADED: ReasonSummaryDetailSchema,
    SAMPLE_TASTING: ReasonSummaryDetailSchema,
    THEFT_LOSS: ReasonSummaryDetailSchema,
    OTHER: ReasonSummaryDetailSchema,
  }),
});
export type ShrinkageSummary = z.infer<typeof ShrinkageSummarySchema>;

// ==========================================
// 6. Expiry Evaluation Options & Results
// ==========================================
export interface ExpiryEvaluationOptions {
  referenceDate?: Date | string;
  expiringSoonHours?: number; // Custom threshold in hours, e.g. 24h or 72h
  urgentClearanceHours?: number; // Threshold for flash sale / urgent action
}

export interface BatchExpiryEvaluation {
  batchId: string;
  productId: string;
  productName: string;
  category: PerishableCategory;
  expiresAt: Date;
  status: ExpiryStatus;
  remainingHours: number;
  remainingDays: number;
  isExpired: boolean;
  isUrgentClearanceNeeded: boolean;
  message: string;
}

export interface InventoryExpiryEvaluation {
  freshBatches: BatchItem[];
  expiringSoonBatches: BatchItem[];
  expiredBatches: BatchItem[];
  clearanceCandidates: BatchItem[];
  stats: {
    freshCount: number;
    expiringSoonCount: number;
    expiredCount: number;
    totalUsableQty: number;
    totalExpiringQty: number;
    totalExpiredQty: number;
  };
}

export interface FefoDeductionResult {
  requestedQuantity: number;
  deductedQuantity: number;
  unfulfilledQuantity: number;
  isFullyFulfilled: boolean;
  deductions: Array<{
    batchId: string;
    quantityDeducted: number;
    remainingInBatch: number;
    expiresAt: Date;
  }>;
}
