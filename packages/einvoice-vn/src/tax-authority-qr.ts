import { InvoiceNumberSchema, InvoiceSeriesSchema } from './types';

export interface TaxAuthorityQRInput {
  sellerTaxCode: string;
  invoiceSeries: string;
  invoiceNumber: string | number;
  issuedDate: string; // YYYY-MM-DD
  totalAmount: number;
  vatAmount: number;
  taxAuthorityCode?: string; // Mã CQT 34 ký tự
  lookupCode?: string;       // Mã tra cứu hóa đơn
  portalBaseUrl?: string;    // Base URL cổng tra cứu
}

export interface TaxAuthorityQRData {
  sellerTaxCode: string;
  invoiceSeries: string;
  invoiceNumber: string;
  issuedDate: string;
  totalAmount: number;
  vatAmount: number;
  taxAuthorityCode?: string;
  lookupCode?: string;
}

/**
 * Chuẩn hóa số hóa đơn thành chuỗi 8 chữ số (ví dụ: 1 -> "00000001")
 */
export function formatInvoiceNumber(invoiceNumber: string | number): string {
  const str = String(invoiceNumber).trim();
  return InvoiceNumberSchema.parse(str);
}

/**
 * Kiểm tra tính hợp lệ của Ký hiệu hóa đơn theo Thông tư 78
 */
export function validateInvoiceSeries(series: string): boolean {
  return InvoiceSeriesSchema.safeParse(series).success;
}

/**
 * Sinh chuỗi payload QR Code chuẩn hóa đơn điện tử Thông tư 78/2021/TT-BTC
 * Cấu trúc phân tách bởi dấu gạch đứng (|):
 * MST Người bán|Ký hiệu HĐ|Số HĐ|Ngày lập|Tổng tiền thanh toán|Tiền thuế GTGT|Mã CQT|Mã tra cứu
 */
export function generateTaxAuthorityQRPayload(input: TaxAuthorityQRInput): string {
  const formattedNumber = formatInvoiceNumber(input.invoiceNumber);
  const taxCode = input.sellerTaxCode.trim();
  const series = input.invoiceSeries.trim().toUpperCase();
  const date = input.issuedDate.trim();
  const total = Math.round(input.totalAmount);
  const vat = Math.round(input.vatAmount);
  const taxAuthCode = (input.taxAuthorityCode || '').trim();
  const lookup = (input.lookupCode || '').trim();

  return [taxCode, series, formattedNumber, date, total, vat, taxAuthCode, lookup].join('|');
}

/**
 * Phân tích cú pháp chuỗi QR Code hóa đơn điện tử
 */
export function parseTaxAuthorityQRPayload(qrText: string): TaxAuthorityQRData | null {
  if (!qrText || typeof qrText !== 'string') return null;

  // Nếu là URL, trích xuất query parameters
  if (qrText.startsWith('http://') || qrText.startsWith('https://')) {
    try {
      const url = new URL(qrText);
      const sellerTaxCode = url.searchParams.get('mst') || url.searchParams.get('sellerTaxCode') || '';
      const invoiceSeries = url.searchParams.get('kh') || url.searchParams.get('series') || '';
      const rawNumber = url.searchParams.get('shd') || url.searchParams.get('number') || '';
      const issuedDate = url.searchParams.get('date') || url.searchParams.get('ngay') || '';
      const totalAmount = Number(url.searchParams.get('total') || url.searchParams.get('tong') || 0);
      const vatAmount = Number(url.searchParams.get('vat') || url.searchParams.get('thue') || 0);
      const taxAuthorityCode = url.searchParams.get('macqt') || url.searchParams.get('cqt') || undefined;
      const lookupCode = url.searchParams.get('matracuu') || url.searchParams.get('code') || undefined;

      if (!sellerTaxCode || !invoiceSeries || !rawNumber) {
        return null;
      }

      return {
        sellerTaxCode,
        invoiceSeries,
        invoiceNumber: formatInvoiceNumber(rawNumber),
        issuedDate,
        totalAmount,
        vatAmount,
        taxAuthorityCode,
        lookupCode,
      };
    } catch {
      return null;
    }
  }

  // Format dạng pipe delimiter: MST|KHHDon|SHDon|NLap|TgTTTBSo|TgTThue|MaCQT|MaTraCuu
  const parts = qrText.split('|');
  if (parts.length < 5) {
    return null;
  }

  const [sellerTaxCode, invoiceSeries, rawNumber, issuedDate, rawTotal, rawVat, taxAuthorityCode, lookupCode] = parts;

  return {
    sellerTaxCode: sellerTaxCode.trim(),
    invoiceSeries: invoiceSeries.trim().toUpperCase(),
    invoiceNumber: formatInvoiceNumber(rawNumber),
    issuedDate: issuedDate.trim(),
    totalAmount: Number(rawTotal) || 0,
    vatAmount: Number(rawVat) || 0,
    taxAuthorityCode: taxAuthorityCode ? taxAuthorityCode.trim() : undefined,
    lookupCode: lookupCode ? lookupCode.trim() : undefined,
  };
}

/**
 * Sinh URL tra cứu trực tiếp hóa đơn điện tử trên cổng Tổng cục Thuế hoặc cổng đơn vị
 */
export function generateTaxAuthorityLookupUrl(
  input: TaxAuthorityQRInput,
  portalBaseUrl?: string
): string {
  const formattedNumber = formatInvoiceNumber(input.invoiceNumber);
  const baseUrl = portalBaseUrl || input.portalBaseUrl || 'https://hoadondientu.gdt.gov.vn';

  const url = new URL('/tra-cuu', baseUrl);
  url.searchParams.set('mst', input.sellerTaxCode.trim());
  url.searchParams.set('kh', input.invoiceSeries.trim().toUpperCase());
  url.searchParams.set('shd', formattedNumber);

  if (input.taxAuthorityCode) {
    url.searchParams.set('macqt', input.taxAuthorityCode.trim());
  }
  if (input.lookupCode) {
    url.searchParams.set('matracuu', input.lookupCode.trim());
  }
  if (input.issuedDate) {
    url.searchParams.set('date', input.issuedDate.trim());
  }
  if (typeof input.totalAmount === 'number') {
    url.searchParams.set('total', String(Math.round(input.totalAmount)));
  }

  return url.toString();
}

/**
 * Sinh mã Cơ quan Thuế 34 ký tự chuẩn Thông tư 78 (dùng cho Sandbox / Mock CQT)
 * Quy cách: 2 số loại ('00' là có mã) + 2 số năm ('26') + 30 ký tự Hexadecimal
 */
export function generateMockTaxAuthorityCode(year: number = 2026): string {
  const prefix = '00' + String(year).slice(-2);
  const chars = '0123456789ABCDEF';
  let hex = '';
  for (let i = 0; i < 30; i++) {
    const idx = Math.floor(Math.random() * chars.length);
    hex += chars[idx];
  }
  return prefix + hex;
}
