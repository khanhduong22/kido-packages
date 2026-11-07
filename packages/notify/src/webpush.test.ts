import assert from 'node:assert';
import test from 'node:test';
import webpush from 'web-push';
import {
  createWebPushNotifier,
  generateVAPIDKeys,
  sendWebPush,
  WebPushError,
  WebPushNotifier,
  WebPushPayload,
  WebPushPayloadSchema,
  WebPushSubscription,
  WebPushSubscriptionSchema,
} from './index';

const mockSubscription: WebPushSubscription = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/test-token-12345',
  keys: {
    p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM=',
    auth: 'tBHItJI5svbpez7KI4CCXg==',
  },
};

const mockVapid = {
  subject: 'mailto:admin@example.com',
  publicKey: 'test-public-key-base64',
  privateKey: 'test-private-key-base64',
};

const mockPayload: WebPushPayload = {
  title: '💰 Cơ hội mua! Gap +120 VND',
  body: 'Binance thấp hơn chợ đen 120 VND',
  icon: '/icon-192x192.png',
  url: '/markets/p2p',
  data: {
    gap: 120,
    symbol: 'USDT/VND',
  },
};

test('generateVAPIDKeys generates valid base64url public and private keys', () => {
  const keys = generateVAPIDKeys();
  assert.ok(typeof keys.publicKey === 'string' && keys.publicKey.length > 50);
  assert.ok(typeof keys.privateKey === 'string' && keys.privateKey.length > 20);
});

test('WebPushSubscriptionSchema validates correct subscription structure', () => {
  const valid = WebPushSubscriptionSchema.safeParse(mockSubscription);
  assert.strictEqual(valid.success, true);

  const invalid = WebPushSubscriptionSchema.safeParse({
    endpoint: '',
    keys: { p256dh: '' },
  });
  assert.strictEqual(invalid.success, false);
});

test('WebPushPayloadSchema validates and preserves custom metadata and actions', () => {
  const valid = WebPushPayloadSchema.safeParse(mockPayload);
  assert.strictEqual(valid.success, true);
  if (valid.success) {
    assert.strictEqual(valid.data.title, '💰 Cơ hội mua! Gap +120 VND');
    assert.strictEqual(valid.data.url, '/markets/p2p');
    assert.deepStrictEqual(valid.data.data, { gap: 120, symbol: 'USDT/VND' });
  }
});

test('sendWebPush successfully sends notification when web-push succeeds', async () => {
  const originalSendNotification = webpush.sendNotification;
  let capturedSub: unknown;
  let capturedPayload: unknown;
  let capturedOptions: unknown;

  webpush.sendNotification = async (sub: any, payload: any, options: any) => {
    capturedSub = sub;
    capturedPayload = payload;
    capturedOptions = options;
    return {
      statusCode: 201,
      body: '',
      headers: { 'content-type': 'text/plain' },
    };
  };

  try {
    const result = await sendWebPush(mockSubscription, mockPayload, mockVapid);

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.statusCode, 201);
    assert.strictEqual(result.isExpired, false);
    assert.strictEqual(result.error, undefined);

    // Verify arguments passed to webpush.sendNotification
    assert.deepStrictEqual(capturedSub, {
      endpoint: mockSubscription.endpoint,
      keys: mockSubscription.keys,
    });
    assert.strictEqual(capturedPayload, JSON.stringify(mockPayload));
    assert.deepStrictEqual((capturedOptions as any)?.vapidDetails, {
      subject: mockVapid.subject,
      publicKey: mockVapid.publicKey,
      privateKey: mockVapid.privateKey,
    });
  } finally {
    webpush.sendNotification = originalSendNotification;
  }
});

test('sendWebPush accepts pre-serialized string payload', async () => {
  const originalSendNotification = webpush.sendNotification;
  let capturedPayload: unknown;

  webpush.sendNotification = async (_sub: any, payload: any) => {
    capturedPayload = payload;
    return { statusCode: 200, body: 'ok', headers: {} };
  };

  try {
    const rawString = JSON.stringify({ hello: 'world' });
    const result = await sendWebPush(mockSubscription, rawString, mockVapid);

    assert.strictEqual(result.success, true);
    assert.strictEqual(capturedPayload, rawString);
  } finally {
    webpush.sendNotification = originalSendNotification;
  }
});

