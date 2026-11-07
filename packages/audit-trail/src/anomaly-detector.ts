import { AnomalyConfig, AnomalyFlag, AuditEntry } from './types';

/**
 * Default threshold parameters for anomaly and fraud detection
 */
export const DEFAULT_ANOMALY_CONFIG: AnomalyConfig = {
  orderCancelMaxAmount: 500_000,
  orderCancelCriticalAmount: 5_000_000,
  orderCancelNightHourStart: 22,
  orderCancelNightHourEnd: 6,
  priceOverrideMaxDiscountPercent: 10,
  priceOverrideCriticalPercent: 30,
  cashDiscrepancyThreshold: 200_000,
  cashDiscrepancyCriticalThreshold: 1_000_000,
};

export type CustomAnomalyRule = (
  entry: AuditEntry,
  config: AnomalyConfig
) => AnomalyFlag | AnomalyFlag[] | null;

/**
 * Real-time Anomaly and Fraud Detection Engine for POS and ERP retail operations
 */
export class AnomalyDetector {
  private config: AnomalyConfig;
  private customRules: CustomAnomalyRule[] = [];

  constructor(customConfig?: Partial<AnomalyConfig>) {
    this.config = {
      ...DEFAULT_ANOMALY_CONFIG,
      ...customConfig,
    };
  }

  /**
   * Update configuration parameters
   */
  public updateConfig(newConfig: Partial<AnomalyConfig>): void {
    this.config = {
      ...this.config,
      ...newConfig,
    };
  }

  /**
   * Get current active configuration
   */
  public getConfig(): AnomalyConfig {
    return { ...this.config };
  }

  /**
   * Register a custom rule validator
   */
  public registerRule(rule: CustomAnomalyRule): void {
    this.customRules.push(rule);
  }

  /**
   * Inspect an audit entry in real-time and return all triggered anomaly flags
   */
  public detect(entry: AuditEntry): AnomalyFlag[] {
    const flags: AnomalyFlag[] = [];

    // 1. ORDER_CANCEL Rules
    if (entry.action === 'ORDER_CANCEL') {
      this.checkOrderCancelAnomalies(entry, flags);
    }

    // 2. PRICE_OVERRIDE Rules
    if (entry.action === 'PRICE_OVERRIDE') {
      this.checkPriceOverrideAnomalies(entry, flags);
    }

    // 3. CASH_DRAWER_OPEN / CASH_DISCREPANCY Rules
    if (
      entry.action === 'CASH_DRAWER_OPEN' ||
      entry.payload.discrepancy !== undefined ||
      (entry.payload.actualCash !== undefined && entry.payload.expectedCash !== undefined)
    ) {
      this.checkCashDiscrepancyAnomalies(entry, flags);
    }

    // 4. DEBT_WRITEOFF Rules
    if (entry.action === 'DEBT_WRITEOFF') {
      this.checkDebtWriteoffAnomalies(entry, flags);
    }

    // 5. Custom Rules
    for (const rule of this.customRules) {
      const result = rule(entry, this.config);
      if (result) {
        if (Array.isArray(result)) {
          flags.push(...result);
        } else {
          flags.push(result);
        }
      }
    }

    return flags;
  }

  private checkOrderCancelAnomalies(entry: AuditEntry, flags: AnomalyFlag[]): void {
    const payload = entry.payload;
    const rawAmount = payload.amount ?? payload.totalAmount ?? payload.orderValue ?? 0;
    const amount = Number(rawAmount);

    // Rule A1: Order cancel exceeds amount threshold (> 500k warning, > 5m critical)
    if (amount > this.config.orderCancelCriticalAmount) {
      flags.push({
        ruleId: 'ORDER_CANCEL_CRITICAL_AMOUNT',
        severity: 'CRITICAL',
        message: `Hủy đơn hàng giá trị đặc biệt lớn: ${amount.toLocaleString('vi-VN')} VND (vượt ngưỡng nghiêm trọng ${this.config.orderCancelCriticalAmount.toLocaleString('vi-VN')} VND)`,
        detectedAt: Date.now(),
        details: { amount, threshold: this.config.orderCancelCriticalAmount },
      });
    } else if (amount > this.config.orderCancelMaxAmount) {
      flags.push({
        ruleId: 'ORDER_CANCEL_OVER_LIMIT',
        severity: 'WARNING',
        message: `Hủy đơn hàng vượt hạn mức cho phép: ${amount.toLocaleString('vi-VN')} VND (hạn mức: ${this.config.orderCancelMaxAmount.toLocaleString('vi-VN')} VND)`,
        detectedAt: Date.now(),
        details: { amount, threshold: this.config.orderCancelMaxAmount },
      });
    }

    // Rule A2: Order cancel during suspicious night hours (>= 22h or < 6h)
    const date = new Date(entry.timestamp);
    const hour = date.getHours();
    const isNightHour =
      hour >= this.config.orderCancelNightHourStart || hour < this.config.orderCancelNightHourEnd;

    if (isNightHour) {
      flags.push({
        ruleId: 'ORDER_CANCEL_NIGHT_TIME',
        severity: 'CRITICAL',
        message: `Thao tác hủy đơn ngoài giờ làm việc quy định (${hour}:00 - sau ${this.config.orderCancelNightHourStart}h đêm)`,
        detectedAt: Date.now(),
        details: { hour, timestamp: entry.timestamp },
      });
    }
  }

