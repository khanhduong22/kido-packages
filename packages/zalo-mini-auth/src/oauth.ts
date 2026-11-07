import { ZaloTokens, ZaloTokensSchema } from './schemas';

export class ZaloOAuthError extends Error {
  public readonly code: number | string;
  public readonly details?: unknown;

  constructor(message: string, code: number | string = 'OAUTH_ERROR', details?: unknown) {
    super(message);
    this.name = 'ZaloOAuthError';
    this.code = code;
    this.details = details;
  }
}

export interface GetZaloLoginUrlOptions {
  appId: string;
  redirectUri: string;
  state?: string;
  codeChallenge?: string;
}

/**
 * Generates the official Zalo OAuth 2.0 authorization URL.
 */
export function getZaloLoginUrl(options: GetZaloLoginUrlOptions): string {
  const { appId, redirectUri, state, codeChallenge } = options;

  if (!appId) {
    throw new Error('appId is required to generate Zalo login URL');
  }
  if (!redirectUri) {
    throw new Error('redirectUri is required to generate Zalo login URL');
  }

  const url = new URL('https://oauth.zaloapp.com/v4/permission');
  url.searchParams.set('app_id', appId);
  url.searchParams.set('redirect_uri', redirectUri);

  if (state) {
    url.searchParams.set('state', state);
  }
  if (codeChallenge) {
    url.searchParams.set('code_challenge', codeChallenge);
  }

  return url.toString();
}

/**
 * Calculates absolute expiration Date from expiresIn (in seconds).
 */
export function calculateTokenExpiresAt(
  expiresInSeconds: number | string,
  fromDate: Date = new Date(),
): Date {
  const seconds = typeof expiresInSeconds === 'string' ? Number.parseInt(expiresInSeconds, 10) : expiresInSeconds;
  return new Date(fromDate.getTime() + seconds * 1000);
}

/**
 * Checks whether an access token is expired or close to expiring within a buffer window.
 * @param expiresAt Date or millisecond epoch timestamp when token expires
 * @param bufferSeconds Buffer window in seconds (default: 60s)
 */
export function isTokenExpired(expiresAt: Date | number, bufferSeconds = 60): boolean {
  const expirationMs = expiresAt instanceof Date ? expiresAt.getTime() : expiresAt;
  const nowMs = Date.now();
  const thresholdMs = expirationMs - bufferSeconds * 1000;
  return nowMs >= thresholdMs;
}

export interface ExchangeCodeOptions {
  appId: string;
  secretKey: string;
  code: string;
  codeVerifier?: string;
  redirectUri?: string;
  fetchFn?: typeof fetch;
}

export interface TokenExchangeResult extends ZaloTokens {
  expiresAt: Date;
}

/**
 * Exchanges authorization code for access_token and refresh_token.
 */
export async function exchangeCodeForTokens(
  options: ExchangeCodeOptions,
): Promise<TokenExchangeResult> {
  const { appId, secretKey, code, codeVerifier, fetchFn = fetch } = options;

  if (!appId || !secretKey || !code) {
    throw new Error('appId, secretKey, and code are required for token exchange');
  }

  const bodyParams = new URLSearchParams({
    app_id: appId,
    grant_type: 'authorization_code',
    code,
  });

  if (codeVerifier) {
    bodyParams.set('code_verifier', codeVerifier);
  }

  const response = await fetchFn('https://oauth.zaloapp.com/v4/access_token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      secret_key: secretKey,
    },
    body: bodyParams.toString(),
  });

  const data = (await response.json()) as Record<string, unknown>;

  if (data.error) {
    const errorMsg =
      (data.error_description as string) ||
      (data.message as string) ||
      `Zalo OAuth token exchange failed with code: ${data.error}`;
    throw new ZaloOAuthError(errorMsg, data.error as string | number, data);
  }

  const tokens = ZaloTokensSchema.parse(data);
  const expiresAt = calculateTokenExpiresAt(tokens.expires_in);

  return {
    ...tokens,
    expiresAt,
  };
}

export interface RefreshTokensOptions {
  appId: string;
  secretKey: string;
  refreshToken: string;
  fetchFn?: typeof fetch;
}

/**
 * Refreshes an expired access_token using a refresh_token.
 */
export async function refreshZaloAccessToken(
  options: RefreshTokensOptions,
): Promise<TokenExchangeResult> {
  const { appId, secretKey, refreshToken, fetchFn = fetch } = options;

  if (!appId || !secretKey || !refreshToken) {
    throw new Error('appId, secretKey, and refreshToken are required to refresh access token');
  }

  const bodyParams = new URLSearchParams({
    app_id: appId,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });

  const response = await fetchFn('https://oauth.zaloapp.com/v4/access_token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      secret_key: secretKey,
    },
    body: bodyParams.toString(),
  });

  const data = (await response.json()) as Record<string, unknown>;

  if (data.error) {
    const errorMsg =
      (data.error_description as string) ||
      (data.message as string) ||
      `Zalo OAuth token refresh failed with code: ${data.error}`;
    throw new ZaloOAuthError(errorMsg, data.error as string | number, data);
  }

  const tokens = ZaloTokensSchema.parse(data);
  const expiresAt = calculateTokenExpiresAt(tokens.expires_in);

  return {
    ...tokens,
    expiresAt,
  };
}
