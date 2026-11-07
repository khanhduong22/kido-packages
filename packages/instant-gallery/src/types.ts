import { z } from 'zod';

/**
 * Supported Media Types captured by Glambot 360 & Photobooth hardware
 */
export const MediaTypeSchema = z.enum(['PHOTO', 'VIDEO_240FPS', 'GIF_BOOMERANG']);
export type MediaType = z.infer<typeof MediaTypeSchema>;

/**
 * Access Tier:
 * - PREVIEW_LOCKED: WebP 720p with visible watermark / overlay banner
 * - UNLOCKED_4K: Raw uncompressed 4K 240fps MP4 or 24MP JPEG
 */
export const AccessTierSchema = z.enum(['PREVIEW_LOCKED', 'UNLOCKED_4K']);
export type AccessTier = z.infer<typeof AccessTierSchema>;

/**
 * Supported Social Sharing Platforms
 */
export const SharePlatformSchema = z.enum([
  'TIKTOK',
  'INSTAGRAM_REELS',
  'FACEBOOK_STORY',
  'ZALO',
  'SYSTEM_SHARE',
]);
export type SharePlatform = z.infer<typeof SharePlatformSchema>;

/**
 * Watermark / Overlay Placement Positions
 */
export const WatermarkPositionSchema = z.enum([
  'TOP_LEFT',
  'TOP_RIGHT',
  'BOTTOM_LEFT',
  'BOTTOM_RIGHT',
  'CENTER',
  'REPEATING_DIAGONAL',
]);
export type WatermarkPosition = z.infer<typeof WatermarkPositionSchema>;

/**
 * Watermark & Branded Frame Configuration
 */
export const WatermarkConfigSchema = z.object({
  text: z.string().default('T-RED Media • fotobooth.vn'),
  logoUrl: z.string().url().optional(),
  brandedFrameUrl: z.string().url().optional(),
  sponsorLogoUrl: z.string().url().optional(),
  coupleNames: z.string().optional(),
  eventHashtag: z.string().optional(),
  opacity: z.number().min(0).max(1).default(0.4),
  position: WatermarkPositionSchema.default('CENTER'),
  safeZoneMarginPx: z.number().nonnegative().default(64),
});
export type WatermarkConfig = z.infer<typeof WatermarkConfigSchema>;

/**
 * Sponsor & Brand Banner for Gallery Header / Footer / Gate Modal
 */
export const SponsorBannerSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  logoUrl: z.string().url(),
  targetUrl: z.string().url().optional(),
  callToAction: z.string().optional(),
  displayPlacement: z.enum(['HEADER', 'FOOTER', 'MODAL_GATE', 'INTERSTITIAL']).default('HEADER'),
});
export type SponsorBanner = z.infer<typeof SponsorBannerSchema>;

/**
 * Aspect Ratio for Media
 */
export const AspectRatioSchema = z.enum(['9:16', '16:9', '1:1', '4:3', '3:4']);
export type AspectRatio = z.infer<typeof AspectRatioSchema>;

/**
 * Resolution Spec
 */
export const ResolutionSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type Resolution = z.infer<typeof ResolutionSchema>;

/**
 * Single Media Item in Event Gallery
 */
export const MediaItemSchema = z.object({
  id: z.string().min(1),
  eventId: z.string().min(1),
  type: MediaTypeSchema,
  title: z.string().optional(),
  aspectRatio: AspectRatioSchema.default('9:16'),
  previewUrl: z.string().url(),
  originalUrl: z.string().url(),
  thumbnailUrl: z.string().url(),
  durationSeconds: z.number().nonnegative().optional(),
  fileSizeBytes: z.number().int().nonnegative(),
  resolution: ResolutionSchema,
  fps: z.number().int().positive().optional(),
  capturedAt: z.union([z.string(), z.date()]),
  assignedGuestId: z.string().optional(),
  assignedTable: z.string().optional(),
  watermarkConfig: WatermarkConfigSchema.optional(),
  downloadCount: z.number().int().nonnegative().default(0),
});
export type MediaItem = z.infer<typeof MediaItemSchema>;

/**
 * Event Gallery Schema
 */
export const EventGallerySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  brand: z.enum(['T_RED_MEDIA', 'T_RED_PHOTOBOOTH', 'CO_BRANDED']).default('T_RED_MEDIA'),
  customDomain: z.string().optional(),
  shortUrlPrefix: z.string().default('tr.vn/g'),
  startDate: z.union([z.string(), z.date()]),
  endDate: z.union([z.string(), z.date()]),
  isActive: z.boolean().default(true),
  allowGuestUpload: z.boolean().default(false),
  requireLeadCapture: z.boolean().default(true),
  sponsorBanners: z.array(SponsorBannerSchema).default([]),
  defaultWatermark: WatermarkConfigSchema.default({}),
  totalGuests: z.number().int().nonnegative().optional(),
  totalMediaCount: z.number().int().nonnegative().optional(),
});
export type EventGallery = z.infer<typeof EventGallerySchema>;

/**
 * Guest Access Pass Schema
 */
