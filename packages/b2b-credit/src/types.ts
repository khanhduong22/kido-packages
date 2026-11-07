import { z } from 'zod';

/**
 * Cấp bậc đại lý phân phối B2B
 */
export type DealerTier = 'TIER_2' | 'TIER_1' | 'GOLD' | 'VIP';

export const DEALER_TIER_LABELS: Record<DealerTier, string> = {
  TIER_2: 'Đại lý Cấp 2',
  TIER_1: 'Đại lý Cấp 1',
  GOLD: 'Đại lý Vàng (Gold Partner)',
  VIP: 'Đại lý VIP Chiến Lược',
};

/**
 * Trạng thái khóa tín dụng đơn hàng B2B
 */
export type CreditLockStatus = 'APPROVED' | 'SOFT_LOCKED' | 'HARD_LOCKED';

export type LockReasonCode =
  | 'NONE'
  | 'OVERDUE_30D'
  | 'CREDIT_EXCEEDED'
  | 'OVERDUE_AND_CREDIT_EXCEEDED'
  | 'ACCOUNT_SUSPENDED'
  | 'SOFT_UTILIZATION_WARNING';

/**
 * Phân loại tuổi nợ doanh nghiệp
 * D0: Trong hạn nợ (Current)
 * D15: Quá hạn 1 - 15 ngày (Sắp đến hạn/chậm thanh toán ngắn hạn)
 * D30: Quá hạn 16 - 30 ngày (Quá hạn 1 tháng)
 * D60: Quá hạn 31 - 60 ngày (Quá hạn 2 tháng)
 * D90_PLUS: Quá hạn > 60 ngày hoặc >= 91 ngày (Nợ khó đòi trích lập dự phòng rủi ro)
 */
export type AgingBucket = 'D0' | 'D15' | 'D30' | 'D60' | 'D90_PLUS';

export const AGING_BUCKET_LABELS: Record<AgingBucket, string> = {
  D0: 'D0 (Trong hạn)',
  D15: 'D15 (Quá hạn 1-15 ngày)',
  D30: 'D30 (Quá hạn 16-30 ngày)',
  D60: 'D60 (Quá hạn 31-60 ngày)',
  D90_PLUS: 'D90+ (Nợ xấu / Trích lập dự phòng)',
};

/**
 * Đơn vị đóng gói hàng sỉ
 */
export type PackagingUnit = 'THUNG' | 'PALLET' | 'HOP' | 'CAI';

export const PACKAGING_UNIT_LABELS: Record<PackagingUnit, string> = {
  THUNG: 'Thùng',
  PALLET: 'Pallet',
  HOP: 'Hộp',
  CAI: 'Cái',
};

/**
 * Hồ sơ hóa đơn công nợ
 */
export interface InvoiceRecord {
  id: string;
  invoiceNumber: string;
  dealerId: string;
  orderId?: string;
  issueDate: string | Date;
  dueDate: string | Date;
  totalAmount: number;
  paidAmount: number;
  remainingAmount: number;
  status?: 'UNPAID' | 'PARTIALLY_PAID' | 'PAID' | 'OVERDUE';
  notes?: string;
}

/**
 * Hồ sơ Đại lý B2B
 */
export interface DealerRecord {
  id: string;
  code: string;
  name: string;
  phone: string;
  email?: string;
  address: string;
  region?: 'BAC' | 'TRUNG' | 'NAM';
  taxCode?: string;
  tier: DealerTier;
  creditLimit: number;
  currentDebt: number;
  paymentTermDays: number;
  isSuspended?: boolean;
  warningNotes?: string;
}

/**
 * Đầu vào đánh giá hạn mức tín dụng
 */
export interface CreditEvaluationInput {
  dealerId: string;
  dealerName?: string;
  creditLimit: number;
  currentDebt: number;
  newOrderAmount: number;
  unpaidInvoices?: InvoiceRecord[];
  isSuspended?: boolean;
  softLockGracePercent?: number; // Ví dụ 5% cho phép cảnh báo thay vì khóa cứng nếu cấu hình
  referenceDate?: string | Date;
}

