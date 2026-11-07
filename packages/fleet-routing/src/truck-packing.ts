import { z } from 'zod';

export const TruckTypeSchema = z.enum([
  'DRY_VAN_1_5T',
  'DRY_VAN_2_5T',
  'DRY_VAN_5_0T',
  'REEFER_FROZEN',
  'CUSTOM',
]);
export type TruckType = z.infer<typeof TruckTypeSchema>;

export const TruckSpecificationSchema = z.object({
  id: z.string(),
  name: z.string(),
  category: TruckTypeSchema,
  maxPayloadKg: z.number().positive(),
  boxLengthM: z.number().positive(),
  boxWidthM: z.number().positive(),
  boxHeightM: z.number().positive(),
  usableVolumeM3: z.number().positive(),
  isRefrigerated: z.boolean().default(false),
  minTemperatureCelsius: z.number().optional(),
  maxTemperatureCelsius: z.number().optional(),
});
export type TruckSpecification = z.infer<typeof TruckSpecificationSchema>;

export const CargoItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  sku: z.string().optional(),
  weightKg: z.number().positive(),
  lengthM: z.number().positive(),
  widthM: z.number().positive(),
  heightM: z.number().positive(),
  quantity: z.number().int().positive().default(1),
  stackable: z.boolean().default(true),
  maxStackLayers: z.number().int().positive().default(3),
  requiresRefrigeration: z.boolean().default(false),
  targetTempCelsius: z.number().optional(),
  fragile: z.boolean().default(false),
  destinationStopId: z.string().optional(),
});
export type CargoItem = z.input<typeof CargoItemSchema>;

export interface PlacedPackage {
  itemId: string;
  name: string;
  unitIndex: number;
  x: number; // Width axis (0 to boxWidthM)
  y: number; // Length axis (0 to boxLengthM)
  z: number; // Height axis (0 to boxHeightM)
  lengthM: number;
  widthM: number;
  heightM: number;
  weightKg: number;
  stackLayer: number;
  destinationStopId?: string;
}

export interface PackingResult {
  truck: TruckSpecification;
  totalWeightKg: number;
  maxPayloadKg: number;
  weightUtilizationPct: number;
  totalVolumeM3: number;
  usableVolumeM3: number;
  volumeUtilizationPct: number;
  isOverweight: boolean;
  isOvervolume: boolean;
  isDimensionViolated: boolean;
  isRefrigerationCompatible: boolean;
  isFit: boolean;
  placedCount: number;
  totalRequestedCount: number;
  placedPackages: PlacedPackage[];
  unpackedPackages: Array<{ itemId: string; name: string; reason: string }>;
  axleLoadDistribution: {
    frontAxlePct: number;
    rearAxlePct: number;
    isBalanced: boolean;
  };
  warnings: string[];
  recommendation: string;
}

/**
 * Standard Presets for Vietnamese Logistics Fleet
 */
export const TRUCK_PRESETS: Record<Exclude<TruckType, 'CUSTOM'>, TruckSpecification> = {
  DRY_VAN_1_5T: {
    id: 'TRK-1.5T',
    name: 'Xe Tải Thùng Kín 1.5 Tấn (Kia K200/K250, Hyundai Porter H150)',
    category: 'DRY_VAN_1_5T',
    maxPayloadKg: 1500,
    boxLengthM: 3.2,
    boxWidthM: 1.67,
    boxHeightM: 1.7,
    usableVolumeM3: 9.08,
    isRefrigerated: false,
  },
  DRY_VAN_2_5T: {
    id: 'TRK-2.5T',
    name: 'Xe Tải Thùng Kín 2.5 Tấn (Hyundai Mighty N250, Isuzu QKR 270)',
    category: 'DRY_VAN_2_5T',
    maxPayloadKg: 2500,
    boxLengthM: 4.35,
    boxWidthM: 1.85,
    boxHeightM: 1.85,
    usableVolumeM3: 14.88,
    isRefrigerated: false,
  },
  DRY_VAN_5_0T: {
    id: 'TRK-5.0T',
    name: 'Xe Tải Thùng Kín 5.0 Tấn (Hino 500 Series, Isuzu NQR 550)',
    category: 'DRY_VAN_5_0T',
    maxPayloadKg: 5000,
    boxLengthM: 6.2,
    boxWidthM: 2.15,
    boxHeightM: 2.2,
    usableVolumeM3: 29.32,
    isRefrigerated: false,
  },
  REEFER_FROZEN: {
    id: 'TRK-REEFER-3.5T',
    name: 'Xe Tải Đông Lạnh 3.5 Tấn (-18°C Hwasung Thermo, cách nhiệt PU)',
    category: 'REEFER_FROZEN',
    maxPayloadKg: 3500,
    boxLengthM: 4.8,
    boxWidthM: 1.95,
    boxHeightM: 1.95,
    usableVolumeM3: 18.25,
    isRefrigerated: true,
    minTemperatureCelsius: -25,
    maxTemperatureCelsius: -15,
  },
};

