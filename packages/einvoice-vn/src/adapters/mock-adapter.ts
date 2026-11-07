import * as crypto from 'node:crypto';
import type { EInvoiceProviderAdapter } from './base-adapter';
import type {
  AdjustInvoiceInput,
  AdjustInvoiceResult,
  CancelInvoiceInput,
  CancelInvoiceResult,
  DownloadInvoiceInput,
  Invoice,
  IssueInvoiceInput,
  InvoiceResult,
  LookupInvoiceInput,
  LookupInvoiceResult,
  ReplaceInvoiceInput,
  ReplaceInvoiceResult,
} from '../types';
import { calculateInvoiceTax } from '../tax-calculator';
import {
  formatInvoiceNumber,
  generateMockTaxAuthorityCode,
  generateTaxAuthorityLookupUrl,
  generateTaxAuthorityQRPayload,
} from '../tax-authority-qr';
import {
  buildInvoiceXml,
  generateSelfSignedCert,
  signInvoiceXml,
} from '../xml-dsig-signer';

export interface MockAdapterOptions {
  portalBaseUrl?: string;
  autoApproveTax?: boolean; // Tự động duyệt cấp mã CQT ngay khi phát hành
  privateKeyPem?: string;
  certificatePem?: string;
}

/**
 * Adapter Giả lập Nhà cung cấp Hóa đơn Điện tử (Mock E-Invoice Adapter)
 * Giả lập 100% quy trình ký số Cloud HSM, sinh số HĐ tự động, sinh mã CQT 34 ký tự,
 * tạo chuỗi QR tra cứu, hủy, điều chỉnh, thay thế và lưu trữ in-memory phục vụ Sandbox/Demo/Test.
 */
export class MockEInvoiceAdapter implements EInvoiceProviderAdapter {
  public readonly providerName = 'MOCK_SANDBOX';

  private portalBaseUrl: string;
  private autoApproveTax: boolean;
  private privateKeyPem?: string;
  private certificatePem?: string;

  // In-memory databases
  private invoices = new Map<string, Invoice>();
  private lookupIndex = new Map<string, string>(); // lookupCode -> invoiceKey
  private sequenceCounters = new Map<string, number>(); // `${taxCode}_${series}` -> currentSequence

  constructor(options?: MockAdapterOptions) {
    this.portalBaseUrl = options?.portalBaseUrl || 'https://einvoice-sandbox.khanhtam.vn';
    this.autoApproveTax = options?.autoApproveTax ?? true;
    this.privateKeyPem = options?.privateKeyPem;
    this.certificatePem = options?.certificatePem;
  }

  /**
   * Khởi tạo chứng thư số và khóa bí mật nếu chưa có
   */
  private ensureCryptoKeys(): { privateKey: string; cert: string } {
    if (!this.privateKeyPem || !this.certificatePem) {
      try {
        const certData = generateSelfSignedCert({
          commonName: 'MOCK CLOUD HSM CÔNG TY KHÁNH TÂM',
          org: 'KT E-Invoice Sandbox',
        });
        this.privateKeyPem = certData.privateKeyPem;
        this.certificatePem = certData.certificatePem;
      } catch {
        // Fallback tạo cặp khóa RSA thuần nếu openssl CLI không chạy được
        const pair = crypto.generateKeyPairSync('rsa', {
          modulusLength: 2048,
          publicKeyEncoding: { type: 'spki', format: 'pem' },
          privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        });
        this.privateKeyPem = pair.privateKey;
        // Mock X509 pem header
        const dummyCert = `-----BEGIN CERTIFICATE-----\n${Buffer.from('MOCK_X509_CERTIFICATE_BODY').toString('base64')}\n-----END CERTIFICATE-----`;
        this.certificatePem = dummyCert;
      }
    }
    return { privateKey: this.privateKeyPem, cert: this.certificatePem };
  }

  private getInvoiceKey(sellerTaxCode: string, series: string, number: string): string {
    return `${sellerTaxCode.trim()}_${series.trim().toUpperCase()}_${formatInvoiceNumber(number)}`;
  }

  /**
   * Lấy số hóa đơn tiếp theo tự động
   */
  public getNextInvoiceNumber(sellerTaxCode: string, series: string): string {
    const key = `${sellerTaxCode.trim()}_${series.trim().toUpperCase()}`;
    const current = this.sequenceCounters.get(key) ?? 0;
    const next = current + 1;
    this.sequenceCounters.set(key, next);
    return formatInvoiceNumber(next);
  }