test('sendWebPush flags isExpired: true when subscription returns HTTP 410 Gone', async () => {
  const originalSendNotification = webpush.sendNotification;

  webpush.sendNotification = async () => {
    const err = new WebPushError(
      'Received unexpected response code: 410',
      410,
      {},
      'Unregistered',
      mockSubscription.endpoint
    );
    throw err;
  };

  try {
    const result = await sendWebPush(mockSubscription, mockPayload, mockVapid);

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.statusCode, 410);
    assert.strictEqual(result.isExpired, true);
    assert.ok(result.error?.includes('410'));
  } finally {
    webpush.sendNotification = originalSendNotification;
  }
});

test('sendWebPush flags isExpired: true when subscription returns HTTP 404 Not Found', async () => {
  const originalSendNotification = webpush.sendNotification;

  webpush.sendNotification = async () => {
    const err = new WebPushError(
      'Received unexpected response code: 404',
      404,
      {},
      'Not Found',
      mockSubscription.endpoint
    );
    throw err;
  };

  try {
    const result = await sendWebPush(mockSubscription, mockPayload, mockVapid);

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.statusCode, 404);
    assert.strictEqual(result.isExpired, true);
    assert.ok(result.error?.includes('404'));
  } finally {
    webpush.sendNotification = originalSendNotification;
  }
});

test('sendWebPush flags isExpired: false on network or connection errors', async () => {
  const originalSendNotification = webpush.sendNotification;

  webpush.sendNotification = async () => {
    throw new Error('connect ECONNREFUSED 142.250.190.46:443');
  };

  try {
    const result = await sendWebPush(mockSubscription, mockPayload, mockVapid);

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.statusCode, undefined);
    assert.strictEqual(result.isExpired, false);
    assert.ok(result.error?.includes('ECONNREFUSED'));
  } finally {
    webpush.sendNotification = originalSendNotification;
  }
});

test('sendWebPush flags isExpired: false on server 500 error', async () => {
  const originalSendNotification = webpush.sendNotification;

  webpush.sendNotification = async () => {
    const err = new WebPushError(
      'Internal Server Error',
      500,
      {},
      'Internal Error',
      mockSubscription.endpoint
    );
    throw err;
  };

  try {
    const result = await sendWebPush(mockSubscription, mockPayload, mockVapid);

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.statusCode, 500);
    assert.strictEqual(result.isExpired, false);
    assert.ok(result.error?.includes('Internal Server Error'));
  } finally {
    webpush.sendNotification = originalSendNotification;
  }
});

test('sendWebPush validates invalid subscription arguments upfront', async () => {
  const invalidSub = { endpoint: '', keys: { p256dh: '', auth: '' } } as any;
  const result = await sendWebPush(invalidSub, mockPayload, mockVapid);

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.isExpired, false);
  assert.ok(result.error?.includes('Invalid push subscription'));
});

test('sendWebPush validates missing VAPID credentials upfront', async () => {
  const invalidVapid = { subject: '', publicKey: '', privateKey: '' } as any;
  const result = await sendWebPush(mockSubscription, mockPayload, invalidVapid);

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.isExpired, false);
  assert.ok(result.error?.includes('VAPID credentials missing'));
});

test('WebPushNotifier class and createWebPushNotifier helper work correctly', async () => {
  const originalSendNotification = webpush.sendNotification;

  webpush.sendNotification = async () => {
    return { statusCode: 201, body: '', headers: {} };
  };

  try {
    const notifier = createWebPushNotifier(mockVapid);
    assert.ok(notifier instanceof WebPushNotifier);

    const result = await notifier.send(mockSubscription, mockPayload, { TTL: 3600 });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.statusCode, 201);
    assert.strictEqual(result.isExpired, false);
  } finally {
    webpush.sendNotification = originalSendNotification;
  }
});
