import * as crypto from 'crypto';
import {
  CloudinaryConfig,
  CloudinaryConfigSchema,
  ImageTransformOptions,
  UploadOptions,
  UploadResult,
  UploadResultSchema,
} from '../types';
import { FileUploadInput, StorageAdapter } from './base';

// ==========================================
// 1. Signature & Transformation Helpers
// ==========================================

/**
 * Generates Cloudinary API signature according to official specification:
 * 1. Exclude 'file', 'cloud_name', 'resource_type', 'api_key'
 * 2. Sort keys alphabetically
 * 3. Serialize as 'key=value' separated by '&'
 * 4. Append api_secret directly at the end
 * 5. Compute SHA-1 digest
 */
export function generateCloudinarySignature(
  params: Record<string, string | number | boolean | undefined | null>,
  apiSecret: string
): string {
  const ignoredKeys = new Set(['file', 'cloud_name', 'resource_type', 'api_key']);

  const sortedPairs = Object.keys(params)
    .filter((key) => !ignoredKeys.has(key))
    .filter((key) => params[key] !== undefined && params[key] !== null && params[key] !== '')
    .sort()
    .map((key) => `${key}=${params[key]}`);

  const toSign = sortedPairs.join('&') + apiSecret;
  return crypto.createHash('sha1').update(toSign).digest('hex');
}

/**
 * Builds Cloudinary transformation string segment
 * e.g., 'c_fill,w_800,h_600,q_auto,f_webp'
 */
export function buildCloudinaryTransformString(options?: ImageTransformOptions): string {
  if (!options) return '';

  const parts: string[] = [];

  // Crop & Dimensions
  if (options.crop) {
    parts.push(`c_${options.crop}`);
  } else if (options.width || options.height) {
    parts.push('c_fill');
  }

  if (options.width) parts.push(`w_${options.width}`);
  if (options.height) parts.push(`h_${options.height}`);
  if (options.gravity) parts.push(`g_${options.gravity}`);

  // Quality & Format
  if (options.quality) {
    parts.push(`q_${options.quality}`);
  }
  if (options.format) {
    parts.push(`f_${options.format}`);
  }
  if (options.dpr) {
    parts.push(`dpr_${options.dpr}`);
  }

  return parts.join(',');
}

/**
 * Transforms an existing Cloudinary URL or publicId with desired transformations
 */
export function transformCloudinaryUrl(
  urlOrPublicId: string,
  options: ImageTransformOptions,
  cloudName?: string
): string {
  const transformStr = buildCloudinaryTransformString(options);
  if (!transformStr) return urlOrPublicId;

  // Case 1: Already a full Cloudinary URL
  if (urlOrPublicId.includes('res.cloudinary.com')) {
    const uploadIndex = urlOrPublicId.indexOf('/upload/');
    if (uploadIndex !== -1) {
      const prefix = urlOrPublicId.slice(0, uploadIndex + '/upload/'.length);
      const suffix = urlOrPublicId.slice(uploadIndex + '/upload/'.length);
      return `${prefix}${transformStr}/${suffix}`;
    }
  }

  // Case 2: Public ID provided
  if (!cloudName) {
    throw new Error('cloudName is required when transforming a publicId into a Cloudinary URL');
  }

  const cleanPublicId = urlOrPublicId.replace(/^\/+/, '');
  return `https://res.cloudinary.com/${cloudName}/image/upload/${transformStr}/${cleanPublicId}`;
}

// ==========================================
// 2. Cloudinary Adapter Implementation
// ==========================================

export interface CloudinaryAdapterOptions {
  config: CloudinaryConfig;
  fetchFn?: typeof fetch;
}

export class CloudinaryAdapter implements StorageAdapter {
  readonly provider = 'cloudinary' as const;
  private readonly config: CloudinaryConfig;
  private readonly fetchFn: typeof fetch;

  constructor(options: CloudinaryAdapterOptions | CloudinaryConfig) {
    if ('config' in options) {
      this.config = CloudinaryConfigSchema.parse(options.config);
      this.fetchFn = options.fetchFn ?? globalThis.fetch;
    } else {
      this.config = CloudinaryConfigSchema.parse(options);
      this.fetchFn = globalThis.fetch;
    }
  }

  /**
   * Generates signature and required payload for direct client upload
   */
  generateUploadSignature(extraParams: Record<string, string | number | boolean> = {}): {
    signature: string;
    timestamp: number;
    apiKey: string;
    cloudName: string;
    folder?: string;
    params: Record<string, any>;
  } {
    const timestamp = Math.floor(Date.now() / 1000);
    const params: Record<string, any> = {
      timestamp,
      ...extraParams,
    };

    if (this.config.folder && !params.folder) {
      params.folder = this.config.folder;
    }

    const signature = generateCloudinarySignature(params, this.config.apiSecret);

    return {
      signature,
      timestamp,
      apiKey: this.config.apiKey,
      cloudName: this.config.cloudName,
      folder: params.folder,
      params,
    };
  }

  /**
   * Uploads file directly to Cloudinary API
   */
  async upload(file: FileUploadInput, options?: UploadOptions): Promise<UploadResult> {
    const timestamp = Math.floor(Date.now() / 1000);
    const signParams: Record<string, any> = {
      timestamp,
    };

    const targetFolder = options?.folder ?? this.config.folder;
    if (targetFolder) signParams.folder = targetFolder;
    if (options?.fileName) signParams.public_id = options.fileName;
    if (options?.tags && options.tags.length > 0) signParams.tags = options.tags.join(',');

    const signature = generateCloudinarySignature(signParams, this.config.apiSecret);

    const formData = new FormData();
    formData.append('api_key', this.config.apiKey);
    formData.append('timestamp', timestamp.toString());
    formData.append('signature', signature);

    if (signParams.folder) formData.append('folder', signParams.folder);
    if (signParams.public_id) formData.append('public_id', signParams.public_id);
    if (signParams.tags) formData.append('tags', signParams.tags);
    if (this.config.uploadPreset) formData.append('upload_preset', this.config.uploadPreset);

    // Append File / Blob / Buffer / string
    if (typeof file === 'string') {
      formData.append('file', file);
    } else if (file instanceof Blob) {
      formData.append('file', file);
    } else if (Buffer.isBuffer(file) || file instanceof Uint8Array) {
      const mime = options?.contentType || 'application/octet-stream';
      const blob = new Blob([file as any], { type: mime });
      formData.append('file', blob);
    } else {
      formData.append('file', file as any);
    }

    const uploadUrl = `https://api.cloudinary.com/v1_1/${this.config.cloudName}/image/upload`;
    const response = await this.fetchFn(uploadUrl, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Cloudinary upload failed (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as any;

    const result: UploadResult = {
      url: data.url,
      secureUrl: data.secure_url || data.url,
      key: data.public_id,
      provider: 'cloudinary',
      bytes: data.bytes ?? 0,
      format: data.format,
      width: data.width,
      height: data.height,
      createdAt: data.created_at || new Date().toISOString(),
      metadata: {
        etag: data.etag,
        resourceType: data.resource_type,
        version: data.version,
      },
    };

    return UploadResultSchema.parse(result);
  }

  /**
   * Get public transformed URL
   */
  getPublicUrl(key: string, transform?: ImageTransformOptions): string {
    const baseUrl = `https://res.cloudinary.com/${this.config.cloudName}/image/upload`;
    const transformStr = buildCloudinaryTransformString(transform);

    const cleanKey = key.replace(/^\/+/, '');
    if (transformStr) {
      return `${baseUrl}/${transformStr}/${cleanKey}`;
    }
    return `${baseUrl}/${cleanKey}`;
  }
}
