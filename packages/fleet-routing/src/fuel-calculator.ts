import { z } from 'zod';
import { TruckType, TruckTypeSchema } from './truck-packing';

export const TrafficConditionSchema = z.enum([
  'NORMAL',
  'MODERATE_CITY',
  'HEAVY_CONGESTION',
  'HIGHWAY_SMOOTH',
]);
export type TrafficCondition = z.infer<typeof TrafficConditionSchema>;

export const FuelBenchmarkConfigSchema = z.object({
  truckType: TruckTypeSchema,
  baseRateLitersPer100Km: z.number().positive(),
  reeferCompressorLitersPerHour: z.number().nonnegative().default(0),
  defaultDieselPriceVndPerLiter: z.number().positive().default(21500),
});
export type FuelBenchmarkConfig = z.infer<typeof FuelBenchmarkConfigSchema>;

export const DEFAULT_FUEL_BENCHMARKS: Record<Exclude<TruckType, 'CUSTOM'>, FuelBenchmarkConfig> = {
  DRY_VAN_1_5T: {
    truckType: 'DRY_VAN_1_5T',
    baseRateLitersPer100Km: 10.5,
    reeferCompressorLitersPerHour: 0,
    defaultDieselPriceVndPerLiter: 21500,
  },
  DRY_VAN_2_5T: {
    truckType: 'DRY_VAN_2_5T',
    baseRateLitersPer100Km: 13.5,
    reeferCompressorLitersPerHour: 0,
    defaultDieselPriceVndPerLiter: 21500,
  },
  DRY_VAN_5_0T: {
    truckType: 'DRY_VAN_5_0T',
    baseRateLitersPer100Km: 19.5,
    reeferCompressorLitersPerHour: 0,
    defaultDieselPriceVndPerLiter: 21500,
  },
  REEFER_FROZEN: {
    truckType: 'REEFER_FROZEN',
    baseRateLitersPer100Km: 16.0,
    reeferCompressorLitersPerHour: 2.8, // Máy nén làm lạnh -18°C chạy dầu DO riêng/trích công suất
    defaultDieselPriceVndPerLiter: 21500,
  },
};

export interface RouteFuelEstimateParams {
  truckType: TruckType;
  distanceKm: number;
  payloadKg?: number;
  maxPayloadKg?: number;
  trafficCondition?: TrafficCondition;
  reeferHours?: number;
  dieselPriceVndPerLiter?: number;
  customBaseRate?: number;
}

export interface RouteFuelEstimateResult {
  truckType: TruckType;
  distanceKm: number;
  effectiveRateLitersPer100Km: number;
  drivingLiters: number;
  reeferLiters: number;
  totalEstimatedLiters: number;
  dieselPriceVndPerLiter: number;
  totalEstimatedCostVnd: number;
  breakdown: {
    baseRateLitersPer100Km: number;
    loadAdjustmentPct: number;
    trafficAdjustmentPct: number;
    reeferHours: number;
  };
}

export interface DriverFuelReceipt {
  receiptId: string;
  driverId: string;
  driverName: string;
  truckLicensePlate: string;
  stationName: string;
  invoiceNumber: string;
  timestamp: string;
  actualLiters: number;
  actualCostVnd: number;
  actualPricePerLiter?: number;
  odometerStartKm?: number;
  odometerEndKm?: number;
  photoUrl?: string;
  notes?: string;
}

export type FuelAuditStatus =
  | 'EFFICIENT'
  | 'NORMAL'
  | 'MODERATE_EXCESS'
  | 'HIGH_RISK_ANOMALY';

export interface FuelReconciliationResult {
  receipt: DriverFuelReceipt;
  estimate: RouteFuelEstimateResult;
  varianceLiters: number;
  varianceCostVnd: number;
  variancePct: number;
  actualRatePer100Km?: number;
  status: FuelAuditStatus;
  statusLabelVi: string;
  isFlaggedForAudit: boolean;
  explanation: string;
  actionRecommendation: string;
}

/**
 * Calculate expected fuel consumption and cost for a delivery route
 */
export function estimateRouteFuel(params: RouteFuelEstimateParams): RouteFuelEstimateResult {
  const benchmark =
    params.truckType !== 'CUSTOM' && DEFAULT_FUEL_BENCHMARKS[params.truckType]
      ? DEFAULT_FUEL_BENCHMARKS[params.truckType]
      : {
          truckType: params.truckType,
          baseRateLitersPer100Km: params.customBaseRate || 14.0,
          reeferCompressorLitersPerHour: params.truckType === 'REEFER_FROZEN' ? 2.8 : 0,
          defaultDieselPriceVndPerLiter: 21500,
        };

  const baseRate = params.customBaseRate ?? benchmark.baseRateLitersPer100Km;
  const dieselPrice = params.dieselPriceVndPerLiter ?? benchmark.defaultDieselPriceVndPerLiter;

  // Load factor: 0.0 (empty) to 1.0 (full capacity) adds up to +18% fuel burn
  let loadRatio = 0.5; // default half load
  if (params.payloadKg !== undefined && params.maxPayloadKg && params.maxPayloadKg > 0) {
    loadRatio = Math.max(0, Math.min(1.2, params.payloadKg / params.maxPayloadKg));
  }
  const loadAdjustmentPct = Math.round(loadRatio * 18 * 10) / 10; // e.g. +9% at 50% load

  // Traffic factor
  let trafficAdjustmentPct = 0;
  switch (params.trafficCondition ?? 'MODERATE_CITY') {
    case 'HEAVY_CONGESTION':
      trafficAdjustmentPct = 25;
      break;
    case 'MODERATE_CITY':
      trafficAdjustmentPct = 15;
      break;
    case 'HIGHWAY_SMOOTH':
      trafficAdjustmentPct = -10;
      break;
    case 'NORMAL':
    default:
      trafficAdjustmentPct = 0;
      break;
  }

  // Combined rate (liters / 100km)
  const multiplier = 1 + (loadAdjustmentPct + trafficAdjustmentPct) / 100;
  const effectiveRate = Math.round(baseRate * multiplier * 100) / 100;

  // Driving consumption
  const drivingLiters = Math.round(((params.distanceKm / 100) * effectiveRate) * 100) / 100;

  // Reefer compressor consumption
  const reeferHours = params.reeferHours ?? 0;
  const reeferRate = benchmark.reeferCompressorLitersPerHour;
  const reeferLiters = Math.round(reeferHours * reeferRate * 100) / 100;

  const totalEstimatedLiters = Math.round((drivingLiters + reeferLiters) * 100) / 100;
  const totalEstimatedCostVnd = Math.round(totalEstimatedLiters * dieselPrice);

  return {
    truckType: params.truckType,
    distanceKm: params.distanceKm,
    effectiveRateLitersPer100Km: effectiveRate,
    drivingLiters,
    reeferLiters,
    totalEstimatedLiters,
    dieselPriceVndPerLiter: dieselPrice,
    totalEstimatedCostVnd,
    breakdown: {
      baseRateLitersPer100Km: baseRate,
      loadAdjustmentPct,
      trafficAdjustmentPct,
      reeferHours,
    },
  };
}