export const GuestAccessPassSchema = z.object({
  tokenId: z.string().min(1),
  shortCode: z.string().min(1),
  fullShortUrl: z.string().url(),
  eventId: z.string().min(1),
  guestId: z.string().optional(),
  tableNumber: z.string().optional(),
  accessTier: AccessTierSchema.default('PREVIEW_LOCKED'),
  issuedAt: z.union([z.string(), z.date()]),
  expiresAt: z.union([z.string(), z.date()]),
  leadCaptured: z.boolean().default(false),
  capturedLeadId: z.string().optional(),
  qrPayload: z.string().min(1),
});
export type GuestAccessPass = z.infer<typeof GuestAccessPassSchema>;

/**
 * Vietnam Phone Number Validator Regex:
 * Supports:
 * - 03x, 05x, 07x, 08x, 09x (10 digits)
 * - +84 prefix (+843x, +845x, +847x, +848x, +849x)
 */
export const VIETNAM_PHONE_REGEX = /^(0|\+84)(3[2-9]|5[25689]|7[06-9]|8[1-9]|9[0-9])[0-9]{7}$/;

/**
 * Lead Capture Submission Schema
 */
export const LeadCaptureSubmissionSchema = z.object({
  fullName: z
    .string()
    .trim()
    .min(2, 'Họ và tên phải có ít nhất 2 ký tự')
    .max(100, 'Họ và tên không được vượt quá 100 ký tự'),
  phoneNumber: z
    .string()
    .trim()
    .transform((val) => {
      let cleaned = val.replace(/[\s\-\.\(\)]/g, '');
      if (cleaned.startsWith('+84')) {
        cleaned = '0' + cleaned.slice(3);
      } else if (cleaned.startsWith('84') && cleaned.length === 11) {
        cleaned = '0' + cleaned.slice(2);
      }
      return cleaned;
    })
    .pipe(
      z
        .string()
        .regex(VIETNAM_PHONE_REGEX, 'Số điện thoại không đúng định dạng di động Việt Nam (10 số, đầu 03/05/07/08/09)')
    ),
  email: z
    .string()
    .trim()
    .email('Địa chỉ email không hợp lệ'),
  company: z.string().trim().max(120).optional(),
  jobTitle: z.string().trim().max(80).optional(),
  consentMarketing: z
    .boolean()
    .refine((val) => val === true, 'Quý khách vui lòng đồng ý điều khoản để nhận file 4K không nén'),
  notes: z.string().trim().max(500).optional(),
  submittedAt: z.union([z.string(), z.date()]).optional(),
});
export type LeadCaptureSubmission = z.infer<typeof LeadCaptureSubmissionSchema>;

/**
 * Persisted Captured Lead Record
 */
export const CapturedLeadRecordSchema = z.object({
  id: z.string().min(1),
  eventId: z.string().min(1),
  guestPassTokenId: z.string().min(1),
  leadData: LeadCaptureSubmissionSchema,
  clientIp: z.string().optional(),
  userAgent: z.string().optional(),
  unlockedMediaIds: z.array(z.string()).default([]),
  createdAt: z.union([z.string(), z.date()]),
});
export type CapturedLeadRecord = z.infer<typeof CapturedLeadRecordSchema>;

/**
 * Presigned Download Result
 */
export const PresignedDownloadResultSchema = z.object({
  url: z.string().url(),
  tier: AccessTierSchema,
  expiresInSeconds: z.number().int().positive(),
  fileName: z.string().min(1),
  contentType: z.string().min(1),
  isWatermarked: z.boolean(),
  fileSizeBytes: z.number().int().nonnegative().optional(),
});
export type PresignedDownloadResult = z.infer<typeof PresignedDownloadResultSchema>;

export const PlatformShareDetailSchema = z.object({
  shareUrl: z.string(),
  caption: z.string(),
});
export type PlatformShareDetail = z.infer<typeof PlatformShareDetailSchema>;

export const SocialSharePayloadSchema = z.object({
  title: z.string().min(1),
  description: z.string(),
  openGraphUrl: z.string().url(),
  ogImageUrl: z.string().url(),
  ogVideoUrl: z.string().url().optional(),
  hashtags: z.array(z.string()),
  storyAssetUrl: z.string().url(),
  platformTargets: z.record(SharePlatformSchema, PlatformShareDetailSchema),
});
export type SocialSharePayload = Omit<z.infer<typeof SocialSharePayloadSchema>, 'platformTargets'> & {
  platformTargets: Record<SharePlatform, PlatformShareDetail>;
};

/**
 * Result of Lead Gate validation & unlocking
 */
export interface LeadGateResult {
  success: boolean;
  accessTier: AccessTier;
  updatedPass: GuestAccessPass;
  leadRecord?: CapturedLeadRecord;
  error?: string;
  fieldErrors?: Record<string, string>;
}

/**
 * Options for Token Generator
 */
export interface TokenGenerationOptions {
  eventId: string;
  guestId?: string;
  tableNumber?: string;
  ttlSeconds?: number; // default: 7 days
  shortUrlPrefix?: string; // default: 'https://tr.vn/g'
  secretKey?: string;
}

/**
 * Rate Limit Inspection Result
 */
export interface RateLimitStatus {
  isBlocked: boolean;
  remainingAttempts: number;
  retryAfterSeconds: number;
}
