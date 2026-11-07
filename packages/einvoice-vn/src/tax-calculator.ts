import type {
  InvoiceItem,
  InvoiceTaxSummary,
  VatRate,
  VatRateSummary,
} from './types';

/**
 * Làm tròn tiền đồng VNĐ theo chuẩn kế toán Việt Nam (số nguyên không có phần thập phân)
 */
export function roundVnd(amount: number): number {
  return Math.round(amount);
}

/**
 * Chuyển đổi chuỗi thuế suất sang tỷ lệ số thập phân
 */
export function parseVatRatePercentage(vatRate: VatRate): number {
  switch (vatRate) {
    case '0%':
      return 0;
    case '5%':
      return 0.05;
    case '8%':
      return 0.08;
    case '10%':
      return 0.1;
    case 'KCT':
    case 'KKKNT':
      return 0;
    default:
      return 0;
  }
}

/**
 * Tính toán chi tiết cho một dòng hàng hóa dịch vụ
 */
export function calculateLineItem(
  item: {
    lineNumber?: number;
    itemType?: 1 | 2 | 3 | 4;
    itemCode?: string;
    itemName: string;
    unit?: string;
    quantity: number;
    unitPrice: number;
    discountRate?: number;
    discountAmount?: number;
    vatRate: VatRate;
  },
  index: number = 1
): InvoiceItem {
  const quantity = item.quantity;
  const unitPrice = item.unitPrice;
  const grossAmount = roundVnd(quantity * unitPrice);

  let discountAmount = 0;
  if (typeof item.discountAmount === 'number' && item.discountAmount > 0) {
    discountAmount = roundVnd(item.discountAmount);
  } else if (typeof item.discountRate === 'number' && item.discountRate > 0) {
    discountAmount = roundVnd(grossAmount * (item.discountRate / 100));
  }

  // Thành tiền chưa thuế
  const amount = Math.max(0, grossAmount - discountAmount);

  // Tiền thuế GTGT dòng
  const vatPercentage = parseVatRatePercentage(item.vatRate);
  const vatAmount = roundVnd(amount * vatPercentage);

  return {
    lineNumber: item.lineNumber ?? index,
    itemType: item.itemType ?? 1,
    itemCode: item.itemCode,
    itemName: item.itemName,
    unit: item.unit ?? 'Cái',
    quantity,
    unitPrice,
    discountRate: item.discountRate,
    discountAmount: discountAmount > 0 ? discountAmount : undefined,
    vatRate: item.vatRate,
    amount,
    vatAmount,
  };
}

/**
 * Phân nhóm và tính toán tổng tiền chưa thuế & tiền thuế theo từng mức thuế suất
 * Tuân thủ quy định: Tổng tiền thuế của nhóm = Làm tròn (Tổng doanh thu chịu thuế của nhóm * Thuế suất)
 */
export function calculateVatRateSummaries(items: InvoiceItem[]): VatRateSummary[] {
  // Gom nhóm doanh thu theo từng mức thuế suất
  const groupMap = new Map<VatRate, number>();

  for (const item of items) {
    const current = groupMap.get(item.vatRate) ?? 0;
    groupMap.set(item.vatRate, current + item.amount);
  }

  // Thứ tự hiển thị chuẩn trên hóa đơn
  const canonicalOrder: VatRate[] = ['KCT', 'KKKNT', '0%', '5%', '8%', '10%'];
  const summaries: VatRateSummary[] = [];

  for (const rate of canonicalOrder) {
    if (groupMap.has(rate)) {
      const taxableAmount = roundVnd(groupMap.get(rate)!);
      const percentage = parseVatRatePercentage(rate);
      const vatAmount = roundVnd(taxableAmount * percentage);
      summaries.push({
        vatRate: rate,
        taxableAmount,
        vatAmount,
      });
    }
  }

  return summaries;
}

/**
 * Đọc cụm 3 chữ số sang tiếng Việt
 */
