import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  computeInvoiceTotals,
  formatCurrencyVND,
  formatDateTimeVN,
  formatDeliverySlipHtml,
  formatInvoiceHtml,
  formatThermalReceiptHtml,
  formatThermalReceiptText,
  generateVietQrFromInvoice,
  getStringDisplayWidth,
  InvoiceData,
  InvoiceDataSchema,
  LineItemSchema,
  numberToVietnameseWords,
  removeVietnameseDiacritics,
  StoreProfileSchema,
} from './index';

const mockStore = {
  name: 'Tiệm Cà Phê & FastFood KT',
  branch: 'Chi nhánh Quận 1',
  address: '123 Đường Nguyễn Huệ, Phường Bến Nghé, Quận 1, TP. Hồ Chí Minh',
  phone: '0901234567',
  hotline: '1900 6868',
  email: 'contact@ktfood.vn',
  website: 'https://ktfood.vn',
  taxCode: '0312345678',
  bankInfo: {
    bank: 'MB',
    accountNumber: '0901234567',
    accountName: 'CONG TY TNHH KT FOOD',
  },
  wifiInfo: {
    ssid: 'KT_Coffee_5G',
    password: 'uongcaphekhong',
  },
};

const mockCustomer = {
  name: 'Nguyễn Văn An',
  phone: '0988776655',
  address: '456 Lê Duẩn, Phường Bến Nghé, Quận 1, TP.HCM',
  email: 'an.nguyen@gmail.com',
  note: 'Giao giờ hành chính, gọi trước khi đến 15 phút',
};

const mockItems = [
  {
    id: 'item-1',
    name: 'Cà phê sữa đá Sài Gòn',
    quantity: 2,
    unit: 'ly',
    unitPrice: 35000,
    discount: 0,
    note: 'Ít ngọt, nhiều đá',
  },
  {
    id: 'item-2',
    name: 'Gà rán sốt cay Hàn Quốc',
    quantity: 1,
    unit: 'phần',
    unitPrice: 79000,
    discount: 5000,
    note: 'Cay vừa, thêm tương cà',
  },
];

const mockInvoice: InvoiceData = {
  id: 'HD20260930-001',
  orderCode: 'ORD-8899',
  type: 'invoice',
  createdAt: new Date('2026-09-30T10:30:00Z'),
  creatorName: 'Trần Thị Thu Ngân',
  cashier: 'Thu Ngân 01',
  tableName: 'Bàn số 05 (Lầu 1)',
  orderChannel: 'Tại quán',
  store: mockStore,
  customer: mockCustomer,
  items: mockItems,
  subtotal: 149000,
  discountAmount: 5000,
  shippingFee: 15000,
  vatRate: 8,
  vatAmount: 11520,
  totalAmount: 170520,
  amountPaid: 200000,
  changeAmount: 29480,
  paymentMethod: 'vietqr',
  paymentStatus: 'paid',
  footerMessage: 'Xin cảm ơn Quý khách & Hẹn gặp lại!',
};

