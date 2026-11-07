import {
  ShrinkageReason,
  ShrinkageRecord,
  ShrinkageRecordSchema,
  ShrinkageSummary,
  ShrinkageSummarySchema,
} from './types';

export interface CreateShrinkageInput {
  id?: string;
  productId: string;
  productName: string;
  batchId?: string;
  quantity: number;
  unit?: string;
  unitCost?: number;
  reason: ShrinkageReason;
  note?: string;
  recordedBy?: string;
  loggedAt?: Date | string;
}

export class ShrinkageLogger {
  private records: ShrinkageRecord[] = [];

  constructor(initialRecords?: ShrinkageRecord[]) {
    if (initialRecords && initialRecords.length > 0) {
      for (const rec of initialRecords) {
        this.records.push(ShrinkageRecordSchema.parse(rec));
      }
    }
  }

  /**
   * Logs a new shrinkage/wastage record.
   * Calculates totalLossValue = quantity * unitCost automatically.
   */
  public logShrinkage(input: CreateShrinkageInput): ShrinkageRecord {
    const id = input.id || `SHRINK-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const unitCost = input.unitCost ?? 0;
    const totalLossValue = Math.round(input.quantity * unitCost);

    const record: ShrinkageRecord = {
      id,
      productId: input.productId,
      productName: input.productName,
      batchId: input.batchId,
      quantity: input.quantity,
      unit: input.unit ?? 'cái',
      unitCost,
      totalLossValue,
      reason: input.reason,
      note: input.note,
      recordedBy: input.recordedBy,
      loggedAt: input.loggedAt ? new Date(input.loggedAt) : new Date(),
    };

    const validated = ShrinkageRecordSchema.parse(record);
    this.records.push(validated);
    return validated;
  }

  /**
   * Retrieves all logged records, optionally filtered by productId or reason.
   */
  public getRecords(filter?: {
    productId?: string;
    reason?: ShrinkageReason;
    batchId?: string;
  }): ShrinkageRecord[] {
    return this.records.filter((r) => {
      if (filter?.productId && r.productId !== filter.productId) return false;
      if (filter?.reason && r.reason !== filter.reason) return false;
      if (filter?.batchId && r.batchId !== filter.batchId) return false;
      return true;
    });
  }

  /**
   * Calculates shrinkage rate as a percentage of total received quantity:
   * (totalLossQuantity / totalReceivedQuantity) * 100
   */
  public calculateShrinkageRate(
    totalReceivedQuantity: number,
    lossRecords?: ShrinkageRecord[]
  ): number {
    if (totalReceivedQuantity <= 0) return 0;

    const list = lossRecords ?? this.records;
    const totalLossQty = list.reduce((sum, item) => sum + item.quantity, 0);
    const rate = (totalLossQty / totalReceivedQuantity) * 100;
    return Math.round(rate * 100) / 100; // 2 decimal places
  }

  /**
   * Computes the total monetary loss value (in VND).
   */
  public calculateTotalLossValue(records?: ShrinkageRecord[]): number {
    const list = records ?? this.records;
    return list.reduce((sum, item) => sum + item.totalLossValue, 0);
  }

  /**
   * Generates a comprehensive summary with reason breakdown and loss rate.
   */
  public getSummary(totalReceivedQuantity: number = 0): ShrinkageSummary {
    let totalQuantityLoss = 0;
    let totalValueLoss = 0;

    const byReason: Record<
      ShrinkageReason,
      { quantity: number; lossValue: number; count: number }
    > = {
      EXPIRED: { quantity: 0, lossValue: 0, count: 0 },
      DAMAGED_CRUSHED: { quantity: 0, lossValue: 0, count: 0 },
      QUALITY_DEGRADED: { quantity: 0, lossValue: 0, count: 0 },
      SAMPLE_TASTING: { quantity: 0, lossValue: 0, count: 0 },
      THEFT_LOSS: { quantity: 0, lossValue: 0, count: 0 },
      OTHER: { quantity: 0, lossValue: 0, count: 0 },
    };

    for (const rec of this.records) {
      totalQuantityLoss += rec.quantity;
      totalValueLoss += rec.totalLossValue;

      if (!byReason[rec.reason]) {
        byReason[rec.reason] = { quantity: 0, lossValue: 0, count: 0 };
      }
      byReason[rec.reason].quantity += rec.quantity;
      byReason[rec.reason].lossValue += rec.totalLossValue;
      byReason[rec.reason].count += 1;
    }

    const shrinkageRatePercent =
      totalReceivedQuantity > 0
        ? Math.round((totalQuantityLoss / totalReceivedQuantity) * 10000) / 100
        : 0;

    const summary: ShrinkageSummary = {
      totalRecords: this.records.length,
      totalQuantityLoss,
      totalValueLoss,
      shrinkageRatePercent,
      byReason,
    };

    return ShrinkageSummarySchema.parse(summary);
  }

  /**
   * Clears in-memory records (useful for test resets).
   */
  public clear(): void {
    this.records = [];
  }
}
