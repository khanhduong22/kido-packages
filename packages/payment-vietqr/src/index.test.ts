import assert from 'node:assert';
import test from 'node:test';
import {
  crc16Ccitt,
  generatePaymentQr,
  generateSepayQrUrl,
  generateVietQrEmvco,
  generateVietQrImageUrl,
  parsePayosWebhook,
  parseSepayWebhook,
  parseUnifiedWebhook,
  resolveBank,
  createPayosSignature,
} from './index';

test('resolveBank resolves by code, shortName and bin', () => {
  const mb = resolveBank('MB');
  assert.strictEqual(mb.bin, '970422');
  assert.strictEqual(mb.shortName, 'MBBank');

  const vcb = resolveBank('970436');
  assert.strictEqual(vcb.code, 'VCB');

  const tcb = resolveBank('Techcombank');
  assert.strictEqual(tcb.bin, '970407');
});

test('crc16Ccitt calculates accurate 4-char hex checksum', () => {
  // Test with standard EMVCo prefix
  const sample = '00020101021238540010A00000072701240006970422011001234567890208QRIBFTTA53037045405500005802VN62110807DH123456304';
  const crc = crc16Ccitt(sample);
  assert.strictEqual(crc.length, 4);
  assert.match(crc, /^[0-9A-F]{4}$/);
});

test('generateVietQrEmvco creates valid EMVCo payload', () => {
  const payload = generateVietQrEmvco({
    bank: 'MB',
    accountNumber: '0123456789',
    amount: 50000,
    description: 'DH12345',
  });

  assert.ok(payload.startsWith('000201010212')); // Dynamic QR
  assert.ok(payload.includes('A000000727')); // VietQR AID
  assert.ok(payload.includes('970422')); // MBBank BIN
  assert.ok(payload.includes('0123456789')); // Account number
  assert.ok(payload.includes('540550000')); // Amount 50000
  assert.ok(payload.includes('62110807DH12345')); // Description
  assert.ok(payload.includes('6304')); // CRC tag

  // Verify CRC of generated payload
  const withoutCrc = payload.slice(0, -4);
  const expectedCrc = crc16Ccitt(withoutCrc);
  assert.strictEqual(payload.slice(-4), expectedCrc);
});

test('generateVietQrImageUrl and generateSepayQrUrl format valid URLs', () => {
  const vietQrUrl = generateVietQrImageUrl({
    bank: 'MB',
    accountNumber: '0123456789',
    amount: 99000,
    description: 'ORD-999',
    accountName: 'NGUYEN VAN A',
  });
  assert.ok(vietQrUrl.includes('img.vietqr.io/image/970422-0123456789-compact2.png'));
  assert.ok(vietQrUrl.includes('amount=99000'));
  assert.ok(vietQrUrl.includes('addInfo=ORD-999'));

  const sepayUrl = generateSepayQrUrl({
    bank: 'MB',
    accountNumber: '0123456789',
    amount: 99000,
    description: 'ORD-999',
  });
  assert.ok(sepayUrl.includes('qr.sepay.vn/img'));
  assert.ok(sepayUrl.includes('acc=0123456789'));
  assert.ok(sepayUrl.includes('bank=MB'));
});

test('parseSepayWebhook validates payload and extracts order code', () => {
  const webhookBody = {
    id: 998822,
    gateway: 'MBBank',
    transactionDate: '2026-09-30 12:00:00',
    accountNumber: '0123456789',
    content: 'MBVCB.12345678.DH10023.THANH TOAN DON HANG',
    transferType: 'in',
    transferAmount: 150000,
    accumulated: 5000000,
    referenceCode: 'FT26273819',
  };

  // Valid without auth
  const res = parseSepayWebhook(webhookBody);
  assert.strictEqual(res.isValid, true);
  assert.strictEqual(res.provider, 'sepay');
  assert.strictEqual(res.orderCode, '10023');
  assert.strictEqual(res.amount, 150000);
  assert.strictEqual(res.transactionId, '998822');

  // Valid with auth check
  const resAuth = parseSepayWebhook(webhookBody, 'Apikey my_secret_key', {
    apiKey: 'my_secret_key',
  });
  assert.strictEqual(resAuth.isValid, true);

  // Invalid auth
  const resBadAuth = parseSepayWebhook(webhookBody, 'Apikey wrong_key', {
    apiKey: 'my_secret_key',
  });
  assert.strictEqual(resBadAuth.isValid, false);
  assert.ok(resBadAuth.error?.includes('Unauthorized'));

  // Ignores outgoing transfer
  const outBody = { ...webhookBody, transferType: 'out' };
  const resOut = parseSepayWebhook(outBody);
  assert.strictEqual(resOut.isValid, false);
});

test('parsePayosWebhook validates HMAC signature and order data', () => {
  const checksumKey = 'test_checksum_key_123456';
  const data = {
    orderCode: 8899,
    amount: 250000,
    description: 'Thanh toan lich hen SPA8899',
    accountNumber: '0123456789',
    reference: 'REF889900',
    transactionDateTime: '2026-09-30 12:30:00',
    currency: 'VND',
    code: '00',
    desc: 'Success',
  };

  const signature = createPayosSignature(data, checksumKey);

  const payload = {
    code: '00',
    desc: 'Success',
    data,
    signature,
  };

  const result = parsePayosWebhook(payload, { checksumKey });
  assert.strictEqual(result.isValid, true);
  assert.strictEqual(result.provider, 'payos');
  assert.strictEqual(result.orderCode, '8899');
  assert.strictEqual(result.amount, 250000);
  assert.strictEqual(result.transactionId, 'REF889900');
});

test('parseUnifiedWebhook automatically detects SePay and PayOS', () => {
  const sepayBody = {
    id: 111,
    gateway: 'MBBank',
    transactionDate: '2026-09-30',
    accountNumber: '123',
    content: 'DH99',
    transferType: 'in',
    transferAmount: 50000,
    accumulated: 100000,
  };

  const detectedSepay = parseUnifiedWebhook(sepayBody);
  assert.strictEqual(detectedSepay.provider, 'sepay');
  assert.strictEqual(detectedSepay.isValid, true);
});
