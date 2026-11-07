import { describe, expect, it } from 'bun:test';
import { createHmac } from 'crypto';
import {
  AIRWALLEX_CURRENCY_SYMBOLS,
  AIRWALLEX_DEFAULT_CONFIG,
  AIRWALLEX_METHOD_LABELS,
  AIRWALLEX_SUPPORTED_CURRENCIES,
  AIRWALLEX_SUPPORTED_METHODS,
  AirwallexCardInput,
  AirwallexClient,
  AirwallexCurrency,
  AirwallexIntentConfig,
  checkLuhn,
  createAirwallexPaymentIntent,
  detectCardBrand,
  formatAirwallexAmount,
  getSupportedMethodsByCurrency,
  parseAirwallexWebhook,
  validateCardInput,
  verifyAirwallexWebhookSignature,
} from '../src';

describe('@kido/payment-airwallex: Constants & Config', () => {
  it('should expose all 8 supported currencies', () => {
    expect(AIRWALLEX_SUPPORTED_CURRENCIES).toHaveLength(8);
    expect(AIRWALLEX_SUPPORTED_CURRENCIES).toContain('USD');
    expect(AIRWALLEX_SUPPORTED_CURRENCIES).toContain('EUR');
    expect(AIRWALLEX_SUPPORTED_CURRENCIES).toContain('GBP');
    expect(AIRWALLEX_SUPPORTED_CURRENCIES).toContain('AUD');
    expect(AIRWALLEX_SUPPORTED_CURRENCIES).toContain('CAD');
    expect(AIRWALLEX_SUPPORTED_CURRENCIES).toContain('SGD');
    expect(AIRWALLEX_SUPPORTED_CURRENCIES).toContain('HKD');
    expect(AIRWALLEX_SUPPORTED_CURRENCIES).toContain('JPY');
  });

  it('should expose supported payment methods and readable labels', () => {
    expect(AIRWALLEX_SUPPORTED_METHODS).toHaveLength(7);
    for (const method of AIRWALLEX_SUPPORTED_METHODS) {
      expect(AIRWALLEX_METHOD_LABELS[method]).toBeDefined();
      expect(typeof AIRWALLEX_METHOD_LABELS[method]).toBe('string');
    }
  });

  it('should define valid default configuration endpoints', () => {
    expect(AIRWALLEX_DEFAULT_CONFIG.defaultCurrency).toBe('USD');
    expect(AIRWALLEX_DEFAULT_CONFIG.endpoints.demo).toContain('api-demo.airwallex.com');
    expect(AIRWALLEX_DEFAULT_CONFIG.endpoints.production).toContain('api.airwallex.com');
  });
});

describe('@kido/payment-airwallex: Card Brand Detection', () => {
  it('should detect Visa card prefix (starts with 4)', () => {
    expect(detectCardBrand('4111 2222 3333 4444')).toBe('visa');
    expect(detectCardBrand('4000123456789010')).toBe('visa');
  });

  it('should detect Mastercard 51-55 series', () => {
    expect(detectCardBrand('5100 0000 0000 0000')).toBe('mastercard');
    expect(detectCardBrand('5300 1234 5678 9012')).toBe('mastercard');
    expect(detectCardBrand('5500 0000 0000 0004')).toBe('mastercard');
  });

  it('should detect Mastercard 2221-2720 series', () => {
    expect(detectCardBrand('2221 0000 0000 0001')).toBe('mastercard');
    expect(detectCardBrand('2500 0000 0000 0000')).toBe('mastercard');
    expect(detectCardBrand('2720 9999 9999 9999')).toBe('mastercard');
  });

  it('should detect American Express (starts with 34 or 37)', () => {
    expect(detectCardBrand('3400 0000 0000 000')).toBe('amex');
    expect(detectCardBrand('3782 822463 10005')).toBe('amex');
  });

  it('should detect JCB (starts with 35, 2131, 1800)', () => {
    expect(detectCardBrand('3530 1113 3330 0000')).toBe('jcb');
    expect(detectCardBrand('2131 0000 0000 0000')).toBe('jcb');
    expect(detectCardBrand('1800 0000 0000 0000')).toBe('jcb');
  });

  it('should detect Discover (starts with 6011, 65, 644-649, 622)', () => {
    expect(detectCardBrand('6011 0000 0000 0000')).toBe('discover');
    expect(detectCardBrand('6500 0000 0000 0000')).toBe('discover');
    expect(detectCardBrand('6440 0000 0000 0000')).toBe('discover');
    expect(detectCardBrand('6221 2600 0000 0000')).toBe('discover');
  });

  it('should return unknown for unrecognized prefixes or empty input', () => {
    expect(detectCardBrand('9999 0000 0000 0000')).toBe('unknown');
    expect(detectCardBrand('')).toBe('unknown');
    expect(detectCardBrand('abcd')).toBe('unknown');
  });
});

