import { z } from 'zod';

/**
 * Loại mẫu số hóa đơn theo Thông tư 78/2021/TT-BTC & Nghị định 123/2020/NĐ-CP
 * 1: Hóa đơn điện tử giá trị gia tăng (GTGT)
 * 2: Hóa đơn điện tử bán hàng
 * 3: Hóa đơn điện tử bán tài sản công
 * 4: Hóa đơn điện tử bán hàng dự trữ quốc gia
 * 5: Hóa đơn khác (vé, tem, thẻ, chứng từ điện tử thu phí...)
 * 6: Các chứng từ điện tử được quản lý như hóa đơn (phiếu xuất kho kiêm vận chuyển nội bộ, phiếu xuất kho gửi bán đại lý)
 */
export const InvoiceTypeSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
  z.literal(6),
]);
export type InvoiceType = z.infer<typeof InvoiceTypeSchema>;

/**
 * Thuế suất GTGT theo quy định Việt Nam
 * '0%': Thuế suất 0% (xuất khẩu, vận tải quốc tế...)
 * '5%': Thuế suất ưu đãi 5% (y tế, giáo dục, nông sản sơ chế...)
 * '8%': Thuế suất giảm 8% (theo Nghị quyết Quốc hội/Chính phủ hỗ trợ kinh tế)
 * '10%': Thuế suất chuẩn 10%
 * 'KCT': Không chịu thuế GTGT
 * 'KKKNT': Không kê khai, nộp thuế GTGT
 */
export const VatRateSchema = z.enum(['0%', '5%', '8%', '10%', 'KCT', 'KKKNT']);
export type VatRate = z.infer<typeof VatRateSchema>;

/**
 * Trạng thái vòng đời của hóa đơn điện tử
 */
export const InvoiceStatusSchema = z.enum([
  'DRAFT',         // Hóa đơn nháp chưa ký
  'SIGNED',        // Đã ký số điện tử
  'SENT_TAX',      // Đã gửi Cơ quan Thuế
  'TAX_APPROVED',  // Cục Thuế đã cấp mã hóa đơn hợp lệ
  'CANCELLED',     // Hóa đơn đã bị hủy (Mẫu 04/SS-HĐĐT)
  'REPLACED',      // Hóa đơn đã bị thay thế bởi hóa đơn khác
  'ADJUSTED',      // Hóa đơn đã bị điều chỉnh
]);
export type InvoiceStatus = z.infer<typeof InvoiceStatusSchema>;

/**
 * Ký hiệu hóa đơn (Series) theo Thông tư 78/2021/TT-BTC:
 * - Ký tự 1: C (Có mã CQT) hoặc K (Không có mã CQT)
 * - Ký tự 2-3: 2 chữ số năm lập hóa đơn (ví dụ: 26 cho năm 2026)
 * - Ký tự 4: Loại HĐ (T: Doanh nghiệp, D: Tài sản công, L: CQT cấp lẻ, M: Máy tính tiền, N: Vận chuyển nội bộ, B: Hàng gửi bán, G: Tem/vé)
 * - Ký tự 5-6: 2 ký tự tự chọn do DN quản lý (chữ cái A-Z hoặc số 0-9)
 * Regex: ^[C|K][0-9]{2}[T|D|L|M|N|B|G][A-Z0-9]{2}$
 */
export const InvoiceSeriesSchema = z
  .string()
  .regex(
    /^[C|K][0-9]{2}[T|D|L|M|N|B|G][A-Z0-9]{2}$/,
    'Ký hiệu hóa đơn không đúng chuẩn TT78 (ví dụ: C26TKT, K26TKT, C26MKT)'
  );
export type InvoiceSeries = z.infer<typeof InvoiceSeriesSchema>;

/**
 * Số hóa đơn: Tối đa 8 chữ số (từ 00000001 đến 99999999)
 */
export const InvoiceNumberSchema = z
  .string()
  .regex(/^[0-9]{1,8}$/, 'Số hóa đơn phải gồm 1 đến 8 chữ số')
  .transform((val) => val.padStart(8, '0'));
export type InvoiceNumber = z.infer<typeof InvoiceNumberSchema>;

