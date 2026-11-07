import {
  CpiRating,
  EventRoiInput,
  EventRoiInputSchema,
  EventRoiTelemetry,
  EventRoiTelemetrySchema,
} from './types';

/**
 * Format currency to Vietnamese Dong string (e.g. 15.000.000 ₫)
 */
export function formatVndCurrency(amount: number): string {
  return new Intl.NumberFormat('vi-VN', {
    style: 'currency',
    currency: 'VND',
    maximumFractionDigits: 0,
  }).format(amount);
}

/**
 * Evaluate CPI rating based on cost-per-impression thresholds
 */
export function evaluateCpiRating(cpi: number): CpiRating {
  if (cpi < 100) return 'EXCELLENT';
  if (cpi <= 300) return 'GOOD';
  if (cpi <= 800) return 'AVERAGE';
  return 'SUB_OPTIMAL';
}

/**
 * Calculate Event ROI Telemetry metrics for brand activations and corporate galas
 */
export function calculateEventRoiTelemetry(input: EventRoiInput): EventRoiTelemetry {
  const validated = EventRoiInputSchema.parse(input);

  const {
    eventCost,
    totalSessions,
    totalPhotosPrinted,
    qrScans,
    leadsCaptured,
    estimatedAttendance,
    avgSocialSharesPerGuest = 2.5,
    avgFollowersPerGuest = 350,
  } = validated;

  // 1. Total direct brand touchpoints/interactions
  const totalInteractions = totalSessions + totalPhotosPrinted + qrScans;

  // 2. Conversion rate to high-intent leads (%)
  const conversionRatePercent =
    qrScans > 0
      ? Math.round((leadsCaptured / qrScans) * 10000) / 100
      : totalSessions > 0
      ? Math.round((leadsCaptured / totalSessions) * 10000) / 100
      : 0;

  // 3. Direct interaction ratio per event guest
  const interactionPerGuestRatio =
    estimatedAttendance && estimatedAttendance > 0
      ? Math.round((totalInteractions / estimatedAttendance) * 100) / 100
      : undefined;

  // 4. Estimated organic social viral reach
  // Guests scan QR, download 4K photo/video, and post to Instagram/Facebook/TikTok Stories
  const estimatedSocialReach = Math.round(
    qrScans * avgSocialSharesPerGuest * avgFollowersPerGuest
  );

  // 5. Cost Per Impression (CPI) in VND
  const costPerImpressionVnd =
    estimatedSocialReach > 0
      ? Math.round((eventCost / estimatedSocialReach) * 100) / 100
      : eventCost;

  // 6. Cost Per Lead (CPL) in VND
  const costPerLeadVnd =
    leadsCaptured > 0 ? Math.round(eventCost / leadsCaptured) : eventCost;

  // 7. Rating
  const cpiRating = evaluateCpiRating(costPerImpressionVnd);

  // 8. Executive brief for Marketing Directors
  const cpiFormatted = formatVndCurrency(costPerImpressionVnd);
  const costPerLeadFormatted = formatVndCurrency(costPerLeadVnd);
  const reachFormatted = new Intl.NumberFormat('vi-VN').format(estimatedSocialReach);
  const leadsFormatted = new Intl.NumberFormat('vi-VN').format(leadsCaptured);

  const summaryText =
    `Sự kiện ghi nhận ${totalInteractions.toLocaleString('vi-VN')} điểm chạm thương hiệu với ` +
    `${totalSessions.toLocaleString('vi-VN')} lượt trải nghiệm trực tiếp và ${totalPhotosPrinted.toLocaleString('vi-VN')} bản in kỷ niệm. ` +
    `Tỷ lệ chuyển đổi đạt ${conversionRatePercent}%, thu về ${leadsFormatted} data khách hàng tiềm năng (${costPerLeadFormatted}/lead). ` +
    `Ước tính lan toả mạng xã hội đạt ${reachFormatted} lượt hiển thị với chi phí mỗi lượt tiếp cận (CPI) chỉ ${cpiFormatted} ` +
    `(Đánh giá: ${cpiRating}), vượt trội so với mức bình quân quảng cáo số (Facebook/TikTok Ads).`;

  const telemetry: EventRoiTelemetry = {
    totalInteractions,
    totalSessions,
    totalPhotosPrinted,
    qrScans,
    leadsCaptured,
    conversionRatePercent,
    interactionPerGuestRatio,
    estimatedSocialReach,
    costPerImpressionVnd,
    costPerLeadVnd,
    cpiRating,
    summaryText,
    generatedAt: new Date(),
  };

  return EventRoiTelemetrySchema.parse(telemetry);
}

/**
 * Alias for calculateEventRoiTelemetry for backwards compatibility with registry
 */
export const calculateB2bRoiTelemetry = calculateEventRoiTelemetry;

/**
 * Compare campaign results against standard social ads benchmark (e.g. 350 VND / impression)
 */
export function compareWithBenchmark(
  roi: EventRoiTelemetry,
  industryStandardCpi: number = 350
): {
  savingsPercent: number;
  savingsVndTotal: number;
  isMoreEfficient: boolean;
} {
  const simulatedAdSpend = roi.estimatedSocialReach * industryStandardCpi;
  const actualSpend = roi.costPerImpressionVnd * roi.estimatedSocialReach;
  const savingsVndTotal = Math.max(0, Math.round(simulatedAdSpend - actualSpend));
  const savingsPercent =
    industryStandardCpi > 0
      ? Math.round(
          ((industryStandardCpi - roi.costPerImpressionVnd) / industryStandardCpi) * 100
        )
      : 0;

  return {
    savingsPercent,
    savingsVndTotal,
    isMoreEfficient: roi.costPerImpressionVnd < industryStandardCpi,
  };
}
