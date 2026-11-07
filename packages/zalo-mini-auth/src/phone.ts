import crypto from 'node:crypto';
import { normalizeVietnamesePhoneNumber } from './phone-utils';
import { ZaloPhoneResponseSchema } from './schemas';

export class ZaloPhoneDecryptionError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'ZaloPhoneDecryptionError';
  }
}

/**
 * Prepares a 16-byte key for AES-128
 */
export function prepareAes128Key(secretKey: string | Buffer): Buffer {
  if (Buffer.isBuffer(secretKey)) {
    if (secretKey.length === 16) return secretKey;
    if (secretKey.length > 16) return secretKey.subarray(0, 16);
    const padded = Buffer.alloc(16, 0);
    secretKey.copy(padded);
    return padded;
  }

  if (typeof secretKey === 'string') {
    // 32-character hexadecimal string represents exactly 16 bytes
    if (/^[0-9a-fA-F]{32}$/.test(secretKey)) {
      return Buffer.from(secretKey, 'hex');
    }
    const buf = Buffer.from(secretKey, 'utf8');
    if (buf.length === 16) return buf;
    if (buf.length > 16) return buf.subarray(0, 16);
    const padded = Buffer.alloc(16, 0);
    buf.copy(padded);
    return padded;
  }

  throw new ZaloPhoneDecryptionError('secretKey must be a string or Buffer');
}

/**
 * Prepares a 16-byte IV for AES-128-CBC
 */
export function prepareAes128Iv(iv?: string | Buffer): Buffer {
  if (!iv) {
    return Buffer.alloc(16, 0);
  }
  if (Buffer.isBuffer(iv)) {
    if (iv.length === 16) return iv;
    if (iv.length > 16) return iv.subarray(0, 16);
    const padded = Buffer.alloc(16, 0);
    iv.copy(padded);
    return padded;
  }
  if (typeof iv === 'string') {
    if (/^[0-9a-fA-F]{32}$/.test(iv)) {
      return Buffer.from(iv, 'hex');
    }
    const buf = Buffer.from(iv, 'utf8');
    if (buf.length === 16) return buf;
    if (buf.length > 16) return buf.subarray(0, 16);
    const padded = Buffer.alloc(16, 0);
    buf.copy(padded);
    return padded;
  }
  return Buffer.alloc(16, 0);
}

export interface DecryptPhoneNumberOptions {
  encryptedData: string | Buffer;
  secretKey: string | Buffer;
  iv?: string | Buffer;
}

export interface DecryptedPhoneResult {
  phoneNumber: string;
  rawText: string;
  payload?: Record<string, unknown>;
}

/**
 * Decrypts phone number encrypted by Zalo Mini App via AES-128-CBC.
 */
export function decryptPhoneNumberAes(
  options: DecryptPhoneNumberOptions,
): DecryptedPhoneResult {
  const { encryptedData, secretKey, iv } = options;

  if (!encryptedData) {
    throw new ZaloPhoneDecryptionError('encryptedData is required');
  }
  if (!secretKey) {
    throw new ZaloPhoneDecryptionError('secretKey is required');
  }

  try {
    const keyBuffer = prepareAes128Key(secretKey);
    const ivBuffer = prepareAes128Iv(iv);

    let cipherBuffer: Buffer;
    if (Buffer.isBuffer(encryptedData)) {
      cipherBuffer = encryptedData;
    } else if (typeof encryptedData === 'string') {
      // Check if it's hex or base64
      if (/^[0-9a-fA-F]+$/.test(encryptedData) && encryptedData.length % 2 === 0 && !encryptedData.includes('=')) {
        cipherBuffer = Buffer.from(encryptedData, 'hex');
      } else {
        cipherBuffer = Buffer.from(encryptedData, 'base64');
      }
    } else {
      throw new ZaloPhoneDecryptionError('Invalid encryptedData format');
    }

    const decipher = crypto.createDecipheriv('aes-128-cbc', keyBuffer, ivBuffer);
    decipher.setAutoPadding(true);

    const decrypted = Buffer.concat([decipher.update(cipherBuffer), decipher.final()]);
    const rawText = decrypted.toString('utf8');

    let payload: Record<string, unknown> | undefined;
    let extractedPhone = rawText;

    try {
      const parsed = JSON.parse(rawText) as Record<string, unknown>;
      payload = parsed;
      if (typeof parsed.number === 'string') {
        extractedPhone = parsed.number;
      } else if (typeof parsed.phone === 'string') {
        extractedPhone = parsed.phone;
      } else if (
        parsed.data &&
        typeof (parsed.data as Record<string, unknown>).number === 'string'
      ) {
        extractedPhone = (parsed.data as Record<string, unknown>).number as string;
      }
    } catch {
      // rawText is already a plain phone string
    }

    const phoneNumber = normalizeVietnamesePhoneNumber(extractedPhone);

    return {
      phoneNumber,
      rawText,
      payload,
    };
  } catch (err) {
    if (err instanceof ZaloPhoneDecryptionError) {
      throw err;
    }
    throw new ZaloPhoneDecryptionError(
      `Failed to decrypt AES-128-CBC phone data: ${(err as Error).message}`,
      err,
    );
  }
}