/**
 * Thông tin Người bán (Seller)
 */
export const SellerSchema = z.object({
  sellerTaxCode: z
    .string()
    .min(10, 'Mã số thuế tối thiểu 10 ký tự')
    .max(14, 'Mã số thuế tối đa 14 ký tự')
    .regex(/^[0-9]{10}(-[0-9]{3})?$/, 'Mã số thuế người bán không hợp lệ (10 số hoặc 13 số có gạch ngang)'),
  sellerName: z.string().min(1, 'Tên đơn vị bán không được để trống'),
  sellerLegalName: z.string().optional(),
  sellerAddress: z.string().min(1, 'Địa chỉ người bán không được để trống'),
  sellerPhone: z.string().optional(),
  sellerEmail: z.string().email('Email người bán không hợp lệ').optional().or(z.literal('')),
  sellerBankAccount: z.string().optional(),
  sellerBankName: z.string().optional(),
});
export type Seller = z.infer<typeof SellerSchema>;

/**
 * Thông tin Người mua (Buyer)
 */
export const BuyerSchema = z.object({
  buyerName: z.string().min(1, 'Tên người mua / đơn vị mua không được để trống'),
  buyerLegalName: z.string().optional(),
  buyerTaxCode: z.string().optional(), // MST doanh nghiệp hoặc CCCD/CMND cá nhân
  buyerAddress: z.string().optional(),
  buyerEmail: z.string().email('Email nhận hóa đơn không hợp lệ').optional().or(z.literal('')),
  buyerPhone: z.string().optional(),
  buyerBankAccount: z.string().optional(),
  buyerBankName: z.string().optional(),
});
export type Buyer = z.infer<typeof BuyerSchema>;

/**
 * Loại dòng hàng hóa / dịch vụ:
 * 1: Hàng hóa, dịch vụ thông thường
 * 2: Khuyến mại, biếu tặng không thu tiền
 * 3: Chiết khấu thương mại
 * 4: Ghi chú, diễn giải
 */
export const ItemTypeSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
]);
export type ItemType = z.infer<typeof ItemTypeSchema>;

/**
 * Chi tiết dòng hàng hóa dịch vụ (Line item)
 */
export const InvoiceItemSchema = z.object({
  lineNumber: z.number().int().positive('Số thứ tự phải lớn hơn 0'),
  itemType: ItemTypeSchema.default(1),
  itemCode: z.string().optional(),
  itemName: z.string().min(1, 'Tên hàng hóa dịch vụ không được để trống'),
  unit: z.string().min(1, 'Đơn vị tính không được để trống').default('Cái'),
  quantity: z.number().min(0, 'Số lượng không được âm'),
  unitPrice: z.number().min(0, 'Đơn giá không được âm'),
  discountRate: z.number().min(0).max(100).optional(), // Tỷ lệ chiết khấu (%)
  discountAmount: z.number().min(0).optional(),         // Tiền chiết khấu (VNĐ)
  vatRate: VatRateSchema,
  amount: z.number(),                                   // Thành tiền chưa thuế
  vatAmount: z.number().optional(),                     // Tiền thuế GTGT dòng
});
export type InvoiceItem = z.infer<typeof InvoiceItemSchema>;

/**
 * Bảng kê tổng hợp doanh thu & tiền thuế theo từng mức thuế suất
 */
export const VatRateSummarySchema = z.object({
  vatRate: VatRateSchema,
  taxableAmount: z.number(), // Doanh thu chưa thuế cho mức này
  vatAmount: z.number(),     // Tiền thuế GTGT cho mức này
});
export type VatRateSummary = z.infer<typeof VatRateSummarySchema>;

/**
 * Tổng hợp tài chính & tiền thuế của toàn bộ hóa đơn
 */
export const InvoiceTaxSummarySchema = z.object({
  vatSummaries: z.array(VatRateSummarySchema),
  totalUntaxedAmount: z.number(),  // Tổng tiền chưa thuế
  totalDiscountAmount: z.number(), // Tổng tiền chiết khấu
  totalVatAmount: z.number(),      // Tổng tiền thuế GTGT
  totalAmount: z.number(),         // Tổng tiền thanh toán đã có thuế (VNĐ)
  amountInWords: z.string(),       // Số tiền viết bằng chữ tiếng Việt
});
export type InvoiceTaxSummary = z.infer<typeof InvoiceTaxSummarySchema>;

