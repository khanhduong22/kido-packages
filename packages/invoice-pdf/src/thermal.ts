import { generateVietQrImageUrl } from '@kido/payment-vietqr';
import { InvoiceData, ReceiptFormatOptions, ReceiptFormatOptionsSchema } from './types';
import {
  centerText,
  computeInvoiceTotals,
  divider,
  formatCurrencyVND,
  formatDateTimeVN,
  getStringDisplayWidth,
  padLine,
  removeVietnameseDiacritics,
  wrapText,
} from './utils';

/**
 * ESC/POS control commands for thermal receipt printers
 */
export const ESC_POS = {
  INIT: '\x1b\x40', // Initialize printer
  ALIGN_LEFT: '\x1b\x61\x00',
  ALIGN_CENTER: '\x1b\x61\x01',
  ALIGN_RIGHT: '\x1b\x61\x02',
  BOLD_ON: '\x1b\x45\x01',
  BOLD_OFF: '\x1b\x45\x00',
  CUT_FULL: '\x1d\x56\x00', // GS V 0 (Full cut)
  CUT_PARTIAL: '\x1d\x56\x01', // GS V 1 (Partial cut)
  FEED_3_LINES: '\x1b\x64\x03',
};

/**
 * Formats an invoice into monospace plain text for K80 (80mm) or K57 (58mm) thermal receipt printers.
 * Supports Vietnamese Unicode or ASCII diacritic removal, two-sided column justification, and dashed dividers.
 */