/**
 * Reconcile Driver's Actual Fuel Invoice against Dispatch Estimate
 */
export function reconcileFuelReceipt(
  receipt: DriverFuelReceipt,
  estimate: RouteFuelEstimateResult
): FuelReconciliationResult {
  const varianceLiters = Math.round((receipt.actualLiters - estimate.totalEstimatedLiters) * 100) / 100;
  const varianceCostVnd = Math.round(receipt.actualCostVnd - estimate.totalEstimatedCostVnd);
  const variancePct =
    estimate.totalEstimatedLiters > 0
      ? Math.round((varianceLiters / estimate.totalEstimatedLiters) * 1000) / 10
      : 0;

  // Actual rate per 100km if odometer info is provided
  let actualRatePer100Km: number | undefined;
  if (
    receipt.odometerEndKm !== undefined &&
    receipt.odometerStartKm !== undefined &&
    receipt.odometerEndKm > receipt.odometerStartKm
  ) {
    const actualTripKm = receipt.odometerEndKm - receipt.odometerStartKm;
    actualRatePer100Km = Math.round((receipt.actualLiters / actualTripKm) * 100 * 100) / 100;
  }

  let status: FuelAuditStatus = 'NORMAL';
  let statusLabelVi = 'Hợp lệ trong định mức';
  let isFlaggedForAudit = false;
  let explanation = '';
  let actionRecommendation = '';

  if (variancePct <= -5) {
    status = 'EFFICIENT';
    statusLabelVi = 'Tiết kiệm nhiên liệu xuất sắc';
    explanation = `Tài xế tiêu hao ít hơn dự toán ${Math.abs(varianceLiters)} L (${Math.abs(variancePct)}%). Kỹ năng lái xe sinh thái (Eco-driving) tốt.`;
    actionRecommendation = 'Ghi nhận điểm thưởng hiệu suất nhiên liệu cuối tháng cho tài xế.';
  } else if (variancePct <= 8) {
    status = 'NORMAL';
    statusLabelVi = 'Định mức chuẩn (Hợp lệ)';
    explanation = `Mức chênh lệch ${varianceLiters > 0 ? '+' : ''}${varianceLiters} L (${variancePct}%) nằm trong sai số cho phép của giao thông nội đô.`;
    actionRecommendation = 'Duyệt thanh toán hoàn ứng hóa đơn xăng dầu tự động.';
  } else if (variancePct <= 18) {
    status = 'MODERATE_EXCESS';
    statusLabelVi = 'Vượt định mức nhẹ (Cần giải trình)';
    isFlaggedForAudit = false;
    explanation = `Tiêu hao vượt ${varianceLiters} L (${variancePct}%), phát sinh thêm ${varianceCostVnd.toLocaleString('vi-VN')} đ. Có thể do kẹt xe kéo dài hoặc bật máy lạnh dừng chờ dỡ hàng lâu.`;
    actionRecommendation = 'Yêu cầu tài xế ghi chú lý do kẹt xe hoặc thời gian nổ máy chờ bốc dỡ vào lệnh vận chuyển.';
  } else {
    status = 'HIGH_RISK_ANOMALY';
    statusLabelVi = 'CẢNH BÁO BẤT THƯỜNG (Vượt định mức >18%)';
    isFlaggedForAudit = true;
    explanation = `Tiêu hao vượt nghiêm trọng +${varianceLiters} L (+${variancePct}%), chênh lệch ${varianceCostVnd.toLocaleString('vi-VN')} đ so với lộ trình GPS. Nguy cơ rút trộm dầu, chạy sai cung đường chỉ định hoặc nổ máy ngủ điều hòa.`;
    actionRecommendation = 'KHÓA THANH TOÁN HOÀN ỨNG. Chuyển hồ sơ cho Trưởng bộ phận Đội xe kiểm tra lịch sử hành trình GPS và trích xuất camera cabin.';
  }

  return {
    receipt,
    estimate,
    varianceLiters,
    varianceCostVnd,
    variancePct,
    actualRatePer100Km,
    status,
    statusLabelVi,
    isFlaggedForAudit,
    explanation,
    actionRecommendation,
  };
}
