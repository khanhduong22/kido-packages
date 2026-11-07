import * as crypto from 'node:crypto';
import {
  GuestAccessPass,
  GuestAccessPassSchema,
  RateLimitStatus,
  TokenGenerationOptions,
} from './types';

/**
 * In-memory Sliding Window Rate Limiter to prevent brute-force attacks on guest QR codes
 */
export class RateLimiter {
  private attempts = new Map<string, { count: number; firstAttemptAt: number; blockedUntil?: number }>();

  constructor(
    private readonly maxAttempts: number = 5,
    private readonly windowMs: number = 60_000,
    private readonly blockDurationMs: number = 300_000
  ) {}

  public check(key: string): RateLimitStatus {
    const now = Date.now();
    const record = this.attempts.get(key);

    if (!record) {
      return {
        isBlocked: false,
        remainingAttempts: this.maxAttempts,
        retryAfterSeconds: 0,
      };
    }

    // Check if currently blocked
    if (record.blockedUntil && record.blockedUntil > now) {
      const retryAfterSeconds = Math.ceil((record.blockedUntil - now) / 1000);
      return {
        isBlocked: true,
        remainingAttempts: 0,
        retryAfterSeconds,
      };
    }

    // Reset window if expired
    if (now - record.firstAttemptAt > this.windowMs) {
      this.attempts.delete(key);
      return {
        isBlocked: false,
        remainingAttempts: this.maxAttempts,
        retryAfterSeconds: 0,
      };
    }

    const remaining = Math.max(0, this.maxAttempts - record.count);
    return {
      isBlocked: record.count >= this.maxAttempts,
      remainingAttempts: remaining,
      retryAfterSeconds: record.count >= this.maxAttempts ? Math.ceil(this.blockDurationMs / 1000) : 0,
    };
  }

  public recordFailure(key: string): RateLimitStatus {
    const now = Date.now();
    let record = this.attempts.get(key);

    if (!record || now - record.firstAttemptAt > this.windowMs) {
      record = { count: 1, firstAttemptAt: now };
    } else {
      record.count += 1;
    }

    if (record.count >= this.maxAttempts) {
      record.blockedUntil = now + this.blockDurationMs;
    }

    this.attempts.set(key, record);
    return this.check(key);
  }

  public reset(key: string): void {
    this.attempts.delete(key);
  }

  public clearAll(): void {
    this.attempts.clear();
  }
}

/**
 * Token Manager for generating & cryptographically verifying short QR guest access passes
 */
export class TokenManager {
  private readonly defaultSecret: string;
  private readonly defaultPrefix: string;
  private readonly rateLimiter: RateLimiter;
  private readonly passStore = new Map<string, GuestAccessPass>();

  constructor(options?: {
    secretKey?: string;
    shortUrlPrefix?: string;
    maxVerificationAttempts?: number;
    rateLimitWindowMs?: number;
    blockDurationMs?: number;
  }) {
    this.defaultSecret = options?.secretKey || process.env.GALLERY_HMAC_SECRET || 'tred-photobooth-secret-2026';
    this.defaultPrefix = options?.shortUrlPrefix || 'https://tr.vn/g';
    this.rateLimiter = new RateLimiter(
      options?.maxVerificationAttempts ?? 5,
      options?.rateLimitWindowMs ?? 60_000,
      options?.blockDurationMs ?? 300_000
    );
  }

  /**
   * Generates a tamper-proof cryptographic signature for a pass
   */
  public generateSignature(
    payload: {
      eventId: string;
      guestId?: string;
      tableNumber?: string;
      expiresAt: string | Date;
      shortCode: string;
    },
    secretKey?: string
  ): string {
    const secret = secretKey || this.defaultSecret;
    const expStr = payload.expiresAt instanceof Date ? payload.expiresAt.toISOString() : payload.expiresAt;
    const raw = `${payload.eventId}:${payload.guestId || ''}:${payload.tableNumber || ''}:${expStr}:${payload.shortCode}`;
    return crypto.createHmac('sha256', secret).update(raw).digest('hex').substring(0, 16);
  }

  /**
   * Generates a new personalized GuestAccessPass with shortCode and K80 QR Payload
   */
  public createGuestPass(options: TokenGenerationOptions): GuestAccessPass {
    const ttlSeconds = options.ttlSeconds ?? 7 * 24 * 3600; // 7 days default
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + ttlSeconds * 1000);

    // Short ID: v7_ followed by 8 high-entropy alphanumeric chars
    const randomSuffix = crypto.randomBytes(4).toString('hex');
    const shortCode = `v7_${randomSuffix}`;

    const prefix = options.shortUrlPrefix || this.defaultPrefix;
    const cleanPrefix = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
    const fullShortUrl = `${cleanPrefix}/${shortCode}`;

