import { generateVietQrImageUrl } from '@kido/payment-vietqr';
import {
  InvoiceData,
  InvoiceTemplateOptions,
  InvoiceTemplateOptionsSchema,
} from './types';
import {
  computeInvoiceTotals,
  formatCurrencyVND,
  formatDateTimeVN,
  numberToVietnameseWords,
} from './utils';

/**
 * Generates VietQR image payment URL from InvoiceData and Store bank credentials
 */
export function generateVietQrFromInvoice(data: InvoiceData): string | undefined {
  if (data.qrPaymentUrl) {
    return data.qrPaymentUrl;
  }
  if (!data.store.bankInfo) {
    return undefined;
  }

  const { bank, accountNumber, accountName } = data.store.bankInfo;
  const totals = computeInvoiceTotals(data);

  try {
    return generateVietQrImageUrl({
      bank,
      accountNumber,
      accountName,
      amount: totals.totalAmount,
      description: `TT ${data.id}`,
      template: 'compact2',
    });
  } catch {
    return `https://img.vietqr.io/image/${bank}-${accountNumber}-compact2.png?amount=${totals.totalAmount}&addInfo=TT%20${data.id}&accountName=${encodeURIComponent(
      accountName
    )}`;
  }
}

/**
 * Formats a full standard Retail/Commercial Invoice into print/PDF-ready HTML (A4/A5)
 */