  private checkPriceOverrideAnomalies(entry: AuditEntry, flags: AnomalyFlag[]): void {
    const payload = entry.payload;

    let discountPercent = 0;
    if (payload.discountPercent !== undefined) {
      discountPercent = Number(payload.discountPercent);
    } else if (payload.discountRate !== undefined) {
      discountPercent = Number(payload.discountRate) * 100;
    } else if (payload.originalPrice !== undefined && payload.overridePrice !== undefined) {
      const orig = Number(payload.originalPrice);
      const over = Number(payload.overridePrice);
      if (orig > 0) {
        discountPercent = ((orig - over) / orig) * 100;
      }
    }

    // Rule B1: High discount exceeding limits
    if (discountPercent > this.config.priceOverrideCriticalPercent) {
      flags.push({
        ruleId: 'PRICE_OVERRIDE_CRITICAL_DISCOUNT',
        severity: 'CRITICAL',
        message: `Chiết khấu giá vượt thẩm quyền nghiêm trọng: ${discountPercent.toFixed(1)}% (vượt ngưỡng phê duyệt giám đốc ${this.config.priceOverrideCriticalPercent}%)`,
        detectedAt: Date.now(),
        details: { discountPercent, role: entry.actor.role },
      });
    } else if (discountPercent > this.config.priceOverrideMaxDiscountPercent) {
      // If role is cashier, escalate to CRITICAL because cashiers typically cannot override > 10%
      const isCashier = entry.actor.role.toUpperCase().includes('CASHIER');
      flags.push({
        ruleId: 'PRICE_OVERRIDE_UNAUTHORIZED',
        severity: isCashier ? 'CRITICAL' : 'WARNING',
        message: `Chiết khấu giá vượt quá hạn mức cho phép: ${discountPercent.toFixed(1)}% (hạn mức thông thường: ${this.config.priceOverrideMaxDiscountPercent}%)`,
        detectedAt: Date.now(),
        details: { discountPercent, role: entry.actor.role },
      });
    }
  }

  private checkCashDiscrepancyAnomalies(entry: AuditEntry, flags: AnomalyFlag[]): void {
    const payload = entry.payload;

    let discrepancy = 0;
    if (payload.discrepancy !== undefined) {
      discrepancy = Math.abs(Number(payload.discrepancy));
    } else if (payload.actualCash !== undefined && payload.expectedCash !== undefined) {
      discrepancy = Math.abs(Number(payload.actualCash) - Number(payload.expectedCash));
    } else if (payload.difference !== undefined) {
      discrepancy = Math.abs(Number(payload.difference));
    }

    // Rule C1: Drawer discrepancy > threshold
    if (discrepancy > this.config.cashDiscrepancyCriticalThreshold) {
      flags.push({
        ruleId: 'CASH_DISCREPANCY_CRITICAL',
        severity: 'CRITICAL',
        message: `Chênh lệch tiền mặt két quỹ đặc biệt lớn: ${discrepancy.toLocaleString('vi-VN')} VND (ngưỡng nghiêm trọng: ${this.config.cashDiscrepancyCriticalThreshold.toLocaleString('vi-VN')} VND)`,
        detectedAt: Date.now(),
        details: { discrepancy, payload },
      });
    } else if (discrepancy > this.config.cashDiscrepancyThreshold) {
      flags.push({
        ruleId: 'CASH_DISCREPANCY_WARNING',
        severity: 'WARNING',
        message: `Chênh lệch tiền mặt kiểm kê két quỹ so với doanh thu POS thực tế: ${discrepancy.toLocaleString('vi-VN')} VND (vượt ngưỡng 200.000 VND)`,
        detectedAt: Date.now(),
        details: { discrepancy, payload },
      });
    }

    // Rule C2: Cash drawer opened with No Sale / without transaction
    if (
      entry.action === 'CASH_DRAWER_OPEN' &&
      (payload.reason === 'NO_SALE' || payload.unauthorized === true)
    ) {
      flags.push({
        ruleId: 'CASH_DRAWER_NO_SALE_OPEN',
        severity: 'WARNING',
        message: 'Thao tác mở két tiền thủ công không phát sinh giao dịch bán lẻ (No Sale Open)',
        detectedAt: Date.now(),
        details: { reason: payload.reason },
      });
    }
  }

  private checkDebtWriteoffAnomalies(entry: AuditEntry, flags: AnomalyFlag[]): void {
    const payload = entry.payload;
    const amount = Number(payload.amount ?? payload.writeoffAmount ?? 0);
    const role = entry.actor.role.toUpperCase();

    if (amount > 1_000_000 || (!role.includes('ADMIN') && !role.includes('DIRECTOR'))) {
      flags.push({
        ruleId: 'DEBT_WRITEOFF_UNAUTHORIZED',
        severity: 'CRITICAL',
        message: `Bút toán xóa nợ khách hàng cần phê duyệt cấp cao: ${amount.toLocaleString('vi-VN')} VND bởi vai trò ${entry.actor.role}`,
        detectedAt: Date.now(),
        details: { amount, role: entry.actor.role },
      });
    } else {
      flags.push({
        ruleId: 'DEBT_WRITEOFF_RECORDED',
        severity: 'INFO',
        message: `Ghi nhận bút toán xóa nợ khách hàng: ${amount.toLocaleString('vi-VN')} VND`,
        detectedAt: Date.now(),
        details: { amount },
      });
    }
  }
}
