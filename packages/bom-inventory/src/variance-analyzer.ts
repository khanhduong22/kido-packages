import {
  InventoryRecord,
  ItemVarianceResult,
  StoreVarianceSummary,
  VarianceReason,
  VarianceSeverity,
} from './types';

export interface VarianceThresholds {
  normalThresholdPercent?: number;       // Mặc định: 2% (trong giới hạn dung sai)
  warningThresholdPercent?: number;      // Mặc định: 5% (cảnh báo hao hụt)
  criticalThresholdPercent?: number;     // Mặc định: 10% (nguy cấp)
  investigationCostThreshold?: number;   // Mặc định: 500.000 VND (vượt mức này bắt buộc điều tra)
}

const DEFAULT_THRESHOLDS: Required<VarianceThresholds> = {
  normalThresholdPercent: 2,
  warningThresholdPercent: 5,
  criticalThresholdPercent: 10,
  investigationCostThreshold: 500000,
};

/**
 * Phân tích sai lệch hao hụt cho 1 mã nguyên vật liệu kiểm kê
 */
export function calculateItemVariance(
  record: InventoryRecord,
  customThresholds: VarianceThresholds = {}
): ItemVarianceResult {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...customThresholds };

  const recordedWaste = record.recordedWaste || 0;
  // Tồn lý thuyết = Đầu kỳ + Nhập - Tiêu hao lý thuyết (BOM POS) - Xuất trả - Hao hụt hủy đã ghi nhận
  const theoreticalClosing = Number(
    (
      record.openingStock +
      record.transfersIn -
      record.theoreticalUsage -
      record.transfersOut -
      recordedWaste
    ).toFixed(2)
  );

  // Tiêu hao thực tế = Đầu kỳ + Nhập - Xuất - Tồn thực tế
  const actualUsage = Number(
    (
      record.openingStock +
      record.transfersIn -
      record.transfersOut -
      record.actualCount
    ).toFixed(2)
  );

  // Chênh lệch = Thực tế kiểm kê - Tồn lý thuyết
  // Số âm: Thực tế ít hơn lý thuyết (Thất thoát / Hụt kho)
  // Số dương: Thực tế nhiều hơn lý thuyết (Dư kho / Đong thiếu định lượng cho khách)
  const varianceQty = Number((record.actualCount - theoreticalClosing).toFixed(2));

  // Tỷ lệ % sai lệch so với tiêu hao lý thuyết (hoặc tồn lý thuyết nếu không có tiêu hao)
  let variancePercent = 0;
  const baseForPercentage =
    record.theoreticalUsage > 0
      ? record.theoreticalUsage
      : theoreticalClosing > 0
      ? theoreticalClosing
      : 1;

  variancePercent = Number(
    ((varianceQty / baseForPercentage) * 100).toFixed(2)
  );

  // Giá trị thất thoát / chênh lệch tài chính (VND)
  const varianceCost = Number((varianceQty * record.unitCost).toFixed(0));

  const absPercent = Math.abs(variancePercent);
  const absCost = Math.abs(varianceCost);

  // Phân loại mức độ nghiêm trọng (Severity)
  let severity: VarianceSeverity = 'NORMAL';
  let suggestedReason: VarianceReason = 'NORMAL_TOLERANCE';
  let notes = '';

  if (
    absPercent > thresholds.criticalThresholdPercent ||
    absCost >= thresholds.investigationCostThreshold
  ) {
    severity = 'INVESTIGATION_REQUIRED';
    if (varianceQty < 0) {
      suggestedReason = 'THEFT_OR_LEAKAGE';
      notes = `CẢNH BÁO THẤT THOÁT NGHIÊM TRỌNG: Hụt ${Math.abs(varianceQty)} ${record.unit} (${absPercent}%), thiệt hại ${Math.abs(varianceCost).toLocaleString('vi-VN')}đ. Cần kiểm tra camera quầy pha chế và rà soát biên bản xuất nhập.`;
    } else {
      suggestedReason = 'OVER_PORTIONING';
      notes = `Dư kho bất thường (+${varianceQty} ${record.unit}). Nghi vấn nhân viên pha chế bớt xén nguyên liệu không đúng chuẩn công thức món.`;
    }
  } else if (absPercent > thresholds.warningThresholdPercent) {
    severity = 'CRITICAL';
    if (varianceQty < 0) {
      suggestedReason = 'OVER_PORTIONING';
      notes = `Sai lệch mức cao (-${absPercent}%): Nhân viên đong quá tay hoặc làm đổ bể không ghi biên bản hủy (Unrecorded Spillage).`;
    } else {
      suggestedReason = 'OVER_PORTIONING';
      notes = `Thực tế kiểm kê dôi dư (+${absPercent}%): Định lượng ly bán ra bị giảm so với chuẩn BOM.`;
    }
  } else if (absPercent > thresholds.normalThresholdPercent) {
    severity = 'WARNING';
    suggestedReason = varianceQty < 0 ? 'UNRECORDED_SPILLAGE' : 'NORMAL_TOLERANCE';
    notes = `Sai lệch nhẹ trong tầm kiểm soát (${variancePercent}%). Cần nhắc nhở nhân viên đong ca chuẩn xác.`;
  } else {
    severity = 'NORMAL';
    suggestedReason = 'NORMAL_TOLERANCE';
    notes = `Hao hụt chuẩn định mức kiểm kê F&B (sai lệch ${variancePercent}%).`;
  }

  return {
    itemId: record.itemId,
    name: record.name,
    unit: record.unit,
    unitCost: record.unitCost,
    openingStock: record.openingStock,
    transfersIn: record.transfersIn,
    transfersOut: record.transfersOut,
    theoreticalUsage: record.theoreticalUsage,
    theoreticalClosing,
    actualCount: record.actualCount,
    actualUsage,
    varianceQty,
    variancePercent,
    varianceCost,
    severity,
    suggestedReason,
    notes,
  };
}

