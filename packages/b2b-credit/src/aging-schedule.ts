import {
  AgingBucket,
  AGING_BUCKET_LABELS,
  AgingBucketSummary,
  AgingScheduleSummary,
  DealerRecord,
  InvoiceRecord,
} from './types';

/**
 * Tỷ lệ trích lập dự phòng nợ phải thu khó đòi theo chuẩn quản trị rủi ro
 */
export const DEFAULT_PROVISION_RATES: Record<AgingBucket, number> = {
  D0: 0.0,       // Trong hạn: 0%
  D15: 0.05,     // Quá hạn 1-15 ngày: 5% dự phòng rủi ro sớm
  D30: 0.20,     // Quá hạn 16-30 ngày (1 tháng): 20%
  D60: 0.50,     // Quá hạn 31-60 ngày (2 tháng): 50%
  D90_PLUS: 1.0, // Quá hạn > 60 ngày hoặc > 90 ngày: 100% trích lập toàn phần
};

/**
 * Phân loại một hóa đơn vào đúng xô tuổi nợ (Aging Bucket)
 */
export function classifyInvoiceAging(
  invoice: InvoiceRecord,
  referenceDate: string | Date = new Date(),
  provisionRates: Record<AgingBucket, number> = DEFAULT_PROVISION_RATES
) {
  const refTime = new Date(referenceDate).getTime();
  const dueTime = new Date(invoice.dueDate).getTime();
  const remaining = invoice.remainingAmount ?? (invoice.totalAmount - (invoice.paidAmount ?? 0));

  let overdueDays = 0;
  if (refTime > dueTime && remaining > 0) {
    overdueDays = Math.floor((refTime - dueTime) / (1000 * 60 * 60 * 24));
  }

  let bucket: AgingBucket = 'D0';
  if (overdueDays <= 0) {
    bucket = 'D0';
  } else if (overdueDays <= 15) {
    bucket = 'D15';
  } else if (overdueDays <= 30) {
    bucket = 'D30';
  } else if (overdueDays <= 60) {
    bucket = 'D60';
  } else {
    bucket = 'D90_PLUS';
  }

  const provisionRate = provisionRates[bucket] ?? 0;
  const provisionAmount = Math.round(remaining * provisionRate);

  return {
    ...invoice,
    remainingAmount: remaining,
    overdueDays,
    bucket,
    isOverdue: overdueDays > 0,
    provisionRate,
    provisionAmount,
  };
}

/**
 * Thuật toán tổng hợp bảng phân loại tuổi nợ doanh nghiệp (Aging Schedule)
 */
export function calculateAgingSchedule(
  invoices: InvoiceRecord[],
  referenceDate: string | Date = new Date(),
  options: {
    dealerId?: string;
    dealerName?: string;
    customProvisionRates?: Partial<Record<AgingBucket, number>>;
  } = {}
): AgingScheduleSummary {
  const refDateObj = new Date(referenceDate);
  const refDateIso = refDateObj.toISOString();
  const provisionRates = {
    ...DEFAULT_PROVISION_RATES,
    ...options.customProvisionRates,
  };

  const bucketsData: Record<AgingBucket, { count: number; amount: number; provision: number }> = {
    D0: { count: 0, amount: 0, provision: 0 },
    D15: { count: 0, amount: 0, provision: 0 },
    D30: { count: 0, amount: 0, provision: 0 },
    D60: { count: 0, amount: 0, provision: 0 },
    D90_PLUS: { count: 0, amount: 0, provision: 0 },
  };

  const classifiedInvoices: AgingScheduleSummary['classifiedInvoices'] = [];
  let totalOutstandingDebt = 0;
  let totalOverdueDebt = 0;
  let totalProvisionAmount = 0;

  for (const inv of invoices) {
    const remaining = inv.remainingAmount ?? (inv.totalAmount - (inv.paidAmount ?? 0));
    if (remaining <= 0) continue; // Bỏ qua hóa đơn đã thanh toán xong

    const classified = classifyInvoiceAging(inv, refDateObj, provisionRates);
    classifiedInvoices.push(classified);

    bucketsData[classified.bucket].count++;
    bucketsData[classified.bucket].amount += classified.remainingAmount;
    bucketsData[classified.bucket].provision += classified.provisionAmount;

    totalOutstandingDebt += classified.remainingAmount;
    if (classified.isOverdue) {
      totalOverdueDebt += classified.remainingAmount;
    }
    totalProvisionAmount += classified.provisionAmount;
  }

  // Tạo summaries cho từng bucket
  const buckets = (['D0', 'D15', 'D30', 'D60', 'D90_PLUS'] as AgingBucket[]).reduce(
    (acc, b) => {
      const data = bucketsData[b];
      const percentage =
        totalOutstandingDebt > 0
          ? Math.round((data.amount / totalOutstandingDebt) * 1000) / 10
          : 0;

      acc[b] = {
        bucket: b,
        label: AGING_BUCKET_LABELS[b],
        invoiceCount: data.count,
        totalAmount: data.amount,
        provisionRate: provisionRates[b],
        provisionAmount: data.provision,
        percentageOfTotal: percentage,
      };
      return acc;
    },
    {} as Record<AgingBucket, AgingBucketSummary>
  );

  // Tỷ lệ nợ khó đòi D90+
  const d90Amount = bucketsData.D90_PLUS.amount;
  const badDebtRatio =
    totalOutstandingDebt > 0
      ? Math.round((d90Amount / totalOutstandingDebt) * 1000) / 1000
      : 0;

  // Đánh giá xếp hạng rủi ro tín dụng doanh nghiệp
  let riskGrade: AgingScheduleSummary['riskGrade'] = 'A_EXCELLENT';
  if (bucketsData.D90_PLUS.amount > 0 || badDebtRatio >= 0.2) {
    riskGrade = 'D_CRITICAL';
  } else if (bucketsData.D60.amount > 0 || (bucketsData.D30.amount > 0 && totalOverdueDebt / (totalOutstandingDebt || 1) > 0.4)) {
    riskGrade = 'C_WARNING';
  } else if (bucketsData.D30.amount > 0 || bucketsData.D15.amount > 0) {
    riskGrade = 'B_GOOD';
  } else {
    riskGrade = 'A_EXCELLENT';
  }

  return {
    dealerId: options.dealerId,
    dealerName: options.dealerName,
    referenceDate: refDateIso,
    buckets,
    totalOutstandingDebt,
    totalOverdueDebt,
    totalProvisionAmount,
    badDebtRatio,
    riskGrade,
    classifiedInvoices,
  };
}

/**
 * Tính báo cáo tuổi nợ cho đại lý cụ thể
 */
export function calculateDealerAging(
  dealer: DealerRecord,
  invoices: InvoiceRecord[],
  referenceDate: string | Date = new Date()
): AgingScheduleSummary {
  const dealerInvoices = invoices.filter((inv) => inv.dealerId === dealer.id);
  return calculateAgingSchedule(dealerInvoices, referenceDate, {
    dealerId: dealer.id,
    dealerName: dealer.name,
  });
}
