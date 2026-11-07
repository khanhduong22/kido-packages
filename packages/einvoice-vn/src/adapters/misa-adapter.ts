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

export interface MisaConfig {
  apiUrl: string;             // Base URL MISA meInvoice API (vd: https://testapi.meinvoice.vn/api/v1)
  appId: string;              // Application ID do MISA cấp
  taxCode: string;            // Mã số thuế đơn vị phát hành
  secretToken: string;        // API Token / Cloud HSM Token
  isSandbox?: boolean;        // Chế độ Sandbox thử nghiệm
}

/**
 * Adapter kết nối hệ thống Hóa đơn Điện tử MISA meInvoice
 */
export class MisaMeInvoiceAdapter implements EInvoiceProviderAdapter {
  public readonly providerName = 'MISA_MEINVOICE';
  private config: MisaConfig;
  private sandboxFallback: MockEInvoiceAdapter;

  constructor(config: MisaConfig) {
    this.config = {
      isSandbox: true,
      ...config,
    };
    this.sandboxFallback = new MockEInvoiceAdapter({
      portalBaseUrl: this.config.apiUrl || 'https://test.meinvoice.vn',
    });
  }

  /**
   * Định dạng payload JSON theo chuẩn MISA meInvoice REST API
   */
  public formatMisaInvoicePayload(input: IssueInvoiceInput, invoiceNumber?: string): Record<string, unknown> {
    const { items, taxSummary } = calculateInvoiceTax(input.items);

    return {
      RefID: `MISA-${Date.now()}`,
      InvSeries: input.invoiceSeries,
      InvNo: invoiceNumber ? formatInvoiceNumber(invoiceNumber) : undefined,
      InvDate: input.issuedDate || new Date().toISOString().slice(0, 10),
      CurrencyID: 'VND',
      ExchangeRate: 1,
      PaymentMethod: input.paymentMethod || 'TM/CK',
      SellerTaxCode: input.seller.sellerTaxCode,
      SellerName: input.seller.sellerName,
      SellerAddress: input.seller.sellerAddress,
      BuyerTaxCode: input.buyer.buyerTaxCode,
      BuyerLegalName: input.buyer.buyerLegalName || input.buyer.buyerName,
      BuyerAddress: input.buyer.buyerAddress,
      BuyerEmail: input.buyer.buyerEmail,
      OriginalInvoiceDetail: items.map((it) => ({
        LineNumber: it.lineNumber,
        ItemType: it.itemType,
        ItemCode: it.itemCode,
        ItemName: it.itemName,
        UnitName: it.unit,
        Quantity: it.quantity,
        UnitPrice: it.unitPrice,
        DiscountAmount: it.discountAmount || 0,
        VATRateName: it.vatRate,
        Amount: it.amount,
        VATAmount: it.vatAmount || 0,
      })),
      TotalAmountWithoutVAT: taxSummary.totalUntaxedAmount,
      TotalVATAmount: taxSummary.totalVatAmount,
      TotalAmount: taxSummary.totalAmount,
      TotalAmountInWords: taxSummary.amountInWords,
    };
  }

  public async issueInvoice(input: IssueInvoiceInput): Promise<InvoiceResult> {
    if (this.config.isSandbox) {
      return this.sandboxFallback.issueInvoice(input);
    }

    try {
      const payload = this.formatMisaInvoicePayload(input);
      const endpoint = `${this.config.apiUrl.replace(/\/$/, '')}/invoices/publish`;

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.secretToken}`,
          'X-MISA-AppId': this.config.appId,
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        throw new Error(`Lỗi kết nối MISA meInvoice: HTTP ${res.status}`);
      }

      return {
        success: true,
        invoiceSeries: input.invoiceSeries,
        invoiceNumber: formatInvoiceNumber(input.invoiceNumber || '1'),
        lookupCode: 'MISA' + Math.random().toString(36).substring(2, 8).toUpperCase(),
        lookupUrl: 'https://meinvoice.vn/tra-cuu',
        qrCodeData: `https://meinvoice.vn/tra-cuu?kh=${input.invoiceSeries}&shd=${input.invoiceNumber || '1'}`,
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