export interface EncryptPhoneNumberOptions {
  data: string | Record<string, unknown>;
  secretKey: string | Buffer;
  iv?: string | Buffer;
  outputFormat?: 'base64' | 'hex';
}

/**
 * Utility to encrypt phone number with AES-128-CBC (useful for mock testing or server-to-server payloads).
 */
export function encryptPhoneNumberAes(options: EncryptPhoneNumberOptions): string {
  const { data, secretKey, iv, outputFormat = 'base64' } = options;
  const keyBuffer = prepareAes128Key(secretKey);
  const ivBuffer = prepareAes128Iv(iv);

  const plainText = typeof data === 'string' ? data : JSON.stringify(data);
  const cipher = crypto.createCipheriv('aes-128-cbc', keyBuffer, ivBuffer);
  cipher.setAutoPadding(true);

  const encrypted = Buffer.concat([cipher.update(Buffer.from(plainText, 'utf8')), cipher.final()]);
  return outputFormat === 'hex' ? encrypted.toString('hex') : encrypted.toString('base64');
}

export interface FetchPhoneNumberFromZaloOptions {
  token: string;
  accessToken: string;
  secretKey: string;
  fetchFn?: typeof fetch;
}

/**
 * Fetches user phone number from Zalo OpenAPI (Mini App / OpenAPI getPhoneNumber endpoint).
 * Endpoint: https://graph.zalo.me/v2.0/me/info
 * Headers: access_token, code, secret_key
 */
export async function fetchPhoneNumberFromZalo(
  options: FetchPhoneNumberFromZaloOptions,
): Promise<{ rawNumber: string; phoneNumber: string }> {
  const { token, accessToken, secretKey, fetchFn = fetch } = options;

  if (!token || !accessToken || !secretKey) {
    throw new Error('token, accessToken, and secretKey are required to fetch phone number from Zalo');
  }

  const response = await fetchFn('https://graph.zalo.me/v2.0/me/info', {
    method: 'GET',
    headers: {
      access_token: accessToken,
      code: token,
      secret_key: secretKey,
    },
  });

  const json = (await response.json()) as Record<string, unknown>;
  const parsed = ZaloPhoneResponseSchema.parse(json);

  if (parsed.error && parsed.error !== 0) {
    throw new Error(
      `Zalo OpenAPI getPhoneNumber failed with error ${parsed.error}: ${parsed.message || 'Unknown error'}`,
    );
  }

  const rawNumber = parsed.data?.number || '';
  if (!rawNumber) {
    throw new Error('No phone number returned in Zalo OpenAPI response');
  }

  const phoneNumber = normalizeVietnamesePhoneNumber(rawNumber);

  return {
    rawNumber,
    phoneNumber,
  };
}
