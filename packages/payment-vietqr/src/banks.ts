import { BankInfo } from './types';

export const VIETNAMESE_BANKS: BankInfo[] = [
  { bin: '970436', code: 'VCB', shortName: 'Vietcombank', name: 'Ngân hàng TMCP Ngoại thương Việt Nam', supportVietQr: true },
  { bin: '970415', code: 'CTG', shortName: 'VietinBank', name: 'Ngân hàng TMCP Công thương Việt Nam', supportVietQr: true },
  { bin: '970418', code: 'BIDV', shortName: 'BIDV', name: 'Ngân hàng TMCP Đầu tư và Phát triển Việt Nam', supportVietQr: true },
  { bin: '970422', code: 'MB', shortName: 'MBBank', name: 'Ngân hàng TMCP Quân đội', supportVietQr: true },
  { bin: '970407', code: 'TCB', shortName: 'Techcombank', name: 'Ngân hàng TMCP Kỹ thương Việt Nam', supportVietQr: true },
  { bin: '970416', code: 'ACB', shortName: 'ACB', name: 'Ngân hàng TMCP Á Châu', supportVietQr: true },
  { bin: '970432', code: 'VPB', shortName: 'VPBank', name: 'Ngân hàng TMCP Việt Nam Thịnh Vượng', supportVietQr: true },
  { bin: '970423', code: 'TPB', shortName: 'TPBank', name: 'Ngân hàng TMCP Tiên Phong', supportVietQr: true },
  { bin: '970403', code: 'STB', shortName: 'Sacombank', name: 'Ngân hàng TMCP Sài Gòn Thương Tín', supportVietQr: true },
  { bin: '970437', code: 'HDB', shortName: 'HDBank', name: 'Ngân hàng TMCP Phát triển TP.HCM', supportVietQr: true },
  { bin: '970441', code: 'VIB', shortName: 'VIB', name: 'Ngân hàng TMCP Quốc tế Việt Nam', supportVietQr: true },
  { bin: '970443', code: 'SHB', shortName: 'SHB', name: 'Ngân hàng TMCP Sài Gòn - Hà Nội', supportVietQr: true },
  { bin: '970431', code: 'EIB', shortName: 'Eximbank', name: 'Ngân hàng TMCP Xuất Nhập khẩu Việt Nam', supportVietQr: true },
  { bin: '970426', code: 'MSB', shortName: 'MSB', name: 'Ngân hàng TMCP Hàng Hải Việt Nam', supportVietQr: true },
  { bin: '970448', code: 'OCB', shortName: 'OCB', name: 'Ngân hàng TMCP Phương Đông', supportVietQr: true },
  { bin: '970449', code: 'LPB', shortName: 'LPBank', name: 'Ngân hàng TMCP Lộc Phát Việt Nam', supportVietQr: true },
  { bin: '970440', code: 'SEAB', shortName: 'SeABank', name: 'Ngân hàng TMCP Đông Nam Á', supportVietQr: true },
  { bin: '970425', code: 'ABB', shortName: 'ABBank', name: 'Ngân hàng TMCP An Bình', supportVietQr: true },
  { bin: '970409', code: 'BAB', shortName: 'BacABank', name: 'Ngân hàng TMCP Bắc Á', supportVietQr: true },
  { bin: '970428', code: 'NAB', shortName: 'NamABank', name: 'Ngân hàng TMCP Nam Á', supportVietQr: true },
  { bin: '963388', code: 'TIMO', shortName: 'Timo', name: 'Ngân hàng số Timo by BanVietBank', supportVietQr: true },
  { bin: '546034', code: 'CAKE', shortName: 'Cake', name: 'Ngân hàng số Cake by VPBank', supportVietQr: true },
  { bin: '971005', code: 'VIETTELMONEY', shortName: 'ViettelMoney', name: 'Tổng Công ty Dịch vụ Số Viettel', supportVietQr: true },
  { bin: '971011', code: 'VNPTMONEY', shortName: 'VNPTMoney', name: 'VNPT Money', supportVietQr: true }
];

export function findBank(keywordOrBin: string): BankInfo | undefined {
  if (!keywordOrBin) return undefined;
  const clean = keywordOrBin.trim().toLowerCase();

  return VIETNAMESE_BANKS.find(
    (b) =>
      b.bin === clean ||
      b.code.toLowerCase() === clean ||
      b.shortName.toLowerCase() === clean ||
      b.name.toLowerCase().includes(clean)
  );
}

export function resolveBank(keywordOrBin: string): BankInfo {
  const found = findBank(keywordOrBin);
  if (found) return found;

  // Fallback for custom or direct 6-digit BIN
  if (/^\d{6}$/.test(keywordOrBin.trim())) {
    return {
      bin: keywordOrBin.trim(),
      code: keywordOrBin.trim(),
      shortName: keywordOrBin.trim(),
      name: `Bank BIN ${keywordOrBin.trim()}`,
      supportVietQr: true
    };
  }

  // Fallback generic
  return {
    bin: keywordOrBin.trim(),
    code: keywordOrBin.trim().toUpperCase(),
    shortName: keywordOrBin.trim().toUpperCase(),
    name: keywordOrBin.trim(),
    supportVietQr: true
  };
}