  /**
   * Phát hành hóa đơn điện tử mới
   */
  public async issueInvoice(input: IssueInvoiceInput): Promise<InvoiceResult> {
    try {
      const sellerTaxCode = input.seller.sellerTaxCode;
      const invoiceSeries = input.invoiceSeries.toUpperCase();

      // Xác định số hóa đơn
      let invoiceNumber = input.invoiceNumber;
      if (!invoiceNumber) {
        invoiceNumber = this.getNextInvoiceNumber(sellerTaxCode, invoiceSeries);
      } else {
        invoiceNumber = formatInvoiceNumber(invoiceNumber);
      }

      const key = this.getInvoiceKey(sellerTaxCode, invoiceSeries, invoiceNumber);
      if (this.invoices.has(key)) {
        return {
          success: false,
          invoiceSeries,
          invoiceNumber,
          lookupCode: '',
          lookupUrl: '',
          qrCodeData: '',
          status: 'DRAFT',
          issuedDate: input.issuedDate || new Date().toISOString().slice(0, 10),
          errorMessage: `Số hóa đơn ${invoiceNumber} thuộc ký hiệu ${invoiceSeries} đã tồn tại trong hệ thống`,
        };
      }

      const issuedDate = input.issuedDate || new Date().toISOString().slice(0, 10);

      // Tính thuế & tổng tiền
      const { items: calculatedItems, taxSummary } = calculateInvoiceTax(input.items);

      // Sinh mã CQT nếu là hóa đơn có mã (ký tự đầu 'C')
      const isTaxCoded = invoiceSeries.startsWith('C');
      const taxAuthorityCode = isTaxCoded ? generateMockTaxAuthorityCode() : undefined;

      // Sinh mã tra cứu bí mật ngẫu nhiên (ví dụ TRA-CUU-A1B2C3)
      const lookupCode = 'TRACUU' + Math.random().toString(36).substring(2, 8).toUpperCase();

      // Sinh URL tra cứu & mã QR
      const lookupUrl = generateTaxAuthorityLookupUrl(
        {
          sellerTaxCode,
          invoiceSeries,
          invoiceNumber,
          issuedDate,
          totalAmount: taxSummary.totalAmount,
          vatAmount: taxSummary.totalVatAmount,
          taxAuthorityCode,
          lookupCode,
        },
        this.portalBaseUrl
      );

      const qrCodeData = generateTaxAuthorityQRPayload({
        sellerTaxCode,
        invoiceSeries,
        invoiceNumber,
        issuedDate,
        totalAmount: taxSummary.totalAmount,
        vatAmount: taxSummary.totalVatAmount,
        taxAuthorityCode,
        lookupCode,
      });

      // Tạo hóa đơn
      const status = this.autoApproveTax
        ? (isTaxCoded ? 'TAX_APPROVED' : 'SIGNED')
        : 'SIGNED';

      const fullInvoice: Invoice = {
        id: `inv-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        invoiceType: input.invoiceType ?? 1,
        invoiceSeries,
        invoiceNumber,
        issuedDate,
        currency: 'VND',
        exchangeRate: 1,
        paymentMethod: input.paymentMethod || 'TM/CK',
        status,
        seller: input.seller,
        buyer: input.buyer,
        items: calculatedItems,
        taxSummary,
        taxAuthority: {
          taxAuthorityCode,
          lookupCode,
          lookupUrl,
          qrCodeData,
          submittedDate: issuedDate,
          approvedDate: this.autoApproveTax ? issuedDate : undefined,
        },
        notes: input.notes,
      };

      // Ký số XML
      const { privateKey, cert } = this.ensureCryptoKeys();
      const rawXml = buildInvoiceXml(fullInvoice);
      let signedXml: string | undefined;
      try {
        const signResult = signInvoiceXml({
          xml: rawXml,
          privateKeyPem: privateKey,
          certificatePem: cert,
          elementId: 'data-invoice',
        });
        signedXml = signResult.signedXml;
        fullInvoice.signedXml = signedXml;
        fullInvoice.signedAt = new Date().toISOString();
      } catch {
        // Nếu ký thất bại, giữ nguyên raw XML để test
        signedXml = rawXml;
        fullInvoice.signedXml = rawXml;
      }

      // Lưu trữ in-memory
      this.invoices.set(key, fullInvoice);
      this.lookupIndex.set(lookupCode, key);

      return {
        success: true,
        invoiceSeries,
        invoiceNumber,
        taxAuthorityCode,
        lookupCode,
        lookupUrl,
        qrCodeData,
        signedXml,
        status,
        issuedDate,
      };
    } catch (err) {
      return {
        success: false,
        invoiceSeries: input.invoiceSeries,
        invoiceNumber: input.invoiceNumber ? formatInvoiceNumber(input.invoiceNumber) : '00000000',
        lookupCode: '',
        lookupUrl: '',
        qrCodeData: '',
        status: 'DRAFT',
        issuedDate: input.issuedDate || new Date().toISOString().slice(0, 10),
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Hủy hóa đơn (Thông báo 04/SS-HĐĐT)
   */
  public async cancelInvoice(input: CancelInvoiceInput): Promise<CancelInvoiceResult> {
    const key = this.getInvoiceKey(input.sellerTaxCode, input.invoiceSeries, input.invoiceNumber);
    const invoice = this.invoices.get(key);

    if (!invoice) {
      return {
        success: false,
        invoiceSeries: input.invoiceSeries,
        invoiceNumber: formatInvoiceNumber(input.invoiceNumber),
        cancelledAt: new Date().toISOString(),
        status: 'CANCELLED',
        errorMessage: `Không tìm thấy hóa đơn ${input.invoiceNumber} ký hiệu ${input.invoiceSeries}`,
      };
    }

    if (invoice.status === 'CANCELLED') {
      return {
        success: false,
        invoiceSeries: input.invoiceSeries,
        invoiceNumber: formatInvoiceNumber(input.invoiceNumber),
        cancelledAt: new Date().toISOString(),
        status: 'CANCELLED',
        errorMessage: `Hóa đơn này đã được hủy trước đó`,
      };
    }

    invoice.status = 'CANCELLED';
    invoice.notes = `Đã hủy theo thông báo 04/SS số ${input.noticeDocNumber} ngày ${input.noticeDocDate}. Lý do: ${input.reason}`;

    return {
      success: true,
      invoiceSeries: invoice.invoiceSeries,
      invoiceNumber: invoice.invoiceNumber,
      cancelledAt: new Date().toISOString(),
      status: 'CANCELLED',
    };
  }

  /**
   * Lập hóa đơn điều chỉnh
   */
  public async adjustInvoice(input: AdjustInvoiceInput): Promise<AdjustInvoiceResult> {
    const originalKey = this.getInvoiceKey(
      input.adjustmentInvoice.seller.sellerTaxCode,
      input.originalSeries,
      input.originalNumber
    );
    const originalInvoice = this.invoices.get(originalKey);

    if (!originalInvoice) {
      return {
        success: false,
        originalSeries: input.originalSeries,
        originalNumber: formatInvoiceNumber(input.originalNumber),
        adjustmentSeries: input.adjustmentInvoice.invoiceSeries,
        adjustmentNumber: '00000000',
        lookupCode: '',
        lookupUrl: '',
        status: 'DRAFT',
        errorMessage: `Không tìm thấy hóa đơn gốc để điều chỉnh`,
      };
    }

    // Đánh dấu hóa đơn gốc đã điều chỉnh
    originalInvoice.status = 'ADJUSTED';

    // Phát hành hóa đơn điều chỉnh
    const issueResult = await this.issueInvoice(input.adjustmentInvoice);
    if (!issueResult.success) {
      return {
        success: false,
        originalSeries: input.originalSeries,
        originalNumber: formatInvoiceNumber(input.originalNumber),
        adjustmentSeries: input.adjustmentInvoice.invoiceSeries,
        adjustmentNumber: issueResult.invoiceNumber,
        lookupCode: '',
        lookupUrl: '',
        status: 'DRAFT',
        errorMessage: issueResult.errorMessage,
      };
    }

    // Cập nhật quan hệ hóa đơn điều chỉnh
    const newKey = this.getInvoiceKey(
      input.adjustmentInvoice.seller.sellerTaxCode,
      issueResult.invoiceSeries,
      issueResult.invoiceNumber
    );
    const newInvoice = this.invoices.get(newKey);
    if (newInvoice) {
      newInvoice.relatedInvoice = {
        series: input.originalSeries,
        number: formatInvoiceNumber(input.originalNumber),
        issuedDate: originalInvoice.issuedDate,
        relationType: 'ADJUSTMENT',
        reason: input.reason,
        adjustmentType: input.adjustmentType,
      };
    }

    return {
      success: true,
      originalSeries: input.originalSeries,
      originalNumber: formatInvoiceNumber(input.originalNumber),
      adjustmentSeries: issueResult.invoiceSeries,
      adjustmentNumber: issueResult.invoiceNumber,
      taxAuthorityCode: issueResult.taxAuthorityCode,
      lookupCode: issueResult.lookupCode,
      lookupUrl: issueResult.lookupUrl,
      status: issueResult.status,
    };
  }

  /**
   * Lập hóa đơn thay thế
   */
  public async replaceInvoice(input: ReplaceInvoiceInput): Promise<ReplaceInvoiceResult> {
    const originalKey = this.getInvoiceKey(
      input.replacementInvoice.seller.sellerTaxCode,
      input.originalSeries,
      input.originalNumber
    );
    const originalInvoice = this.invoices.get(originalKey);

    if (!originalInvoice) {
      return {
        success: false,
        originalSeries: input.originalSeries,
        originalNumber: formatInvoiceNumber(input.originalNumber),
        replacementSeries: input.replacementInvoice.invoiceSeries,
        replacementNumber: '00000000',
        lookupCode: '',
        lookupUrl: '',
        status: 'DRAFT',
        errorMessage: `Không tìm thấy hóa đơn gốc để thay thế`,
      };
    }

    // Đánh dấu hóa đơn gốc đã bị thay thế
    originalInvoice.status = 'REPLACED';

    // Phát hành hóa đơn thay thế
    const issueResult = await this.issueInvoice(input.replacementInvoice);
    if (!issueResult.success) {
      return {
        success: false,
        originalSeries: input.originalSeries,
        originalNumber: formatInvoiceNumber(input.originalNumber),
        replacementSeries: input.replacementInvoice.invoiceSeries,
        replacementNumber: issueResult.invoiceNumber,
        lookupCode: '',
        lookupUrl: '',
        status: 'DRAFT',
        errorMessage: issueResult.errorMessage,
      };
    }

    // Cập nhật quan hệ thay thế
    const newKey = this.getInvoiceKey(
      input.replacementInvoice.seller.sellerTaxCode,
      issueResult.invoiceSeries,
      issueResult.invoiceNumber
    );
    const newInvoice = this.invoices.get(newKey);
    if (newInvoice) {
      newInvoice.relatedInvoice = {
        series: input.originalSeries,
        number: formatInvoiceNumber(input.originalNumber),
        issuedDate: originalInvoice.issuedDate,
        relationType: 'REPLACEMENT',
        reason: input.reason,
      };
    }

    return {
      success: true,
      originalSeries: input.originalSeries,
      originalNumber: formatInvoiceNumber(input.originalNumber),
      replacementSeries: issueResult.invoiceSeries,
      replacementNumber: issueResult.invoiceNumber,
      taxAuthorityCode: issueResult.taxAuthorityCode,
      lookupCode: issueResult.lookupCode,
      lookupUrl: issueResult.lookupUrl,
      status: issueResult.status,
    };
  }

  /**
   * Tra cứu hóa đơn
   */
  public async lookupInvoice(input: LookupInvoiceInput): Promise<LookupInvoiceResult> {
    if (input.lookupCode) {
      const key = this.lookupIndex.get(input.lookupCode.trim());
      if (key && this.invoices.has(key)) {
        return { found: true, invoice: this.invoices.get(key) };
      }
    }

    if (input.invoiceSeries && input.invoiceNumber) {
      const key = this.getInvoiceKey(input.sellerTaxCode, input.invoiceSeries, input.invoiceNumber);
      if (this.invoices.has(key)) {
        return { found: true, invoice: this.invoices.get(key) };
      }
    }

    return { found: false, errorMessage: 'Không tìm thấy hóa đơn phù hợp với tiêu chí tra cứu' };
  }

  /**
   * Tải tệp PDF
   */
  public async downloadInvoicePdf(input: DownloadInvoiceInput): Promise<Buffer> {
    const key = this.getInvoiceKey(input.sellerTaxCode, input.invoiceSeries, input.invoiceNumber);
    const invoice = this.invoices.get(key);
    if (!invoice) {
      throw new Error(`Không tìm thấy hóa đơn để xuất PDF`);
    }

    // Trả về Buffer mô phỏng file PDF
    const pdfMockContent = `%PDF-1.4\n% MOCK EINVOICE PDF: ${invoice.invoiceSeries}-${invoice.invoiceNumber}\n%%EOF`;
    return Buffer.from(pdfMockContent, 'utf-8');
  }

  /**
   * Tải tệp XML đã ký số
   */
  public async downloadInvoiceXml(input: DownloadInvoiceInput): Promise<string> {
    const key = this.getInvoiceKey(input.sellerTaxCode, input.invoiceSeries, input.invoiceNumber);
    const invoice = this.invoices.get(key);
    if (!invoice) {
      throw new Error(`Không tìm thấy hóa đơn để xuất XML`);
    }
    return invoice.signedXml || buildInvoiceXml(invoice);
  }
}
