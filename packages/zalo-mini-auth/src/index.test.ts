import assert from 'node:assert';
import test from 'node:test';
import {
  CustomerProfileSchema,
  ZaloOAuthError,
  ZaloPhonePayloadSchema,
  ZaloTokensSchema,
  calculateTokenExpiresAt,
  decryptPhoneNumberAes,
  encryptPhoneNumberAes,
  exchangeCodeForTokens,
  fetchPhoneNumberFromZalo,
  formatVietnamesePhoneNumber,
  getZaloLoginUrl,
  isTokenExpired,
  isValidVietnamesePhoneNumber,
  mapToCustomerProfile,
  mapZaloMiniAppToCustomerProfile,
  mapZaloOAuthToCustomerProfile,
  normalizeVietnamesePhoneNumber,
  refreshZaloAccessToken,
} from './index';

test('1. getZaloLoginUrl generates valid Zalo OAuth 2.0 authorization URL', () => {
  const urlString = getZaloLoginUrl({
    appId: '1234567890',
    redirectUri: 'https://myapp.vn/callback',
    state: 'csrf-secret-123',
    codeChallenge: 'pkce-challenge-xyz',
  });

  const url = new URL(urlString);
  assert.strictEqual(url.origin, 'https://oauth.zaloapp.com');
  assert.strictEqual(url.pathname, '/v4/permission');
  assert.strictEqual(url.searchParams.get('app_id'), '1234567890');
  assert.strictEqual(url.searchParams.get('redirect_uri'), 'https://myapp.vn/callback');
  assert.strictEqual(url.searchParams.get('state'), 'csrf-secret-123');
  assert.strictEqual(url.searchParams.get('code_challenge'), 'pkce-challenge-xyz');
});

test('2. isTokenExpired and calculateTokenExpiresAt accurately handle expiration', () => {
  const now = new Date('2026-09-30T10:00:00Z');
  const expiresAt = calculateTokenExpiresAt(3600, now);
  assert.strictEqual(expiresAt.getTime(), now.getTime() + 3600 * 1000);

  // Buffer test: token expires in 30 seconds, buffer is 60 seconds -> should be treated as expired
  const almostExpired = new Date(Date.now() + 30 * 1000);
  assert.strictEqual(isTokenExpired(almostExpired, 60), true);

  // Fresh token: expires in 500 seconds, buffer 60 -> not expired
  const freshToken = new Date(Date.now() + 500 * 1000);
  assert.strictEqual(isTokenExpired(freshToken, 60), false);
});

test('3. exchangeCodeForTokens exchanges auth code for tokens', async () => {
  const mockFetch: typeof fetch = async (input, init) => {
    assert.strictEqual(input, 'https://oauth.zaloapp.com/v4/access_token');
    assert.strictEqual(init?.method, 'POST');
    assert.strictEqual((init?.headers as Record<string, string>)?.secret_key, 'my-secret-key');

    return {
      ok: true,
      json: async () => ({
        access_token: 'mock-access-token-123',
        refresh_token: 'mock-refresh-token-456',
        expires_in: 3600,
      }),
    } as unknown as Response;
  };

  const result = await exchangeCodeForTokens({
    appId: '123456789',
    secretKey: 'my-secret-key',
    code: 'oauth-code-abc',
    codeVerifier: 'verifier-xyz',
    fetchFn: mockFetch,
  });

  assert.strictEqual(result.access_token, 'mock-access-token-123');
  assert.strictEqual(result.refresh_token, 'mock-refresh-token-456');
  assert.strictEqual(result.expires_in, 3600);
  assert.ok(result.expiresAt instanceof Date);
});