/**
 * Phân tích tổng thể kiểm kê và tỷ lệ hao hụt toàn chi nhánh (Store Variance Analysis)
 * Gắn cờ rò rỉ nguyên vật liệu và tính điểm sức khỏe kho vận
 */
export function analyzeStoreVariance(
  branchId: string,
  branchName: string,
  records: InventoryRecord[],
  options: {
    period?: { from: string; to: string };
    thresholds?: VarianceThresholds;
  } = {}
): StoreVarianceSummary {
  const period = options.period || {
    from: new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0],
    to: new Date().toISOString().split('T')[0],
  };

  const items = records.map((r) => calculateItemVariance(r, options.thresholds));

  // Kiểm tra mối tương quan rò rỉ nguyên vật liệu (Leakage Detection Heuristics):
  // Nếu bao bì (Ly, nắp) khớp gần như 100% nhưng Siro/Sữa/Cà phê hụt nặng -> Rò rỉ nguyên liệu
  const packagingItems = items.filter((i) => i.itemId.startsWith('BB-'));
  const rawItems = items.filter((i) => i.itemId.startsWith('NL-') || i.itemId.startsWith('SUB-'));

  const highRiskItems = items.filter(
    (i) => i.severity === 'CRITICAL' || i.severity === 'INVESTIGATION_REQUIRED'
  );

  const totalVarianceCost = items.reduce((acc, curr) => acc + curr.varianceCost, 0);

  // Đánh giá cờ rò rỉ nguyên vật liệu (Leakage Alert)
  let leakageAlert = false;
  if (highRiskItems.length >= 2 || totalVarianceCost < -1000000) {
    leakageAlert = true;
  }

  // Nếu bao bì ly nắp lệch bình thường (<2%) nhưng nguyên liệu chính lệch > 8% -> Rò rỉ âm thầm
  const avgPackVariance =
    packagingItems.length > 0
      ? packagingItems.reduce((acc, p) => acc + Math.abs(p.variancePercent), 0) /
        packagingItems.length
      : 0;

  const avgRawNegativeVariance =
    rawItems.length > 0
      ? rawItems
          .filter((r) => r.varianceQty < 0)
          .reduce((acc, r) => acc + Math.abs(r.variancePercent), 0) /
        Math.max(1, rawItems.filter((r) => r.varianceQty < 0).length)
      : 0;

  if (avgPackVariance <= 2 && avgRawNegativeVariance >= 7) {
    leakageAlert = true;
    for (const item of rawItems) {
      if (item.varianceQty < 0 && Math.abs(item.variancePercent) >= 7) {
        item.suggestedReason = 'THEFT_OR_LEAKAGE';
        item.notes = `NGHI VẤN RÒ RỈ: Tiêu hao ly nắp bình thường nhưng hụt nguyên liệu (${item.variancePercent}%). Có dấu hiệu pha thừa hoặc thất thoát nội bộ.`;
      }
    }
  }

  // Tính điểm sức khỏe tồn kho (Inventory Health Score: 0 - 100)
  let healthScore = 100;
  for (const item of items) {
    if (item.severity === 'INVESTIGATION_REQUIRED') healthScore -= 20;
    else if (item.severity === 'CRITICAL') healthScore -= 10;
    else if (item.severity === 'WARNING') healthScore -= 3;
  }
  if (leakageAlert) healthScore -= 15;
  healthScore = Math.max(0, Math.min(100, healthScore));

  return {
    branchId,
    branchName,
    auditDate: new Date().toISOString(),
    period,
    items,
    totalVarianceCost,
    highRiskItemsCount: highRiskItems.length,
    leakageAlert,
    overallHealthScore: healthScore,
  };
}