export function formatThermalReceiptText(
  data: InvoiceData,
  options?: Partial<ReceiptFormatOptions>
): string {
  const opts = ReceiptFormatOptionsSchema.parse(options || {});
  const width = opts.columns || (opts.paperWidth === 'k57' ? 32 : 48);
  const isK57 = width <= 36;
  const totals = computeInvoiceTotals(data);

  const lines: string[] = [];

  // Helper for adding lines
  const add = (line: string) => lines.push(line);
  const addCentered = (text: string) => {
    const wrapped = wrapText(text, width);
    for (const w of wrapped) {
      add(centerText(w, width));
    }
  };

  // Header: Store Profile
  addCentered(data.store.name.toUpperCase());
  if (data.store.branch) {
    addCentered(`Chi nhánh: ${data.store.branch}`);
  }
  if (data.store.address) {
    addCentered(data.store.address);
  }
  if (data.store.phone) {
    addCentered(`Hotline/SĐT: ${data.store.phone}`);
  }
  if (data.store.taxCode) {
    addCentered(`MST: ${data.store.taxCode}`);
  }
  if (data.store.wifiInfo && (data.store.wifiInfo.ssid || data.store.wifiInfo.password)) {
    const wifiText = `Wifi: ${data.store.wifiInfo.ssid || ''} - Pass: ${
      data.store.wifiInfo.password || ''
    }`;
    addCentered(wifiText);
  }

  add(divider('=', width));

  // Receipt Title
  const title =
    data.type === 'delivery_slip'
      ? 'PHIẾU GIAO HÀNG'
      : data.type === 'receipt'
      ? 'PHIẾU THU TIỀN'
      : 'HÓA ĐƠN BÁN HÀNG';
  addCentered(title);
  add(divider('-', width));

  // Order Details / Metadata
  add(padLine(`Số HĐ: ${data.id}`, formatDateTimeVN(data.createdAt), width));

  if (data.orderCode && data.orderCode !== data.id) {
    add(padLine('Mã đơn hàng:', data.orderCode, width));
  }
  if (data.cashier || data.creatorName) {
    add(padLine('Thu ngân:', data.cashier || data.creatorName || '', width));
  }
  if (data.tableName) {
    add(padLine('Vị trí / Bàn:', data.tableName, width));
  }
  if (data.orderChannel) {
    add(padLine('Kênh bán:', data.orderChannel, width));
  }
  if (data.customer?.name) {
    add(padLine('Khách hàng:', data.customer.name, width));
  }
  if (data.customer?.phone) {
    add(padLine('Số điện thoại:', data.customer.phone, width));
  }
  if (data.customer?.address) {
    const addrLines = wrapText(`Địa chỉ: ${data.customer.address}`, width);
    for (const a of addrLines) {
      add(a);
    }
  }

  add(divider('-', width));

  // Items Header & Rows
  add(padLine('Tên mặt hàng / Đơn giá', 'SL  T.Tiền', width));
  add(divider('-', width));

  data.items.forEach((item, index) => {
    const itemTotal =
      item.totalPrice !== undefined
        ? item.totalPrice
        : item.quantity * item.unitPrice - (item.discount || 0);

    // Line 1: Item index + name
    const namePrefix = `${index + 1}. ${item.name}`;
    const nameLines = wrapText(namePrefix, width);
    for (const nl of nameLines) {
      add(nl);
    }

    // Line 2: Details: "  qty x price" and "total"
    const discountNote =
      item.discount && item.discount > 0
        ? ` (-${formatCurrencyVND(item.discount)})`
        : '';
    const detailsLeft = `   ${item.quantity} ${item.unit || ''} x ${formatCurrencyVND(
      item.unitPrice
    )}${discountNote}`;
    const detailsRight = formatCurrencyVND(itemTotal);
    add(padLine(detailsLeft, detailsRight, width));

    // Optional note
    if (opts.showItemNote && item.note) {
      const noteLines = wrapText(`   * Ghi chú: ${item.note}`, width);
      for (const nl of noteLines) {
        add(nl);
      }
    }
  });

  add(divider('-', width));

  // Totals Summary
  add(padLine('Cộng tiền hàng:', formatCurrencyVND(totals.subtotal), width));

  if (totals.discountAmount > 0) {
    add(padLine('Chiết khấu / Giảm giá:', `-${formatCurrencyVND(totals.discountAmount)}`, width));
  }
  if (totals.shippingFee > 0) {
    add(padLine('Phí vận chuyển:', formatCurrencyVND(totals.shippingFee), width));
  }
  if (totals.vatAmount > 0) {
    const vatLabel = data.vatRate ? `Thuế VAT (${data.vatRate}%):` : 'Thuế VAT:';
    add(padLine(vatLabel, formatCurrencyVND(totals.vatAmount), width));
  }

  add(divider('=', width));
  add(padLine('TỔNG THANH TOÁN:', formatCurrencyVND(totals.totalAmount), width));

  if (data.amountPaid !== undefined) {
    add(padLine('Tiền khách đưa:', formatCurrencyVND(data.amountPaid), width));
  }
  if (data.changeAmount !== undefined) {
    add(padLine('Tiền thừa trả khách:', formatCurrencyVND(data.changeAmount), width));
  }

  const paymentLabels: Record<string, string> = {
    cash: 'Tiền mặt',
    vietqr: 'Chuyển khoản VietQR',
    bank_transfer: 'Chuyển khoản ngân hàng',
    card: 'Thẻ POS',
    cod: 'Thu hộ COD',
  };
  const paymentStr = paymentLabels[data.paymentMethod] || data.paymentMethod;
  add(padLine('Hình thức:', paymentStr, width));

  const statusLabels: Record<string, string> = {
    paid: 'Đã thanh toán',
    pending: 'Chờ thanh toán',
    partially_paid: 'Thanh toán một phần',
    refunded: 'Đã hoàn tiền',
  };
  const statusStr = statusLabels[data.paymentStatus] || data.paymentStatus;
  add(padLine('Trạng thái:', statusStr, width));

  add(divider('-', width));

  // Bank Info & VietQR notice if applicable
  if (opts.includeQr && data.store.bankInfo) {
    addCentered('THANH TOÁN QUA VIETQR');
    addCentered(`Ngân hàng: ${data.store.bankInfo.bank}`);
    addCentered(`Số TK: ${data.store.bankInfo.accountNumber}`);
    addCentered(`Chủ TK: ${data.store.bankInfo.accountName}`);
    if (data.qrPaymentUrl) {
      addCentered(`QR Link: ${data.qrPaymentUrl}`);
    }
    add(divider('-', width));
  }

  // Footer Message
  const footer = data.footerMessage || 'CẢM ƠN QUÝ KHÁCH & HẸN GẶP LẠI!';
  addCentered(footer);
  addCentered(formatDateTimeVN(new Date(), true));

  let result = lines.join('\n');

  // Convert to ASCII if requested for older thermal printers
  if (opts.encoding === 'ascii_unaccented') {
    result = removeVietnameseDiacritics(result);
  }

  // Append ESC/POS Paper Cut if enabled
  if (opts.cutPaper) {
    result += `\n\n\n${ESC_POS.FEED_3_LINES}${ESC_POS.CUT_PARTIAL}`;
  }

  return result;
}

