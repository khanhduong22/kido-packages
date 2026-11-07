import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  // Types & Formatters
  formatVnd,
  DealerRecord,
  InvoiceRecord,
  // Credit Lockout
  evaluateCreditLimit,
  isOrderAllowed,
  assertCreditLimit,
  CreditLockoutError,
  // Aging Schedule
  classifyInvoiceAging,
  calculateAgingSchedule,
  calculateDealerAging,
  DEFAULT_PROVISION_RATES,
  // Tiered Pricing
  TIER_BASE_DISCOUNTS,
  convertToThungEquivalent,
  getVolumeDiscountTier,
  calculateLineItemPricing,
  calculateOrderPricing,
  // SOA Generator
  buildVietQrUrl,
  generateK80SoaText,
  generateK80SoaHtml,
  generateFormalSoaHtml,
  DEFAULT_B2B_BANK,
} from './index';

describe('@kido/b2b-credit Package Comprehensive Test Suite', () => {
  // =========================================================================
  // 1. Credit Lockout Engine Tests
  // =========================================================================
  describe('1. Credit Lockout Engine', () => {
    const mockDealer: DealerRecord = {
      id: 'dl-001',
      code: 'DL-HN-01',
      name: 'Đại Lý Phân Phối Hà Nội',
      phone: '0912345678',
      address: '123 Cầu Giấy, Hà Nội',
      tier: 'GOLD',
      creditLimit: 200_000_000, // 200 triệu
      currentDebt: 120_000_000, // 120 triệu
      paymentTermDays: 30,
    };

    it('1.1. Approves order when total exposure is strictly within credit limit', () => {
      const result = evaluateCreditLimit({
        dealerId: mockDealer.id,
        dealerName: mockDealer.name,
        creditLimit: mockDealer.creditLimit,
        currentDebt: mockDealer.currentDebt,
        newOrderAmount: 50_000_000, // 120tr + 50tr = 170tr < 200tr
        unpaidInvoices: [],
      });

      assert.equal(result.isLocked, false);
      assert.equal(result.status, 'APPROVED');
      assert.equal(result.canPlaceOrder, true);
      assert.equal(result.totalExposure, 170_000_000);
      assert.equal(result.remainingCreditAfterOrder, 30_000_000);
      assert.equal(result.utilizationRate, 0.85);
      assert.equal(isOrderAllowed({
        dealerId: mockDealer.id,
        creditLimit: mockDealer.creditLimit,
        currentDebt: mockDealer.currentDebt,
        newOrderAmount: 50_000_000,
      }), true);
    });

    it('1.2. Hard locks order when new order amount exceeds credit limit', () => {
      const result = evaluateCreditLimit({
        dealerId: mockDealer.id,
        dealerName: mockDealer.name,
        creditLimit: mockDealer.creditLimit,
        currentDebt: mockDealer.currentDebt,
        newOrderAmount: 90_000_000, // 120tr + 90tr = 210tr > 200tr
        unpaidInvoices: [],
      });

      assert.equal(result.isLocked, true);
      assert.equal(result.status, 'HARD_LOCKED');
      assert.equal(result.lockReasonCode, 'CREDIT_EXCEEDED');
      assert.equal(result.canPlaceOrder, false);
      assert.equal(result.totalExposure, 210_000_000);
      assert.equal(result.remainingCreditAfterOrder, -10_000_000);
      assert.match(result.reasons[0], /vượt quá hạn mức tín dụng/);

      assert.throws(
        () => {
          assertCreditLimit({
            dealerId: mockDealer.id,
            creditLimit: mockDealer.creditLimit,
            currentDebt: mockDealer.currentDebt,
            newOrderAmount: 90_000_000,
          });
        },
        CreditLockoutError
      );
    });

    it('1.3. Hard locks order when dealer has overdue invoice > 30 days regardless of credit limit headroom', () => {
      const referenceDate = new Date('2026-10-01T00:00:00Z');
      const overdueInvoice: InvoiceRecord = {
        id: 'inv-001',
        invoiceNumber: 'HD-2026-0801',
        dealerId: mockDealer.id,
        issueDate: '2026-08-01',
        dueDate: '2026-08-15', // Quá hạn ~47 ngày tính đến 2026-10-01
        totalAmount: 30_000_000,
        paidAmount: 0,
        remainingAmount: 30_000_000,
      };

      const result = evaluateCreditLimit({
        dealerId: mockDealer.id,
        dealerName: mockDealer.name,
        creditLimit: mockDealer.creditLimit,
        currentDebt: 30_000_000,
        newOrderAmount: 10_000_000, // Còn dư nhiều hạn mức (40tr / 200tr)
        unpaidInvoices: [overdueInvoice],
        referenceDate,
      });

      assert.equal(result.isLocked, true);
      assert.equal(result.status, 'HARD_LOCKED');
      assert.equal(result.lockReasonCode, 'OVERDUE_30D');
      assert.equal(result.hasOverdue30Plus, true);
      assert.equal(result.maxOverdueDays >= 45, true);
      assert.equal(result.canPlaceOrder, false);
    });

    it('1.4. Hard locks order with compound reason when both exceeded limit and overdue > 30 days', () => {
      const referenceDate = new Date('2026-10-01T00:00:00Z');
      const overdueInvoice: InvoiceRecord = {
        id: 'inv-002',
        invoiceNumber: 'HD-2026-0810',
        dealerId: mockDealer.id,
        issueDate: '2026-08-10',
        dueDate: '2026-08-25', // Quá hạn ~37 ngày
        totalAmount: 150_000_000,
        paidAmount: 0,
        remainingAmount: 150_000_000,
      };

      const result = evaluateCreditLimit({
        dealerId: mockDealer.id,
        creditLimit: mockDealer.creditLimit, // 200tr
        currentDebt: 150_000_000,
        newOrderAmount: 70_000_000, // 150tr + 70tr = 220tr > 200tr
        unpaidInvoices: [overdueInvoice],
        referenceDate,
      });

      assert.equal(result.isLocked, true);
      assert.equal(result.status, 'HARD_LOCKED');
      assert.equal(result.lockReasonCode, 'OVERDUE_AND_CREDIT_EXCEEDED');
    });

    it('1.5. Handles soft lock grace tolerance and short-term overdue warnings', () => {
      // Vượt 2tr trên 200tr (1%), có grace 5% -> SOFT_LOCKED
      const softResult = evaluateCreditLimit({
        dealerId: mockDealer.id,
        creditLimit: 200_000_000,
        currentDebt: 195_000_000,
        newOrderAmount: 7_000_000, // 202tr, vượt 2tr <= 5% (10tr)
        softLockGracePercent: 5,
        unpaidInvoices: [],
      });

      assert.equal(softResult.status, 'SOFT_LOCKED');
      assert.equal(softResult.isLocked, false);
      assert.equal(softResult.requiresSupervisorApproval, true);
      assert.equal(softResult.lockReasonCode, 'SOFT_UTILIZATION_WARNING');

      // Có nợ quá hạn ngắn hạn 5 ngày -> Cảnh báo SOFT_LOCKED
      const refDate = new Date('2026-10-06T00:00:00Z');
      const shortOverdueInv: InvoiceRecord = {
        id: 'inv-003',
        invoiceNumber: 'HD-2026-0925',
        dealerId: mockDealer.id,
        issueDate: '2026-09-15',
        dueDate: '2026-10-01', // Quá hạn 5 ngày
        totalAmount: 20_000_000,
        paidAmount: 0,
        remainingAmount: 20_000_000,
      };

      const warnResult = evaluateCreditLimit({
        dealerId: mockDealer.id,
        creditLimit: 200_000_000,
        currentDebt: 20_000_000,
        newOrderAmount: 10_000_000,
        unpaidInvoices: [shortOverdueInv],
        referenceDate: refDate,
      });

      assert.equal(warnResult.status, 'SOFT_LOCKED');
      assert.equal(warnResult.isLocked, false);
      assert.equal(warnResult.maxOverdueDays, 5);
    });

    it('1.6. Hard locks immediately if dealer account is suspended', () => {
      const result = evaluateCreditLimit({
        dealerId: mockDealer.id,
        creditLimit: mockDealer.creditLimit,
        currentDebt: 0,
        newOrderAmount: 10_000_000,
        isSuspended: true,
      });

      assert.equal(result.isLocked, true);
      assert.equal(result.status, 'HARD_LOCKED');
      assert.equal(result.lockReasonCode, 'ACCOUNT_SUSPENDED');
    });
  });

  // =========================================================================
  // 2. Aging Schedule Engine Tests (D0 - D90+)
  // =========================================================================
  describe('2. Aging Schedule Engine', () => {
    const refDate = new Date('2026-10-01T00:00:00Z');

    it('2.1. Accurately classifies single invoices into correct aging buckets and calculates provision', () => {
      // D0: Trong hạn (chưa tới ngày đáo hạn)
      const invD0: InvoiceRecord = {
        id: '1',
        invoiceNumber: 'INV-D0',
        dealerId: 'dl-1',
        issueDate: '2026-09-20',
        dueDate: '2026-10-10', // Còn 9 ngày mới tới hạn
        totalAmount: 10_000_000,
        paidAmount: 0,
        remainingAmount: 10_000_000,
      };
      const classD0 = classifyInvoiceAging(invD0, refDate);
      assert.equal(classD0.bucket, 'D0');
      assert.equal(classD0.overdueDays, 0);
      assert.equal(classD0.isOverdue, false);
      assert.equal(classD0.provisionRate, 0);
      assert.equal(classD0.provisionAmount, 0);

      // D15: Quá hạn 10 ngày (1 <= 10 <= 15)
      const invD15: InvoiceRecord = {
        id: '2',
        invoiceNumber: 'INV-D15',
        dealerId: 'dl-1',
        issueDate: '2026-09-01',
        dueDate: '2026-09-21', // Quá hạn 10 ngày
        totalAmount: 20_000_000,
        paidAmount: 0,
        remainingAmount: 20_000_000,
      };
      const classD15 = classifyInvoiceAging(invD15, refDate);
      assert.equal(classD15.bucket, 'D15');
      assert.equal(classD15.overdueDays, 10);
      assert.equal(classD15.provisionRate, DEFAULT_PROVISION_RATES.D15);
      assert.equal(classD15.provisionAmount, 20_000_000 * 0.05);

      // D30: Quá hạn 25 ngày (16 <= 25 <= 30)
      const invD30: InvoiceRecord = {
        id: '3',
        invoiceNumber: 'INV-D30',
        dealerId: 'dl-1',
        issueDate: '2026-08-15',
        dueDate: '2026-09-06', // Quá hạn 25 ngày
        totalAmount: 30_000_000,
        paidAmount: 0,
        remainingAmount: 30_000_000,
      };
      const classD30 = classifyInvoiceAging(invD30, refDate);
      assert.equal(classD30.bucket, 'D30');
      assert.equal(classD30.overdueDays, 25);
      assert.equal(classD30.provisionRate, 0.20);
      assert.equal(classD30.provisionAmount, 6_000_000);

      // D60: Quá hạn 45 ngày (31 <= 45 <= 60)
      const invD60: InvoiceRecord = {
        id: '4',
        invoiceNumber: 'INV-D60',
        dealerId: 'dl-1',
        issueDate: '2026-07-20',
        dueDate: '2026-08-17', // Quá hạn 45 ngày
        totalAmount: 40_000_000,
        paidAmount: 0,
        remainingAmount: 40_000_000,
      };
      const classD60 = classifyInvoiceAging(invD60, refDate);
      assert.equal(classD60.bucket, 'D60');
      assert.equal(classD60.overdueDays, 45);
      assert.equal(classD60.provisionRate, 0.50);
      assert.equal(classD60.provisionAmount, 20_000_000);

      // D90+: Quá hạn 100 ngày (> 60 ngày)
      const invD90: InvoiceRecord = {
        id: '5',
        invoiceNumber: 'INV-D90',
        dealerId: 'dl-1',
        issueDate: '2026-05-10',
        dueDate: '2026-06-23', // Quá hạn 100 ngày
        totalAmount: 50_000_000,
        paidAmount: 0,
        remainingAmount: 50_000_000,
      };
      const classD90 = classifyInvoiceAging(invD90, refDate);
      assert.equal(classD90.bucket, 'D90_PLUS');
      assert.equal(classD90.overdueDays, 100);
      assert.equal(classD90.provisionRate, 1.0);
      assert.equal(classD90.provisionAmount, 50_000_000);
    });

    it('2.2. Aggregates multi-invoice portfolio and assigns correct risk grading', () => {
      const invoices: InvoiceRecord[] = [
        {
          id: '1',
          invoiceNumber: 'HD-01',
          dealerId: 'dl-good',
          issueDate: '2026-09-20',
          dueDate: '2026-10-15',
          totalAmount: 100_000_000,
          paidAmount: 0,
          remainingAmount: 100_000_000, // D0: 100tr
        },
        {
          id: '2',
          invoiceNumber: 'HD-02',
          dealerId: 'dl-good',
          issueDate: '2026-09-01',
          dueDate: '2026-09-25', // Quá hạn 6 ngày (D15)
          totalAmount: 50_000_000,
          paidAmount: 20_000_000,
          remainingAmount: 30_000_000, // D15: 30tr
        },
        {
          id: '3',
          invoiceNumber: 'HD-03',
          dealerId: 'dl-good',
          issueDate: '2026-08-01',
          dueDate: '2026-08-10',
          totalAmount: 40_000_000,
          paidAmount: 40_000_000,
          remainingAmount: 0, // Đã trả xong -> phải được bỏ qua
        },
      ];

      const summary = calculateAgingSchedule(invoices, refDate);

      assert.equal(summary.totalOutstandingDebt, 130_000_000);
      assert.equal(summary.totalOverdueDebt, 30_000_000);
      assert.equal(summary.buckets.D0.totalAmount, 100_000_000);
      assert.equal(summary.buckets.D15.totalAmount, 30_000_000);
      assert.equal(summary.buckets.D30.totalAmount, 0);
      assert.equal(summary.buckets.D60.totalAmount, 0);
      assert.equal(summary.buckets.D90_PLUS.totalAmount, 0);
      assert.equal(summary.riskGrade, 'B_GOOD');
      assert.equal(summary.totalProvisionAmount, 30_000_000 * 0.05); // 1.5 triệu
    });

    it('2.3. Correctly flags critical risk grade (D_CRITICAL) when D90+ exists', () => {
      const invoices: InvoiceRecord[] = [
        {
          id: '1',
          invoiceNumber: 'HD-BAD',
          dealerId: 'dl-bad',
          issueDate: '2026-04-01',
          dueDate: '2026-05-01', // Quá hạn ~153 ngày
          totalAmount: 80_000_000,
          paidAmount: 0,
          remainingAmount: 80_000_000,
        },
      ];

      const summary = calculateAgingSchedule(invoices, refDate);
      assert.equal(summary.riskGrade, 'D_CRITICAL');
      assert.equal(summary.badDebtRatio, 1.0);
      assert.equal(summary.totalProvisionAmount, 80_000_000);
    });
  });

  // =========================================================================
  // 3. Tiered Wholesale & Volume Pricing Matrix Tests
  // =========================================================================
  describe('3. Tiered Wholesale & Volume Pricing Matrix', () => {
    it('3.1. Validates base tier discount rates (Cấp 2: 8%, Cấp 1: 14%, Vàng: 20%, VIP: 25%)', () => {
      assert.equal(TIER_BASE_DISCOUNTS.TIER_2, 8);
      assert.equal(TIER_BASE_DISCOUNTS.TIER_1, 14);
      assert.equal(TIER_BASE_DISCOUNTS.GOLD, 20);
      assert.equal(TIER_BASE_DISCOUNTS.VIP, 25);
    });

    it('3.2. Validates volume discount rules (> 50 thùng: +3%, > 100 thùng: +5%)', () => {
      assert.equal(getVolumeDiscountTier(20).discountPercent, 0);
      assert.equal(getVolumeDiscountTier(49).discountPercent, 0);
      assert.equal(getVolumeDiscountTier(50).discountPercent, 3);
      assert.equal(getVolumeDiscountTier(75).discountPercent, 3);
      assert.equal(getVolumeDiscountTier(100).discountPercent, 5);
      assert.equal(getVolumeDiscountTier(250).discountPercent, 5);
    });

    it('3.3. Correctly converts Pallets into equivalent Thùng (1 Pallet = 50 Thùng)', () => {
      assert.equal(convertToThungEquivalent(2, 'PALLET', 50), 100);
      assert.equal(convertToThungEquivalent(10, 'THUNG'), 10);
      assert.equal(convertToThungEquivalent(48, 'HOP'), 2); // 48 / 24 = 2 thùng
    });

    it('3.4. Computes line item pricing combining Tier and Volume discounts', () => {
      // Đại lý Vàng (20%) đặt 60 thùng sản phẩm giá 500,000đ/thùng
      // Tổng thùng = 60 >= 50 -> Volume discount = +3% => Tổng giảm 23%
      const item = {
        productId: 'prod-01',
        productName: 'Nước Tăng Lực B2B',
        baseUnitPrice: 500_000,
        quantity: 60,
        unit: 'THUNG' as const,
      };

      const result = calculateLineItemPricing(item, 'GOLD', 60);

      assert.equal(result.tierDiscountPercent, 20);
      assert.equal(result.volumeDiscountPercent, 3);
      assert.equal(result.totalDiscountPercent, 23);
      // Đơn giá sau giảm = 500,000 * (1 - 0.23) = 385,000đ
      assert.equal(result.discountedUnitPrice, 385_000);
      assert.equal(result.originalSubtotal, 30_000_000);
      assert.equal(result.finalSubtotal, 23_100_000);
      assert.equal(result.discountAmount, 6_900_000);
    });

    it('3.5. Computes full order pricing with multi-product volume aggregation', () => {
      // Đại lý Cấp 1 (14%) đặt 2 sản phẩm:
      // Sp 1: 40 thùng @ 200,000đ = 8,000,000đ
      // Sp 2: 70 thùng @ 300,000đ = 21,000,000đ
      // Tổng số thùng = 40 + 70 = 110 thùng (> 100 thùng)
      // -> Cả 2 sản phẩm đều được hưởng Volume Discount +5%!
      // Tổng chiết khấu = 14% + 5% = 19%
      const items = [
        {
          productId: 'sp-1',
          productName: 'Sữa Đặc Lon',
          baseUnitPrice: 200_000,
          quantity: 40,
          unit: 'THUNG' as const,
        },
        {
          productId: 'sp-2',
          productName: 'Bột Giặt Sỉ',
          baseUnitPrice: 300_000,
          quantity: 70,
          unit: 'THUNG' as const,
        },
      ];

      const orderPricing = calculateOrderPricing(items, 'TIER_1');

      assert.equal(orderPricing.totalThungQuantity, 110);
      assert.equal(orderPricing.appliedVolumeTier.discountPercent, 5);
      assert.equal(orderPricing.originalTotalAmount, 29_000_000);

      // Sp1: 200k * (1 - 0.19) = 162,000đ -> x 40 = 6,480,000đ
      // Sp2: 300k * (1 - 0.19) = 243,000đ -> x 70 = 17,010,000đ
      // Final total = 23,490,000đ
      assert.equal(orderPricing.finalTotalAmount, 23_490_000);
      assert.equal(orderPricing.totalDiscountAmount, 5_510_000);
      assert.equal(orderPricing.effectiveDiscountRate, 19.0);
    });
  });

  // =========================================================================
  // 4. Statement of Account (SOA) Generator Tests (K80 & VietQR)
  // =========================================================================
  describe('4. Statement of Account (SOA) Generator', () => {
    const mockDealer: DealerRecord = {
      id: 'dl-gold',
      code: 'DL-GOLD-01',
      name: 'TỔNG ĐẠI LÝ VÀNG MIỀN BẮC',
      phone: '0988776655',
      address: 'Số 88 Lê Duẩn, Hoàn Kiếm, Hà Nội',
      tier: 'GOLD',
      creditLimit: 500_000_000,
      currentDebt: 140_000_000,
      paymentTermDays: 30,
    };

    const mockInvoices: InvoiceRecord[] = [
      {
        id: '1',
        invoiceNumber: 'HD-2026-0815',
        dealerId: mockDealer.id,
        issueDate: '2026-08-15',
        dueDate: '2026-09-15',
        totalAmount: 40_000_000,
        paidAmount: 0,
        remainingAmount: 40_000_000,
      },
      {
        id: '2',
        invoiceNumber: 'HD-2026-0901',
        dealerId: mockDealer.id,
        issueDate: '2026-09-01',
        dueDate: '2026-10-15',
        totalAmount: 100_000_000,
        paidAmount: 0,
        remainingAmount: 100_000_000,
      },
    ];

    const aging = calculateAgingSchedule(mockInvoices, new Date('2026-10-01'));

    it('4.1. Generates VietQR URL with correct parameters', () => {
      const qrUrl = buildVietQrUrl(DEFAULT_B2B_BANK, 40_000_000, 'B2B SOA TEST');
      assert.match(qrUrl, /img\.vietqr\.io/);
      assert.match(qrUrl, /amount=40000000/);
      assert.match(qrUrl, /addInfo=B2B\+SOA\+TEST/);
      assert.match(qrUrl, new RegExp(DEFAULT_B2B_BANK.accountNumber));
    });

    it('4.2. Generates K80 plain text SOA receipt with all required sections', () => {
      const k80Text = generateK80SoaText(mockDealer, aging, mockInvoices, DEFAULT_B2B_BANK);

      assert.match(k80Text, /BIÊN BẢN ĐỐI SOÁT CÔNG NỢ ĐẠI LÝ/);
      assert.match(k80Text, /TỔNG ĐẠI LÝ VÀNG MIỀN BẮC/);
      assert.match(k80Text, /DL-GOLD-01/);
      assert.match(k80Text, /AGING SCHEDULE/);
      assert.match(k80Text, /THÔNG TIN THANH TOÁN CÔNG NỢ \(VIETQR\)/);
      assert.match(k80Text, /MBBank/);
      assert.match(k80Text, /XÁC NHẬN BÀN GIAO: KẾ TOÁN TRƯỞNG & ĐẠI LÝ/);
    });

    it('4.3. Generates K80 HTML and Formal A4 SOA documents', () => {
      const k80Html = generateK80SoaHtml(mockDealer, aging, mockInvoices);
      assert.match(k80Html, /<!DOCTYPE html>/);
      assert.match(k80Html, /@page \{ size: 80mm auto;/);
      assert.match(k80Html, /img\.vietqr\.io/);
      assert.match(k80Html, /BIÊN BẢN ĐỐI SOÁT CÔNG NỢ/);

      const a4Html = generateFormalSoaHtml(mockDealer, aging, mockInvoices);
      assert.match(a4Html, /<!DOCTYPE html>/);
      assert.match(a4Html, /BIÊN BẢN ĐỐI SOÁT CÔNG NỢ & NGHĨA VỤ TÀI CHÍNH/);
      assert.match(a4Html, /GIÁM ĐỐC TÀI CHÍNH/);
      assert.match(a4Html, /BẢNG PHÂN BỔ TUỔI NỢ & DỰ PHÒNG RỦI RO/);
    });
  });
});
