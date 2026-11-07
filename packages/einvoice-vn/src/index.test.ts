import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  InvoiceSeriesSchema,
  InvoiceNumberSchema,
  SellerSchema,
  BuyerSchema,
  InvoiceSchema,
  calculateLineItem,
  calculateVatRateSummaries,
  calculateInvoiceTax,
  numberToVietnameseWords,
  formatInvoiceNumber,
  validateInvoiceSeries,
  generateTaxAuthorityQRPayload,
  parseTaxAuthorityQRPayload,
  generateTaxAuthorityLookupUrl,
  generateMockTaxAuthorityCode,
  buildInvoiceXml,
  canonicalizeXml,
  computeXmlDigest,
  signInvoiceXml,
  verifyInvoiceXmlSignature,
  generateSelfSignedCert,
  MockEInvoiceAdapter,
  VNPTInvoiceAdapter,
  ViettelSInvoiceAdapter,
  MisaMeInvoiceAdapter,
  type IssueInvoiceInput,
} from './index';

describe('@kido/einvoice-vn Package Suite', () => {
  // -------------------------------------------------------------
  // 1. Zod Schemas & Types Validation
  // -------------------------------------------------------------
  describe('Zod Schemas & Types (TT78 / ND123)', () => {
    it('1. should validate valid invoice series (TT78) and reject invalid format', () => {
      // Valid series
      assert.strictEqual(validateInvoiceSeries('C26TKT'), true);
      assert.strictEqual(validateInvoiceSeries('K26TKT'), true);
      assert.strictEqual(validateInvoiceSeries('C26MKT'), true);
      assert.strictEqual(validateInvoiceSeries('C26NAA'), true);

      // Invalid series
      assert.strictEqual(validateInvoiceSeries('X26TKT'), false); // Invalid first char
      assert.strictEqual(validateInvoiceSeries('C26XKT'), false); // Invalid type char 'X'
      assert.strictEqual(validateInvoiceSeries('C26T'), false);   // Too short
      assert.strictEqual(validateInvoiceSeries('C26TKT1'), false); // Too long
    });

    it('2. should format and validate 8-digit invoice numbers', () => {
      assert.strictEqual(formatInvoiceNumber(1), '00000001');
      assert.strictEqual(formatInvoiceNumber('15'), '00000015');
      assert.strictEqual(formatInvoiceNumber('00000123'), '00000123');
      assert.strictEqual(formatInvoiceNumber(99999999), '99999999');

      assert.throws(() => InvoiceNumberSchema.parse('100000000')); // > 8 digits
      assert.throws(() => InvoiceNumberSchema.parse('ABC'));       // Non-digit
    });

    it('3. should validate Seller and Buyer schemas correctly', () => {
      // Valid 10-digit MST
      const validSeller = SellerSchema.parse({
        sellerTaxCode: '0109876543',
        sellerName: 'CÔNG TY TNHH CÔNG NGHỆ KHÁNH TÂM',
        sellerAddress: '123 Đường Công Nghệ, Quận 1, TP. Hồ Chí Minh',
        sellerEmail: 'tax@khanhtam.vn',
      });
      assert.strictEqual(validSeller.sellerTaxCode, '0109876543');

      // Valid 13-digit MST (chi nhánh)
      const validBranch = SellerSchema.parse({
        sellerTaxCode: '0109876543-001',
        sellerName: 'CHI NHÁNH CÔNG TY KHÁNH TÂM',
        sellerAddress: 'Hà Nội',
      });
      assert.strictEqual(validBranch.sellerTaxCode, '0109876543-001');

      // Invalid MST
      assert.throws(() =>
        SellerSchema.parse({
          sellerTaxCode: '123',
          sellerName: 'Test',
          sellerAddress: 'Test',
        })
      );

      // Valid Buyer
      const validBuyer = BuyerSchema.parse({
        buyerName: 'Nguyễn Văn An',
        buyerTaxCode: '0312345678',
        buyerEmail: 'an.nguyen@example.com',
      });
      assert.strictEqual(validBuyer.buyerName, 'Nguyễn Văn An');
    });
  });

  // -------------------------------------------------------------
  // 2. Tax Calculator & Number-to-Words
  // -------------------------------------------------------------
  describe('Tax Calculator & Accounting Rules', () => {
    it('4. should calculate line items and single 10% VAT accurately', () => {
      const line = calculateLineItem({
        itemName: 'Phần mềm Bán hàng POS',
        quantity: 2,
        unitPrice: 500000,
        vatRate: '10%',
      });

      assert.strictEqual(line.amount, 1000000);
      assert.strictEqual(line.vatAmount, 100000);
      assert.strictEqual(line.unit, 'Cái');
    });

    it('5. should handle discounts on line items (percentage and amount)', () => {
      const lineWithPercentDiscount = calculateLineItem({
        itemName: 'Dịch vụ Cloud Server',
        quantity: 1,
        unitPrice: 1000000,
        discountRate: 10, // 10%
        vatRate: '10%',
      });
      assert.strictEqual(lineWithPercentDiscount.amount, 900000);
      assert.strictEqual(lineWithPercentDiscount.discountAmount, 100000);
      assert.strictEqual(lineWithPercentDiscount.vatAmount, 90000);

      const lineWithFixedDiscount = calculateLineItem({
        itemName: 'Dịch vụ Tên miền',
        quantity: 1,
        unitPrice: 200000,
        discountAmount: 50000,
        vatRate: '8%',
      });
      assert.strictEqual(lineWithFixedDiscount.amount, 150000);
      assert.strictEqual(lineWithFixedDiscount.vatAmount, 12000); // 8% of 150000
    });

    it('6. should separate multiple VAT rate groups (0%, 5%, 8%, 10%, KCT) and calculate totals', () => {
      const rawItems = [
        { itemName: 'Phần mềm kế toán (KCT)', quantity: 1, unitPrice: 2000000, vatRate: 'KCT' as const },
        { itemName: 'Dịch vụ xuất khẩu (0%)', quantity: 1, unitPrice: 1000000, vatRate: '0%' as const },
        { itemName: 'Nông sản sơ chế (5%)', quantity: 2, unitPrice: 100000, vatRate: '5%' as const }, // 200,000 -> 10,000 VAT
        { itemName: 'Vật tư CNTT (8%)', quantity: 1, unitPrice: 500000, vatRate: '8%' as const },      // 500,000 -> 40,000 VAT
        { itemName: 'Dịch vụ tư vấn (10%)', quantity: 1, unitPrice: 1000000, vatRate: '10%' as const }, // 1,000,000 -> 100,000 VAT
      ];

      const { items, taxSummary } = calculateInvoiceTax(rawItems);

      assert.strictEqual(items.length, 5);
      assert.strictEqual(taxSummary.totalUntaxedAmount, 4700000);
      assert.strictEqual(taxSummary.totalVatAmount, 150000); // 0 + 0 + 10000 + 40000 + 100000
      assert.strictEqual(taxSummary.totalAmount, 4850000);

      // Verify VAT rate summaries group
      const kctGroup = taxSummary.vatSummaries.find((v) => v.vatRate === 'KCT');
      assert.strictEqual(kctGroup?.taxableAmount, 2000000);
      assert.strictEqual(kctGroup?.vatAmount, 0);

      const vat8Group = taxSummary.vatSummaries.find((v) => v.vatRate === '8%');
      assert.strictEqual(vat8Group?.taxableAmount, 500000);
      assert.strictEqual(vat8Group?.vatAmount, 40000);

      const vat10Group = taxSummary.vatSummaries.find((v) => v.vatRate === '10%');
      assert.strictEqual(vat10Group?.taxableAmount, 1000000);
      assert.strictEqual(vat10Group?.vatAmount, 100000);
    });

    it('7. should convert money amount to Vietnamese words correctly', () => {
      assert.strictEqual(numberToVietnameseWords(0), 'Không đồng chẵn.');
      assert.strictEqual(numberToVietnameseWords(1000000), 'Một triệu đồng chẵn.');
      assert.strictEqual(
        numberToVietnameseWords(1234567),
        'Một triệu hai trăm ba mươi tư nghìn năm trăm sáu mươi bảy đồng chẵn.'
      );
      assert.strictEqual(numberToVietnameseWords(105000), 'Một trăm lẻ năm nghìn đồng chẵn.');
      assert.strictEqual(numberToVietnameseWords(21000000), 'Hai mươi mốt triệu đồng chẵn.');
      assert.strictEqual(numberToVietnameseWords(15), 'Mười lăm đồng chẵn.');
      assert.strictEqual(numberToVietnameseWords(1000000005), 'Một tỷ không trăm lẻ năm đồng chẵn.');
      assert.strictEqual(numberToVietnameseWords(-500000), 'Âm Năm trăm nghìn đồng chẵn.');
    });
  });

  // -------------------------------------------------------------
  // 3. Tax Authority QR Code & URL
  // -------------------------------------------------------------
  describe('Tax Authority QR Code & Lookup URL', () => {
    it('8. should generate and parse standard TT78 QR pipe-delimited payload', () => {
      const mockTaxCode = generateMockTaxAuthorityCode(2026);
      assert.strictEqual(mockTaxCode.length, 34);
      assert.strictEqual(mockTaxCode.startsWith('0026'), true);

      const qrInput = {
        sellerTaxCode: '0109876543',
        invoiceSeries: 'C26TKT',
        invoiceNumber: 1,
        issuedDate: '2026-09-30',
        totalAmount: 1100000,
        vatAmount: 100000,
        taxAuthorityCode: mockTaxCode,
        lookupCode: 'TRACUU8899',
      };

      const payload = generateTaxAuthorityQRPayload(qrInput);
      assert.strictEqual(
        payload,
        `0109876543|C26TKT|00000001|2026-09-30|1100000|100000|${mockTaxCode}|TRACUU8899`
      );

      // Parse payload
      const parsed = parseTaxAuthorityQRPayload(payload);
      assert.ok(parsed);
      assert.strictEqual(parsed.sellerTaxCode, '0109876543');
      assert.strictEqual(parsed.invoiceSeries, 'C26TKT');
      assert.strictEqual(parsed.invoiceNumber, '00000001');
      assert.strictEqual(parsed.issuedDate, '2026-09-30');
      assert.strictEqual(parsed.totalAmount, 1100000);
      assert.strictEqual(parsed.vatAmount, 100000);
      assert.strictEqual(parsed.taxAuthorityCode, mockTaxCode);
      assert.strictEqual(parsed.lookupCode, 'TRACUU8899');
    });

    it('9. should generate and parse direct lookup URL', () => {
      const qrInput = {
        sellerTaxCode: '0109876543',
        invoiceSeries: 'C26TKT',
        invoiceNumber: '00000042',
        issuedDate: '2026-09-30',
        totalAmount: 540000,
        vatAmount: 40000,
        taxAuthorityCode: '0026A1B2C3D4E5F6G7H8I9J0K1L2M3N4O5',
        lookupCode: 'CODE123',
      };

      const url = generateTaxAuthorityLookupUrl(qrInput, 'https://einvoice.khanhtam.vn');
      assert.ok(url.includes('https://einvoice.khanhtam.vn/tra-cuu'));
      assert.ok(url.includes('mst=0109876543'));
      assert.ok(url.includes('kh=C26TKT'));
      assert.ok(url.includes('shd=00000042'));

      // Parse URL
      const parsed = parseTaxAuthorityQRPayload(url);
      assert.ok(parsed);
      assert.strictEqual(parsed.sellerTaxCode, '0109876543');
      assert.strictEqual(parsed.invoiceSeries, 'C26TKT');
      assert.strictEqual(parsed.invoiceNumber, '00000042');
      assert.strictEqual(parsed.totalAmount, 540000);
    });
  });

  // -------------------------------------------------------------
  // 4. W3C XMLDSig Signing & Verification
  // -------------------------------------------------------------
  describe('W3C XMLDSig Signing & Verification', () => {
    it('10. should build valid Circular 78 XML document from Invoice data', () => {
      const sampleInvoice = {
        invoiceType: 1 as const,
        invoiceSeries: 'C26TKT',
        invoiceNumber: '00000001',
        issuedDate: '2026-09-30',
        currency: 'VND',
        exchangeRate: 1,
        paymentMethod: 'TM/CK',
        status: 'SIGNED' as const,
        seller: {
          sellerTaxCode: '0109876543',
          sellerName: 'CÔNG TY TNHH CÔNG NGHỆ KHÁNH TÂM',
          sellerAddress: '123 Đường Công Nghệ, Quận 1, TP. HCM',
        },
        buyer: {
          buyerName: 'Công ty Cổ phần Alpha',
          buyerTaxCode: '0312345678',
        },
        items: [
          {
            lineNumber: 1,
            itemType: 1 as const,
            itemName: 'Gói Dịch vụ Phần mềm',
            unit: 'Gói',
            quantity: 1,
            unitPrice: 1000000,
            vatRate: '10%' as const,
            amount: 1000000,
            vatAmount: 100000,
          },
        ],
        taxSummary: {
          vatSummaries: [{ vatRate: '10%' as const, taxableAmount: 1000000, vatAmount: 100000 }],
          totalUntaxedAmount: 1000000,
          totalDiscountAmount: 0,
          totalVatAmount: 100000,
          totalAmount: 1100000,
          amountInWords: 'Một triệu một trăm nghìn đồng chẵn.',
        },
      };

      const xml = buildInvoiceXml(sampleInvoice, 'data-invoice-test');
      assert.ok(xml.includes('<HDon>'));
      assert.ok(xml.includes('<DLHDon Id="data-invoice-test">'));
      assert.ok(xml.includes('<KHHDon>C26TKT</KHHDon>'));
      assert.ok(xml.includes('<SHDon>00000001</SHDon>'));
      assert.ok(xml.includes('<MST>0109876543</MST>'));
      assert.ok(xml.includes('<TgTTTBSo>1100000</TgTTTBSo>'));
    });

    it('11. should sign XML document using RSA-SHA256 enveloped signature and verify it', () => {
      const keys = generateSelfSignedCert({ commonName: 'KT Test Certificate' });
      assert.ok(keys.privateKeyPem.includes('BEGIN PRIVATE KEY'));
      assert.ok(keys.certificatePem.includes('BEGIN CERTIFICATE'));

      const rawXml = `<HDon>
  <DLHDon Id="data-test">
    <TTChung>
      <KHHDon>C26TKT</KHHDon>
      <SHDon>00000001</SHDon>
    </TTChung>
    <TToan>
      <TgTTTBSo>1000000</TgTTTBSo>
    </TToan>
  </DLHDon>
</HDon>`;

      const signResult = signInvoiceXml({
        xml: rawXml,
        privateKeyPem: keys.privateKeyPem,
        certificatePem: keys.certificatePem,
        elementId: 'data-test',
      });

      assert.ok(signResult.signedXml.includes('<ds:Signature'));
      assert.ok(signResult.signedXml.includes('<ds:DigestValue>'));
      assert.ok(signResult.signedXml.includes('<ds:SignatureValue>'));
      assert.ok(signResult.signedXml.includes('<ds:X509Certificate>'));

      // Verify signature
      const verifyResult = verifyInvoiceXmlSignature(signResult.signedXml);
      assert.strictEqual(verifyResult.valid, true);
      assert.strictEqual(verifyResult.digestValid, true);
      assert.strictEqual(verifyResult.signatureValid, true);
    });

    it('12. should detect tampering and fail verification when XML content is modified', () => {
      const keys = generateSelfSignedCert();
      const rawXml = `<HDon>
  <DLHDon Id="data-tamper">
    <TTChung>
      <KHHDon>C26TKT</KHHDon>
      <SHDon>00000001</SHDon>
    </TTChung>
    <TToan>
      <TgTTTBSo>1000000</TgTTTBSo>
    </TToan>
  </DLHDon>
</HDon>`;

      const signResult = signInvoiceXml({
        xml: rawXml,
        privateKeyPem: keys.privateKeyPem,
        certificatePem: keys.certificatePem,
        elementId: 'data-tamper',
      });

      // Tamper with data inside DLHDon
      const tamperedXml = signResult.signedXml.replace(
        '<TgTTTBSo>1000000</TgTTTBSo>',
        '<TgTTTBSo>9999999</TgTTTBSo>'
      );

      const verifyResult = verifyInvoiceXmlSignature(tamperedXml);
      assert.strictEqual(verifyResult.valid, false);
      assert.strictEqual(verifyResult.digestValid, false);
      assert.ok(verifyResult.error?.includes('chỉnh sửa'));
    });
  });

  // -------------------------------------------------------------
  // 5. Adapters (Mock, VNPT, Viettel, MISA)
  // -------------------------------------------------------------
  describe('E-Invoice Adapters Lifecycle', () => {
    const mockAdapter = new MockEInvoiceAdapter({
      portalBaseUrl: 'https://test-einvoice.khanhtam.vn',
    });

    const sampleSeller = {
      sellerTaxCode: '0109876543',
      sellerName: 'CÔNG TY TNHH CÔNG NGHỆ KHÁNH TÂM',
      sellerAddress: '123 Đường Công Nghệ, Quận 1, TP. HCM',
      sellerEmail: 'finance@khanhtam.vn',
    };

    const sampleBuyer = {
      buyerName: 'Công ty Cổ phần Beta',
      buyerLegalName: 'BETA CORPORATION',
      buyerTaxCode: '0398765432',
      buyerAddress: '456 Lê Duẩn, Quận 1, TP. HCM',
      buyerEmail: 'accounting@beta.com',
    };

    it('13. MockAdapter: should issue invoice with auto-generated sequential number, CQT code, and signed XML', async () => {
      const issueInput: IssueInvoiceInput = {
        invoiceType: 1,
        invoiceSeries: 'C26TKT',
        seller: sampleSeller,
        buyer: sampleBuyer,
        items: [
          {
            itemName: 'Bản quyền Phần mềm Micro-SaaS',
            unit: 'Năm',
            quantity: 1,
            unitPrice: 10000000,
            vatRate: '10%',
          },
        ],
      };

      const result = await mockAdapter.issueInvoice(issueInput);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.invoiceSeries, 'C26TKT');
      assert.strictEqual(result.invoiceNumber, '00000001'); // First auto sequential number
      assert.strictEqual(result.status, 'TAX_APPROVED');
      assert.ok(result.taxAuthorityCode?.startsWith('0026'));
      assert.ok(result.lookupCode.startsWith('TRACUU'));
      assert.ok(result.lookupUrl.includes('test-einvoice.khanhtam.vn/tra-cuu'));
      assert.ok(result.signedXml?.includes('<ds:Signature'));

      // Verify the signed XML inside the issued invoice
      const verify = verifyInvoiceXmlSignature(result.signedXml!);
      assert.strictEqual(verify.valid, true);

      // Issue second invoice to verify auto-increment
      const result2 = await mockAdapter.issueInvoice(issueInput);
      assert.strictEqual(result2.invoiceNumber, '00000002');
    });

    it('14. MockAdapter: should lookup issued invoice by series/number or lookupCode', async () => {
      // Lookup by series and number
      const lookup1 = await mockAdapter.lookupInvoice({
        sellerTaxCode: sampleSeller.sellerTaxCode,
        invoiceSeries: 'C26TKT',
        invoiceNumber: '00000001',
      });

      assert.strictEqual(lookup1.found, true);
      assert.ok(lookup1.invoice);
      assert.strictEqual(lookup1.invoice.taxSummary.totalAmount, 11000000);

      // Lookup by lookupCode
      const lookupCode = lookup1.invoice.taxAuthority?.lookupCode;
      assert.ok(lookupCode);

      const lookup2 = await mockAdapter.lookupInvoice({
        sellerTaxCode: sampleSeller.sellerTaxCode,
        lookupCode,
      });

      assert.strictEqual(lookup2.found, true);
      assert.strictEqual(lookup2.invoice?.invoiceNumber, '00000001');

      // Download XML & PDF
      const xml = await mockAdapter.downloadInvoiceXml({
        sellerTaxCode: sampleSeller.sellerTaxCode,
        invoiceSeries: 'C26TKT',
        invoiceNumber: '00000001',
        format: 'XML',
      });
      assert.ok(xml.includes('<HDon>'));

      const pdf = await mockAdapter.downloadInvoicePdf({
        sellerTaxCode: sampleSeller.sellerTaxCode,
        invoiceSeries: 'C26TKT',
        invoiceNumber: '00000001',
        format: 'PDF',
      });
      assert.ok(pdf.length > 0);
    });

    it('15. MockAdapter: should cancel invoice with notice 04/SS-HDDT', async () => {
      const cancelResult = await mockAdapter.cancelInvoice({
        sellerTaxCode: sampleSeller.sellerTaxCode,
        invoiceSeries: 'C26TKT',
        invoiceNumber: '00000001',
        reason: 'Khách hàng hủy hợp đồng dịch vụ',
        noticeDocNumber: '04/TB-KT-2026',
        noticeDocDate: '2026-09-30',
      });

      assert.strictEqual(cancelResult.success, true);
      assert.strictEqual(cancelResult.status, 'CANCELLED');

      // Verify status updated in database
      const lookup = await mockAdapter.lookupInvoice({
        sellerTaxCode: sampleSeller.sellerTaxCode,
        invoiceSeries: 'C26TKT',
        invoiceNumber: '00000001',
      });
      assert.strictEqual(lookup.invoice?.status, 'CANCELLED');

      // Cannot cancel again
      const doubleCancel = await mockAdapter.cancelInvoice({
        sellerTaxCode: sampleSeller.sellerTaxCode,
        invoiceSeries: 'C26TKT',
        invoiceNumber: '00000001',
        reason: 'Hủy lại',
        noticeDocNumber: '04/TB-KT-2026',
        noticeDocDate: '2026-09-30',
      });
      assert.strictEqual(doubleCancel.success, false);
      assert.ok(doubleCancel.errorMessage?.includes('đã được hủy'));
    });

    it('16. MockAdapter: should adjust and replace invoices with full audit metadata', async () => {
      // 1. Issue an invoice to be adjusted
      const originalResult = await mockAdapter.issueInvoice({
        invoiceSeries: 'C26TKT',
        seller: sampleSeller,
        buyer: sampleBuyer,
        items: [{ itemName: 'Dịch vụ tư vấn tháng 9', quantity: 1, unitPrice: 5000000, vatRate: '10%' }],
      });
      const originalNumber = originalResult.invoiceNumber;

      // 2. Adjust invoice (tăng tiền)
      const adjustResult = await mockAdapter.adjustInvoice({
        originalSeries: 'C26TKT',
        originalNumber,
        adjustmentType: 'INCREASE',
        reason: 'Điều chỉnh tăng thêm giờ tư vấn phát sinh',
        adjustmentInvoice: {
          invoiceSeries: 'C26TKT',
          seller: sampleSeller,
          buyer: sampleBuyer,
          items: [{ itemName: 'Giờ tư vấn bổ sung', quantity: 2, unitPrice: 1000000, vatRate: '10%' }],
        },
      });

      assert.strictEqual(adjustResult.success, true);
      assert.strictEqual(adjustResult.originalNumber, originalNumber);
      assert.ok(adjustResult.adjustmentNumber);

      // Verify original status became ADJUSTED
      const originalLookup = await mockAdapter.lookupInvoice({
        sellerTaxCode: sampleSeller.sellerTaxCode,
        invoiceSeries: 'C26TKT',
        invoiceNumber: originalNumber,
      });
      assert.strictEqual(originalLookup.invoice?.status, 'ADJUSTED');

      // Verify adjustment invoice links to original
      const adjLookup = await mockAdapter.lookupInvoice({
        sellerTaxCode: sampleSeller.sellerTaxCode,
        invoiceSeries: adjustResult.adjustmentSeries,
        invoiceNumber: adjustResult.adjustmentNumber,
      });
      assert.strictEqual(adjLookup.invoice?.relatedInvoice?.relationType, 'ADJUSTMENT');
      assert.strictEqual(adjLookup.invoice?.relatedInvoice?.number, originalNumber);

      // 3. Replace invoice
      const replaceResult = await mockAdapter.replaceInvoice({
        originalSeries: 'C26TKT',
        originalNumber: adjustResult.adjustmentNumber,
        reason: 'Sai mã số thuế người mua',
        replacementInvoice: {
          invoiceSeries: 'C26TKT',
          seller: sampleSeller,
          buyer: { ...sampleBuyer, buyerTaxCode: '0399999999' },
          items: [{ itemName: 'Giờ tư vấn bổ sung', quantity: 2, unitPrice: 1000000, vatRate: '10%' }],
        },
      });

      assert.strictEqual(replaceResult.success, true);
      assert.ok(replaceResult.replacementNumber);

      // Verify status became REPLACED
      const replacedLookup = await mockAdapter.lookupInvoice({
        sellerTaxCode: sampleSeller.sellerTaxCode,
        invoiceSeries: adjustResult.adjustmentSeries,
        invoiceNumber: adjustResult.adjustmentNumber,
      });
      assert.strictEqual(replacedLookup.invoice?.status, 'REPLACED');
    });

    it('17. VNPT, Viettel, and MISA adapters: format payloads and execute sandbox workflow', async () => {
      // VNPT Adapter
      const vnpt = new VNPTInvoiceAdapter({
        serviceUrl: 'https://demo-tt78.vnpt-invoice.com.vn',
        account: 'demo_user',
        accountPassword: 'demo_password',
        sellerTaxCode: '0109876543',
        isSandbox: true,
      });
      assert.strictEqual(vnpt.providerName, 'VNPT_INVOICE');
      const vnptPayload = vnpt.formatVnptInvoicePayload({
        invoiceSeries: 'C26TKT',
        seller: sampleSeller,
        buyer: sampleBuyer,
        items: [{ itemName: 'Dịch vụ mạng VNPT', quantity: 1, unitPrice: 500000, vatRate: '10%' }],
      });
      assert.ok(vnptPayload.includes('<Invoices>'));
      assert.ok(vnptPayload.includes('<CusTaxCode>0398765432</CusTaxCode>'));

      const vnptIssue = await vnpt.issueInvoice({
        invoiceSeries: 'C26TKT',
        seller: sampleSeller,
        buyer: sampleBuyer,
        items: [{ itemName: 'Dịch vụ mạng VNPT', quantity: 1, unitPrice: 500000, vatRate: '10%' }],
      });
      assert.strictEqual(vnptIssue.success, true);

      // Viettel S-Invoice Adapter
      const viettel = new ViettelSInvoiceAdapter({
        apiUrl: 'https://api-sinvoice-demo.viettel.vn',
        username: 'viettel_demo',
        password: 'password_demo',
        supplierTaxCode: '0109876543',
        isSandbox: true,
      });
      assert.strictEqual(viettel.providerName, 'VIETTEL_SINVOICE');
      const viettelPayload = viettel.formatViettelInvoicePayload({
        invoiceSeries: 'C26TKT',
        seller: sampleSeller,
        buyer: sampleBuyer,
        items: [{ itemName: 'Viettel Leased Line', quantity: 1, unitPrice: 2000000, vatRate: '10%' }],
      });
      assert.ok((viettelPayload as any).generalInvoiceInfo);
      assert.ok((viettelPayload as any).summarizeInfo);

      const viettelIssue = await viettel.issueInvoice({
        invoiceSeries: 'C26TKT',
        seller: sampleSeller,
        buyer: sampleBuyer,
        items: [{ itemName: 'Viettel Leased Line', quantity: 1, unitPrice: 2000000, vatRate: '10%' }],
      });
      assert.strictEqual(viettelIssue.success, true);

      // MISA meInvoice Adapter
      const misa = new MisaMeInvoiceAdapter({
        apiUrl: 'https://testapi.meinvoice.vn/api/v1',
        appId: 'MISA_TEST_APP_ID',
        taxCode: '0109876543',
        secretToken: 'TOKEN_123',
        isSandbox: true,
      });
      assert.strictEqual(misa.providerName, 'MISA_MEINVOICE');
      const misaPayload = misa.formatMisaInvoicePayload({
        invoiceSeries: 'C26TKT',
        seller: sampleSeller,
        buyer: sampleBuyer,
        items: [{ itemName: 'MISA AMIS Kế toán', quantity: 1, unitPrice: 4000000, vatRate: '10%' }],
      });
      assert.ok((misaPayload as any).OriginalInvoiceDetail);
      assert.ok((misaPayload as any).TotalAmountWithoutVAT);

      const misaIssue = await misa.issueInvoice({
        invoiceSeries: 'C26TKT',
        seller: sampleSeller,
        buyer: sampleBuyer,
        items: [{ itemName: 'MISA AMIS Kế toán', quantity: 1, unitPrice: 4000000, vatRate: '10%' }],
      });
      assert.strictEqual(misaIssue.success, true);
    });
  });
});
