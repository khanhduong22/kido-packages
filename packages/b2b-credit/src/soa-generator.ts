import {
  AgingScheduleSummary,
  BankPaymentInfo,
  DealerRecord,
  InvoiceRecord,
} from './types';
import { formatVnd } from './credit-lockout';

/**
 * Ngân hàng mặc định thu hồi công nợ B2B
 */
export const DEFAULT_B2B_BANK: BankPaymentInfo = {
  bank: 'MBBank',
  accountNumber: '999988882222',
  accountName: 'CONG TY CP PHAN PHOI B2B VIET NAM',
  template: 'compact2',
};

/**
 * Sinh link ảnh VietQR chuẩn
 */
export function buildVietQrUrl(
  bankInfo: BankPaymentInfo,
  amount: number,
  description: string
): string {
  // Chuẩn hóa tên ngân hàng thành BIN code hoặc tên viết tắt phổ biến
  const bankBinMap: Record<string, string> = {
    MBBank: '970422',
    MB: '970422',
    Vietcombank: '970436',
    VCB: '970436',
    TCB: '970407',
    ACB: '970416',
    BIDV: '970418',
    VietinBank: '970415',
    VPBank: '970432',
    TPBank: '970423',
  };

  const bin = bankBinMap[bankInfo.bank] || bankInfo.bank;
  const template = bankInfo.template || 'compact2';
  const cleanAcc = bankInfo.accountNumber.trim();

  const params = new URLSearchParams();
  if (amount > 0) {
    params.set('amount', Math.round(amount).toString());
  }
  if (description) {
    params.set('addInfo', description.trim());
  }
  if (bankInfo.accountName) {
    params.set('accountName', bankInfo.accountName.trim());
  }

  const query = params.toString();
  return `https://img.vietqr.io/image/${bin}-${cleanAcc}-${template}.png${query ? `?${query}` : ''}`;
}

/**
 * Sinh biên bản đối soát công nợ tự động định dạng K80 (Plain Text cho máy in nhiệt 80mm)
 */
export function generateK80SoaText(
  dealer: DealerRecord,
  aging: AgingScheduleSummary,
  unpaidInvoices: InvoiceRecord[] = [],
  bankInfo: BankPaymentInfo = DEFAULT_B2B_BANK,
  settlementAmount?: number
): string {
  const line = '==========================================';
  const subLine = '------------------------------------------';

  // Số tiền đề nghị thanh toán: ưu tiên nợ quá hạn, hoặc toàn bộ nợ, hoặc con số chỉ định
  const payAmount = settlementAmount ?? (aging.totalOverdueDebt > 0 ? aging.totalOverdueDebt : aging.totalOutstandingDebt);
  const transferMemo = `B2B SOA ${dealer.code} TRA NO`;
  const qrUrl = buildVietQrUrl(bankInfo, payAmount, transferMemo);

  const availableCredit = Math.max(0, dealer.creditLimit - aging.totalOutstandingDebt);
  const isLocked = aging.totalOverdueDebt > 0 && aging.classifiedInvoices.some((i) => i.overdueDays > 30);

  const dateStr = new Date().toLocaleString('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  const lines: string[] = [
    line,
    '    BIÊN BẢN ĐỐI SOÁT CÔNG NỢ ĐẠI LÝ',
    '       (STATEMENT OF ACCOUNT - SOA)',
    line,
    `Thời điểm: ${dateStr}`,
    `Đại lý:    ${dealer.name.toUpperCase()}`,
    `Mã ĐL:     ${dealer.code} | Cấp: ${dealer.tier}`,
    `SĐT:       ${dealer.phone}`,
    subLine,
    `Hạn mức cấp:      ${formatVnd(dealer.creditLimit)}`,
    `Tổng nợ hiện tại: ${formatVnd(aging.totalOutstandingDebt)}`,
    `Hạn mức khả dụng: ${formatVnd(availableCredit)}`,
    `Trạng thái nợ:    ${isLocked ? '[KHÓA ĐẶT HÀNG - QUÁ HẠN > 30D]' : '[AN TOÀN / ĐỦ ĐIỀU KIỆN]'}`,
    subLine,
    'PHÂN BỔ TUỔI NỢ (AGING SCHEDULE):',
    `- D0  (Trong hạn):       ${formatVnd(aging.buckets.D0.totalAmount)}`,
    `- D15 (Quá hạn 1-15d):   ${formatVnd(aging.buckets.D15.totalAmount)}`,
    `- D30 (Quá hạn 16-30d):  ${formatVnd(aging.buckets.D30.totalAmount)}`,
    `- D60 (Quá hạn 31-60d):  ${formatVnd(aging.buckets.D60.totalAmount)}`,
    `- D90+ (Nợ khó đòi):     ${formatVnd(aging.buckets.D90_PLUS.totalAmount)}`,
    `=> Tổng nợ quá hạn:     ${formatVnd(aging.totalOverdueDebt)}`,
    subLine,
    'HÓA ĐƠN CHƯA THANH TOÁN (TOP GẦN NHẤT):',
  ];

  const topInvoices = unpaidInvoices.slice(0, 5);
  if (topInvoices.length === 0) {
    lines.push('  (Không có hóa đơn nào tồn đọng)');
  } else {
    topInvoices.forEach((inv, idx) => {
      const remaining = inv.remainingAmount ?? inv.totalAmount;
      const dueStr = new Date(inv.dueDate).toLocaleDateString('vi-VN');
      lines.push(`${idx + 1}. ${inv.invoiceNumber} | Hạn: ${dueStr} | ${formatVnd(remaining)}`);
    });
  }

  lines.push(
    subLine,
    'THÔNG TIN THANH TOÁN CÔNG NỢ (VIETQR):',
    `Ngân hàng: ${bankInfo.bank}`,
    `Số TK:     ${bankInfo.accountNumber}`,
    `Chủ TK:    ${bankInfo.accountName}`,
    `Số tiền:   ${formatVnd(payAmount)}`,
    `Nội dung:  ${transferMemo}`,
    `Link QR:   ${qrUrl}`,
    line,
    'XÁC NHẬN BÀN GIAO: KẾ TOÁN TRƯỞNG & ĐẠI LÝ',
    '       (Ký và ghi rõ họ tên)',
    line
  );

  return lines.join('\n');
}

