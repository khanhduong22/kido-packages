import { z } from 'zod';

// ==========================================
// 1. Storage Provider Types
// ==========================================
export const StorageProviderSchema = z.enum(['cloudinary', 's3', 'r2', 'local-mock']);
export type StorageProvider = z.infer<typeof StorageProviderSchema>;

// ==========================================
// 2. Image Metadata & Validation Schemas
// ==========================================
export const ImageFormatSchema = z.enum(['jpeg', 'jpg', 'png', 'webp', 'avif', 'svg', 'gif']);
export type ImageFormat = z.infer<typeof ImageFormatSchema>;

export const ImageMetadataSchema = z.object({
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  aspectRatio: z.number().positive().optional(),
  format: z.string().optional(),
  size: z.number().int().nonnegative(),
  mimeType: z.string(),
  name: z.string().optional(),
});
export type ImageMetadata = z.infer<typeof ImageMetadataSchema>;

export const AspectRatioPresetSchema = z.enum(['1:1', '4:3', '16:9', '3:4', '9:16', '3:2', '2:3']);
export type AspectRatioPreset = z.infer<typeof AspectRatioPresetSchema>;

export const AspectRatioCheckResultSchema = z.object({
  matches: z.boolean(),
  actualRatio: z.number(),
  targetRatio: z.number(),
  tolerance: z.number(),
  difference: z.number(),
  label: z.string().optional(),
});
export type AspectRatioCheckResult = z.infer<typeof AspectRatioCheckResultSchema>;

export const ImageValidationOptionsSchema = z.object({
  maxSizeBytes: z.number().int().positive().default(5 * 1024 * 1024), // 5MB default
  allowedMimeTypes: z.array(z.string()).default(['image/jpeg', 'image/png', 'image/webp']),
  targetAspectRatio: z.union([AspectRatioPresetSchema, z.number().positive()]).optional(),
  aspectRatioTolerance: z.number().min(0).max(1).default(0.02), // 2% tolerance
});
export type ImageValidationOptions = z.infer<typeof ImageValidationOptionsSchema>;

export const ImageValidationResultSchema = z.object({
  valid: z.boolean(),
  errors: z.array(z.string()),
  metadata: ImageMetadataSchema.optional(),
  aspectRatioResult: AspectRatioCheckResultSchema.optional(),
});
export type ImageValidationResult = z.infer<typeof ImageValidationResultSchema>;

// ==========================================
// 3. Image Transformation Options
// ==========================================
export const ImageCropModeSchema = z.enum([
  'fill',
  'limit',
  'fit',
  'scale',
  'thumb',
  'crop',
  'pad',
]);
export type ImageCropMode = z.infer<typeof ImageCropModeSchema>;

export const ImageTransformOptionsSchema = z.object({
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  crop: ImageCropModeSchema.optional(),
  quality: z.union([z.literal('auto'), z.number().int().min(1).max(100)]).default('auto').optional(),
  format: z.union([z.literal('auto'), ImageFormatSchema]).default('webp').optional(),
  gravity: z.enum(['auto', 'center', 'face', 'faces', 'north', 'south', 'east', 'west']).optional(),
  dpr: z.union([z.literal('auto'), z.number().positive()]).optional(),
});
export type ImageTransformOptions = z.infer<typeof ImageTransformOptionsSchema>;

// ==========================================
// 4. Upload Options & Results
// ==========================================
export const UploadOptionsSchema = z.object({
  folder: z.string().optional(),
  fileName: z.string().optional(),
  tags: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  accessMode: z.enum(['public', 'private']).default('public').optional(),
  maxSizeBytes: z.number().positive().optional(),
  allowedMimeTypes: z.array(z.string()).optional(),
  contentType: z.string().optional(),
  transformation: ImageTransformOptionsSchema.optional(),
});
export type UploadOptions = z.infer<typeof UploadOptionsSchema>;

export const UploadResultSchema = z.object({
  url: z.string().url(),
  secureUrl: z.string().url(),
  key: z.string().min(1), // public_id for Cloudinary, Object Key for S3/R2
  provider: StorageProviderSchema,
  bytes: z.number().int().nonnegative(),
  format: z.string().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  createdAt: z.string(),
  metadata: z.record(z.string(), z.any()).optional(),
});
export type UploadResult = z.infer<typeof UploadResultSchema>;

// ==========================================
// 5. Provider Configuration Schemas
// ==========================================
export const CloudinaryConfigSchema = z.object({
  cloudName: z.string().min(1, 'Cloudinary cloudName is required'),
  apiKey: z.string().min(1, 'Cloudinary apiKey is required'),
  apiSecret: z.string().min(1, 'Cloudinary apiSecret is required'),
  uploadPreset: z.string().optional(),
  folder: z.string().optional(),
  secure: z.boolean().default(true).optional(),
});
export type CloudinaryConfig = z.infer<typeof CloudinaryConfigSchema>;

export const S3R2ConfigSchema = z.object({
  bucket: z.string().min(1, 'Bucket name is required'),
  endpoint: z.string().url('Endpoint must be a valid URL'),
  region: z.string().default('auto'), // 'auto' for Cloudflare R2
  accessKeyId: z.string().min(1, 'accessKeyId is required'),
  secretAccessKey: z.string().min(1, 'secretAccessKey is required'),
  publicUrlBase: z.string().url().optional(), // CDN / custom domain base URL
  forcePathStyle: z.boolean().default(true).optional(),
});
export type S3R2Config = z.infer<typeof S3R2ConfigSchema>;

export const LocalMockConfigSchema = z.object({
  baseUrl: z.string().default('http://localhost:3000/mock-storage').optional(),
  latencyMs: z.number().int().nonnegative().default(0).optional(),
});
export type LocalMockConfig = z.infer<typeof LocalMockConfigSchema>;

export const PresignedPutUrlResultSchema = z.object({
  url: z.string().url(),
  method: z.literal('PUT'),
  headers: z.record(z.string(), z.string()),
  key: z.string(),
  expiresAt: z.date().or(z.string()),
});
export type PresignedPutUrlResult = z.infer<typeof PresignedPutUrlResultSchema>;