function readTriplet(n: number, showZeroHundred: boolean): string {
  const digits = ['không', 'một', 'hai', 'ba', 'bốn', 'năm', 'sáu', 'bảy', 'tám', 'chín'];
  const hundreds = Math.floor(n / 100);
  const remainder = n % 100;
  const tens = Math.floor(remainder / 10);
  const units = remainder % 10;
  const res: string[] = [];

  if (hundreds > 0 || showZeroHundred) {
    res.push(digits[hundreds] + ' trăm');
  }

  if (tens > 1) {
    res.push(digits[tens] + ' mươi');
    if (units === 1) res.push('mốt');
    else if (units === 4) res.push('tư');
    else if (units === 5) res.push('lăm');
    else if (units > 0) res.push(digits[units]);
  } else if (tens === 1) {
    res.push('mười');
    if (units === 5) res.push('lăm');
    else if (units > 0) res.push(digits[units]);
  } else if (tens === 0 && (hundreds > 0 || showZeroHundred) && units > 0) {
    res.push('lẻ ' + digits[units]);
  } else if (tens === 0 && !hundreds && !showZeroHundred && units > 0) {
    res.push(digits[units]);
  }

  return res.join(' ');
}

/**
 * Đọc số tiền thành chữ tiếng Việt chuẩn xác theo luật kế toán Việt Nam
 */
export function numberToVietnameseWords(amount: number): string {
  const rounded = roundVnd(amount);
  if (rounded === 0) {
    return 'Không đồng chẵn.';
  }

  const scales = ['', 'nghìn', 'triệu', 'tỷ', 'nghìn tỷ', 'triệu tỷ'];
  const isNegative = rounded < 0;
  let n = Math.abs(rounded);
  const chunks: number[] = [];

  while (n > 0) {
    chunks.push(n % 1000);
    n = Math.floor(n / 1000);
  }

  const words: string[] = [];
  for (let i = chunks.length - 1; i >= 0; i--) {
    const chunk = chunks[i];
    if (chunk === 0) continue;
    const showZeroHundred = i < chunks.length - 1;
    const chunkWord = readTriplet(chunk, showZeroHundred);
    if (chunkWord) {
      words.push(chunkWord);
      if (scales[i]) {
        words.push(scales[i]);
      }
    }
  }

  let result = words.join(' ').trim();
  result = (isNegative ? 'Âm ' : '') + result.charAt(0).toUpperCase() + result.slice(1) + ' đồng chẵn.';
  return result;
}

/**
 * Tính toán toàn bộ bảng tổng kết thuế & tổng tiền thanh toán hóa đơn
 */
export function calculateInvoiceTax(
  rawItems: Array<{
    lineNumber?: number;
    itemType?: 1 | 2 | 3 | 4;
    itemCode?: string;
    itemName: string;
    unit?: string;
    quantity: number;
    unitPrice: number;
    discountRate?: number;
    discountAmount?: number;
    vatRate: VatRate;
  }>,
  options?: {
    additionalDiscountAmount?: number;
  }
): {
  items: InvoiceItem[];
  taxSummary: InvoiceTaxSummary;
} {
  const calculatedItems = rawItems.map((item, idx) => calculateLineItem(item, idx + 1));
  const vatSummaries = calculateVatRateSummaries(calculatedItems);

  // Tổng tiền chưa thuế
  const totalUntaxedAmount = vatSummaries.reduce((sum, v) => sum + v.taxableAmount, 0);

  // Tổng chiết khấu dòng
  const itemDiscounts = calculatedItems.reduce((sum, item) => sum + (item.discountAmount ?? 0), 0);
  const totalDiscountAmount = roundVnd(itemDiscounts + (options?.additionalDiscountAmount ?? 0));

  // Tổng tiền thuế GTGT
  const totalVatAmount = vatSummaries.reduce((sum, v) => sum + v.vatAmount, 0);

  // Tổng tiền thanh toán đã có thuế
  const totalAmount = roundVnd(totalUntaxedAmount + totalVatAmount);

  // Đọc tiền bằng chữ
  const amountInWords = numberToVietnameseWords(totalAmount);

  return {
    items: calculatedItems,
    taxSummary: {
      vatSummaries,
      totalUntaxedAmount,
      totalDiscountAmount,
      totalVatAmount,
      totalAmount,
      amountInWords,
    },
  };
}