/**
 * Thông tin Cơ quan Thuế & Tra cứu
 */
export const TaxAuthorityInfoSchema = z.object({
  taxAuthorityCode: z.string().optional(), // Mã CQT 34 ký tự (ví dụ: 0026A1B2C3...)
  lookupCode: z.string().optional(),       // Mã tra cứu bí mật hóa đơn
  lookupUrl: z.string().optional(),        // Đường link tra cứu hóa đơn
  qrCodeData: z.string().optional(),       // Chuỗi dữ liệu mã QR tra cứu
  submittedDate: z.string().optional(),    // Ngày gửi thuế (ISO string hoặc YYYY-MM-DD)
  approvedDate: z.string().optional(),     // Ngày CQT duyệt cấp mã
});
export type TaxAuthorityInfo = z.infer<typeof TaxAuthorityInfoSchema>;

/**
 * Dữ liệu Hóa đơn Điện tử hoàn chỉnh (Full Invoice Schema)
 */
export const InvoiceSchema = z.object({
  id: z.string().optional(),
  invoiceType: InvoiceTypeSchema.default(1),
  invoiceSeries: InvoiceSeriesSchema,
  invoiceNumber: InvoiceNumberSchema,
  issuedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Ngày lập phải có định dạng YYYY-MM-DD'),
  currency: z.string().default('VND'),
  exchangeRate: z.number().default(1),
  paymentMethod: z.string().default('TM/CK'), // Tiền mặt / Chuyển khoản
  status: InvoiceStatusSchema.default('DRAFT'),
  seller: SellerSchema,
  buyer: BuyerSchema,
  items: z.array(InvoiceItemSchema).min(1, 'Hóa đơn phải có ít nhất 1 dòng hàng hóa dịch vụ'),
  taxSummary: InvoiceTaxSummarySchema,
  taxAuthority: TaxAuthorityInfoSchema.optional(),
  signedXml: z.string().optional(),
  signedAt: z.string().optional(),
  notes: z.string().optional(),
  // Quan hệ điều chỉnh / thay thế
  relatedInvoice: z
    .object({
      series: InvoiceSeriesSchema,
      number: InvoiceNumberSchema,
      issuedDate: z.string(),
      relationType: z.enum(['ADJUSTMENT', 'REPLACEMENT']),
      reason: z.string().optional(),
      adjustmentType: z.enum(['INCREASE', 'DECREASE', 'INFO']).optional(),
    })
    .optional(),
});
export type Invoice = z.infer<typeof InvoiceSchema>;

/**
 * Input phát hành hóa đơn mới
 */
export const IssueInvoiceInputSchema = z.object({
  invoiceType: InvoiceTypeSchema.optional().default(1),
  invoiceSeries: InvoiceSeriesSchema,
  invoiceNumber: InvoiceNumberSchema.optional(), // Có thể để adapter tự sinh số tiếp theo
  issuedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  paymentMethod: z.string().optional().default('TM/CK'),
  seller: SellerSchema,
  buyer: BuyerSchema,
  items: z.array(
    z.object({
      lineNumber: z.number().int().positive().optional(),
      itemType: ItemTypeSchema.optional().default(1),
      itemCode: z.string().optional(),
      itemName: z.string().min(1),
      unit: z.string().optional().default('Cái'),
      quantity: z.number().min(0),
      unitPrice: z.number().min(0),
      discountRate: z.number().min(0).max(100).optional(),
      discountAmount: z.number().min(0).optional(),
      vatRate: VatRateSchema,
    })
  ).min(1),
  notes: z.string().optional(),
});
export type IssueInvoiceInput = z.input<typeof IssueInvoiceInputSchema>;
export type IssuedInvoiceData = z.output<typeof IssueInvoiceInputSchema>;

/**
 * Kết quả phát hành hóa đơn
 */