export function formatInvoiceHtml(
  data: InvoiceData,
  options?: Partial<InvoiceTemplateOptions>
): string {
  const opts = InvoiceTemplateOptionsSchema.parse(options || {});
  const totals = computeInvoiceTotals(data);
  const qrUrl = opts.showVietQr ? generateVietQrFromInvoice(data) : undefined;
  const amountInWords = numberToVietnameseWords(totals.totalAmount);

  const paymentLabels: Record<string, string> = {
    cash: 'Tiền mặt',
    vietqr: 'Chuyển khoản VietQR',
    bank_transfer: 'Chuyển khoản ngân hàng',
    card: 'Thẻ POS / Thẻ tín dụng',
    cod: 'Thanh toán khi nhận hàng (COD)',
  };

  const statusLabels: Record<string, { text: string; bg: string; color: string }> = {
    paid: { text: 'ĐÃ THANH TOÁN', bg: '#dcfce7', color: '#166534' },
    pending: { text: 'CHỜ THANH TOÁN', bg: '#fef3c7', color: '#92400e' },
    partially_paid: { text: 'THANH TOÁN MỘT PHẦN', bg: '#e0e7ff', color: '#3730a3' },
    refunded: { text: 'ĐÃ HOÀN TIỀN', bg: '#fee2e2', color: '#991b1b' },
  };

  const statusInfo = statusLabels[data.paymentStatus] || {
    text: data.paymentStatus.toUpperCase(),
    bg: '#f3f4f6',
    color: '#374151',
  };

  const rowsHtml = data.items
    .map((item, index) => {
      const itemTotal =
        item.totalPrice !== undefined
          ? item.totalPrice
          : item.quantity * item.unitPrice - (item.discount || 0);

      return `
        <tr>
          <td class="text-center text-muted">${index + 1}</td>
          <td>
            <div class="font-medium text-dark">${escapeHtml(item.name)}</div>
            ${item.sku ? `<div class="text-xs text-muted">SKU: ${escapeHtml(item.sku)}</div>` : ''}
            ${item.note ? `<div class="text-xs text-note">* ${escapeHtml(item.note)}</div>` : ''}
          </td>
          <td class="text-center">${escapeHtml(item.unit || 'phần')}</td>
          <td class="text-center font-medium">${item.quantity}</td>
          <td class="text-right">${formatCurrencyVND(item.unitPrice)}</td>
          <td class="text-right text-discount">
            ${item.discount && item.discount > 0 ? `-${formatCurrencyVND(item.discount)}` : '-'}
          </td>
          <td class="text-right font-semibold text-dark">${formatCurrencyVND(itemTotal)}</td>
        </tr>
      `;
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(opts.title || 'Hóa đơn bán lẻ')} - ${escapeHtml(data.id)}</title>
  <style>
    @page {
      size: ${opts.paperSize.toUpperCase()} ${opts.orientation};
      margin: 14mm 16mm;
    }
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      font-size: 13px;
      line-height: 1.5;
      color: #1e293b;
      background: #fff;
      padding: 24px;
      max-width: 900px;
      margin: 0 auto;
    }
    .text-center { text-align: center; }
    .text-right { text-align: right; }
    .text-left { text-align: left; }
    .font-medium { font-weight: 500; }
    .font-semibold { font-weight: 600; }
    .font-bold { font-weight: 700; }
    .text-xs { font-size: 11px; }
    .text-sm { font-size: 12px; }
    .text-base { font-size: 14px; }
    .text-lg { font-size: 16px; }
    .text-xl { font-size: 20px; }
    .text-2xl { font-size: 24px; }
    .text-dark { color: #0f172a; }
    .text-muted { color: #64748b; }
    .text-discount { color: #dc2626; }
    .text-note { color: #475569; font-style: italic; }
    .text-primary { color: ${opts.accentColor}; }

    /* Header styling */
    .invoice-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      border-bottom: 2px solid #e2e8f0;
      padding-bottom: 20px;
      margin-bottom: 20px;
    }
    .store-info {
      max-width: 58%;
    }
    .store-logo {
      max-height: 55px;
      max-width: 180px;
      object-fit: contain;
      margin-bottom: 8px;
    }
    .store-name {
      font-size: 18px;
      font-weight: 800;
      color: #0f172a;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .invoice-meta {
      text-align: right;
      max-width: 40%;
    }
    .invoice-title {
      font-size: 24px;
      font-weight: 800;
      color: ${opts.accentColor};
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-bottom: 6px;
    }
    .status-badge {
      display: inline-block;
      padding: 4px 10px;
      border-radius: 9999px;
      font-size: 11px;
      font-weight: 700;
      background: ${statusInfo.bg};
      color: ${statusInfo.color};
      margin-bottom: 8px;
    }

    /* Customer details box */
    .customer-card {
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      padding: 14px 18px;
      margin-bottom: 20px;
      display: flex;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 16px;
    }
    .customer-col {
      flex: 1;
      min-width: 220px;
    }
    .customer-col-title {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      color: #64748b;
      margin-bottom: 4px;
      letter-spacing: 0.5px;
    }

    /* Products table */
    .invoice-table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 20px;
    }
    .invoice-table th {
      background: #f1f5f9;
      color: #334155;
      font-weight: 700;
      text-transform: uppercase;
      font-size: 11px;
      letter-spacing: 0.5px;
      padding: 10px 12px;
      border-top: 1px solid #cbd5e1;
      border-bottom: 2px solid #cbd5e1;
    }
    .invoice-table td {
      padding: 10px 12px;
      border-bottom: 1px solid #e2e8f0;
      vertical-align: middle;
    }
    .invoice-table tbody tr:nth-child(even) {
      background-color: #fafafa;
    }

    /* Totals section */
    .summary-section {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 24px;
      page-break-inside: avoid;
    }
    .vietqr-box {
      border: 1px dashed #cbd5e1;
      border-radius: 8px;
      padding: 12px;
      display: flex;
      gap: 14px;
      background: #f8fafc;
      max-width: 48%;
      align-items: center;
    }
    .vietqr-img {
      width: 105px;
      height: 105px;
      border-radius: 4px;
      border: 1px solid #e2e8f0;
      background: #fff;
    }
    .vietqr-details {
      font-size: 11px;
      line-height: 1.4;
    }
    .vietqr-title {
      font-weight: 700;
      color: #0f172a;
      margin-bottom: 4px;
      font-size: 12px;
    }
    .totals-table {
      width: 46%;
      border-collapse: collapse;
    }
    .totals-table td {
      padding: 6px 8px;
    }
    .total-highlight {
      font-size: 16px;
      font-weight: 800;
      color: ${opts.accentColor};
      border-top: 2px solid #0f172a;
      border-bottom: 2px solid #0f172a;
    }

    /* Words row */
    .words-box {
      background: #f8fafc;
      border-left: 4px solid ${opts.accentColor};
      padding: 8px 14px;
      margin-bottom: 24px;
      font-style: italic;
      color: #334155;
    }

    /* Signatures block */
    .signatures-block {
      display: flex;
      justify-content: space-between;
      margin-top: 30px;
      padding-top: 10px;
      page-break-inside: avoid;
      text-align: center;
    }
    .sign-col {
      flex: 1;
      min-width: 140px;
    }
    .sign-title {
      font-weight: 700;
      font-size: 13px;
      color: #0f172a;
    }
    .sign-hint {
      font-size: 11px;
      color: #64748b;
      margin-top: 2px;
    }
    .sign-space {
      height: 75px;
    }

    /* Footer note */
    .invoice-footer {
      border-top: 1px solid #e2e8f0;
      margin-top: 30px;
      padding-top: 16px;
      text-align: center;
      color: #64748b;
      font-size: 11px;
    }

    @media print {
      body {
        padding: 0;
        max-width: 100%;
      }
      .no-print {
        display: none !important;
      }
      .invoice-table th {
        background: #f1f5f9 !important;
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }
      .status-badge {
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }
      .customer-card, .vietqr-box, .words-box {
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }
    }
  </style>
</head>
<body>

  <!-- Top Header -->
  <div class="invoice-header">
    <div class="store-info">
      ${
        data.store.logoUrl
          ? `<img src="${data.store.logoUrl}" alt="Logo" class="store-logo" />`
          : ''
      }
      <div class="store-name">${escapeHtml(data.store.name)}</div>
      ${
        data.store.branch
          ? `<div class="text-sm font-medium text-dark">Chi nhánh: ${escapeHtml(
              data.store.branch
            )}</div>`
          : ''
      }
      <div class="text-sm text-muted">${escapeHtml(data.store.address)}</div>
      <div class="text-sm text-muted">Hotline: <strong>${escapeHtml(
        data.store.phone
      )}</strong>${
    data.store.hotline ? ` - ${escapeHtml(data.store.hotline)}` : ''
  }</div>
      ${
        opts.showTaxCode && data.store.taxCode
          ? `<div class="text-sm text-muted">Mã số thuế: <strong>${escapeHtml(
              data.store.taxCode
            )}</strong></div>`
          : ''
      }
      ${
        data.store.website
          ? `<div class="text-sm text-muted">Website: ${escapeHtml(data.store.website)}</div>`
          : ''
      }
    </div>

    <div class="invoice-meta">
      <div class="invoice-title">${escapeHtml(opts.title || 'HÓA ĐƠN BÁN HÀNG')}</div>
      <div class="status-badge">${statusInfo.text}</div>
      <div class="text-sm">Số hóa đơn: <strong>${escapeHtml(data.id)}</strong></div>
      ${
        data.orderCode && data.orderCode !== data.id
          ? `<div class="text-sm">Mã đơn: <strong>${escapeHtml(data.orderCode)}</strong></div>`
          : ''
      }
      <div class="text-sm text-muted">Ngày lập: ${formatDateTimeVN(data.createdAt)}</div>
      ${
        data.cashier || data.creatorName
          ? `<div class="text-sm text-muted">Người lập: ${escapeHtml(
              data.cashier || data.creatorName || ''
            )}</div>`
          : ''
      }
      ${
        data.tableName
          ? `<div class="text-sm text-muted">Khu vực / Bàn: <strong>${escapeHtml(
              data.tableName
            )}</strong></div>`
          : ''
      }
    </div>
  </div>

  <!-- Customer Details Card -->
  <div class="customer-card">
    <div class="customer-col">
      <div class="customer-col-title">Khách hàng</div>
      <div class="font-bold text-dark text-base">${escapeHtml(
        data.customer?.name || 'Khách lẻ'
      )}</div>
      ${
        data.customer?.phone
          ? `<div class="text-sm text-muted">SĐT: <strong>${escapeHtml(
              data.customer.phone
            )}</strong></div>`
          : ''
      }
      ${
        data.customer?.email
          ? `<div class="text-sm text-muted">Email: ${escapeHtml(data.customer.email)}</div>`
          : ''
      }
    </div>

    <div class="customer-col">
      <div class="customer-col-title">Địa chỉ nhận hàng</div>
      <div class="text-sm text-dark">${escapeHtml(
        data.customer?.address || 'Tại cửa hàng'
      )}</div>
      ${
        data.customer?.note
          ? `<div class="text-xs text-note" style="margin-top: 4px;">Ghi chú: ${escapeHtml(
              data.customer.note
            )}</div>`
          : ''
      }
    </div>

    <div class="customer-col" style="flex: 0 0 180px;">
      <div class="customer-col-title">Thanh toán</div>
      <div class="text-sm font-semibold text-dark">${escapeHtml(
        paymentLabels[data.paymentMethod] || data.paymentMethod
      )}</div>
      <div class="text-xs text-muted" style="margin-top: 2px;">Trạng thái: ${
        statusInfo.text
      }</div>
    </div>
  </div>

  <!-- Items Table -->
  <table class="invoice-table">
    <thead>
      <tr>
        <th class="text-center" style="width: 45px;">STT</th>
        <th class="text-left">Tên sản phẩm / Dịch vụ</th>
        <th class="text-center" style="width: 65px;">ĐVT</th>
        <th class="text-center" style="width: 65px;">SL</th>
        <th class="text-right" style="width: 110px;">Đơn giá</th>
        <th class="text-right" style="width: 100px;">Chiết khấu</th>
        <th class="text-right" style="width: 125px;">Thành tiền</th>
      </tr>
    </thead>
    <tbody>
      ${rowsHtml}
    </tbody>
  </table>

  <!-- Summary & VietQR Section -->
  <div class="summary-section">
    ${
      qrUrl
        ? `
    <div class="vietqr-box">
      <img src="${qrUrl}" alt="VietQR Payment" class="vietqr-img" />
      <div class="vietqr-details">
        <div class="vietqr-title">QUÉT MÃ VIETQR THANH TOÁN</div>
        <div>Ngân hàng: <strong>${escapeHtml(data.store.bankInfo?.bank || '')}</strong></div>
        <div>Số tài khoản: <strong>${escapeHtml(
          data.store.bankInfo?.accountNumber || ''
        )}</strong></div>
        <div>Chủ tài khoản: <strong>${escapeHtml(
          data.store.bankInfo?.accountName.toUpperCase() || ''
        )}</strong></div>
        <div>Số tiền: <strong>${formatCurrencyVND(totals.totalAmount)}</strong></div>
        <div>Nội dung: <strong>TT ${escapeHtml(data.id)}</strong></div>
      </div>
    </div>`
        : `<div style="flex: 1;"></div>`
    }

    <table class="totals-table">
      <tr>
        <td class="text-muted">Cộng tiền hàng:</td>
        <td class="text-right font-medium">${formatCurrencyVND(totals.subtotal)}</td>
      </tr>
      ${
        totals.discountAmount > 0
          ? `
      <tr>
        <td class="text-muted">Chiết khấu / Giảm giá:</td>
        <td class="text-right text-discount font-medium">-${formatCurrencyVND(
          totals.discountAmount
        )}</td>
      </tr>`
          : ''
      }
      ${
        totals.shippingFee > 0
          ? `
      <tr>
        <td class="text-muted">Phí vận chuyển:</td>
        <td class="text-right font-medium">${formatCurrencyVND(totals.shippingFee)}</td>
      </tr>`
          : ''
      }
      ${
        totals.vatAmount > 0
          ? `
      <tr>
        <td class="text-muted">Thuế VAT ${data.vatRate ? `(${data.vatRate}%)` : ''}:</td>
        <td class="text-right font-medium">${formatCurrencyVND(totals.vatAmount)}</td>
      </tr>`
          : ''
      }
      <tr>
        <td class="total-highlight">TỔNG CỘNG:</td>
        <td class="text-right total-highlight">${formatCurrencyVND(totals.totalAmount)}</td>
      </tr>
      ${
        data.amountPaid !== undefined
          ? `
      <tr>
        <td class="text-muted">Tiền khách trả:</td>
        <td class="text-right font-medium">${formatCurrencyVND(data.amountPaid)}</td>
      </tr>`
          : ''
      }
      ${
        data.changeAmount !== undefined
          ? `
      <tr>
        <td class="text-muted">Tiền thừa trả khách:</td>
        <td class="text-right font-medium">${formatCurrencyVND(data.changeAmount)}</td>
      </tr>`
          : ''
      }
    </table>
  </div>

  <!-- Amount in Words -->
  <div class="words-box">
    <strong>Số tiền viết bằng chữ:</strong> ${amountInWords}
  </div>

  <!-- Signatures Section -->
  ${
    opts.showSignatures
      ? `
  <div class="signatures-block">
    <div class="sign-col">
      <div class="sign-title">Người mua hàng</div>
      <div class="sign-hint">(Ký, ghi rõ họ tên)</div>
      <div class="sign-space"></div>
      <div class="font-medium text-dark">${escapeHtml(data.customer?.name || '')}</div>
    </div>
    <div class="sign-col">
      <div class="sign-title">Người giao hàng</div>
      <div class="sign-hint">(Ký, ghi rõ họ tên)</div>
      <div class="sign-space"></div>
    </div>
    <div class="sign-col">
      <div class="sign-title">Người lập phiếu / Thu ngân</div>
      <div class="sign-hint">(Ký, ghi rõ họ tên)</div>
      <div class="sign-space"></div>
      <div class="font-medium text-dark">${escapeHtml(
        data.cashier || data.creatorName || data.store.name
      )}</div>
    </div>
  </div>`
      : ''
  }

  <!-- Footer -->
  <div class="invoice-footer">
    <div>${escapeHtml(
      data.footerMessage ||
        'Cảm ơn Quý khách đã mua sắm! Quý khách vui lòng kiểm tra hàng trước khi nhận.'
    )}</div>
    <div style="margin-top: 4px;">In từ hệ thống lúc: ${formatDateTimeVN(
      new Date(),
      true
    )}</div>
  </div>

</body>
</html>`;
}

/**
 * Formats a dedicated Delivery Slip (Phiếu giao hàng / Shipper Slip) in HTML/PDF
 */
export function formatDeliverySlipHtml(
  data: InvoiceData,
  options?: Partial<InvoiceTemplateOptions>
): string {
  const mergedOptions: Partial<InvoiceTemplateOptions> = {
    ...options,
    title: options?.title || 'PHIẾU GIAO HÀNG',
  };
  const totals = computeInvoiceTotals(data);
  const isCod = data.paymentMethod === 'cod' || data.paymentStatus === 'pending';
  const qrUrl = mergedOptions.showVietQr !== false ? generateVietQrFromInvoice(data) : undefined;

  const rowsHtml = data.items
    .map(
      (item, idx) => `
      <tr>
        <td class="text-center">${idx + 1}</td>
        <td>
          <div class="font-bold text-dark">${escapeHtml(item.name)}</div>
          ${item.note ? `<div class="text-xs text-note">* Ghi chú: ${escapeHtml(item.note)}</div>` : ''}
        </td>
        <td class="text-center font-bold text-lg">${item.quantity}</td>
        <td class="text-center">${escapeHtml(item.unit || 'phần')}</td>
        <td class="text-right">${formatCurrencyVND(item.unitPrice)}</td>
        <td class="text-right font-bold">${formatCurrencyVND(
          item.totalPrice !== undefined
            ? item.totalPrice
            : item.quantity * item.unitPrice - (item.discount || 0)
        )}</td>
      </tr>
    `
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <title>Phiếu Giao Hàng - ${escapeHtml(data.id)}</title>
  <style>
    @page { size: A4 portrait; margin: 12mm 15mm; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 13px;
      color: #0f172a;
      line-height: 1.5;
      padding: 20px;
      max-width: 850px;
      margin: 0 auto;
    }
    .text-center { text-align: center; }
    .text-right { text-align: right; }
    .font-bold { font-weight: 700; }
    .text-xs { font-size: 11px; }
    .text-sm { font-size: 12px; }
    .text-lg { font-size: 16px; }
    .text-xl { font-size: 20px; }
    .text-2xl { font-size: 24px; }
    .text-muted { color: #64748b; }
    .text-note { color: #475569; font-style: italic; }
    
    .slip-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 2px solid #0f172a;
      padding-bottom: 12px;
      margin-bottom: 16px;
    }
    .slip-title {
      font-size: 24px;
      font-weight: 900;
      color: #0f172a;
      text-transform: uppercase;
      letter-spacing: 1px;
    }
    .slip-boxes {
      display: flex;
      gap: 16px;
      margin-bottom: 18px;
    }
    .party-box {
      flex: 1;
      border: 1px solid #cbd5e1;
      border-radius: 8px;
      padding: 14px;
      background: #f8fafc;
    }
    .party-title {
      font-size: 11px;
      font-weight: 800;
      color: #475569;
      text-transform: uppercase;
      margin-bottom: 6px;
      border-bottom: 1px solid #e2e8f0;
      padding-bottom: 4px;
    }
    .party-name {
      font-size: 16px;
      font-weight: 700;
      color: #0f172a;
    }
    .recipient-phone {
      font-size: 18px;
      font-weight: 900;
      color: #2563eb;
      margin: 4px 0;
    }
    .cod-banner {
      background: #fee2e2;
      border: 2px dashed #ef4444;
      border-radius: 8px;
      padding: 12px 18px;
      margin-bottom: 18px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .cod-amount {
      font-size: 22px;
      font-weight: 900;
      color: #dc2626;
    }
    .delivery-table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 16px;
    }
    .delivery-table th {
      background: #f1f5f9;
      border: 1px solid #cbd5e1;
      padding: 8px 10px;
      font-size: 12px;
      text-transform: uppercase;
    }
    .delivery-table td {
      border: 1px solid #e2e8f0;
      padding: 8px 10px;
    }
    .instruction-box {
      border: 1px solid #fde047;
      background: #fefce8;
      border-radius: 6px;
      padding: 10px 14px;
      margin-bottom: 18px;
      font-weight: 600;
      color: #854d0e;
    }
    .qr-and-signs {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-top: 10px;
      page-break-inside: avoid;
    }
    .qr-slip-box {
      border: 1px dashed #cbd5e1;
      border-radius: 8px;
      padding: 10px;
      display: flex;
      align-items: center;
      gap: 10px;
      max-width: 45%;
      background: #f8fafc;
    }
    .qr-slip-box img {
      width: 85px;
      height: 85px;
    }
    .signs-wrapper {
      flex: 1;
      display: flex;
      justify-content: space-around;
      text-align: center;
    }
    .sign-title {
      font-weight: 700;
      font-size: 13px;
    }
    .sign-space {
      height: 60px;
    }
  </style>
</head>
<body>
  <div class="slip-header">
    <div>
      <div class="slip-title">PHIẾU GIAO HÀNG</div>
      <div class="text-sm text-muted">Mã vận đơn: <strong>${escapeHtml(data.id)}</strong> | Ngày: ${formatDateTimeVN(data.createdAt)}</div>
    </div>
    <div class="text-right">
      <div class="font-bold text-lg">${escapeHtml(data.store.name)}</div>
      <div class="text-sm text-muted">Hotline: ${escapeHtml(data.store.phone)}</div>
    </div>
  </div>

  <div class="slip-boxes">
    <div class="party-box">
      <div class="party-title">NGƯỜI GỬI (SENDER)</div>
      <div class="party-name">${escapeHtml(data.store.name)}</div>
      <div class="text-sm">${escapeHtml(data.store.address)}</div>
      <div class="text-sm">SĐT: <strong>${escapeHtml(data.store.phone)}</strong></div>
    </div>

    <div class="party-box" style="background: #eff6ff; border-color: #bfdbfe;">
      <div class="party-title" style="color: #1e40af; border-color: #bfdbfe;">NGƯỜI NHẬN (RECEIVER)</div>
      <div class="party-name">${escapeHtml(data.customer?.name || 'Khách nhận')}</div>
      <div class="recipient-phone">📞 ${escapeHtml(data.customer?.phone || 'Chưa có SĐT')}</div>
      <div class="text-sm font-medium">📍 ${escapeHtml(data.customer?.address || 'Địa chỉ nhận hàng')}</div>
      ${data.customer?.note ? `<div class="text-xs text-note" style="margin-top: 4px;">Ghi chú: ${escapeHtml(data.customer.note)}</div>` : ''}
    </div>
  </div>

  ${
    isCod
      ? `
  <div class="cod-banner">
    <div>
      <div class="text-sm font-bold" style="color: #991b1b;">TIỀN THU HỘ (COD):</div>
      <div class="text-xs text-muted">Shipper thu tiền mặt hoặc hướng dẫn khách quét VietQR</div>
    </div>
    <div class="cod-amount">${formatCurrencyVND(totals.totalAmount)}</div>
  </div>`
      : `
  <div class="cod-banner" style="background: #dcfce7; border-color: #22c55e;">
    <div>
      <div class="text-sm font-bold" style="color: #166534;">ĐƠN HÀNG ĐÃ THANH TOÁN TRƯỚC:</div>
      <div class="text-xs text-muted">KHÔNG THU TIỀN HÀNG (COD = 0 đ)</div>
    </div>
    <div class="cod-amount" style="color: #166534;">0 đ</div>
  </div>`
  }

  <div class="instruction-box">
    ⚠️ GHI CHÚ GIAO HÀNG: Cho xem hàng, không cho thử hàng. Liên hệ người gửi nếu không phát được.
  </div>

  <table class="delivery-table">
    <thead>
      <tr>
        <th style="width: 40px;">STT</th>
        <th>Hàng hóa / Sản phẩm</th>
        <th style="width: 50px;">SL</th>
        <th style="width: 60px;">ĐVT</th>
        <th style="width: 100px;" class="text-right">Đơn giá</th>
        <th style="width: 110px;" class="text-right">Thành tiền</th>
      </tr>
    </thead>
    <tbody>
      ${rowsHtml}
    </tbody>
  </table>

  <div class="qr-and-signs">
    ${
      qrUrl
        ? `
    <div class="qr-slip-box">
      <img src="${qrUrl}" alt="VietQR COD" />
      <div class="text-xs">
        <div class="font-bold">QUÉT MÃ VIETQR</div>
        <div>STK: <strong>${escapeHtml(data.store.bankInfo?.accountNumber || '')}</strong></div>
        <div>NH: <strong>${escapeHtml(data.store.bankInfo?.bank || '')}</strong></div>
        <div>Chủ TK: ${escapeHtml(data.store.bankInfo?.accountName || '')}</div>
        <div>Số tiền: <strong>${formatCurrencyVND(totals.totalAmount)}</strong></div>
      </div>
    </div>`
        : `<div></div>`
    }

    <div class="signs-wrapper">
      <div>
        <div class="sign-title">Người nhận hàng</div>
        <div class="text-xs text-muted">(Ký xác nhận đã nhận đủ hàng)</div>
        <div class="sign-space"></div>
        <div class="text-sm font-medium">${escapeHtml(data.customer?.name || '')}</div>
      </div>
      <div>
        <div class="sign-title">Người giao hàng (Shipper)</div>
        <div class="text-xs text-muted">(Ký khi giao thành công)</div>
        <div class="sign-space"></div>
      </div>
    </div>
  </div>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
