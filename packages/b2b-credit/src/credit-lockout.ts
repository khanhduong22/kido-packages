import {
  CreditEvaluationInput,
  CreditEvaluationResult,
  CreditLockStatus,
  InvoiceRecord,
  LockReasonCode,
} from './types';

/**
 * Format tiền VND sang dạng chuỗi dễ đọc
 */
export function formatVnd(amount: number): string {
  return new Intl.NumberFormat('vi-VN', {
    style: 'currency',
    currency: 'VND',
    maximumFractionDigits: 0,
  }).format(amount);
}

/**
 * Lỗi nghiệp vụ khi vi phạm chính sách khóa tín dụng B2B
 */
export class CreditLockoutError extends Error {
  public readonly code: LockReasonCode;
  public readonly evaluation: CreditEvaluationResult;

  constructor(message: string, evaluation: CreditEvaluationResult) {
    super(message);
    this.name = 'CreditLockoutError';
    this.code = evaluation.lockReasonCode;
    this.evaluation = evaluation;
  }
}

/**
 * Động cơ thẩm định hạn mức tín dụng và khóa đặt hàng tự động
 * 
 * Quy tắc:
 * 1. Nếu có bất kỳ hóa đơn nào quá hạn thanh toán > 30 ngày -> HARD_LOCKED (Khóa cứng tức thì)
 * 2. Nếu currentDebt + newOrderAmount > creditLimit:
 *    - Vượt hạn mức thông thường -> HARD_LOCKED (Chặn đặt hàng)
 *    - Nếu có cấu hình softLockGracePercent và khoản vượt nằm trong biên độ mềm -> SOFT_LOCKED (Cần Kế toán trưởng phê duyệt)
 * 3. Nếu tài khoản bị treo (isSuspended = true) -> HARD_LOCKED
 * 4. Nếu có nợ quá hạn ngắn hạn <= 30 ngày -> SOFT_LOCKED (Cảnh báo thu hồi nợ)
 * 5. Hợp lệ hoàn toàn -> APPROVED
 */
