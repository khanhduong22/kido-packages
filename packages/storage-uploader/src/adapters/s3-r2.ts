import * as crypto from 'crypto';
import {
  ImageTransformOptions,
  PresignedPutUrlResult,
  PresignedPutUrlResultSchema,
  S3R2Config,
  S3R2ConfigSchema,
  UploadOptions,
  UploadResult,
  UploadResultSchema,
} from '../types';
import { FileUploadInput, StorageAdapter } from './base';

// ==========================================
// 1. AWS SigV4 Helpers
// ==========================================

function sha256Hex(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hmacSha256(key: string | Buffer, data: string): Buffer {
  return crypto.createHmac('sha256', key).update(data).digest();
}

function getSigningKey(
  secretKey: string,
  dateStamp: string,
  regionName: string,
  serviceName: string
): Buffer {
  const kDate = hmacSha256('AWS4' + secretKey, dateStamp);
  const kRegion = hmacSha256(kDate, regionName);
  const kService = hmacSha256(kRegion, serviceName);
  const kSigning = hmacSha256(kService, 'aws4_request');
  return kSigning;
}

function formatAmzDate(date: Date): { amzDate: string; dateStamp: string } {
  const pad = (n: number) => n.toString().padStart(2, '0');
  const year = date.getUTCFullYear();
  const month = pad(date.getUTCMonth() + 1);
  const day = pad(date.getUTCDate());
  const hours = pad(date.getUTCHours());
  const minutes = pad(date.getUTCMinutes());
  const seconds = pad(date.getUTCSeconds());

  const dateStamp = `${year}${month}${day}`;
  const amzDate = `${dateStamp}T${hours}${minutes}${seconds}Z`;
  return { amzDate, dateStamp };
}

/**
 * Generates an AWS SigV4 Presigned PUT URL for S3 or Cloudflare R2
 */
export function generatePresignedPutUrl(
  config: S3R2Config,
  key: string,
  options: {
    expiresInSeconds?: number;
    contentType?: string;
    date?: Date;
  } = {}
): PresignedPutUrlResult {
  const parsedConfig = S3R2ConfigSchema.parse(config);
  const cleanKey = key.replace(/^\/+/, '');
  const expiresIn = options.expiresInSeconds ?? 3600; // 1 hour default
  const date = options.date ?? new Date();
  const { amzDate, dateStamp } = formatAmzDate(date);

  const endpointUrl = new URL(parsedConfig.endpoint);
  const host = endpointUrl.host;
  const region = parsedConfig.region || 'auto';
  const service = 's3';

  // Path resolution: default path-style endpoint (standard for R2 and custom S3 endpoints)
  const pathname = endpointUrl.pathname.replace(/\/$/, '');
  const objectPath = `${pathname}/${parsedConfig.bucket}/${cleanKey}`.replace(/\/+/g, '/');

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;

  // Canonical query parameters
  const queryParams: Record<string, string> = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${parsedConfig.accessKeyId}/${credentialScope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': expiresIn.toString(),
    'X-Amz-SignedHeaders': 'host',
  };

  // Canonical query string must be sorted alphabetically by URI-encoded key
  const canonicalQueryString = Object.keys(queryParams)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(queryParams[k])}`)
    .join('&');

  const canonicalHeaders = `host:${host}\n`;
  const signedHeaders = 'host';
  const payloadHash = 'UNSIGNED-PAYLOAD';

  const canonicalRequest = [
    'PUT',
    objectPath,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const signingKey = getSigningKey(parsedConfig.secretAccessKey, dateStamp, region, service);
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  const presignedUrl = `${endpointUrl.origin}${objectPath}?${canonicalQueryString}&X-Amz-Signature=${signature}`;

  const headers: Record<string, string> = {};
  if (options.contentType) {
    headers['Content-Type'] = options.contentType;
  }

  const expiresAt = new Date(date.getTime() + expiresIn * 1000);

  return PresignedPutUrlResultSchema.parse({
    url: presignedUrl,
    method: 'PUT',
    headers,
    key: cleanKey,
    expiresAt,
  });
}

/**
 * Uploads file buffer/blob directly to presigned PUT URL
 */
export async function uploadClientWithPresignedUrl(
  presignedUrl: string,
  file: FileUploadInput,
  options: {
    contentType?: string;
    fetchFn?: typeof fetch;
  } = {}
): Promise<void> {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const headers: Record<string, string> = {};
  if (options.contentType) {
    headers['Content-Type'] = options.contentType;
  }

  let body: any;
  if (typeof file === 'string') {
    // If it's a data url or base64
    if (file.startsWith('data:')) {
      const base64Data = file.split(',')[1];
      body = Buffer.from(base64Data, 'base64');
    } else {
      body = file;
    }
  } else {
    body = file;
  }

  const response = await fetchFn(presignedUrl, {
    method: 'PUT',
    headers,
    body,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`S3/R2 upload failed (${response.status}): ${errorText}`);
  }
}

// ==========================================
// 2. S3 / R2 Storage Adapter Class
// ==========================================

export interface S3R2AdapterOptions {
  config: S3R2Config;
  fetchFn?: typeof fetch;
}

export class S3R2Adapter implements StorageAdapter {
  readonly provider: 's3' | 'r2';
  private readonly config: S3R2Config;
  private readonly fetchFn: typeof fetch;

  constructor(options: S3R2AdapterOptions | S3R2Config) {
    if ('config' in options) {
      this.config = S3R2ConfigSchema.parse(options.config);
      this.fetchFn = options.fetchFn ?? globalThis.fetch;
    } else {
      this.config = S3R2ConfigSchema.parse(options);
      this.fetchFn = globalThis.fetch;
    }
    this.provider = this.config.endpoint.includes('r2.cloudflarestorage.com') ? 'r2' : 's3';
  }

  /**
   * Generates presigned PUT URL for client upload
   */
  getPresignedPutUrl(
    key: string,
    options?: { expiresInSeconds?: number; contentType?: string }
  ): PresignedPutUrlResult {
    return generatePresignedPutUrl(this.config, key, options);
  }

  /**
   * Complete direct upload: generates presigned URL and uploads file via fetch
   */
  async upload(file: FileUploadInput, options?: UploadOptions): Promise<UploadResult> {
    const fileName = options?.fileName || `upload-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    const folder = options?.folder ? options.folder.replace(/^\/+|\/+$/g, '') : '';
    const key = folder ? `${folder}/${fileName}` : fileName;

    const contentType = options?.contentType || 'application/octet-stream';
    const presigned = this.getPresignedPutUrl(key, { contentType });

    let bytes = 0;
    if (typeof file === 'string') {
      bytes = Buffer.byteLength(file);
    } else if (file instanceof Blob) {
      bytes = file.size;
    } else if (Buffer.isBuffer(file) || file instanceof Uint8Array) {
      bytes = file.byteLength;
    }

    await uploadClientWithPresignedUrl(presigned.url, file, {
      contentType,
      fetchFn: this.fetchFn,
    });

    const publicUrl = this.getPublicUrl(key);

    const result: UploadResult = {
      url: publicUrl,
      secureUrl: publicUrl,
      key,
      provider: this.provider,
      bytes,
      createdAt: new Date().toISOString(),
      metadata: {
        bucket: this.config.bucket,
        contentType,
        ...options?.metadata,
      },
    };

    return UploadResultSchema.parse(result);
  }

  /**
   * Resolves public CDN / bucket URL
   */
  getPublicUrl(key: string, _transform?: ImageTransformOptions): string {
    const cleanKey = key.replace(/^\/+/, '');
    if (this.config.publicUrlBase) {
      const base = this.config.publicUrlBase.replace(/\/$/, '');
      return `${base}/${cleanKey}`;
    }

    const endpoint = this.config.endpoint.replace(/\/$/, '');
    return `${endpoint}/${this.config.bucket}/${cleanKey}`;
  }
}
