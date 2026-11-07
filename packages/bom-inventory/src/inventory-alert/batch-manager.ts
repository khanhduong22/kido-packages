import {
  BatchItem,
  BatchItemSchema,
  FefoDeductionResult,
  PerishableCategory,
} from './types';

/**
 * Calculates remaining time until expiration relative to a reference date.
 */
export function calculateRemainingTime(
  expiresAt: Date | string,
  referenceDate: Date | string = new Date()
): {
  totalHours: number;
  remainingDays: number;
  remainingHours: number;
  isExpired: boolean;
} {
  const expiry = new Date(expiresAt);
  const ref = new Date(referenceDate);

  const diffMs = expiry.getTime() - ref.getTime();
  const totalHours = Math.floor(diffMs / (1000 * 60 * 60));
  const isExpired = diffMs <= 0;

  if (isExpired) {
    return {
      totalHours: 0,
      remainingDays: 0,
      remainingHours: 0,
      isExpired: true,
    };
  }

  const remainingDays = Math.floor(totalHours / 24);
  const remainingHours = totalHours % 24;

  return {
    totalHours,
    remainingDays,
    remainingHours,
    isExpired: false,
  };
}

export class BatchManager {
  private batches: Map<string, BatchItem> = new Map();

  constructor(initialBatches?: BatchItem[]) {
    if (initialBatches && initialBatches.length > 0) {
      for (const batch of initialBatches) {
        this.addBatch(batch);
      }
    }
  }

  /**
   * Adds or registers a new perishable batch with validation.
   */
  public addBatch(batchInput: unknown): BatchItem {
    const validated = BatchItemSchema.parse(batchInput);
    if (this.batches.has(validated.batchId)) {
      throw new Error(`Lô hàng với mã batchId "${validated.batchId}" đã tồn tại.`);
    }
    this.batches.set(validated.batchId, validated);
    return validated;
  }

  /**
   * Retrieves a specific batch by ID.
   */
  public getBatch(batchId: string): BatchItem | undefined {
    return this.batches.get(batchId);
  }

  /**
   * Returns all batches, optionally filtered by productId or category.
   */
  public getBatches(filter?: {
    productId?: string;
    category?: PerishableCategory;
  }): BatchItem[] {
    const list = Array.from(this.batches.values());
    return list.filter((b) => {
      if (filter?.productId && b.productId !== filter.productId) return false;
      if (filter?.category && b.category !== filter.category) return false;
      return true;
    });
  }

  /**
   * Returns active, unexpired batches with remaining quantity > 0.
   */
  public getActiveBatches(
    productId?: string,
    referenceDate: Date | string = new Date()
  ): BatchItem[] {
    const refTime = new Date(referenceDate).getTime();
    return this.getBatches(productId ? { productId } : undefined).filter((b) => {
      const expTime = new Date(b.expiresAt).getTime();
      return b.currentQuantity > 0 && expTime > refTime;
    });
  }

  /**
   * Returns expired batches that still have quantity recorded.
   */
  public getExpiredBatches(
    productId?: string,
    referenceDate: Date | string = new Date()
  ): BatchItem[] {
    const refTime = new Date(referenceDate).getTime();
    return this.getBatches(productId ? { productId } : undefined).filter((b) => {
      const expTime = new Date(b.expiresAt).getTime();
      return expTime <= refTime;
    });
  }

  /**
   * Gets batches sorted in FEFO order (First-Expired, First-Out).
   * Earliest expiring batches appear first. Expired batches are excluded.
   */
  public getBatchesSortedFEFO(
    productId: string,
    referenceDate: Date | string = new Date()
  ): BatchItem[] {
    const active = this.getActiveBatches(productId, referenceDate);
    return active.sort((a, b) => {
      const timeA = new Date(a.expiresAt).getTime();
      const timeB = new Date(b.expiresAt).getTime();
      return timeA - timeB;
    });
  }

  /**
   * Deducts requested quantity according to FEFO strategy (earliest expiring first).
   * Mutates the batch quantities in memory and returns a comprehensive deduction result.
   */
  public deductStockFEFO(
    productId: string,
    quantityToDeduct: number,
    referenceDate: Date | string = new Date()
  ): FefoDeductionResult {
    if (quantityToDeduct <= 0) {
      throw new Error('Số lượng xuất kho phải lớn hơn 0.');
    }

    const fefoBatches = this.getBatchesSortedFEFO(productId, referenceDate);
    let remainingNeeded = quantityToDeduct;
    const deductions: FefoDeductionResult['deductions'] = [];

    for (const batch of fefoBatches) {
      if (remainingNeeded <= 0) break;

      const deductAmount = Math.min(batch.currentQuantity, remainingNeeded);
      batch.currentQuantity -= deductAmount;
      remainingNeeded -= deductAmount;

      deductions.push({
        batchId: batch.batchId,
        quantityDeducted: deductAmount,
        remainingInBatch: batch.currentQuantity,
        expiresAt: new Date(batch.expiresAt),
      });
    }

    const deductedQuantity = quantityToDeduct - remainingNeeded;

    return {
      requestedQuantity: quantityToDeduct,
      deductedQuantity,
      unfulfilledQuantity: remainingNeeded,
      isFullyFulfilled: remainingNeeded === 0,
      deductions,
    };
  }

  /**
   * Computes stock totals (total physical, usable unexpired, expired) for a product.
   */
  public calculateProductStock(
    productId: string,
    referenceDate: Date | string = new Date()
  ): {
    totalStock: number;
    usableStock: number;
    expiredStock: number;
    activeBatchesCount: number;
  } {
    const all = this.getBatches({ productId });
    const refTime = new Date(referenceDate).getTime();

    let totalStock = 0;
    let usableStock = 0;
    let expiredStock = 0;
    let activeBatchesCount = 0;

    for (const b of all) {
      totalStock += b.currentQuantity;
      const isExp = new Date(b.expiresAt).getTime() <= refTime;
      if (isExp) {
        expiredStock += b.currentQuantity;
      } else if (b.currentQuantity > 0) {
        usableStock += b.currentQuantity;
        activeBatchesCount++;
      }
    }

    return {
      totalStock,
      usableStock,
      expiredStock,
      activeBatchesCount,
    };
  }
}