describe('@kido/payment-airwallex: Luhn Algorithm & Card Validation', () => {
  it('should validate valid card numbers with checkLuhn', () => {
    // Valid standard test card numbers
    expect(checkLuhn('4111 1111 1111 1111')).toBe(true);
    expect(checkLuhn('4242 4242 4242 4242')).toBe(true);
    expect(checkLuhn('3782 822463 10005')).toBe(true);
  });

  it('should reject invalid Luhn checksum or invalid lengths', () => {
    expect(checkLuhn('4111 1111 1111 1112')).toBe(false);
    expect(checkLuhn('12345')).toBe(false); // too short
    expect(checkLuhn('')).toBe(false);
  });

  it('should succeed with valid complete card input', () => {
    const currentYear = new Date().getFullYear();
    const validCard: AirwallexCardInput = {
      name: 'John Doe',
      cardNumber: '4242 4242 4242 4242',
      expMonth: '12',
      expYear: String(currentYear + 2),
      cvc: '123',
    };

    const result = validateCardInput(validCard);
    expect(result.isValid).toBe(true);
    expect(result.brand).toBe('visa');
    expect(Object.keys(result.errors)).toHaveLength(0);
  });

  it('should require a valid cardholder name', () => {
    const validCard: AirwallexCardInput = {
      name: 'J',
      cardNumber: '4242 4242 4242 4242',
      expMonth: '12',
      expYear: '2028',
      cvc: '123',
    };

    const result = validateCardInput(validCard);
    expect(result.isValid).toBe(false);
    expect(result.errors.name).toBeDefined();
  });

  it('should reject expired cards or invalid expiration month', () => {
    const expiredCard: AirwallexCardInput = {
      name: 'Jane Smith',
      cardNumber: '4242 4242 4242 4242',
      expMonth: '01',
      expYear: '2020',
      cvc: '123',
    };

    const result = validateCardInput(expiredCard);
    expect(result.isValid).toBe(false);
    expect(result.errors.expiry).toContain('expired');

    const invalidMonthCard: AirwallexCardInput = {
      ...expiredCard,
      expMonth: '14',
      expYear: '2028',
    };
    const invalidMonthResult = validateCardInput(invalidMonthCard);
    expect(invalidMonthResult.isValid).toBe(false);
    expect(invalidMonthResult.errors.expiry).toContain('01-12');
  });

  it('should enforce 4-digit CVC for Amex and 3-digit CVC for others', () => {
    const amexWith3Digits: AirwallexCardInput = {
      name: 'Amex User',
      cardNumber: '3782 822463 10005',
      expMonth: '12',
      expYear: '2028',
      cvc: '123',
    };
    const amexRes1 = validateCardInput(amexWith3Digits);
    expect(amexRes1.isValid).toBe(false);
    expect(amexRes1.brand).toBe('amex');
    expect(amexRes1.errors.cvc).toContain('4-digit');

    const amexWith4Digits: AirwallexCardInput = {
      ...amexWith3Digits,
      cvc: '1234',
    };
    const amexRes2 = validateCardInput(amexWith4Digits);
    expect(amexRes2.isValid).toBe(true);

    const visaWith4Digits: AirwallexCardInput = {
      name: 'Visa User',
      cardNumber: '4242 4242 4242 4242',
      expMonth: '12',
      expYear: '2028',
      cvc: '1234',
    };
    const visaRes = validateCardInput(visaWith4Digits);
    expect(visaRes.isValid).toBe(false);
    expect(visaRes.errors.cvc).toContain('3 digits');
  });
});