describe('@kido/invoice-pdf Package Test Suite', () => {
  describe('1. Type-safe Zod Schema Validation', () => {
    it('should successfully parse valid InvoiceData', () => {
      const parsed = InvoiceDataSchema.parse(mockInvoice);
      assert.equal(parsed.id, 'HD20260930-001');
      assert.equal(parsed.items.length, 2);
      assert.equal(parsed.store.bankInfo?.bank, 'MB');
      assert.equal(parsed.paymentMethod, 'vietqr');
    });

    it('should reject invalid store profile without name or address', () => {
      assert.throws(() => {
        StoreProfileSchema.parse({
          name: '',
          address: '',
          phone: '',
        });
      });
    });

    it('should reject invalid line item with non-positive quantity', () => {
      assert.throws(() => {
        LineItemSchema.parse({
          name: 'Trà chanh',
          quantity: 0,
          unitPrice: 20000,
        });
      });
    });

    it('should reject invoice with empty items list', () => {
      assert.throws(() => {
        InvoiceDataSchema.parse({
          ...mockInvoice,
          items: [],
        });
      });
    });
  });

  describe('2. K80 Thermal Receipt Formatter (Text & HTML)', () => {
    it('should format clean K80 monospace plain text receipt', () => {
      const text = formatThermalReceiptText(mockInvoice, {
        paperWidth: 'k80',
        columns: 48,
        cutPaper: true,
      });

      assert.ok(text.includes('TIỆM CÀ PHÊ & FASTFOOD KT'));
      assert.ok(text.includes('HÓA ĐƠN BÁN HÀNG'));
      assert.ok(text.includes('Số HĐ: HD20260930-001'));
      assert.ok(text.includes('Cà phê sữa đá Sài Gòn'));
      assert.ok(text.includes('Gà rán sốt cay Hàn Quốc'));
      assert.ok(text.includes('TỔNG THANH TOÁN:'));
      assert.ok(text.includes('170.520 đ'));
      assert.ok(text.includes('Wifi: KT_Coffee_5G'));
      // Verify cut paper command appended
      assert.ok(text.includes('\x1d\x56\x01'));
    });

    it('should format production-ready K80 HTML receipt with VietQR embed', () => {
      const html = formatThermalReceiptHtml(mockInvoice, {
        paperWidth: 'k80',
        includeQr: true,
      });

      assert.ok(html.includes('<!DOCTYPE html>'));
      assert.ok(html.includes('80mm auto'));
      assert.ok(html.includes('border-top: 1px dashed #000;'));
      assert.ok(html.includes('TIỆM CÀ PHÊ &amp; FASTFOOD KT'));
      assert.ok(html.includes('HD20260930-001'));
      assert.ok(html.includes('QUÉT MÃ VIETQR ĐỂ THANH TOÁN'));
      assert.ok(html.includes('170.520 đ'));
    });
  });

  describe('3. K57 Compact Thermal Receipt Formatter & ASCII Diacritics', () => {
    it('should format compact K57 plain text receipt with 32 columns', () => {
      const text = formatThermalReceiptText(mockInvoice, {
        paperWidth: 'k57',
        columns: 32,
      });

      const lines = text.split('\n');
      for (const line of lines) {
        // Monospace width should not significantly exceed 32 columns
        assert.ok(
          getStringDisplayWidth(line) <= 34,
          `Line width should be ~32 cols: "${line}"`
        );
      }
      assert.ok(text.includes('170.520 đ'));
    });

    it('should strip Vietnamese diacritics when encoding is ascii_unaccented', () => {
      const text = formatThermalReceiptText(mockInvoice, {
        paperWidth: 'k80',
        encoding: 'ascii_unaccented',
      });

      // No accented characters like 'à', 'ê', 'đ', 'Đ'
      assert.ok(!/[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđĐ]/.test(text));
      assert.ok(text.includes('TIEM CA PHE & FASTFOOD KT'));
      assert.ok(text.includes('HOA DON BAN HANG'));
      assert.ok(text.includes('Ca phe sua da Sai Gon'));
    });
  });

  describe('4. Standard Invoice & Delivery Slip HTML Templates', () => {
    it('should format full standard A4 retail invoice HTML with VietQR and signatures', () => {
      const html = formatInvoiceHtml(mockInvoice, {
        paperSize: 'a4',
        showTaxCode: true,
        showSignatures: true,
        showVietQr: true,
      });

      assert.ok(html.includes('<!DOCTYPE html>'));
      assert.ok(html.includes('HÓA ĐƠN BÁN HÀNG'));
      assert.ok(html.includes('0312345678')); // MST
      assert.ok(html.includes('Nguyễn Văn An')); // Customer
      assert.ok(html.includes('Cà phê sữa đá Sài Gòn'));
      assert.ok(html.includes('Số tiền viết bằng chữ:'));
      assert.ok(html.includes('QUÉT MÃ VIETQR THANH TOÁN'));
      assert.ok(html.includes('Người mua hàng'));
      assert.ok(html.includes('Người lập phiếu / Thu ngân'));
    });

    it('should format dedicated delivery slip HTML for shipper & COD', () => {
      const deliveryInvoice: InvoiceData = {
        ...mockInvoice,
        type: 'delivery_slip',
        paymentMethod: 'cod',
        paymentStatus: 'pending',
      };

      const html = formatDeliverySlipHtml(deliveryInvoice);

      assert.ok(html.includes('PHIẾU GIAO HÀNG'));
      assert.ok(html.includes('TIỀN THU HỘ (COD):'));
      assert.ok(html.includes('NGƯỜI GỬI (SENDER)'));
      assert.ok(html.includes('NGƯỜI NHẬN (RECEIVER)'));
      assert.ok(html.includes('0988776655')); // Recipient phone
      assert.ok(html.includes('Người nhận hàng'));
      assert.ok(html.includes('Người giao hàng (Shipper)'));
    });

    it('should generate valid VietQR image URL from invoice data', () => {
      const qrUrl = generateVietQrFromInvoice(mockInvoice);
      assert.ok(qrUrl);
      assert.ok(qrUrl.includes('img.vietqr.io'));
      assert.ok(qrUrl.includes('0901234567')); // Account number
      assert.ok(qrUrl.includes('170520')); // Amount
    });
  });

  describe('5. Vietnamese Currency & Number To Words Formatting', () => {
    it('should correctly convert numbers to Vietnamese spoken currency words', () => {
      assert.equal(numberToVietnameseWords(0), 'Không đồng chẵn');
      assert.equal(numberToVietnameseWords(15000), 'Mười lăm nghìn đồng chẵn');
      assert.equal(numberToVietnameseWords(21000), 'Hai mươi mốt nghìn đồng chẵn');
      assert.equal(numberToVietnameseWords(105000), 'Một trăm lẻ năm nghìn đồng chẵn');
      assert.equal(numberToVietnameseWords(150000), 'Một trăm năm mươi nghìn đồng chẵn');
      assert.equal(
        numberToVietnameseWords(2500000),
        'Hai triệu năm trăm nghìn đồng chẵn'
      );
    });

    it('should format VND currency with dots and suffix', () => {
      assert.equal(formatCurrencyVND(0), '0 đ');
      assert.equal(formatCurrencyVND(35000), '35.000 đ');
      assert.equal(formatCurrencyVND(1250000), '1.250.000 đ');
    });

    it('should remove accents accurately', () => {
      assert.equal(
        removeVietnameseDiacritics('Cà phê sữa đá & Bánh mì kẹp thịt'),
        'Ca phe sua da & Banh mi kep thit'
      );
    });

    it('should auto-compute totals when subtotal or totalAmount are not provided', () => {
      const rawData: InvoiceData = {
        ...mockInvoice,
        subtotal: undefined,
        totalAmount: undefined as any,
        vatAmount: undefined,
        discountAmount: 10000,
        shippingFee: 20000,
        vatRate: 10,
      };

      const totals = computeInvoiceTotals(rawData);
      // Items: (2 * 35000 - 0) + (1 * 79000 - 5000) = 70000 + 74000 = 144000
      assert.equal(totals.subtotal, 144000);
      assert.equal(totals.discountAmount, 10000);
      // Taxable: 144000 - 10000 = 134000
      // VAT 10%: 13400
      assert.equal(totals.vatAmount, 13400);
      assert.equal(totals.shippingFee, 20000);
      // Total: 134000 + 13400 + 20000 = 167400
      assert.equal(totals.totalAmount, 167400);
    });
  });
});
