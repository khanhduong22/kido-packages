import * as crypto from 'node:crypto';
import {
  AccessTier,
  GuestAccessPass,
  MediaItem,
  PresignedDownloadResult,
  PresignedDownloadResultSchema,
} from './types';

export class UnauthorizedTierError extends Error {
  constructor(message: string = 'Khách chưa mở khóa quyền tải file 4K. Vui lòng nhập thông tin để tiếp tục!') {
    super(message);
    this.name = 'UnauthorizedTierError';
  }
}

export interface StorageSignerConfig {
  signingSecret?: string;
  cdnBaseUrl?: string; // e.g. https://cdn.tred.vn
  s3Bucket?: string;
  defaultPreviewTtlSeconds?: number; // 1800s (30m)
  default4kTtlSeconds?: number; // 3600s (1h)
}

export interface DownloadUrlOptions {
  requestedTier?: AccessTier;
  expiresInSeconds?: number;
  customFileName?: string;
  forceAttachment?: boolean;
}

/**
 * Cloudflare R2 / AWS S3 Presigned URL Signer for Event Media
 */
export class StorageSigner {
  private readonly secret: string;
  private readonly cdnBaseUrl?: string;
  private readonly defaultPreviewTtl: number;
  private readonly default4kTtl: number;

  constructor(config?: StorageSignerConfig) {
    this.secret = config?.signingSecret || process.env.STORAGE_SIGNING_SECRET || 'tred-r2-signer-salt-2026';
    this.cdnBaseUrl = config?.cdnBaseUrl;
    this.defaultPreviewTtl = config?.defaultPreviewTtlSeconds || 1800;
    this.default4kTtl = config?.default4kTtlSeconds || 3600;
  }

  /**
   * Generates a tamper-proof HMAC token for presigned download
   */
  public createSignedUrl(
    targetUrl: string,
    tier: AccessTier,
    expiresInSeconds: number,
    dispositionFileName: string,
    isAttachment: boolean
  ): string {
    const urlObj = new URL(targetUrl, this.cdnBaseUrl || 'https://cdn.tred.vn');
    const expiresAt = Math.floor(Date.now() / 1000) + expiresInSeconds;

    const disposition = isAttachment
      ? `attachment; filename="${encodeURIComponent(dispositionFileName)}"`
      : `inline; filename="${encodeURIComponent(dispositionFileName)}"`;

    urlObj.searchParams.set('tier', tier);
    urlObj.searchParams.set('exp', expiresAt.toString());
    urlObj.searchParams.set('disposition', disposition);

    // Cryptographic signature over pathname, tier, expires and disposition
    const stringToSign = `${urlObj.pathname}|${tier}|${expiresAt}|${disposition}`;
    const signature = crypto.createHmac('sha256', this.secret).update(stringToSign).digest('hex');

    urlObj.searchParams.set('sig', signature);
    return urlObj.toString();
  }

  /**
   * Verifies if a signed URL signature is authentic and not expired
   */
  public verifySignedUrl(urlStr: string): { isValid: boolean; error?: string } {
    try {
      const url = new URL(urlStr);
      const tier = url.searchParams.get('tier');
      const expStr = url.searchParams.get('exp');
      const disposition = url.searchParams.get('disposition');
      const sig = url.searchParams.get('sig');

      if (!tier || !expStr || !disposition || !sig) {
        return { isValid: false, error: 'Thiếu tham số chữ ký URL presigned' };
      }

      const expiresAt = parseInt(expStr, 10);
      if (Math.floor(Date.now() / 1000) > expiresAt) {
        return { isValid: false, error: 'Link tải đã hết hạn sử dụng' };
      }

      const stringToSign = `${url.pathname}|${tier}|${expiresAt}|${disposition}`;
      const expectedSig = crypto.createHmac('sha256', this.secret).update(stringToSign).digest('hex');

      const expectedBuf = Buffer.from(expectedSig);
      const actualBuf = Buffer.from(sig);

      if (expectedBuf.length !== actualBuf.length || !crypto.timingSafeEqual(expectedBuf, actualBuf)) {
        return { isValid: false, error: 'Chữ ký presigned URL không chính xác' };
      }

      return { isValid: true };
    } catch {
      return { isValid: false, error: 'URL không đúng định dạng' };
    }
  }

  /**
   * Generates download URL respecting guest access tier:
   * - PREVIEW_LOCKED: Returns 720p watermarked WebP / preview MP4
   * - UNLOCKED_4K: Returns raw 4K 240fps MP4 or 24MP JPEG
   */
  public generateDownloadUrl(
    mediaItem: MediaItem,
    passOrTier: GuestAccessPass | AccessTier,
    options?: DownloadUrlOptions
  ): PresignedDownloadResult {
    let effectiveTier: AccessTier;

    if (typeof passOrTier === 'string') {
      effectiveTier = passOrTier;
    } else {
      effectiveTier = passOrTier.accessTier;
    }

    // Check if caller explicitly requested 4K but pass/tier is only PREVIEW_LOCKED
    if (options?.requestedTier === 'UNLOCKED_4K' && effectiveTier === 'PREVIEW_LOCKED') {
      throw new UnauthorizedTierError(
        'Khách chưa mở khóa quyền tải file 4K. Vui lòng nhập thông tin để mở khóa!'
      );
    }

    const is4K = effectiveTier === 'UNLOCKED_4K';
    const targetUrl = is4K ? mediaItem.originalUrl : mediaItem.previewUrl;
    const isWatermarked = !is4K;

    // Determine filename
    let extension: string;
    let contentType: string;

    if (mediaItem.type === 'VIDEO_240FPS') {
      extension = 'mp4';
      contentType = 'video/mp4';
    } else if (mediaItem.type === 'GIF_BOOMERANG') {
      extension = is4K ? 'mp4' : 'gif';
      contentType = is4K ? 'video/mp4' : 'image/gif';
    } else {
      // PHOTO
      extension = is4K ? 'jpg' : 'webp';
      contentType = is4K ? 'image/jpeg' : 'image/webp';
    }

    const defaultFileName = is4K
      ? `T-RED_${mediaItem.type === 'VIDEO_240FPS' ? 'Glambot_4K_240fps' : 'Photobooth_24MP'}_${mediaItem.id}.${extension}`
      : `preview_watermarked_${mediaItem.id}.${extension}`;

    const fileName = options?.customFileName || defaultFileName;
    const expiresInSeconds =
      options?.expiresInSeconds || (is4K ? this.default4kTtl : this.defaultPreviewTtl);
    const forceAttachment = options?.forceAttachment ?? is4K;

    const signedUrl = this.createSignedUrl(
      targetUrl,
      effectiveTier,
      expiresInSeconds,
      fileName,
      forceAttachment
    );

    const result: PresignedDownloadResult = {
      url: signedUrl,
      tier: effectiveTier,
      expiresInSeconds,
      fileName,
      contentType,
      isWatermarked,
      fileSizeBytes: is4K ? mediaItem.fileSizeBytes : Math.round(mediaItem.fileSizeBytes * 0.15),
    };

    return PresignedDownloadResultSchema.parse(result);
  }
}

/**
 * Standalone generateDownloadUrl function matching PACKAGES_REGISTRY core export
 */
export function generateDownloadUrl(
  mediaItem: MediaItem,
  passOrTier: GuestAccessPass | AccessTier,
  options?: DownloadUrlOptions
): PresignedDownloadResult {
  const signer = new StorageSigner();
  return signer.generateDownloadUrl(mediaItem, passOrTier, options);
}
