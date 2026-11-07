import { resolveBank } from './banks';
import { VietQrOptions } from './types';

/**
 * Calculates standard CRC16-CCITT (polynomial 0x1021, init 0xFFFF)
 * Required by EMVCo QR specification tag 63.
 */
export function crc16Ccitt(str: string): string {
  let crc = 0xffff;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    crc ^= (code << 8);
    for (let j = 0; j < 8; j++) {
      if ((crc & 0x8000) !== 0) {
        crc = ((crc << 1) ^ 0x1021) & 0xffff;
      } else {
        crc = (crc << 1) & 0xffff;
      }
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/**
 * Formats Tag-Length-Value according to EMVCo standard
 */
export function formatTlv(tag: string, value: string): string {
  const len = value.length.toString().padStart(2, '0');
  return `${tag}${len}${value}`;
}

/**
 * Generates official EMVCo QR Payload string for VietQR / NAPAS 247
 */
export function generateVietQrEmvco(options: VietQrOptions): string {
  const bank = resolveBank(options.bank);
  const accountNumber = options.accountNumber.trim();
  const amount = options.amount && options.amount > 0 ? Math.round(options.amount) : undefined;
  const description = options.description ? options.description.trim() : '';

  // 1. Tag 00: Payload Format Indicator (Fixed "01")
  let payload = formatTlv('00', '01');

  // 2. Tag 01: Point of Initiation Method ("12" for Dynamic with amount, "11" for Static)
  payload += formatTlv('01', amount ? '12' : '11');

  // 3. Tag 38: Merchant Account Information (VietQR NAPAS)
  // Subtag 00: GUID "A000000727"
  const sub00 = formatTlv('00', 'A000000727');
  // Subtag 01: Beneficiary Bank (sub-subtag 00: BIN, sub-subtag 01: Account Number)
  const beneficiaryInfo = formatTlv('00', bank.bin) + formatTlv('01', accountNumber);
  const sub01 = formatTlv('01', beneficiaryInfo);
  // Subtag 02: Service Code ("QRIBFTTA" for transfer to account)
  const sub02 = formatTlv('02', 'QRIBFTTA');
  const merchantAccountInfo = sub00 + sub01 + sub02;
  payload += formatTlv('38', merchantAccountInfo);

  // 4. Tag 53: Transaction Currency (704 = VND)
  payload += formatTlv('53', '704');

  // 5. Tag 54: Transaction Amount (if present)
  if (amount) {
    payload += formatTlv('54', amount.toString());
  }

  // 6. Tag 58: Country Code (VN)
  payload += formatTlv('58', 'VN');

  // 7. Tag 62: Additional Data Field (Purpose of Transaction / Bill Number)
  if (description) {
    const sub08 = formatTlv('08', description);
    payload += formatTlv('62', sub08);
  }

  // 8. Tag 63: CRC16 Checksum
  // Must include the tag '63' and length '04' before computing CRC
  const toCheck = `${payload}6304`;
  const checksum = crc16Ccitt(toCheck);

  return `${toCheck}${checksum}`;
}
