import {
  DealerTier,
  DEALER_TIER_LABELS,
  OrderPricingResult,
  PackagingUnit,
  PricingLineItemInput,
  PricingLineItemResult,
} from './types';

/**
 * Ma trận tỷ lệ chiết khấu cố định theo Cấp bậc đại lý
 */
export const TIER_BASE_DISCOUNTS: Record<DealerTier, number> = {
  TIER_2: 8,   // Cấp 2: Giảm 8%
  TIER_1: 14,  // Cấp 1: Giảm 14%
  GOLD: 20,    // Đại lý Vàng: Giảm 20%
  VIP: 25,     // Đại lý VIP chiến lược: Giảm 25%
};

/**
 * Quy đổi đơn vị sang số Thùng tương đương để tính hạn mức chiết khấu khối lượng
 * Mặc định: 1 Pallet = 50 Thùng, 1 Thùng = 1 Thùng, Hộp/Cái = 1/24 Thùng
 */
export function convertToThungEquivalent(
  quantity: number,
  unit: PackagingUnit,
  unitsPerPallet: number = 50
): number {
  switch (unit) {
    case 'PALLET':
      return quantity * unitsPerPallet;
    case 'THUNG':
      return quantity;
    case 'HOP':
    case 'CAI':
      return Math.round((quantity / 24) * 10) / 10;
    default:
      return quantity;
  }
}

/**
 * Lấy mức chiết khấu số lượng (Volume Discount) theo quy định:
 * - Mua > 100 thùng: giảm thêm 5%
 * - Mua > 50 thùng: giảm thêm 3%
 * - Dưới 50 thùng: 0%
 */
export function getVolumeDiscountTier(totalThung: number): {
  discountPercent: number;
  minThung: number;
  description: string;
} {
  if (totalThung >= 100) {
    return {
      discountPercent: 5,
      minThung: 100,
      description: 'Đạt mốc sỉ số lượng lớn (> 100 thùng): Giảm thêm 5%',
    };
  }
  if (totalThung >= 50) {
    return {
      discountPercent: 3,
      minThung: 50,
      description: 'Đạt mốc sỉ đại lý (> 50 thùng): Giảm thêm 3%',
    };
  }
  return {
    discountPercent: 0,
    minThung: 0,
    description: 'Chưa đạt mốc chiết khấu số lượng (Cần tối thiểu 50 thùng để giảm thêm 3%)',
  };
}

/**
 * Tính toán đơn giá và thành tiền cho một dòng sản phẩm
 */
export function calculateLineItemPricing(
  item: PricingLineItemInput,
  dealerTier: DealerTier,
  orderTotalThung?: number
): PricingLineItemResult {
  const unitsPerPallet = item.unitsPerPallet ?? 50;
  const thungEquivalent = convertToThungEquivalent(item.quantity, item.unit, unitsPerPallet);

  // Nếu không truyền orderTotalThung thì tính volume discount theo chính dòng này
  const thungCountForVolume = orderTotalThung !== undefined ? orderTotalThung : thungEquivalent;
  const volumeTier = getVolumeDiscountTier(thungCountForVolume);

  const tierDiscountPercent = TIER_BASE_DISCOUNTS[dealerTier] ?? 0;
  const volumeDiscountPercent = volumeTier.discountPercent;
  const totalDiscountPercent = tierDiscountPercent + volumeDiscountPercent;

  // Tính đơn giá sau chiết khấu (làm tròn số nguyên VND)
  const discountedUnitPrice = Math.max(
    0,
    Math.round(item.baseUnitPrice * (1 - totalDiscountPercent / 100))
  );

  const originalSubtotal = item.baseUnitPrice * item.quantity;
  const finalSubtotal = discountedUnitPrice * item.quantity;
  const discountAmount = originalSubtotal - finalSubtotal;

  return {
    productId: item.productId,
    productName: item.productName,
    unit: item.unit,
    quantity: item.quantity,
    thungEquivalent,
    baseUnitPrice: item.baseUnitPrice,
    tierDiscountPercent,
    volumeDiscountPercent,
    totalDiscountPercent,
    discountedUnitPrice,
    originalSubtotal,
    discountAmount,
    finalSubtotal,
  };
}

/**
 * Tính toán ma trận giá sỉ toàn bộ đơn hàng B2B
 * Tự động gộp tổng số thùng của tất cả sản phẩm để kích hoạt mốc Volume Discount cho toàn đơn
 */
export function calculateOrderPricing(
  items: PricingLineItemInput[],
  dealerTier: DealerTier
): OrderPricingResult {
  // 1. Tính tổng số thùng tương đương của toàn bộ đơn hàng
  let totalThungQuantity = 0;
  for (const item of items) {
    totalThungQuantity += convertToThungEquivalent(
      item.quantity,
      item.unit,
      item.unitsPerPallet ?? 50
    );
  }

  // 2. Xác định mốc Volume Discount áp dụng cho cả đơn
  const volumeTier = getVolumeDiscountTier(totalThungQuantity);
  const tierDiscountPercent = TIER_BASE_DISCOUNTS[dealerTier] ?? 0;

  // 3. Tính toán từng dòng sản phẩm
  let originalTotalAmount = 0;
  let finalTotalAmount = 0;
  let tierDiscountTotalAmount = 0;
  let volumeDiscountTotalAmount = 0;

  const calculatedItems: PricingLineItemResult[] = [];

  for (const item of items) {
    const calculated = calculateLineItemPricing(item, dealerTier, totalThungQuantity);
    calculatedItems.push(calculated);

    const origSub = item.baseUnitPrice * item.quantity;
    const tierDisc = Math.round(origSub * (tierDiscountPercent / 100));
    const volDisc = Math.round(origSub * (volumeTier.discountPercent / 100));

    originalTotalAmount += origSub;
    finalTotalAmount += calculated.finalSubtotal;
    tierDiscountTotalAmount += tierDisc;
    volumeDiscountTotalAmount += volDisc;
  }

  const totalDiscountAmount = originalTotalAmount - finalTotalAmount;
  const effectiveDiscountRate =
    originalTotalAmount > 0
      ? Math.round((totalDiscountAmount / originalTotalAmount) * 1000) / 10
      : 0;

  return {
    dealerTier,
    dealerTierLabel: DEALER_TIER_LABELS[dealerTier] ?? dealerTier,
    items: calculatedItems,
    totalThungQuantity,
    originalTotalAmount,
    tierDiscountTotalAmount,
    volumeDiscountTotalAmount,
    totalDiscountAmount,
    finalTotalAmount,
    effectiveDiscountRate,
    appliedVolumeTier: volumeTier,
  };
}
