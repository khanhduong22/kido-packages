import { calculateRemainingTime } from './batch-manager';
import {
  BatchExpiryEvaluation,
  BatchItem,
  ExpiryEvaluationOptions,
  ExpiryStatus,
  InventoryExpiryEvaluation,
  PerishableCategory,
} from './types';

/**
 * Standard default thresholds (in hours) per perishable category.
 * - FLOWERS: 24h (Hoa tươi)
 * - PASTRY: 48h (Bánh ngọt tươi)
 * - FOOD / BEVERAGE / GENERAL: 72h (3 ngày)
 */
export const DEFAULT_CATEGORY_THRESHOLDS: Record<PerishableCategory, number> = {
  FLOWERS: 24,
  PASTRY: 48,
  FOOD: 72,
  BEVERAGE: 72,
  GENERAL: 72,
};

/**
 * Evaluates the expiry status of an individual batch item.
 */
export function evaluateBatchExpiry(
  batch: BatchItem,
  options: ExpiryEvaluationOptions = {}
): BatchExpiryEvaluation {
  const referenceDate = options.referenceDate ? new Date(options.referenceDate) : new Date();
  const timeInfo = calculateRemainingTime(batch.expiresAt, referenceDate);

  // Category-based or custom threshold
  const thresholdHours =
    options.expiringSoonHours ?? DEFAULT_CATEGORY_THRESHOLDS[batch.category] ?? 72;

  // Urgent clearance threshold (defaults to 24 hours or custom)
  const urgentClearanceHours = options.urgentClearanceHours ?? 24;

  let status: ExpiryStatus;
  let message: string;
  let isUrgentClearanceNeeded = false;

  if (timeInfo.isExpired) {
    status = 'EXPIRED';
    message = `Lô ${batch.batchId} (${batch.productName}) đã quá hạn sử dụng. Cần tiêu hủy/ghi nhận hao hụt.`;
  } else if (timeInfo.totalHours <= thresholdHours) {
    status = 'EXPIRING_SOON';
    isUrgentClearanceNeeded = timeInfo.totalHours <= urgentClearanceHours;

    if (timeInfo.remainingDays > 0) {
      message = `Lô ${batch.batchId} còn ${timeInfo.remainingDays} ngày ${timeInfo.remainingHours} giờ sẽ hết hạn.`;
    } else {
      message = `Lô ${batch.batchId} còn ${timeInfo.remainingHours} giờ sẽ hết hạn (cần ưu tiên xử lý gấp!).`;
    }
  } else {
    status = 'FRESH';
    message = `Lô ${batch.batchId} tươi mới, hạn sử dụng còn ${timeInfo.remainingDays} ngày.`;
  }

  return {
    batchId: batch.batchId,
    productId: batch.productId,
    productName: batch.productName,
    category: batch.category,
    expiresAt: new Date(batch.expiresAt),
    status,
    remainingHours: timeInfo.remainingHours,
    remainingDays: timeInfo.remainingDays,
    isExpired: timeInfo.isExpired,
    isUrgentClearanceNeeded,
    message,
  };
}

/**
 * Evaluates a collection of batches, providing partitioned lists and aggregate statistics.
 */
export function evaluateInventoryExpiry(
  batches: BatchItem[],
  options: ExpiryEvaluationOptions = {}
): InventoryExpiryEvaluation {
  const freshBatches: BatchItem[] = [];
  const expiringSoonBatches: BatchItem[] = [];
  const expiredBatches: BatchItem[] = [];
  const clearanceCandidates: BatchItem[] = [];

  let totalUsableQty = 0;
  let totalExpiringQty = 0;
  let totalExpiredQty = 0;

  for (const batch of batches) {
    const evaluation = evaluateBatchExpiry(batch, options);

    if (evaluation.status === 'EXPIRED') {
      expiredBatches.push(batch);
      totalExpiredQty += batch.currentQuantity;
    } else if (evaluation.status === 'EXPIRING_SOON') {
      expiringSoonBatches.push(batch);
      totalExpiringQty += batch.currentQuantity;
      totalUsableQty += batch.currentQuantity;

      if (evaluation.isUrgentClearanceNeeded && batch.currentQuantity > 0) {
        clearanceCandidates.push(batch);
      }
    } else {
      freshBatches.push(batch);
      totalUsableQty += batch.currentQuantity;
    }
  }

  return {
    freshBatches,
    expiringSoonBatches,
    expiredBatches,
    clearanceCandidates,
    stats: {
      freshCount: freshBatches.length,
      expiringSoonCount: expiringSoonBatches.length,
      expiredCount: expiredBatches.length,
      totalUsableQty,
      totalExpiringQty,
      totalExpiredQty,
    },
  };
}

/**
 * Helper to get a localized badge label for ExpiryStatus
 */
export function getExpiryStatusLabel(status: ExpiryStatus): string {
  switch (status) {
    case 'FRESH':
      return '🟢 TƯƠI MỚI (AN TOÀN)';
    case 'EXPIRING_SOON':
      return '⚠️ SẮP HẾT HẠN';
    case 'EXPIRED':
      return '❌ ĐÃ QUÁ HẠN';
  }
}
