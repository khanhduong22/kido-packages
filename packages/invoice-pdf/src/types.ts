import { z } from 'zod';

/**
 * Line item schema representing an individual product or service on the invoice
 */
export const LineItemSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1, 'Tên mặt hàng không được để trống'),
  sku: z.string().optional(),
  quantity: z.number().positive('Số lượng phải lớn hơn 0'),
  unit: z.string().optional().default('phần'),
  unitPrice: z.number().min(0, 'Đơn giá không được âm'),
  discount: z.number().min(0).optional().default(0),
  note: z.string().optional(),
  totalPrice: z.number().optional(),
});

export type LineItem = z.infer<typeof LineItemSchema>;

/**
 * Bank information for generating VietQR payment dynamic codes
 */
export const BankInfoSchema = z.object({
  bank: z.string().min(1, 'Tên ngân hàng hoặc mã BIN không được để trống'),
  accountNumber: z.string().min(1, 'Số tài khoản không được để trống'),
  accountName: z.string().min(1, 'Tên chủ tài khoản không được để trống'),
});

export type BankInfo = z.infer<typeof BankInfoSchema>;

/**
 * Store / Merchant business profile schema
 */
export const StoreProfileSchema = z.object({
  name: z.string().min(1, 'Tên cửa hàng không được để trống'),
  branch: z.string().optional(),
  address: z.string().min(1, 'Địa chỉ không được để trống'),
  phone: z.string().min(1, 'Số điện thoại không được để trống'),
  hotline: z.string().optional(),
  website: z.string().optional(),
  email: z.string().email().optional(),
  taxCode: z.string().optional(),
  logoUrl: z.string().optional(),
  bankInfo: BankInfoSchema.optional(),
  wifiInfo: z
    .object({
      ssid: z.string().optional(),
      password: z.string().optional(),
    })
    .optional(),
});

export type StoreProfile = z.infer<typeof StoreProfileSchema>;

/**
 * Customer / Recipient contact schema
 */
export const CustomerInfoSchema = z.object({
  name: z.string().min(1, 'Tên khách hàng không được để trống'),
  phone: z.string().optional(),
  address: z.string().optional(),
  email: z.string().email().optional(),
  note: z.string().optional(),
});

export type CustomerInfo = z.infer<typeof CustomerInfoSchema>;

/**
 * Payment method options
 */
export const PaymentMethodSchema = z
  .enum(['cash', 'vietqr', 'card', 'bank_transfer', 'cod', 'other'])
  .or(z.string());

export type PaymentMethod = z.infer<typeof PaymentMethodSchema>;

/**
 * Payment status options
 */
export const PaymentStatusSchema = z.enum([
  'pending',
  'paid',
  'partially_paid',
  'refunded',
]);

export type PaymentStatus = z.infer<typeof PaymentStatusSchema>;

/**
 * Document types: Standard Invoice, Receipt or Delivery Slip
 */
export const InvoiceTypeSchema = z.enum([
  'invoice', // Hóa đơn bán lẻ
  'receipt', // Phiếu thu / Biên lai
  'delivery_slip', // Phiếu giao hàng
]);

export type InvoiceType = z.infer<typeof InvoiceTypeSchema>;

/**
 * Full Invoice Data Schema
 */
export const InvoiceDataSchema = z.object({
  id: z.string().min(1, 'Mã hóa đơn không được để trống'),
  orderCode: z.string().optional(),
  type: InvoiceTypeSchema.default('invoice'),
  createdAt: z.union([z.date(), z.string()]).default(() => new Date()),
  creatorName: z.string().optional(),
  cashier: z.string().optional(),
  tableName: z.string().optional(),
  orderChannel: z.string().optional(),
  store: StoreProfileSchema,
  customer: CustomerInfoSchema.optional(),
  items: z.array(LineItemSchema).min(1, 'Danh sách hàng hóa không được rỗng'),
  subtotal: z.number().optional(),
  discountAmount: z.number().optional(),
  discountPercent: z.number().min(0).max(100).optional(),
  shippingFee: z.number().optional(),
  vatRate: z.number().min(0).max(100).optional(),
  vatAmount: z.number().optional(),
  totalAmount: z.number().min(0, 'Tổng tiền không được âm'),
  amountPaid: z.number().optional(),
  changeAmount: z.number().optional(),
  paymentMethod: PaymentMethodSchema.default('cash'),
  paymentStatus: PaymentStatusSchema.default('paid'),
  qrPaymentUrl: z.string().optional(),
  footerMessage: z.string().optional(),
});

export type InvoiceData = z.infer<typeof InvoiceDataSchema>;
export type InvoiceDataInput = z.input<typeof InvoiceDataSchema>;

/**
 * Receipt Formatter Options for thermal printing
 */
export const ReceiptFormatOptionsSchema = z.object({
  paperWidth: z.enum(['k80', 'k57']).default('k80'),
  columns: z.number().int().positive().optional(),
  includeQr: z.boolean().optional().default(true),
  showItemNote: z.boolean().optional().default(true),
  showStoreLogo: z.boolean().optional().default(true),
  encoding: z.enum(['utf8', 'ascii_unaccented']).optional().default('utf8'),
  cutPaper: z.boolean().optional().default(false),
  fontSize: z.enum(['normal', 'condensed']).optional().default('normal'),
  highlightTotal: z.boolean().optional().default(true),
});

export type ReceiptFormatOptions = z.infer<typeof ReceiptFormatOptionsSchema>;

/**
 * Invoice Template Options for A4/A5 PDF & HTML generation
 */
export const InvoiceTemplateOptionsSchema = z.object({
  paperSize: z.enum(['a4', 'a5', 'letter']).default('a4'),
  orientation: z.enum(['portrait', 'landscape']).default('portrait'),
  showTaxCode: z.boolean().default(true),
  showSignatures: z.boolean().default(true),
  showVietQr: z.boolean().default(true),
  primaryColor: z.string().default('#0f172a'),
  accentColor: z.string().default('#2563eb'),
  title: z.string().optional(),
});

export type InvoiceTemplateOptions = z.infer<typeof InvoiceTemplateOptionsSchema>;