/**
 * Resolves or generates VietQR image URL for embedding in HTML/PDF
 */
export function resolveVietQrUrl(data: InvoiceData): string | undefined {
  if (data.qrPaymentUrl) {
    return data.qrPaymentUrl;
  }
  if (data.store.bankInfo) {
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
      // Safe fallback URL
      return `https://img.vietqr.io/image/${bank}-${accountNumber}-compact2.png?amount=${totals.totalAmount}&addInfo=TT%20${data.id}&accountName=${encodeURIComponent(
        accountName
      )}`;
    }
  }
  return undefined;
}

/**
 * Formats an invoice into production-ready HTML for thermal printers (80mm / 58mm).
 * Can be rendered directly in a browser or WebView and printed via window.print().
 */
export function formatThermalReceiptHtml(
  data: InvoiceData,
  options?: Partial<ReceiptFormatOptions>
): string {
  const opts = ReceiptFormatOptionsSchema.parse(options || {});
  const isK57 = opts.paperWidth === 'k57';
  const widthMm = isK57 ? 58 : 80;
  const printableMm = isK57 ? 48 : 72;
  const totals = computeInvoiceTotals(data);
  const qrUrl = opts.includeQr ? resolveVietQrUrl(data) : undefined;

  const paymentLabels: Record<string, string> = {
    cash: 'Tiền mặt',
    vietqr: 'Chuyển khoản VietQR',
    bank_transfer: 'Chuyển khoản NH',
    card: 'Thẻ POS',
    cod: 'Thu hộ COD',
  };

  const statusLabels: Record<string, string> = {
    paid: 'Đã thanh toán',
    pending: 'Chờ thanh toán',
    partially_paid: 'Thanh toán một phần',
    refunded: 'Đã hoàn tiền',
  };

  const itemsHtml = data.items
    .map((item, index) => {
      const itemTotal =
        item.totalPrice !== undefined
          ? item.totalPrice
          : item.quantity * item.unitPrice - (item.discount || 0);

      return `
        <div class="receipt-item">
          <div class="receipt-row font-medium">
            <span class="item-name">${index + 1}. ${escapeHtml(item.name)}</span>
            <span class="item-total">${formatCurrencyVND(itemTotal)}</span>
          </div>
          <div class="receipt-row text-muted text-xs">
            <span>${item.quantity} ${escapeHtml(item.unit || '')} x ${formatCurrencyVND(
        item.unitPrice
      )}</span>
            ${
              item.discount && item.discount > 0
                ? `<span class="text-discount">-${formatCurrencyVND(item.discount)}</span>`
                : ''
            }
          </div>
          ${
            opts.showItemNote && item.note
              ? `<div class="item-note text-xs text-muted">* ${escapeHtml(item.note)}</div>`
              : ''
          }
        </div>
      `;
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Bill - ${escapeHtml(data.id)}</title>
  <style>
    @page {
      margin: 0;
      size: ${widthMm}mm auto;
    }
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    body {
      font-family: 'Roboto Mono', 'Courier New', Courier, monospace;
      font-size: ${isK57 ? '11px' : '12px'};
      line-height: 1.35;
      color: #000;
      background: #fff;
      margin: 0 auto;
      width: ${printableMm}mm;
      padding: 3mm 1mm;
    }
    .text-center { text-align: center; }
    .text-right { text-align: right; }
    .text-left { text-align: left; }
    .font-bold { font-weight: bold; }
    .font-medium { font-weight: 600; }
    .text-xs { font-size: 10px; }
    .text-sm { font-size: 11px; }
    .text-base { font-size: 13px; }
    .text-lg { font-size: 15px; }
    .text-muted { color: #333; }
    .text-discount { color: #555; }
    
    .receipt-header {
      margin-bottom: 6px;
    }
    .receipt-logo {
      max-width: ${isK57 ? '35mm' : '45mm'};
      max-height: 20mm;
      margin: 0 auto 4px auto;
      display: block;
      filter: grayscale(100%);
    }
    .receipt-title {
      font-size: ${isK57 ? '13px' : '15px'};
      font-weight: bold;
      margin: 4px 0;
    }
    .receipt-divider-dashed {
      border-top: 1px dashed #000;
      margin: 6px 0;
    }
    .receipt-divider-double {
      border-top: 2px solid #000;
      margin: 6px 0;
    }
    .receipt-row {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 2px;
    }
    .receipt-item {
      margin-bottom: 5px;
    }
    .item-name {
      flex: 1;
      padding-right: 4px;
      word-break: break-word;
    }
    .item-total {
      white-space: nowrap;
    }
    .item-note {
      font-style: italic;
      padding-left: 8px;
    }
    .total-row {
      font-size: ${isK57 ? '13px' : '14px'};
      font-weight: bold;
      padding: 3px 0;
    }
    .receipt-qr-box {
      text-align: center;
      margin: 8px 0;
    }
    .receipt-qr-img {
      width: ${isK57 ? '34mm' : '42mm'};
      height: ${isK57 ? '34mm' : '42mm'};
      display: block;
      margin: 4px auto;
    }
    .receipt-footer {
      margin-top: 8px;
      text-align: center;
    }
    @media print {
      body {
        width: 100%;
        padding: 0;
      }
      .no-print {
        display: none !important;
      }
    }
  </style>
</head>
<body>
  <div class="receipt-header text-center">
    ${
      opts.showStoreLogo && data.store.logoUrl
        ? `<img src="${data.store.logoUrl}" alt="Logo" class="receipt-logo" />`
        : ''
    }
    <div class="font-bold text-base">${escapeHtml(data.store.name.toUpperCase())}</div>
    ${
      data.store.branch
        ? `<div class="text-xs">Chi nhánh: ${escapeHtml(data.store.branch)}</div>`
        : ''
    }
    <div class="text-xs">${escapeHtml(data.store.address)}</div>
    <div class="text-xs">Hotline: ${escapeHtml(data.store.phone)}</div>
    ${
      data.store.taxCode ? `<div class="text-xs">MST: ${escapeHtml(data.store.taxCode)}</div>` : ''
    }
    ${
      data.store.wifiInfo && (data.store.wifiInfo.ssid || data.store.wifiInfo.password)
        ? `<div class="text-xs">Wifi: ${escapeHtml(
            data.store.wifiInfo.ssid || ''
          )} - Pass: ${escapeHtml(data.store.wifiInfo.password || '')}</div>`
        : ''
    }
  </div>

  <div class="receipt-divider-double"></div>

  <div class="receipt-title text-center">
    ${
      data.type === 'delivery_slip'
        ? 'PHIẾU GIAO HÀNG'
        : data.type === 'receipt'
        ? 'PHIẾU THU TIỀN'
        : 'HÓA ĐƠN BÁN HÀNG'
    }
  </div>

  <div class="receipt-divider-dashed"></div>

  <div class="receipt-info text-xs">
    <div class="receipt-row">
      <span>Số HĐ: <strong>${escapeHtml(data.id)}</strong></span>
      <span>${formatDateTimeVN(data.createdAt)}</span>
    </div>
    ${
      data.orderCode && data.orderCode !== data.id
        ? `<div class="receipt-row"><span>Mã đơn:</span><span>${escapeHtml(
            data.orderCode
          )}</span></div>`
        : ''
    }
    ${
      data.cashier || data.creatorName
        ? `<div class="receipt-row"><span>Thu ngân:</span><span>${escapeHtml(
            data.cashier || data.creatorName || ''
          )}</span></div>`
        : ''
    }
    ${
      data.tableName
        ? `<div class="receipt-row"><span>Bàn / Phòng:</span><span>${escapeHtml(
            data.tableName
          )}</span></div>`
        : ''
    }
    ${
      data.orderChannel
        ? `<div class="receipt-row"><span>Kênh:</span><span>${escapeHtml(
            data.orderChannel
          )}</span></div>`
        : ''
    }
    ${
      data.customer?.name
        ? `<div class="receipt-row"><span>Khách hàng:</span><span>${escapeHtml(
            data.customer.name
          )}</span></div>`
        : ''
    }
    ${
      data.customer?.phone
        ? `<div class="receipt-row"><span>SĐT:</span><span>${escapeHtml(
            data.customer.phone
          )}</span></div>`
        : ''
    }
    ${
      data.customer?.address
        ? `<div class="text-xs"><span>Địa chỉ: </span>${escapeHtml(data.customer.address)}</div>`
        : ''
    }
  </div>

  <div class="receipt-divider-dashed"></div>

  <!-- Items list -->
  <div class="receipt-items">
    ${itemsHtml}
  </div>

  <div class="receipt-divider-dashed"></div>

  <!-- Totals Summary -->
  <div class="receipt-totals text-xs">
    <div class="receipt-row">
      <span>Cộng tiền hàng:</span>
      <span>${formatCurrencyVND(totals.subtotal)}</span>
    </div>
    ${
      totals.discountAmount > 0
        ? `<div class="receipt-row"><span>Chiết khấu:</span><span>-${formatCurrencyVND(
            totals.discountAmount
          )}</span></div>`
        : ''
    }
    ${
      totals.shippingFee > 0
        ? `<div class="receipt-row"><span>Phí giao hàng:</span><span>${formatCurrencyVND(
            totals.shippingFee
          )}</span></div>`
        : ''
    }
    ${
      totals.vatAmount > 0
        ? `<div class="receipt-row"><span>VAT ${
            data.vatRate ? `(${data.vatRate}%)` : ''
          }:</span><span>${formatCurrencyVND(totals.vatAmount)}</span></div>`
        : ''
    }
    <div class="receipt-divider-double"></div>
    <div class="receipt-row total-row">
      <span>TỔNG CỘNG:</span>
      <span>${formatCurrencyVND(totals.totalAmount)}</span>
    </div>
    ${
      data.amountPaid !== undefined
        ? `<div class="receipt-row"><span>Tiền khách đưa:</span><span>${formatCurrencyVND(
            data.amountPaid
          )}</span></div>`
        : ''
    }
    ${
      data.changeAmount !== undefined
        ? `<div class="receipt-row"><span>Tiền thừa:</span><span>${formatCurrencyVND(
            data.changeAmount
          )}</span></div>`
        : ''
    }
    <div class="receipt-row">
      <span>Thanh toán:</span>
      <span>${escapeHtml(paymentLabels[data.paymentMethod] || data.paymentMethod)}</span>
    </div>
    <div class="receipt-row">
      <span>Trạng thái:</span>
      <span>${escapeHtml(statusLabels[data.paymentStatus] || data.paymentStatus)}</span>
    </div>
  </div>

  ${
    qrUrl
      ? `
  <div class="receipt-divider-dashed"></div>
  <div class="receipt-qr-box">
    <div class="text-xs font-bold">QUÉT MÃ VIETQR ĐỂ THANH TOÁN</div>
    <img src="${qrUrl}" alt="VietQR Payment" class="receipt-qr-img" />
    ${
      data.store.bankInfo
        ? `<div class="text-xs">${escapeHtml(data.store.bankInfo.bank)} - ${escapeHtml(
            data.store.bankInfo.accountNumber
          )}</div>
           <div class="text-xs font-medium">${escapeHtml(
             data.store.bankInfo.accountName.toUpperCase()
           )}</div>`
        : ''
    }
  </div>`
      : ''
  }

  <div class="receipt-divider-double"></div>

  <div class="receipt-footer text-xs">
    <div class="font-bold">${escapeHtml(
      data.footerMessage || 'CẢM ƠN QUÝ KHÁCH & HẸN GẶP LẠI!'
    )}</div>
    <div class="text-muted" style="margin-top: 3px;">In lúc: ${formatDateTimeVN(
      new Date(),
      true
    )}</div>
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
