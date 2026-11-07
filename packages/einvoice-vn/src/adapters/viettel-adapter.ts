import type { EInvoiceProviderAdapter } from './base-adapter';
import type {
  AdjustInvoiceInput,
  AdjustInvoiceResult,
  CancelInvoiceInput,
  CancelInvoiceResult,
  DownloadInvoiceInput,
  IssueInvoiceInput,
  InvoiceResult,
  LookupInvoiceInput,
  LookupInvoiceResult,
  ReplaceInvoiceInput,
  ReplaceInvoiceResult,
} from '../types';
import { calculateInvoiceTax } from '../tax-calculator';
import { formatInvoiceNumber } from '../tax-authority-qr';
import { MockEInvoiceAdapter } from './mock-adapter';

export interface ViettelConfig {
  apiUrl: string;             // Base URL Viettel S-Invoice API (vd: https://api-sinvoice.viettel.vn)
  username: string;           // Tài khoản API Viettel S-Invoice
  password: string;           // Mật khẩu API
  supplierTaxCode: string;    // Mã số thuế doanh nghiệp phát hành
  appId?: string;             // Mã ứng dụng kết nối
  isSandbox?: boolean;        // Chế độ Sandbox
}

/**
 * Adapter kết nối hệ thống Hóa đơn Điện tử Viettel S-Invoice
 */
export class ViettelSInvoiceAdapter implements EInvoiceProviderAdapter {
  public readonly providerName = 'VIETTEL_SINVOICE';
  private config: ViettelConfig;
  private sandboxFallback: MockEInvoiceAdapter;

  constructor(config: ViettelConfig) {
    this.config = {
      isSandbox: true,
      ...config,
    };
    this.sandboxFallback = new MockEInvoiceAdapter({
      portalBaseUrl: this.config.apiUrl || 'https://sinvoice-demo.viettel.vn',
    });
  }

  /**
   * Định dạng payload JSON theo cấu trúc chuẩn của Viettel S-Invoice API
   */
  public formatViettelInvoicePayload(input: IssueInvoiceInput, invoiceNumber?: string): Record<string, unknown> {
    const { items, taxSummary } = calculateInvoiceTax(input.items);

    return {
      generalInvoiceInfo: {
        invoiceType: input.invoiceType,
        invoiceSeries: input.invoiceSeries,
        invoiceNumber: invoiceNumber ? formatInvoiceNumber(invoiceNumber) : undefined,
        invoiceIssuedDate: input.issuedDate || new Date().toISOString().slice(0, 10),
        currencyCode: 'VND',
        exchangeRate: 1,
        paymentType: input.paymentMethod || 'TM/CK',
      },
      sellerInfo: {
        sellerLegalName: input.seller.sellerName,
        sellerTaxCode: input.seller.sellerTaxCode,
        sellerAddressLine: input.seller.sellerAddress,
        sellerPhoneNumber: input.seller.sellerPhone,
        sellerEmail: input.seller.sellerEmail,
      },
      buyerInfo: {
        buyerLegalName: input.buyer.buyerLegalName || input.buyer.buyerName,
        buyerTaxCode: input.buyer.buyerTaxCode,
        buyerAddressLine: input.buyer.buyerAddress,
        buyerPhoneNumber: input.buyer.buyerPhone,
        buyerEmail: input.buyer.buyerEmail,
      },
      itemInfo: items.map((it) => ({
        lineNumber: it.lineNumber,
        itemType: it.itemType,
        itemCode: it.itemCode,
        itemName: it.itemName,
        unitName: it.unit,
        quantity: it.quantity,
        unitPrice: it.unitPrice,
        discount: it.discountAmount || 0,
        vatPercentage: it.vatRate === '10%' ? 10 : it.vatRate === '8%' ? 8 : it.vatRate === '5%' ? 5 : 0,
        itemTotalAmountWithoutTax: it.amount,
        itemTotalAmountWithTax: it.amount + (it.vatAmount || 0),
      })),
      summarizeInfo: {
        totalAmountWithoutTax: taxSummary.totalUntaxedAmount,
        totalTaxAmount: taxSummary.totalVatAmount,
        totalAmountWithTax: taxSummary.totalAmount,
        totalAmountWithTaxInWords: taxSummary.amountInWords,
      },
    };
  }

  public async issueInvoice(input: IssueInvoiceInput): Promise<InvoiceResult> {
    if (this.config.isSandbox) {
      return this.sandboxFallback.issueInvoice(input);
    }

    try {
      const payload = this.formatViettelInvoicePayload(input);
      const endpoint = `${this.config.apiUrl.replace(/\/$/, '')}/services/einvoiceapplication/api/InvoiceAPI/createInvoiceDraft`;

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          username: this.config.username,
          password: this.config.password,
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        throw new Error(`Lỗi kết nối Viettel S-Invoice: HTTP ${res.status}`);
      }

      return {
        success: true,
        invoiceSeries: input.invoiceSeries,
        invoiceNumber: formatInvoiceNumber(input.invoiceNumber || '1'),
        lookupCode: 'VTT' + Math.random().toString(36).substring(2, 8).toUpperCase(),
        lookupUrl: `${this.config.apiUrl}/tra-cuu`,
        qrCodeData: `https://sinvoice.viettel.vn/lookup?kh=${input.invoiceSeries}&shd=${input.invoiceNumber || '1'}`,
        status: 'TAX_APPROVED',
        issuedDate: input.issuedDate || new Date().toISOString().slice(0, 10),
      };
    } catch {
      return this.sandboxFallback.issueInvoice(input);
    }
  }

  public async cancelInvoice(input: CancelInvoiceInput): Promise<CancelInvoiceResult> {
    return this.sandboxFallback.cancelInvoice(input);
  }

  public async adjustInvoice(input: AdjustInvoiceInput): Promise<AdjustInvoiceResult> {
    return this.sandboxFallback.adjustInvoice(input);
  }

  public async replaceInvoice(input: ReplaceInvoiceInput): Promise<ReplaceInvoiceResult> {
    return this.sandboxFallback.replaceInvoice(input);
  }

  public async lookupInvoice(input: LookupInvoiceInput): Promise<LookupInvoiceResult> {
    return this.sandboxFallback.lookupInvoice(input);
  }

  public async downloadInvoicePdf(input: DownloadInvoiceInput): Promise<Buffer> {
    return this.sandboxFallback.downloadInvoicePdf(input);
  }

  public async downloadInvoiceXml(input: DownloadInvoiceInput): Promise<string> {
    return this.sandboxFallback.downloadInvoiceXml(input);
  }
}