test('4. exchangeCodeForTokens handles Zalo OAuth error response', async () => {
  const mockFetch: typeof fetch = async () => {
    return {
      ok: true,
      json: async () => ({
        error: -14002,
        message: 'Invalid authorization code',
        error_description: 'Code is expired or already used',
      }),
    } as unknown as Response;
  };

  await assert.rejects(
    async () => {
      await exchangeCodeForTokens({
        appId: '123456789',
        secretKey: 'my-secret-key',
        code: 'expired-code',
        fetchFn: mockFetch,
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof ZaloOAuthError);
      assert.strictEqual(err.code, -14002);
      assert.ok(err.message.includes('expired or already used'));
      return true;
    },
  );
});

test('5. refreshZaloAccessToken refreshes token successfully', async () => {
  const mockFetch: typeof fetch = async () => {
    return {
      ok: true,
      json: async () => ({
        access_token: 'refreshed-access-token-999',
        refresh_token: 'new-refresh-token-000',
        expires_in: '7200',
      }),
    } as unknown as Response;
  };

  const result = await refreshZaloAccessToken({
    appId: '123456789',
    secretKey: 'my-secret-key',
    refreshToken: 'old-refresh-token',
    fetchFn: mockFetch,
  });

  assert.strictEqual(result.access_token, 'refreshed-access-token-999');
  assert.strictEqual(result.refresh_token, 'new-refresh-token-000');
  assert.strictEqual(result.expires_in, 7200);
  assert.ok(result.expiresAt instanceof Date);
});

test('6. decryptPhoneNumberAes and encryptPhoneNumberAes roundtrip with AES-128-CBC', () => {
  const secretKey = '1234567890123456'; // 16 bytes
  const iv = 'abcdef0123456789'; // 16 bytes
  const phonePayload = { number: '84912345678' };

  const encrypted = encryptPhoneNumberAes({
    data: phonePayload,
    secretKey,
    iv,
    outputFormat: 'base64',
  });

  const decrypted = decryptPhoneNumberAes({
    encryptedData: encrypted,
    secretKey,
    iv,
  });

  assert.strictEqual(decrypted.phoneNumber, '0912345678');
  assert.strictEqual(decrypted.payload?.number, '84912345678');

  // Test with plain string encryption
  const plainEncrypted = encryptPhoneNumberAes({
    data: '0987654321',
    secretKey,
    iv,
  });
  const plainDecrypted = decryptPhoneNumberAes({
    encryptedData: plainEncrypted,
    secretKey,
    iv,
  });
  assert.strictEqual(plainDecrypted.phoneNumber, '0987654321');
});

test('7. fetchPhoneNumberFromZalo retrieves and normalizes phone number from OpenAPI', async () => {
  const mockFetch: typeof fetch = async (input, init) => {
    assert.strictEqual(input, 'https://graph.zalo.me/v2.0/me/info');
    const headers = init?.headers as Record<string, string>;
    assert.strictEqual(headers.access_token, 'mock-access-token');
    assert.strictEqual(headers.code, 'mini-app-phone-token');
    assert.strictEqual(headers.secret_key, 'app-secret');

    return {
      ok: true,
      json: async () => ({
        data: {
          number: '84988776655',
        },
        error: 0,
        message: 'Success',
      }),
    } as unknown as Response;
  };

  const result = await fetchPhoneNumberFromZalo({
    token: 'mini-app-phone-token',
    accessToken: 'mock-access-token',
    secretKey: 'app-secret',
    fetchFn: mockFetch,
  });

  assert.strictEqual(result.rawNumber, '84988776655');
  assert.strictEqual(result.phoneNumber, '0988776655');
});

test('8. normalizeVietnamesePhoneNumber and formatting handles diverse input variations', () => {
  assert.strictEqual(normalizeVietnamesePhoneNumber('+84912345678'), '0912345678');
  assert.strictEqual(normalizeVietnamesePhoneNumber('84912345678'), '0912345678');
  assert.strictEqual(normalizeVietnamesePhoneNumber('840912345678'), '0912345678');
  assert.strictEqual(normalizeVietnamesePhoneNumber('912345678'), '0912345678');
  assert.strictEqual(normalizeVietnamesePhoneNumber('0912 345 678'), '0912345678');
  assert.strictEqual(normalizeVietnamesePhoneNumber('0912-345-678'), '0912345678');
  assert.strictEqual(normalizeVietnamesePhoneNumber('0912.345.678'), '0912345678');

  assert.strictEqual(isValidVietnamesePhoneNumber('0912345678'), true);
  assert.strictEqual(isValidVietnamesePhoneNumber('0388123456'), true);
  assert.strictEqual(isValidVietnamesePhoneNumber('12345'), false);

  assert.strictEqual(formatVietnamesePhoneNumber('0912345678', 'national'), '0912 345 678');
  assert.strictEqual(formatVietnamesePhoneNumber('0912345678', 'dotted'), '0912.345.678');
  assert.strictEqual(formatVietnamesePhoneNumber('0912345678', 'international'), '+84912345678');
});

test('9. mapZaloOAuthToCustomerProfile maps OAuth profile to unified CustomerProfile DTO', () => {
  const rawOAuth = {
    id: 'zalo-user-9988',
    name: 'Nguyễn Văn A',
    picture: {
      data: {
        url: 'https://zalo.me/avatar/9988.jpg',
      },
    },
  };

  const profile = mapZaloOAuthToCustomerProfile(rawOAuth, {
    phoneNumber: '+84901234567',
    metadata: { role: 'CUSTOMER' },
  });

  assert.strictEqual(profile.zaloId, 'zalo-user-9988');
  assert.strictEqual(profile.name, 'Nguyễn Văn A');
  assert.strictEqual(profile.phoneNumber, '0901234567');
  assert.strictEqual(profile.avatar, 'https://zalo.me/avatar/9988.jpg');
  assert.strictEqual(profile.source, 'zalo_oauth');
  assert.strictEqual(profile.metadata?.role, 'CUSTOMER');
});

test('10. mapZaloMiniAppToCustomerProfile and mapToCustomerProfile map Mini App user info', () => {
  const miniAppInfo = {
    id: 'mini-user-7788',
    name: 'Trần Thị B',
    avatar: 'https://avatar.zalo.me/7788.png',
    idByOA: 'oa-user-12345',
    followedOA: true,
  };

  const profile = mapToCustomerProfile({
    source: 'zalo_mini_app',
    userInfo: miniAppInfo,
    phoneNumber: '84933445566',
    metadata: { appVersion: '2.1.0' },
  });

  assert.strictEqual(profile.zaloId, 'mini-user-7788');
  assert.strictEqual(profile.name, 'Trần Thị B');
  assert.strictEqual(profile.phoneNumber, '0933445566');
  assert.strictEqual(profile.avatar, 'https://avatar.zalo.me/7788.png');
  assert.strictEqual(profile.source, 'zalo_mini_app');
  assert.strictEqual(profile.metadata?.idByOA, 'oa-user-12345');
  assert.strictEqual(profile.metadata?.followedOA, true);
  assert.strictEqual(profile.metadata?.appVersion, '2.1.0');
});

test('11. Zod schemas validate correctly and reject invalid inputs', () => {
  // ZaloTokensSchema
  const validTokens = ZaloTokensSchema.parse({
    access_token: 'token-abc',
    refresh_token: 'refresh-xyz',
    expires_in: '3600',
  });
  assert.strictEqual(validTokens.expires_in, 3600);

  assert.throws(() => {
    ZaloTokensSchema.parse({
      access_token: '',
      expires_in: 3600,
    });
  });

  // ZaloPhonePayloadSchema
  const tokenPayload = ZaloPhonePayloadSchema.parse({ token: 'test-token' });
  assert.deepStrictEqual(tokenPayload, { token: 'test-token' });

  const directPayload = ZaloPhonePayloadSchema.parse({ number: '0912345678' });
  assert.deepStrictEqual(directPayload, { number: '0912345678' });

  // CustomerProfileSchema
  const validProfile = CustomerProfileSchema.parse({
    zaloId: 'z-123',
    name: 'Customer 1',
    phoneNumber: '0912345678',
    avatar: null,
    source: 'zalo_oauth',
  });
  assert.strictEqual(validProfile.zaloId, 'z-123');
});