/**
 * Kết quả thẩm định khóa tín dụng tự động
 */
export interface CreditEvaluationResult {
  isLocked: boolean;
  status: CreditLockStatus;
  lockReasonCode: LockReasonCode;
  reasons: string[];
  message: string;
  creditLimit: number;
  currentDebt: number;
  newOrderAmount: number;
  totalExposure: number;
  availableCredit: number;
  remainingCreditAfterOrder: number;
  utilizationRate: number; // e.g. 0.70 = 70%
  hasOverdue30Plus: boolean;
  maxOverdueDays: number;
  overdueInvoicesCount: number;
  overdueTotalAmount: number;
  canPlaceOrder: boolean;
  requiresSupervisorApproval: boolean;
}

/**
 * Chi tiết từng xô tuổi nợ
 */
export interface AgingBucketSummary {
  bucket: AgingBucket;
  label: string;
  invoiceCount: number;
  totalAmount: number;
  provisionRate: number; // Tỷ lệ trích lập dự phòng (0 - 1)
  provisionAmount: number;
  percentageOfTotal: number;
}

/**
 * Báo cáo tuổi nợ tổng hợp cho Ban Giám đốc & Kế toán trưởng
 */
export interface AgingScheduleSummary {
  dealerId?: string;
  dealerName?: string;
  referenceDate: string;
  buckets: Record<AgingBucket, AgingBucketSummary>;
  totalOutstandingDebt: number;
  totalOverdueDebt: number;
  totalProvisionAmount: number;
  badDebtRatio: number; // Tỷ lệ nợ khó đòi D90+ / Tổng nợ
  riskGrade: 'A_EXCELLENT' | 'B_GOOD' | 'C_WARNING' | 'D_CRITICAL';
  classifiedInvoices: Array<InvoiceRecord & {
    overdueDays: number;
    bucket: AgingBucket;
    isOverdue: boolean;
    provisionAmount: number;
  }>;
}

/**
 * Đầu vào tính giá theo dòng sản phẩm
 */
export interface PricingLineItemInput {
  productId: string;
  productName: string;
  baseUnitPrice: number; // Giá niêm yết theo thùng hoặc đơn vị chuẩn
  quantity: number;
  unit: PackagingUnit;
  unitsPerPallet?: number; // Mặc định 50 thùng / pallet
}

/**
 * Kết quả tính chiết khấu từng dòng
 */
export interface PricingLineItemResult {
  productId: string;
  productName: string;
  unit: PackagingUnit;
  quantity: number;
  thungEquivalent: number;
  baseUnitPrice: number;
  tierDiscountPercent: number;
  volumeDiscountPercent: number;
  totalDiscountPercent: number;
  discountedUnitPrice: number;
  originalSubtotal: number;
  discountAmount: number;
  finalSubtotal: number;
}

/**
 * Kết quả định giá đơn hàng sỉ B2B toàn diện
 */
export interface OrderPricingResult {
  dealerTier: DealerTier;
  dealerTierLabel: string;
  items: PricingLineItemResult[];
  totalThungQuantity: number;
  originalTotalAmount: number;
  tierDiscountTotalAmount: number;
  volumeDiscountTotalAmount: number;
  totalDiscountAmount: number;
  finalTotalAmount: number;
  effectiveDiscountRate: number; // % giảm giá thực tế toàn đơn
  appliedVolumeTier: {
    minThung: number;
    discountPercent: number;
    description: string;
  };
}

/**
 * Cấu hình tài khoản ngân hàng thu hồi nợ qua VietQR
 */
export interface BankPaymentInfo {
  bank: string;
  accountNumber: string;
  accountName: string;
  template?: 'compact2' | 'compact' | 'qr_only' | 'print';
}