describe('@kido/payment-airwallex: Webhook Signature Verification', () => {
  const secret = 'whsec_test_secret_key_998877';
  const payloadObj = {
    id: 'evt_123456',
    name: 'payment_intent.succeeded',
    accountId: 'act_001',
    data: {
      object: {
        id: 'int_mock_7788',
        amount: 150.0,
        currency: 'USD',
        status: 'SUCCEEDED',
      },
    },
    createdAt: '2026-10-02T10:00:00Z',
  };
  const payloadString = JSON.stringify(payloadObj);
  const timestamp = '1727850000';

  it('should verify signature with timestamp correctly', () => {
    const signature = createHmac('sha256', secret)
      .update(`${timestamp}${payloadString}`)
      .digest('hex');

    const isValid = verifyAirwallexWebhookSignature(
      payloadString,
      signature,
      secret,
      timestamp
    );
    expect(isValid).toBe(true);
  });

  it('should verify signature without timestamp when omitted', () => {
    const signature = createHmac('sha256', secret)
      .update(payloadString)
      .digest('hex');

    const isValid = verifyAirwallexWebhookSignature(payloadString, signature, secret);
    expect(isValid).toBe(true);
  });

  it('should reject tampered payload or wrong secret', () => {
    const signature = createHmac('sha256', secret)
      .update(`${timestamp}${payloadString}`)
      .digest('hex');

    const tamperedPayload = payloadString + ' ';
    expect(
      verifyAirwallexWebhookSignature(tamperedPayload, signature, secret, timestamp)
    ).toBe(false);

    expect(
      verifyAirwallexWebhookSignature(payloadString, signature, 'wrong_secret', timestamp)
    ).toBe(false);
  });

  it('should reject missing or empty signature parameters', () => {
    expect(verifyAirwallexWebhookSignature('', 'sig', 'secret')).toBe(false);
    expect(verifyAirwallexWebhookSignature('body', '', 'secret')).toBe(false);
    expect(verifyAirwallexWebhookSignature('body', 'sig', '')).toBe(false);
  });

  it('should parse valid webhook and reject invalid signature', () => {
    const signature = createHmac('sha256', secret)
      .update(`${timestamp}${payloadString}`)
      .digest('hex');

    const parseSuccess = parseAirwallexWebhook(
      payloadString,
      signature,
      secret,
      timestamp
    );
    expect(parseSuccess.isValid).toBe(true);
    expect(parseSuccess.event?.name).toBe('payment_intent.succeeded');
    expect(parseSuccess.event?.data.object.status).toBe('SUCCEEDED');

    const parseFail = parseAirwallexWebhook(
      payloadString,
      'invalid_hex_signature_1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      secret,
      timestamp
    );
    expect(parseFail.isValid).toBe(false);
    expect(parseFail.event).toBeNull();
    expect(parseFail.error).toContain('Invalid Airwallex webhook signature');
  });
});

describe('@kido/payment-airwallex: Amount Formatting & Supported Methods', () => {
  it('should format two-decimal currencies properly', () => {
    expect(formatAirwallexAmount(100, 'USD')).toBe('$100.00');
    expect(formatAirwallexAmount(49.99, 'EUR')).toBe('€49.99');
    expect(formatAirwallexAmount(1250.5, 'GBP')).toBe('£1,250.50');
    expect(formatAirwallexAmount(75, 'AUD')).toBe('A$75.00');
    expect(formatAirwallexAmount(99, 'CAD')).toBe('CA$99.00');
    expect(formatAirwallexAmount(120, 'SGD')).toBe('S$120.00');
    expect(formatAirwallexAmount(500, 'HKD')).toBe('HK$500.00');
  });

  it('should format zero-decimal currencies without decimals (JPY)', () => {
    expect(formatAirwallexAmount(1000, 'JPY')).toBe('¥1,000');
    expect(formatAirwallexAmount(250.75, 'JPY')).toBe('¥251');
  });

  it('should provide appropriate payment methods per currency', () => {
    const usdMethods = getSupportedMethodsByCurrency('USD');
    expect(usdMethods).toContain('card');
    expect(usdMethods).toContain('applepay');
    expect(usdMethods).toContain('googlepay');
    expect(usdMethods).toContain('paypal');
    expect(usdMethods).toContain('klarna');

    const eurMethods = getSupportedMethodsByCurrency('EUR');
    expect(eurMethods).toContain('card');
    expect(eurMethods).toContain('klarna');

    const sgdMethods = getSupportedMethodsByCurrency('SGD');
    expect(sgdMethods).toContain('wechatpay');
    expect(sgdMethods).toContain('alipay');

    const jpyMethods = getSupportedMethodsByCurrency('JPY');
    expect(jpyMethods).toContain('wechatpay');
    expect(jpyMethods).toContain('alipay');
    expect(jpyMethods).toContain('paypal');
  });
});

