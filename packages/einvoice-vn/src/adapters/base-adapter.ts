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

/**
 * Interface chuẩn hóa Adapter cho các nhà cung cấp giải pháp Hóa đơn Điện tử tại Việt Nam
 * (VNPT-Invoice, Viettel S-Invoice, MISA meInvoice, Mock Adapter...)
 */
export interface EInvoiceProviderAdapter {
  /**
   * Tên nhà cung cấp giải pháp (VNPT, VIETTEL, MISA, MOCK,...)
   */
  readonly providerName: string;

  /**
   * Phát hành hóa đơn điện tử mới (có mã hoặc không có mã của CQT)
   */
  issueInvoice(input: IssueInvoiceInput): Promise<InvoiceResult>;

  /**
   * Hủy hóa đơn điện tử (theo mẫu 04/SS-HĐĐT gửi Cơ quan Thuế)
   */
  cancelInvoice(input: CancelInvoiceInput): Promise<CancelInvoiceResult>;

  /**
   * Lập hóa đơn điện tử điều chỉnh (tăng/giảm tiền, thuế suất, thông tin)
   */
  adjustInvoice(input: AdjustInvoiceInput): Promise<AdjustInvoiceResult>;

  /**
   * Lập hóa đơn điện tử thay thế cho hóa đơn có sai sót
   */
  replaceInvoice(input: ReplaceInvoiceInput): Promise<ReplaceInvoiceResult>;

  /**
   * Tra cứu thông tin hóa đơn theo Ký hiệu + Số hóa đơn hoặc Mã tra cứu
   */
  lookupInvoice(input: LookupInvoiceInput): Promise<LookupInvoiceResult>;

  /**
   * Tải tệp PDF của hóa đơn điện tử
   */
  downloadInvoicePdf(input: DownloadInvoiceInput): Promise<Buffer | Uint8Array>;

  /**
   * Tải tệp XML có chứa chữ ký số hợp lệ của hóa đơn điện tử
   */
  downloadInvoiceXml(input: DownloadInvoiceInput): Promise<string>;
}
