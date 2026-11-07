import {
  ImageTransformOptions,
  StorageProvider,
  UploadOptions,
  UploadResult,
} from '../types';

export type FileUploadInput = Blob | Buffer | Uint8Array | string;

export interface StorageAdapter {
  readonly provider: StorageProvider;

  /**
   * Uploads a file (Blob, Buffer, Uint8Array, or base64/data-uri string)
   * and returns standardized UploadResult
   */
  upload(file: FileUploadInput, options?: UploadOptions): Promise<UploadResult>;

  /**
   * Returns a publicly accessible URL for the given key/public_id,
   * optionally applying image transformations (resize, quality, format)
   */
  getPublicUrl(key: string, transform?: ImageTransformOptions): string;

  /**
   * Optional deletion method
   */
  delete?(key: string): Promise<boolean>;
}