    // Cryptographic signature
    const signature = this.generateSignature(
      {
        eventId: options.eventId,
        guestId: options.guestId,
        tableNumber: options.tableNumber,
        expiresAt,
        shortCode,
      },
      options.secretKey
    );

    const tokenId = `pass_${crypto.randomUUID()}`;
    // QR Payload embeds short URL with print source tag for K80 photobooth thermal printers
    const qrPayload = `${fullShortUrl}?sig=${signature}&src=k80_print`;

    const pass: GuestAccessPass = {
      tokenId,
      shortCode,
      fullShortUrl,
      eventId: options.eventId,
      guestId: options.guestId,
      tableNumber: options.tableNumber,
      accessTier: 'PREVIEW_LOCKED',
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      leadCaptured: false,
      qrPayload,
    };

    // Validate with Zod before storing
    const validated = GuestAccessPassSchema.parse(pass);
    this.passStore.set(validated.shortCode, validated);
    this.passStore.set(validated.tokenId, validated);

    return validated;
  }

  /**
   * Verifies pass validity, checks expiration, signature integrity and rate-limits brute force attempts
   */
  public verifyPass(
    pass: GuestAccessPass,
    options?: {
      clientIdentifier?: string; // IP or device fingerprint for rate limiting
      signature?: string;
      secretKey?: string;
    }
  ): {
    isValid: boolean;
    pass?: GuestAccessPass;
    error?: string;
    rateLimitStatus?: RateLimitStatus;
  } {
    const rateLimitKey = options?.clientIdentifier || pass.shortCode;
    const rateCheck = this.rateLimiter.check(rateLimitKey);

    if (rateCheck.isBlocked) {
      return {
        isValid: false,
        error: `Quá nhiều lần thử truy cập sai. Vui lòng thử lại sau ${rateCheck.retryAfterSeconds} giây.`,
        rateLimitStatus: rateCheck,
      };
    }

    // Check expiration
    const now = Date.now();
    const expiryTime = new Date(pass.expiresAt).getTime();
    if (now > expiryTime) {
      this.rateLimiter.recordFailure(rateLimitKey);
      return {
        isValid: false,
        error: 'Mã QR truy cập đã hết hạn (Gallery TTL expired). Vui lòng liên hệ ban tổ chức.',
        rateLimitStatus: this.rateLimiter.check(rateLimitKey),
      };
    }

    // If signature provided, verify cryptographic authenticity
    if (options?.signature) {
      const expectedSig = this.generateSignature(
        {
          eventId: pass.eventId,
          guestId: pass.guestId,
          tableNumber: pass.tableNumber,
          expiresAt: pass.expiresAt,
          shortCode: pass.shortCode,
        },
        options.secretKey
      );

      // Constant time comparison to prevent timing attacks
      const expectedBuffer = Buffer.from(expectedSig);
      const actualBuffer = Buffer.from(options.signature);

      if (
        expectedBuffer.length !== actualBuffer.length ||
        !crypto.timingSafeEqual(expectedBuffer, actualBuffer)
      ) {
        const failureStatus = this.rateLimiter.recordFailure(rateLimitKey);
        return {
          isValid: false,
          error: 'Chữ ký mã QR không hợp lệ hoặc đã bị can thiệp.',
          rateLimitStatus: failureStatus,
        };
      }
    }

    // Successful check
    this.rateLimiter.reset(rateLimitKey);
    return {
      isValid: true,
      pass,
    };
  }

  /**
   * Retrieve a pass from in-memory store by shortCode or tokenId
   */
  public getPass(codeOrToken: string): GuestAccessPass | undefined {
    return this.passStore.get(codeOrToken);
  }

  /**
   * Save or update an existing pass
   */
  public updatePass(pass: GuestAccessPass): void {
    const validated = GuestAccessPassSchema.parse(pass);
    this.passStore.set(validated.shortCode, validated);
    this.passStore.set(validated.tokenId, validated);
  }

  /**
   * Get direct reference to the internal rate limiter for tests/custom policies
   */
  public getRateLimiter(): RateLimiter {
    return this.rateLimiter;
  }
}

/**
 * Convenient standalone generator matching the PACKAGES_REGISTRY core export
 */
export function generateGuestQrToken(
  eventId: string,
  guestId?: string,
  tableNumber?: string,
  options?: Partial<TokenGenerationOptions>
): GuestAccessPass {
  const manager = new TokenManager({
    secretKey: options?.secretKey,
    shortUrlPrefix: options?.shortUrlPrefix,
  });
  return manager.createGuestPass({
    eventId,
    guestId,
    tableNumber,
    ...options,
  });
}