export function evaluateCreditLimit(
  input: CreditEvaluationInput
): CreditEvaluationResult {
  const {
    creditLimit,
    currentDebt,
    newOrderAmount,
    unpaidInvoices = [],
    isSuspended = false,
    softLockGracePercent = 0,
    referenceDate = new Date(),
  } = input;

  const refTime = new Date(referenceDate).getTime();
  const totalExposure = currentDebt + newOrderAmount;
  const availableCredit = Math.max(0, creditLimit - currentDebt);
  const remainingCreditAfterOrder = creditLimit - totalExposure;
  const utilizationRate = creditLimit > 0 ? totalExposure / creditLimit : 1;

  // 1. Phân tích hóa đơn nợ quá hạn
  let maxOverdueDays = 0;
  let overdueInvoicesCount = 0;
  let overdueTotalAmount = 0;
  let hasOverdue30Plus = false;

  for (const inv of unpaidInvoices) {
    const remaining = inv.remainingAmount ?? (inv.totalAmount - (inv.paidAmount ?? 0));
    if (remaining <= 0) continue;

    const dueTime = new Date(inv.dueDate).getTime();
    if (refTime > dueTime) {
      const days = Math.floor((refTime - dueTime) / (1000 * 60 * 60 * 24));
      if (days > 0) {
        overdueInvoicesCount++;
        overdueTotalAmount += remaining;
        if (days > maxOverdueDays) {
          maxOverdueDays = days;
        }
        if (days > 30) {
          hasOverdue30Plus = true;
        }
      }
    }
  }

  const reasons: string[] = [];
  let status: CreditLockStatus = 'APPROVED';
  let lockReasonCode: LockReasonCode = 'NONE';
  let isLocked = false;
  let requiresSupervisorApproval = false;

  // 2. Kiểm tra điều kiện tài khoản bị đình chỉ
  if (isSuspended) {
    status = 'HARD_LOCKED';
    lockReasonCode = 'ACCOUNT_SUSPENDED';
    isLocked = true;
    reasons.push(
      'Tài khoản đại lý đang trong diện kiểm soát đặc biệt hoặc tạm dừng cấp tín dụng.'
    );
  }

  // 3. Kiểm tra điều kiện nợ quá hạn > 30 ngày & Vượt hạn mức
  const isCreditExceeded = totalExposure > creditLimit;

  if (hasOverdue30Plus && isCreditExceeded) {
    status = 'HARD_LOCKED';
    lockReasonCode = 'OVERDUE_AND_CREDIT_EXCEEDED';
    isLocked = true;
    reasons.push(
      `Tồn tại hóa đơn quá hạn ${maxOverdueDays} ngày (> 30 ngày) và đơn hàng mới làm tổng nợ (${formatVnd(totalExposure)}) vượt hạn mức (${formatVnd(creditLimit)}).`
    );
  } else if (hasOverdue30Plus) {
    status = 'HARD_LOCKED';
    lockReasonCode = 'OVERDUE_30D';
    isLocked = true;
    reasons.push(
      `Đại lý có ${overdueInvoicesCount} hóa đơn quá hạn trên 30 ngày (quá hạn cao nhất: ${maxOverdueDays} ngày). Hệ thống tự động khóa lên đơn mới để xử lý công nợ tồn đọng.`
    );
  } else if (isCreditExceeded) {
    const exceedAmount = totalExposure - creditLimit;
    const graceAmount = (creditLimit * softLockGracePercent) / 100;

    if (softLockGracePercent > 0 && exceedAmount <= graceAmount) {
      status = 'SOFT_LOCKED';
      lockReasonCode = 'SOFT_UTILIZATION_WARNING';
      isLocked = false;
      requiresSupervisorApproval = true;
      reasons.push(
        `Đơn hàng vượt hạn mức ${formatVnd(exceedAmount)} nhưng nằm trong biên độ mềm ${softLockGracePercent}%. Yêu cầu Kế toán trưởng phê duyệt ngoại lệ.`
      );
    } else {
      status = 'HARD_LOCKED';
      lockReasonCode = 'CREDIT_EXCEEDED';
      isLocked = true;
      reasons.push(
        `Tổng công nợ sau khi lên đơn (${formatVnd(totalExposure)}) vượt quá hạn mức tín dụng được duyệt (${formatVnd(creditLimit)}). Chênh lệch: ${formatVnd(exceedAmount)}.`
      );
    }
  } else if (maxOverdueDays > 0) {
    // Có nợ quá hạn ngắn hạn 1-30 ngày
    status = 'SOFT_LOCKED';
    lockReasonCode = 'SOFT_UTILIZATION_WARNING';
    isLocked = false;
    requiresSupervisorApproval = false;
    reasons.push(
      `Cảnh báo: Có ${overdueInvoicesCount} hóa đơn quá hạn ngắn hạn (${maxOverdueDays} ngày). Vui lòng thanh toán sớm để đảm bảo hạn mức tín dụng.`
    );
  }

  // Tạo thông điệp tóm tắt thân thiện với người dùng
  let message = 'Hạn mức tín dụng hợp lệ. Đủ điều kiện khởi tạo đơn hàng sỉ.';
  if (status === 'HARD_LOCKED') {
    message = `[KHÓA ĐẶT HÀNG] ${reasons.join(' ')}`;
  } else if (status === 'SOFT_LOCKED') {
    message = `[CẢNH BÁO TÍN DỤNG] ${reasons.join(' ')}`;
  }

  return {
    isLocked,
    status,
    lockReasonCode,
    reasons,
    message,
    creditLimit,
    currentDebt,
    newOrderAmount,
    totalExposure,
    availableCredit,
    remainingCreditAfterOrder,
    utilizationRate: Math.round(utilizationRate * 100) / 100,
    hasOverdue30Plus,
    maxOverdueDays,
    overdueInvoicesCount,
    overdueTotalAmount,
    canPlaceOrder: !isLocked,
    requiresSupervisorApproval,
  };
}

/**
 * Kiểm tra nhanh xem đại lý có thể đặt đơn mới hay không
 */
export function isOrderAllowed(input: CreditEvaluationInput): boolean {
  return evaluateCreditLimit(input).canPlaceOrder;
}

/**
 * Ném lỗi nếu đơn hàng vi phạm hạn mức tín dụng
 */
export function assertCreditLimit(input: CreditEvaluationInput): void {
  const result = evaluateCreditLimit(input);
  if (result.isLocked) {
    throw new CreditLockoutError(result.message, result);
  }
}
