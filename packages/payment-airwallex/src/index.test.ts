import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectCardBrand,
  formatCardNumber,
  formatExpiry,
  checkLuhn,
  validateCardInput,
  createAirwallexPaymentIntent,
  AirwallexClient,
  formatAirwallexAmount,
  verifyAirwallexWebhookSignature,
  parseAirwallexWebhook,
  AIRWALLEX_SUPPORTED_CURRENCIES,
  AIRWALLEX_SUPPORTED_METHODS,
  AIRWALLEX_SANDBOX_CARDS,
} from './index';

describe('@kido/payment-airwallex Suite', () => {
  test('Brand detection detects major card schemes', () => {
    assert.equal(detectCardBrand('4111 1111 1111 1111'), 'visa');
    assert.equal(detectCardBrand('5500 0000 0000 0004'), 'mastercard');
    assert.equal(detectCardBrand('3782 822463 10005'), 'amex');
    assert.equal(detectCardBrand('3530 1113 3330 0000'), 'jcb');
    assert.equal(detectCardBrand('6011 0000 0000 0000'), 'discover');
    assert.equal(detectCardBrand(''), 'unknown');
  });

  test('Format card number spaces correctly', () => {
    assert.equal(formatCardNumber('4111111111111111'), '4111 1111 1111 1111');
    assert.equal(formatCardNumber('378282246310005'), '3782 822463 10005');
  });

  test('Format expiry spaces MM / YY', () => {
    assert.equal(formatExpiry('1228'), '12 / 28');
    assert.equal(formatExpiry('05'), '05');
  });

  test('Luhn algorithm validates properly', () => {
    assert.equal(checkLuhn('4111111111111111'), true);
    assert.equal(checkLuhn('4111111111111112'), false);
    assert.equal(checkLuhn(''), false);
  });

  test('validateCardInput reports errors and passes on good cards', () => {
    const invalid = validateCardInput({
      name: '',
      cardNumber: '',
      expMonth: '99',
      expYear: '20',
      cvc: '1',
    });
    assert.equal(invalid.isValid, false);
    assert.ok(invalid.errors.name);
    assert.ok(invalid.errors.cardNumber);
    assert.ok(invalid.errors.expiry);
    assert.ok(invalid.errors.cvc);

    const valid = validateCardInput({
      name: 'John Doe',
      cardNumber: '4111 1111 1111 1111',
      expMonth: '12',
      expYear: '2028',
      cvc: '123',
    });
    assert.equal(valid.isValid, true);
    assert.equal(valid.brand, 'visa');
  });

  test('Intent creation in mock mode', async () => {
    const intent = await createAirwallexPaymentIntent({
      amount: 49.99,
      currency: 'USD',
      merchantOrderId: 'ord_12345',
      customerEmail: 'test@example.com',
      customerName: 'Test Customer',
    });

    assert.ok(intent.id.startsWith('int_mock_'));
    assert.equal(intent.amount, 49.99);
    assert.equal(intent.currency, 'USD');
    assert.equal(intent.merchantOrderId, 'ord_12345');
    assert.ok(intent.clientSecret.startsWith('cs_mock_'));
  });

  test('AirwallexClient wrapper', async () => {
    const client = new AirwallexClient('mock_key');
    const intent = await client.createPaymentIntent({
      amount: 18.0,
      currency: 'USD',
      merchantOrderId: 'ord_client_test',
    });
    assert.equal(intent.amount, 18.0);
    assert.equal(intent.merchantOrderId, 'ord_client_test');
  });

  test('Currency formatting handles standard and zero-decimal currencies', () => {
    assert.equal(formatAirwallexAmount(24.99, 'USD'), '$24.99');
    assert.equal(formatAirwallexAmount(3000, 'JPY'), '¥3,000');
  });

  test('Webhook signature validation and parsing', () => {
    const secret = 'whsec_test_secret_123';
    const payload = JSON.stringify({
      id: 'evt_123',
      name: 'payment_intent.succeeded',
      accountId: 'acct_123',
      data: { object: { id: 'int_123', amount: 50.0 } },
      createdAt: new Date().toISOString(),
    });

    // Compute valid signature
    const { createHmac } = require('crypto');
    const validSignature = createHmac('sha256', secret).update(payload).digest('hex');

    assert.equal(verifyAirwallexWebhookSignature(payload, validSignature, secret), true);
    assert.equal(verifyAirwallexWebhookSignature(payload, 'bad_sig', secret), false);

    const parseResult = parseAirwallexWebhook(payload, validSignature, secret);
    assert.equal(parseResult.isValid, true);
    assert.equal(parseResult.event?.name, 'payment_intent.succeeded');
  });

  test('Metadata constants check', () => {
    assert.ok(AIRWALLEX_SUPPORTED_CURRENCIES.includes('USD'));
    assert.ok(AIRWALLEX_SUPPORTED_METHODS.includes('applepay'));
    assert.ok(AIRWALLEX_SUPPORTED_METHODS.includes('card'));
    assert.ok(AIRWALLEX_SANDBOX_CARDS.length >= 4);
  });
});