describe('@kido/payment-airwallex: Payment Intent Creation', () => {
  it('should generate mock sandbox intent when apiKey is omitted', async () => {
    const config: AirwallexIntentConfig = {
      amount: 199.99,
      currency: 'USD',
      merchantOrderId: 'ORDER_KT_2026_001',
      customerEmail: 'customer@example.com',
      customerName: 'Alex Mercer',
      metadata: { plan: 'pro_annual' },
    };

    const intent = await createAirwallexPaymentIntent(config);

    expect(intent).toBeDefined();
    expect(intent.id).toMatch(/^int_mock_\d+_[a-z0-9]+$/);
    expect(intent.clientSecret).toMatch(/^cs_mock_\d+_[a-z0-9_]+$/);
    expect(intent.status).toBe('REQUIRES_PAYMENT_METHOD');
    expect(intent.amount).toBe(199.99);
    expect(intent.currency).toBe('USD');
    expect(intent.merchantOrderId).toBe('ORDER_KT_2026_001');
    expect(intent.createdAt).toBeDefined();
  });

  it('should generate mock intent when apiKey starts with mock_', async () => {
    const config: AirwallexIntentConfig = {
      amount: 50.0,
      currency: 'EUR',
      merchantOrderId: 'ORDER_EUR_002',
    };

    const intent = await createAirwallexPaymentIntent(config, 'mock_key_test_123');
    expect(intent.id).toMatch(/^int_mock_/);
    expect(intent.currency).toBe('EUR');
  });

  it('should support AirwallexClient class instance creation', async () => {
    const client = new AirwallexClient();
    const config: AirwallexIntentConfig = {
      amount: 88.0,
      currency: 'SGD',
      merchantOrderId: 'ORDER_SGD_003',
    };

    const intent = await client.createPaymentIntent(config);
    expect(intent.id).toMatch(/^int_mock_/);
    expect(intent.amount).toBe(88.0);
    expect(intent.currency).toBe('SGD');
  });

  it('should throw validation errors for invalid config', async () => {
    // Negative or zero amount
    await expect(
      createAirwallexPaymentIntent({
        amount: 0,
        currency: 'USD',
        merchantOrderId: 'ORD_01',
      })
    ).rejects.toThrow('Payment amount must be greater than 0');

    // Missing merchantOrderId
    await expect(
      createAirwallexPaymentIntent({
        amount: 100,
        currency: 'USD',
        merchantOrderId: '',
      })
    ).rejects.toThrow('merchantOrderId is required');

    // Invalid currency
    await expect(
      createAirwallexPaymentIntent({
        amount: 100,
        currency: 'VND' as any,
        merchantOrderId: 'ORD_02',
      })
    ).rejects.toThrow('Unsupported or invalid currency');
  });

  it('should handle simulated live API call using fetch interceptor', async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (url, options) => {
        expect(String(url)).toContain('/api/v1/pa/payment_intents/create');
        expect(options?.headers).toHaveProperty('Authorization', 'Bearer live_api_key_test');

        return new Response(
          JSON.stringify({
            id: 'int_live_airwallex_999',
            amount: 300,
            currency: 'USD',
            status: 'REQUIRES_PAYMENT_METHOD',
            client_secret: 'cs_live_airwallex_secret_999',
            merchant_order_id: 'ORDER_LIVE_001',
            created_at: '2026-10-02T12:00:00Z',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      };

      const intent = await createAirwallexPaymentIntent(
        {
          amount: 300,
          currency: 'USD',
          merchantOrderId: 'ORDER_LIVE_001',
        },
        'live_api_key_test'
      );

      expect(intent.id).toBe('int_live_airwallex_999');
      expect(intent.clientSecret).toBe('cs_live_airwallex_secret_999');
      expect(intent.status).toBe('REQUIRES_PAYMENT_METHOD');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('should handle live API error response', async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => {
        return new Response(
          JSON.stringify({
            code: 'invalid_credentials',
            message: 'Invalid API key provided',
          }),
          { status: 401, statusText: 'Unauthorized' }
        );
      };

      await expect(
        createAirwallexPaymentIntent(
          {
            amount: 100,
            currency: 'USD',
            merchantOrderId: 'ORD_ERR',
          },
          'invalid_live_key'
        )
      ).rejects.toThrow('Airwallex API error (401): Invalid API key provided');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
