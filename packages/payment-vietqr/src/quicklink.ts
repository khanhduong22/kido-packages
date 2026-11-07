import { resolveBank } from './banks';
import { generateVietQrEmvco } from './emvco';
import { PaymentQrResult, VietQrOptions } from './types';

/**
 * Generates official VietQR.io dynamic/static image URL
 * Template options:
 * - compact2: QR + Bank Logo + Account Info + Transfer Info (recommended)
 * - compact: Compact card
 * - qr_only: QR image only
 * - print: Printable A4 template
 */
export function generateVietQrImageUrl(options: VietQrOptions): string {
  const bank = resolveBank(options.bank);
  const accountNumber = options.accountNumber.trim();
  const template = options.template || 'compact2';

  const baseUrl = `https://img.vietqr.io/image/${bank.bin}-${accountNumber}-${template}.png`;
  const params = new URLSearchParams();

  if (options.amount && options.amount > 0) {
    params.set('amount', Math.round(options.amount).toString());
  }
  if (options.description) {
    params.set('addInfo', options.description.trim());
  }
  if (options.accountName) {
    params.set('accountName', options.accountName.trim());
  }

  const queryString = params.toString();
  return queryString ? `${baseUrl}?${queryString}` : baseUrl;
}

/**
 * Generates SePay QuickLink dynamic QR image URL
 * Direct integration with SePay payment gateway
 */
export function generateSepayQrUrl(options: VietQrOptions): string {
  const bank = resolveBank(options.bank);
  const accountNumber = options.accountNumber.trim();
  const template = options.template || 'compact';

  const baseUrl = 'https://qr.sepay.vn/img';
  const params = new URLSearchParams();

  params.set('acc', accountNumber);
  params.set('bank', bank.code || bank.shortName);

  if (options.amount && options.amount > 0) {
    params.set('amount', Math.round(options.amount).toString());
  }
  if (options.description) {
    params.set('des', options.description.trim());
  }
  if (template) {
    params.set('template', template);
  }

  return `${baseUrl}?${params.toString()}`;
}

/**
 * Generates complete payment package:
 * - Raw EMVCo payload string (for client-side QR canvas / offline scanners)
 * - VietQR.io QuickLink URL (for web/mobile img src)
 * - SePay QuickLink URL
 */
export function generatePaymentQr(options: VietQrOptions): PaymentQrResult {
  const bank = resolveBank(options.bank);
  const emvco = generateVietQrEmvco(options);
  const vietQrUrl = generateVietQrImageUrl(options);
  const sepayQrUrl = generateSepayQrUrl(options);

  return {
    emvco,
    vietQrUrl,
    sepayQrUrl,
    bank,
    accountNumber: options.accountNumber.trim(),
    accountName: options.accountName?.trim(),
    amount: options.amount && options.amount > 0 ? Math.round(options.amount) : undefined,
    description: options.description?.trim(),
  };
}