/**
 * 3D Bin Packing & Weight/Volume Capacity Optimization
 */
export function calculateTruckPacking(
  truckInput: TruckSpecification | keyof typeof TRUCK_PRESETS,
  cargoItems: CargoItem[]
): PackingResult {
  const truck: TruckSpecification =
    typeof truckInput === 'string' ? TRUCK_PRESETS[truckInput] : truckInput;

  // Flatten cargo items into individual units
  interface ExpandedUnit {
    item: CargoItem;
    unitIndex: number;
    volumeM3: number;
  }

  const units: ExpandedUnit[] = [];
  let totalRequestedCount = 0;
  let totalWeightKg = 0;
  let totalVolumeM3 = 0;

  for (const item of cargoItems) {
    const itemVol = Math.round(item.lengthM * item.widthM * item.heightM * 1000) / 1000;
    const qty = item.quantity ?? 1;
    for (let i = 0; i < qty; i++) {
      units.push({
        item,
        unitIndex: i + 1,
        volumeM3: itemVol,
      });
      totalRequestedCount++;
      totalWeightKg += item.weightKg;
      totalVolumeM3 += itemVol;
    }
  }

  totalWeightKg = Math.round(totalWeightKg * 100) / 100;
  totalVolumeM3 = Math.round(totalVolumeM3 * 1000) / 1000;

  const weightUtilizationPct = Math.round((totalWeightKg / truck.maxPayloadKg) * 1000) / 10;
  const volumeUtilizationPct = Math.round((totalVolumeM3 / truck.usableVolumeM3) * 1000) / 10;

  const isOverweight = totalWeightKg > truck.maxPayloadKg;
  const isOvervolume = totalVolumeM3 > truck.usableVolumeM3;

  const warnings: string[] = [];

  // 1. Cold chain check
  let isRefrigerationCompatible = true;
  const coldItems = cargoItems.filter((i) => i.requiresRefrigeration);
  if (coldItems.length > 0) {
    if (!truck.isRefrigerated) {
      isRefrigerationCompatible = false;
      warnings.push(
        `Đơn hàng có ${coldItems.length} kiện hàng lạnh nhưng xe [${truck.name}] là xe thùng kín thông thường, nguy cơ hỏng hàng!`
      );
    } else if (truck.minTemperatureCelsius !== undefined) {
      const incompatibleTemps = coldItems.filter(
        (i) => i.targetTempCelsius !== undefined && i.targetTempCelsius < (truck.minTemperatureCelsius ?? -18)
      );
      if (incompatibleTemps.length > 0) {
        isRefrigerationCompatible = false;
        warnings.push(
          `Nhiệt độ thùng xe (${truck.minTemperatureCelsius}°C) không đủ sâu cho hàng bảo quản (${incompatibleTemps[0].targetTempCelsius}°C).`
        );
      }
    }
  }

  // 2. Dimension violation check: Any single package bigger than truck cavity?
  let isDimensionViolated = false;
  for (const u of units) {
    const dims = [u.item.lengthM, u.item.widthM, u.item.heightM].sort((a, b) => b - a);
    const boxDims = [truck.boxLengthM, truck.boxWidthM, truck.boxHeightM].sort((a, b) => b - a);
    if (dims[0] > boxDims[0] || dims[1] > boxDims[1] || dims[2] > boxDims[2]) {
      isDimensionViolated = true;
      warnings.push(
        `Kiện hàng "${u.item.name}" kích thước (${u.item.lengthM}m x ${u.item.widthM}m x ${u.item.heightM}m) vượt quá khẩu độ lòng thùng xe!`
      );
      break;
    }
  }

  // 3. 3D Shelf / Guillotine Layer Packing Heuristic
  // Sort items: Non-stackable or fragile items on top, heavy & large footprint on bottom floor
  const sortedUnits = [...units].sort((a, b) => {
    // Heaviest first for floor stability
    if (b.item.weightKg !== a.item.weightKg) {
      return b.item.weightKg - a.item.weightKg;
    }
    return b.volumeM3 - a.volumeM3;
  });

  const placedPackages: PlacedPackage[] = [];
  const unpackedPackages: Array<{ itemId: string; name: string; reason: string }> = [];

  // 3D coordinate space:
  // x: 0 to boxWidthM (ngang thùng)
  // y: 0 to boxLengthM (dọc thùng - từ vách đầu xe đến đuôi xe)
  // z: 0 to boxHeightM (chiều cao)
  let curX = 0;
  let curY = 0;
  let curZ = 0;
  let maxLayerHeight = 0;
  let maxRowLength = 0;

  for (const u of sortedUnits) {
    let itemL = u.item.lengthM;
    let itemW = u.item.widthM;
    let itemH = u.item.heightM;

    // Check if orientation swap (L vs W) fits current slot better
    if (curX + itemW > truck.boxWidthM && curX + itemL <= truck.boxWidthM && curY + itemW <= truck.boxLengthM) {
      const tmp = itemL;
      itemL = itemW;
      itemW = tmp;
    }

    // Try placing at current (curX, curY, curZ)
    if (curX + itemW > truck.boxWidthM) {
      // Advance to next row along Y axis
      curX = 0;
      curY += maxRowLength > 0 ? maxRowLength : itemL;
      maxRowLength = 0;
    }

    if (curY + itemL > truck.boxLengthM) {
      // Reached back door on current level, attempt stacking on layer (Z)
      if (curZ + maxLayerHeight + itemH <= truck.boxHeightM && (u.item.stackable ?? true)) {
        curX = 0;
        curY = 0;
        curZ += maxLayerHeight;
        maxLayerHeight = 0;
        maxRowLength = 0;
      }
    }

    // Verify bounds fit
    const fitsWidth = curX + itemW <= truck.boxWidthM;
    const fitsLength = curY + itemL <= truck.boxLengthM;
    const fitsHeight = curZ + itemH <= truck.boxHeightM;

    if (fitsWidth && fitsLength && fitsHeight) {
      const stackLayer = Math.floor(curZ / (itemH || 0.5)) + 1;
      placedPackages.push({
        itemId: u.item.id,
        name: u.item.name,
        unitIndex: u.unitIndex,
        x: Math.round(curX * 100) / 100,
        y: Math.round(curY * 100) / 100,
        z: Math.round(curZ * 100) / 100,
        lengthM: itemL,
        widthM: itemW,
        heightM: itemH,
        weightKg: u.item.weightKg,
        stackLayer,
        destinationStopId: u.item.destinationStopId,
      });

      curX += itemW;
      if (itemL > maxRowLength) maxRowLength = itemL;
      if (itemH > maxLayerHeight) maxLayerHeight = itemH;
    } else {
      unpackedPackages.push({
        itemId: u.item.id,
        name: `${u.item.name} (#${u.unitIndex})`,
        reason: !fitsHeight
          ? 'Vượt trần xe tải khi xếp chồng'
          : !fitsLength
          ? 'Hết chiều dài lòng thùng (chạm cửa thùng sau)'
          : 'Hết chiều rộng thành xe',
      });
    }
  }

  // 4. Weight distribution across axles (Center of Gravity along Y-axis)
  let centerOfGravityMoment = 0;
  for (const p of placedPackages) {
    const centerPointY = p.y + p.lengthM / 2;
    centerOfGravityMoment += p.weightKg * centerPointY;
  }
  const effectivePayloadPlaced = placedPackages.reduce((acc, p) => acc + p.weightKg, 0);
  const cogY = effectivePayloadPlaced > 0 ? centerOfGravityMoment / effectivePayloadPlaced : truck.boxLengthM / 2;
  const cogPct = Math.round((cogY / truck.boxLengthM) * 1000) / 10;

  // Ideal center of gravity is 42% - 58% of truck box length for dual axle stability
  const frontAxlePct = Math.max(10, Math.min(90, Math.round((100 - cogPct) * 10) / 10));
  const rearAxlePct = Math.round((100 - frontAxlePct) * 10) / 10;
  const isBalanced = frontAxlePct >= 38 && frontAxlePct <= 62;

  if (!isBalanced && placedPackages.length > 0) {
    warnings.push(
      `Phân bổ tải trọng lệch trục (${frontAxlePct}% đầu xe / ${rearAxlePct}% đuôi xe). Cần dàn đều hàng nặng về phía giữa thùng xe.`
    );
  }

  if (isOverweight) {
    warnings.push(
      `Quá tải trọng quy định: ${totalWeightKg} kg / ${truck.maxPayloadKg} kg (${weightUtilizationPct}%). Phạt quá tải khi kiểm tra cân!`
    );
  }

  if (isOvervolume) {
    warnings.push(
      `Quá thể tích lòng thùng: ${totalVolumeM3} m³ / ${truck.usableVolumeM3} m³ (${volumeUtilizationPct}%). Không đóng được cửa thùng!`
    );
  }

  if (unpackedPackages.length > 0) {
    warnings.push(`Còn ${unpackedPackages.length} kiện hàng chưa thể xếp do thiếu không gian vật lý 3D.`);
  }

  const isFit =
    !isOverweight &&
    !isOvervolume &&
    !isDimensionViolated &&
    isRefrigerationCompatible &&
    unpackedPackages.length === 0;

  let recommendation = '';
  if (isFit) {
    recommendation = `Đạt tiêu chuẩn tải trọng và xếp thùng (${weightUtilizationPct}% tải, ${volumeUtilizationPct}% thể tích). Xe sẵn sàng phát lệnh xuất bến.`;
  } else if (isOverweight && !isOvervolume) {
    recommendation = `Hàng nặng vượt tải. Khuyến nghị nâng cấp lên dòng xe tải trọng lớn hơn hoặc tách chuyến.`;
  } else if (!isOverweight && isOvervolume) {
    recommendation = `Hàng cồng kềnh (thể tích lớn). Cần xe thùng dài/cao hơn hoặc nén quy cách đóng gói.`;
  } else {
    recommendation = `Không đủ điều kiện xuất bến. Vui lòng kiểm tra cảnh báo và điều chỉnh phân bổ hàng hóa.`;
  }

  return {
    truck,
    totalWeightKg,
    maxPayloadKg: truck.maxPayloadKg,
    weightUtilizationPct,
    totalVolumeM3,
    usableVolumeM3: truck.usableVolumeM3,
    volumeUtilizationPct,
    isOverweight,
    isOvervolume,
    isDimensionViolated,
    isRefrigerationCompatible,
    isFit,
    placedCount: placedPackages.length,
    totalRequestedCount,
    placedPackages,
    unpackedPackages,
    axleLoadDistribution: {
      frontAxlePct,
      rearAxlePct,
      isBalanced,
    },
    warnings,
    recommendation,
  };
}