/**
 * Sinh biên bản đối soát công nợ định dạng K80 chuẩn HTML (hỗ trợ hiển thị trực quan và in nhiệt)
 */
export function generateK80SoaHtml(
  dealer: DealerRecord,
  aging: AgingScheduleSummary,
  unpaidInvoices: InvoiceRecord[] = [],
  bankInfo: BankPaymentInfo = DEFAULT_B2B_BANK,
  settlementAmount?: number
): string {
  const payAmount =
    settlementAmount ??
    (aging.totalOverdueDebt > 0 ? aging.totalOverdueDebt : aging.totalOutstandingDebt);
  const transferMemo = `B2B SOA ${dealer.code} TRA NO`;
  const qrUrl = buildVietQrUrl(bankInfo, payAmount, transferMemo);
  const availableCredit = Math.max(0, dealer.creditLimit - aging.totalOutstandingDebt);

  const dateStr = new Date().toLocaleString('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <title>Biên Bản Đối Soát Công Nợ - ${dealer.code}</title>
  <style>
    @page { size: 80mm auto; margin: 4mm; }
    body {
      font-family: 'JetBrains Mono', 'Courier New', monospace;
      font-size: 11px;
      line-height: 1.4;
      color: #000;
      background: #fff;
      max-width: 300px;
      margin: 0 auto;
      padding: 6px;
    }
    .text-center { text-align: center; }
    .text-right { text-align: right; }
    .bold { font-weight: bold; }
    .divider { border-top: 1px dashed #000; margin: 6px 0; }
    .double-divider { border-top: 2px solid #000; margin: 6px 0; }
    .row { display: flex; justify-content: space-between; margin: 2px 0; }
    .qr-container { text-align: center; margin: 8px 0; }
    .qr-container img { width: 170px; height: 170px; object-fit: contain; }
    .badge {
      display: inline-block;
      padding: 2px 6px;
      font-size: 10px;
      font-weight: bold;
      border: 1px solid #000;
    }
  </style>
</head>
<body>
  <div class="double-divider"></div>
  <div class="text-center bold" style="font-size: 13px;">BIÊN BẢN ĐỐI SOÁT CÔNG NỢ</div>
  <div class="text-center bold" style="font-size: 10px;">STATEMENT OF ACCOUNT (SOA)</div>
  <div class="double-divider"></div>

  <div class="row"><span>Thời điểm:</span><span class="bold">${dateStr}</span></div>
  <div class="row"><span>Đại lý:</span><span class="bold">${dealer.name}</span></div>
  <div class="row"><span>Mã ĐL:</span><span class="bold">${dealer.code} (${dealer.tier})</span></div>
  <div class="row"><span>SĐT:</span><span>${dealer.phone}</span></div>

  <div class="divider"></div>
  <div class="row"><span>Hạn mức tín dụng:</span><span class="bold">${formatVnd(dealer.creditLimit)}</span></div>
  <div class="row"><span>Công nợ hiện tại:</span><span class="bold">${formatVnd(aging.totalOutstandingDebt)}</span></div>
  <div class="row"><span>Hạn mức khả dụng:</span><span class="bold">${formatVnd(availableCredit)}</span></div>

  <div class="divider"></div>
  <div class="bold">PHÂN BỔ TUỔI NỢ (AGING SCHEDULE):</div>
  <div class="row"><span>• D0 (Trong hạn):</span><span>${formatVnd(aging.buckets.D0.totalAmount)}</span></div>
  <div class="row"><span>• D15 (Quá hạn 1-15d):</span><span>${formatVnd(aging.buckets.D15.totalAmount)}</span></div>
  <div class="row"><span>• D30 (Quá hạn 16-30d):</span><span>${formatVnd(aging.buckets.D30.totalAmount)}</span></div>
  <div class="row"><span>• D60 (Quá hạn 31-60d):</span><span>${formatVnd(aging.buckets.D60.totalAmount)}</span></div>
  <div class="row"><span>• D90+ (Nợ khó đòi):</span><span>${formatVnd(aging.buckets.D90_PLUS.totalAmount)}</span></div>
  <div class="row bold"><span>=> Tổng quá hạn:</span><span>${formatVnd(aging.totalOverdueDebt)}</span></div>

  <div class="divider"></div>
  <div class="bold">QUÉT MÃ VIETQR THANH TOÁN:</div>
  <div class="qr-container">
    <img src="${qrUrl}" alt="VietQR Thanh Toán Nợ" />
  </div>
  <div class="row"><span>Ngân hàng:</span><span class="bold">${bankInfo.bank}</span></div>
  <div class="row"><span>Số TK:</span><span class="bold">${bankInfo.accountNumber}</span></div>
  <div class="row"><span>Chủ TK:</span><span class="bold">${bankInfo.accountName}</span></div>
  <div class="row"><span>Số tiền nộp:</span><span class="bold">${formatVnd(payAmount)}</span></div>
  <div class="row"><span>Nội dung CK:</span><span class="bold">${transferMemo}</span></div>

  <div class="double-divider"></div>
  <div class="text-center" style="margin-top: 10px;">
    <div><strong>ĐẠI DIỆN ĐẠI LÝ</strong> &nbsp;&nbsp;&nbsp;&nbsp; <strong>KẾ TOÁN TRƯỞNG</strong></div>
    <div style="font-size: 9px; margin-top: 30px;">(Ký, ghi rõ họ tên và đóng dấu xác nhận)</div>
  </div>
</body>
</html>`;
}

/**
 * Sinh biên bản đối soát công nợ chính quy khổ A4 cho Ban Giám đốc & Phòng Tài chính Kế toán
 */
export function generateFormalSoaHtml(
  dealer: DealerRecord,
  aging: AgingScheduleSummary,
  unpaidInvoices: InvoiceRecord[] = [],
  bankInfo: BankPaymentInfo = DEFAULT_B2B_BANK
): string {
  const availableCredit = Math.max(0, dealer.creditLimit - aging.totalOutstandingDebt);
  const transferMemo = `B2B SOA ${dealer.code} QUYET TOAN`;
  const qrUrl = buildVietQrUrl(bankInfo, aging.totalOutstandingDebt, transferMemo);

  return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <title>Biên Bản Đối Soát Công Nợ Doanh Nghiệp - ${dealer.code}</title>
  <style>
    body { font-family: 'Plus Jakarta Sans', Arial, sans-serif; margin: 40px; color: #0F172A; }
    .header { display: flex; justify-content: space-between; border-bottom: 2px solid #2563EB; padding-bottom: 16px; }
    .title { text-align: center; margin: 24px 0; }
    .title h1 { margin: 0; font-size: 22px; color: #1E3A8A; text-transform: uppercase; }
    .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; background: #F8FAFC; padding: 16px; border-radius: 8px; margin-bottom: 24px; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
    th, td { border: 1px solid #E2E8F0; padding: 8px 12px; font-size: 13px; }
    th { background: #F1F5F9; text-align: left; }
    .text-right { text-align: right; }
    .qr-box { display: flex; align-items: center; gap: 24px; background: #EFF6FF; padding: 16px; border-radius: 8px; border: 1px solid #BFDBFE; }
    .qr-img { width: 140px; height: 140px; }
    .signatures { display: flex; justify-content: space-between; margin-top: 48px; text-align: center; }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <h3 style="margin:0; color:#2563EB;">TỔNG KHO PHÂN PHỐI B2B TOÀN QUỐC</h3>
      <p style="margin:4px 0 0; font-size:12px; color:#64748B;">Hệ thống Cổng Đặt Hàng & Quản Trị Tín Dụng Đại Lý</p>
    </div>
    <div style="text-align:right; font-size:12px; color:#64748B;">
      <p style="margin:0;">Ngày lập: ${new Date().toLocaleDateString('vi-VN')}</p>
      <p style="margin:4px 0 0;">Mã hồ sơ: SOA-${dealer.code}-${new Date().getFullYear()}</p>
    </div>
  </div>

  <div class="title">
    <h1>BIÊN BẢN ĐỐI SOÁT CÔNG NỢ & NGHĨA VỤ TÀI CHÍNH</h1>
    <p style="margin:4px 0 0; font-size:13px; color:#64748B;">Căn cứ hợp đồng phân phối thương mại và quy chế hạn mức tín dụng đại lý</p>
  </div>

  <div class="info-grid">
    <div>
      <p style="margin:0 0 6px;"><strong>Đại lý:</strong> ${dealer.name}</p>
      <p style="margin:0 0 6px;"><strong>Mã đối tác:</strong> ${dealer.code} (${dealer.tier})</p>
      <p style="margin:0;"><strong>Địa chỉ:</strong> ${dealer.address}</p>
    </div>
    <div>
      <p style="margin:0 0 6px;"><strong>Hạn mức tín dụng duyệt:</strong> ${formatVnd(dealer.creditLimit)}</p>
      <p style="margin:0 0 6px;"><strong>Tổng dư nợ hiện tại:</strong> <span style="color:#DC2626; font-weight:bold;">${formatVnd(aging.totalOutstandingDebt)}</span></p>
      <p style="margin:0;"><strong>Hạn mức còn lại:</strong> <span style="color:#2563EB; font-weight:bold;">${formatVnd(availableCredit)}</span></p>
    </div>
  </div>

  <h3>1. BẢNG PHÂN BỔ TUỔI NỢ & DỰ PHÒNG RỦI RO</h3>
  <table>
    <thead>
      <tr>
        <th>Nhóm tuổi nợ</th>
        <th>Phân loại</th>
        <th class="text-right">Số hóa đơn</th>
        <th class="text-right">Dư nợ (VND)</th>
        <th class="text-right">Tỷ lệ nợ (%)</th>
        <th class="text-right">Tỷ lệ dự phòng</th>
        <th class="text-right">Trích lập dự phòng (VND)</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td><strong>D0</strong></td>
        <td>Trong hạn thanh toán</td>
        <td class="text-right">${aging.buckets.D0.invoiceCount}</td>
        <td class="text-right">${formatVnd(aging.buckets.D0.totalAmount)}</td>
        <td class="text-right">${aging.buckets.D0.percentageOfTotal}%</td>
        <td class="text-right">0%</td>
        <td class="text-right">0 đ</td>
      </tr>
      <tr>
        <td><strong>D15</strong></td>
        <td>Quá hạn 1 - 15 ngày</td>
        <td class="text-right">${aging.buckets.D15.invoiceCount}</td>
        <td class="text-right">${formatVnd(aging.buckets.D15.totalAmount)}</td>
        <td class="text-right">${aging.buckets.D15.percentageOfTotal}%</td>
        <td class="text-right">5%</td>
        <td class="text-right">${formatVnd(aging.buckets.D15.provisionAmount)}</td>
      </tr>
      <tr>
        <td><strong>D30</strong></td>
        <td>Quá hạn 16 - 30 ngày (1 tháng)</td>
        <td class="text-right">${aging.buckets.D30.invoiceCount}</td>
        <td class="text-right">${formatVnd(aging.buckets.D30.totalAmount)}</td>
        <td class="text-right">${aging.buckets.D30.percentageOfTotal}%</td>
        <td class="text-right">20%</td>
        <td class="text-right">${formatVnd(aging.buckets.D30.provisionAmount)}</td>
      </tr>
      <tr>
        <td><strong>D60</strong></td>
        <td>Quá hạn 31 - 60 ngày (2 tháng)</td>
        <td class="text-right">${aging.buckets.D60.invoiceCount}</td>
        <td class="text-right">${formatVnd(aging.buckets.D60.totalAmount)}</td>
        <td class="text-right">${aging.buckets.D60.percentageOfTotal}%</td>
        <td class="text-right">50%</td>
        <td class="text-right">${formatVnd(aging.buckets.D60.provisionAmount)}</td>
      </tr>
      <tr>
        <td><strong>D90+</strong></td>
        <td>Nợ khó đòi trích lập toàn phần</td>
        <td class="text-right">${aging.buckets.D90_PLUS.invoiceCount}</td>
        <td class="text-right">${formatVnd(aging.buckets.D90_PLUS.totalAmount)}</td>
        <td class="text-right">${aging.buckets.D90_PLUS.percentageOfTotal}%</td>
        <td class="text-right">100%</td>
        <td class="text-right">${formatVnd(aging.buckets.D90_PLUS.provisionAmount)}</td>
      </tr>
      <tr style="font-weight:bold; background:#F8FAFC;">
        <td colspan="2">TỔNG CỘNG NGHĨA VỤ</td>
        <td class="text-right">${unpaidInvoices.length}</td>
        <td class="text-right" style="color:#DC2626;">${formatVnd(aging.totalOutstandingDebt)}</td>
        <td class="text-right">100%</td>
        <td class="text-right">-</td>
        <td class="text-right">${formatVnd(aging.totalProvisionAmount)}</td>
      </tr>
    </tbody>
  </table>

  <div class="qr-box">
    <img class="qr-img" src="${qrUrl}" alt="VietQR Tra No" />
    <div>
      <h4 style="margin:0 0 6px; color:#1E40AF;">KÊNH THANH TOÁN THU HỒI CÔNG NỢ TỰ ĐỘNG</h4>
      <p style="margin:0 0 4px; font-size:13px;">Ngân hàng: <strong>${bankInfo.bank}</strong> - Số tài khoản: <strong>${bankInfo.accountNumber}</strong></p>
      <p style="margin:0 0 4px; font-size:13px;">Chủ thụ hưởng: <strong>${bankInfo.accountName}</strong></p>
      <p style="margin:0; font-size:13px;">Cú pháp chuyển khoản: <strong style="color:#2563EB;">${transferMemo}</strong></p>
    </div>
  </div>

  <div class="signatures">
    <div>
      <p style="font-weight:bold; margin-bottom:60px;">ĐẠI DIỆN ĐẠI LÝ</p>
      <p style="color:#64748B;">(Ký & ghi rõ họ tên)</p>
    </div>
    <div>
      <p style="font-weight:bold; margin-bottom:60px;">KẾ TOÁN TRƯỞNG</p>
      <p style="color:#64748B;">(Ký & ghi rõ họ tên)</p>
    </div>
    <div>
      <p style="font-weight:bold; margin-bottom:60px;">GIÁM ĐỐC TÀI CHÍNH (CFO)</p>
      <p style="color:#64748B;">(Phê duyệt)</p>
    </div>
  </div>
</body>
</html>`;
}
