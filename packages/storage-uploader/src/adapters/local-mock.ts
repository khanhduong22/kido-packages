import {
  ImageTransformOptions,
  LocalMockConfig,
  LocalMockConfigSchema,
  UploadOptions,
  UploadResult,
  UploadResultSchema,
} from '../types';
import { FileUploadInput, StorageAdapter } from './base';

export interface StoredMockFile {
  key: string;
  data: Buffer | Uint8Array | string;
  size: number;
  contentType: string;
  metadata?: Record<string, any>;
  createdAt: string;
}

export class LocalMockStorageAdapter implements StorageAdapter {
  readonly provider = 'local-mock' as const;
  private readonly config: LocalMockConfig;
  private readonly store = new Map<string, StoredMockFile>();

  constructor(config?: Partial<LocalMockConfig>) {
    this.config = LocalMockConfigSchema.parse(config ?? {});
  }

  /**
   * Upload file into in-memory mock store
   */
  async upload(file: FileUploadInput, options?: UploadOptions): Promise<UploadResult> {
    if (this.config.latencyMs && this.config.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.config.latencyMs));
    }

    const fileName =
      options?.fileName || `mock-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    const folder = options?.folder ? options.folder.replace(/^\/+|\/+$/g, '') : '';
    const key = folder ? `${folder}/${fileName}` : fileName;

    let size = 0;
    let dataToStore: Buffer | Uint8Array | string;

    if (typeof file === 'string') {
      dataToStore = file;
      size = Buffer.byteLength(file);
    } else if (file instanceof Blob) {
      size = file.size;
      const arrayBuffer = await file.arrayBuffer();
      dataToStore = Buffer.from(arrayBuffer);
    } else if (Buffer.isBuffer(file) || file instanceof Uint8Array) {
      size = file.byteLength;
      dataToStore = file;
    } else {
      dataToStore = String(file);
      size = Buffer.byteLength(dataToStore);
    }

    const contentType = options?.contentType || 'image/jpeg';
    const createdAt = new Date().toISOString();

    const storedFile: StoredMockFile = {
      key,
      data: dataToStore,
      size,
      contentType,
      metadata: options?.metadata,
      createdAt,
    };

    this.store.set(key, storedFile);

    const publicUrl = this.getPublicUrl(key, options?.transformation);

    const result: UploadResult = {
      url: publicUrl,
      secureUrl: publicUrl,
      key,
      provider: 'local-mock',
      bytes: size,
      format: contentType.split('/')[1] || 'jpeg',
      createdAt,
      metadata: {
        mock: true,
        storedLocally: true,
        ...options?.metadata,
      },
    };

    return UploadResultSchema.parse(result);
  }

  /**
   * Generates mock public URL, optionally appending transform query string
   */
  getPublicUrl(key: string, transform?: ImageTransformOptions): string {
    const cleanKey = key.replace(/^\/+/, '');
    const baseUrl = this.config.baseUrl!.replace(/\/$/, '');
    const url = `${baseUrl}/${cleanKey}`;

    if (!transform) return url;

    const params = new URLSearchParams();
    if (transform.width) params.set('w', transform.width.toString());
    if (transform.height) params.set('h', transform.height.toString());
    if (transform.crop) params.set('c', transform.crop);
    if (transform.quality) params.set('q', transform.quality.toString());
    if (transform.format) params.set('f', transform.format);

    const qs = params.toString();
    return qs ? `${url}?${qs}` : url;
  }

  /**
   * Retrieves a stored file
   */
  getItem(key: string): StoredMockFile | undefined {
    return this.store.get(key);
  }

  /**
   * Checks if file exists
   */
  has(key: string): boolean {
    return this.store.has(key);
  }

  /**
   * Deletes a stored file
   */
  async delete(key: string): Promise<boolean> {
    return this.store.delete(key);
  }

  /**
   * Clears all stored files
   */
  clear(): void {
    this.store.clear();
  }

  /**
   * Lists all stored file keys
   */
  listKeys(): string[] {
    return Array.from(this.store.keys());
  }

  /**
   * Count of stored files
   */
  get size(): number {
    return this.store.size;
  }
}