export interface InvoiceResult {
  success: boolean;
  invoiceSeries: string;
  invoiceNumber: string;
  taxAuthorityCode?: string;
  lookupCode: string;
  lookupUrl: string;
  qrCodeData: string;
  signedXml?: string;
  status: InvoiceStatus;
  issuedDate: string;
  errorMessage?: string;
}

/**
 * Input hủy hóa đơn (Thông báo 04/SS-HĐĐT)
 */
export const CancelInvoiceInputSchema = z.object({
  sellerTaxCode: z.string().min(10).max(14),
  invoiceSeries: InvoiceSeriesSchema,
  invoiceNumber: InvoiceNumberSchema,
  reason: z.string().min(1, 'Lý do hủy hóa đơn không được để trống'),
  noticeDocNumber: z.string().min(1, 'Số thông báo 04/SS-HĐĐT không được để trống'),
  noticeDocDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Ngày lập thông báo định dạng YYYY-MM-DD'),
});
export type CancelInvoiceInput = z.infer<typeof CancelInvoiceInputSchema>;

export interface CancelInvoiceResult {
  success: boolean;
  invoiceSeries: string;
  invoiceNumber: string;
  cancelledAt: string;
  status: 'CANCELLED';
  errorMessage?: string;
}

/**
 * Input điều chỉnh hóa đơn
 */
export const AdjustInvoiceInputSchema = z.object({
  originalSeries: InvoiceSeriesSchema,
  originalNumber: InvoiceNumberSchema,
  adjustmentType: z.enum(['INCREASE', 'DECREASE', 'INFO']),
  reason: z.string().min(1, 'Lý do điều chỉnh không được để trống'),
  docNumber: z.string().optional(), // Số biên bản thỏa thuận
  docDate: z.string().optional(),   // Ngày biên bản thỏa thuận
  adjustmentInvoice: IssueInvoiceInputSchema,
});
export type AdjustInvoiceInput = z.input<typeof AdjustInvoiceInputSchema>;

export interface AdjustInvoiceResult {
  success: boolean;
  originalSeries: string;
  originalNumber: string;
  adjustmentSeries: string;
  adjustmentNumber: string;
  taxAuthorityCode?: string;
  lookupCode: string;
  lookupUrl: string;
  status: InvoiceStatus;
  errorMessage?: string;
}

/**
 * Input thay thế hóa đơn
 */
export const ReplaceInvoiceInputSchema = z.object({
  originalSeries: InvoiceSeriesSchema,
  originalNumber: InvoiceNumberSchema,
  reason: z.string().min(1, 'Lý do thay thế không được để trống'),
  docNumber: z.string().optional(), // Biên bản thỏa thuận thay thế
  docDate: z.string().optional(),
  replacementInvoice: IssueInvoiceInputSchema,
});
export type ReplaceInvoiceInput = z.input<typeof ReplaceInvoiceInputSchema>;

export interface ReplaceInvoiceResult {
  success: boolean;
  originalSeries: string;
  originalNumber: string;
  replacementSeries: string;
  replacementNumber: string;
  taxAuthorityCode?: string;
  lookupCode: string;
  lookupUrl: string;
  status: InvoiceStatus;
  errorMessage?: string;
}

/**
 * Input tra cứu hóa đơn
 */
export const LookupInvoiceInputSchema = z.object({
  sellerTaxCode: z.string().min(10).max(14),
  invoiceSeries: InvoiceSeriesSchema.optional(),
  invoiceNumber: InvoiceNumberSchema.optional(),
  lookupCode: z.string().optional(),
});
export type LookupInvoiceInput = z.infer<typeof LookupInvoiceInputSchema>;

export interface LookupInvoiceResult {
  found: boolean;
  invoice?: Invoice;
  errorMessage?: string;
}

/**
 * Input tải file hóa đơn (PDF / XML)
 */
export const DownloadInvoiceInputSchema = z.object({
  sellerTaxCode: z.string().min(10).max(14),
  invoiceSeries: InvoiceSeriesSchema,
  invoiceNumber: InvoiceNumberSchema,
  format: z.enum(['PDF', 'XML']),
});
export type DownloadInvoiceInput = z.infer<typeof DownloadInvoiceInputSchema>;
