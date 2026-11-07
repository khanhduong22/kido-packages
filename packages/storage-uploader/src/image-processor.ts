import {
  AspectRatioCheckResult,
  AspectRatioPreset,
  ImageMetadata,
  ImageValidationOptions,
  ImageValidationOptionsSchema,
  ImageValidationResult,
} from './types';

// ==========================================
// 1. Constants & Defaults
// ==========================================
export const DEFAULT_ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

export const MAX_FILE_SIZE_5MB = 5 * 1024 * 1024; // 5,242,880 bytes
export const MAX_FILE_SIZE_10MB = 10 * 1024 * 1024; // 10,485,760 bytes

export const ASPECT_RATIO_PRESETS: Record<AspectRatioPreset, number> = {
  '1:1': 1.0,
  '4:3': 4 / 3, // ~1.3333
  '16:9': 16 / 9, // ~1.7778
  '3:4': 3 / 4, // 0.75
  '9:16': 9 / 16, // 0.5625
  '3:2': 1.5,
  '2:3': 2 / 3, // ~0.6667
};

// ==========================================
// 2. Helpers
// ==========================================

/**
 * Formats a byte size into human readable string (e.g. 2.45 MB)
 */
export function formatBytes(bytes: number, decimals = 2): string {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

/**
 * Validates if the given MIME type is within the allowed list
 */
export function validateFileType(
  mimeType: string,
  allowedTypes: readonly string[] | string[] = DEFAULT_ALLOWED_MIME_TYPES
): { valid: boolean; error?: string } {
  const normalized = mimeType.toLowerCase().trim();
  const valid = allowedTypes.map((t) => t.toLowerCase().trim()).includes(normalized);

  if (!valid) {
    return {
      valid: false,
      error: `Invalid file type "${mimeType}". Allowed formats: ${allowedTypes.join(', ')}`,
    };
  }

  return { valid: true };
}

/**
 * Validates if the given file size is within the allowed maximum limit
 */
export function validateFileSize(
  sizeInBytes: number,
  maxSizeBytes: number = MAX_FILE_SIZE_5MB
): { valid: boolean; error?: string; sizeInBytes: number; maxSizeBytes: number } {
  if (sizeInBytes <= 0) {
    return {
      valid: false,
      error: 'File size must be greater than 0 bytes',
      sizeInBytes,
      maxSizeBytes,
    };
  }

  if (sizeInBytes > maxSizeBytes) {
    return {
      valid: false,
      error: `File size ${formatBytes(sizeInBytes)} exceeds maximum limit of ${formatBytes(maxSizeBytes)}`,
      sizeInBytes,
      maxSizeBytes,
    };
  }

  return { valid: true, sizeInBytes, maxSizeBytes };
}

/**
 * Checks if the given width & height match the target aspect ratio within tolerance
 */
export function checkAspectRatio(
  width: number,
  height: number,
  target: AspectRatioPreset | number,
  tolerance = 0.02 // 2% tolerance
): AspectRatioCheckResult {
  if (width <= 0 || height <= 0) {
    return {
      matches: false,
      actualRatio: 0,
      targetRatio: typeof target === 'number' ? target : (ASPECT_RATIO_PRESETS[target] ?? 1),
      tolerance,
      difference: 1,
      label: typeof target === 'string' ? target : undefined,
    };
  }

  const actualRatio = width / height;
  let targetRatio: number;
  let label: string | undefined;

  if (typeof target === 'string') {
    targetRatio = ASPECT_RATIO_PRESETS[target] ?? 1.0;
    label = target;
  } else {
    targetRatio = target;
    // Try to find matching preset label
    const presetEntry = Object.entries(ASPECT_RATIO_PRESETS).find(
      ([_, ratio]) => Math.abs(ratio - targetRatio) < 0.001
    );
    if (presetEntry) {
      label = presetEntry[0];
    }
  }

  const difference = Math.abs(actualRatio - targetRatio);
  const relativeDiff = difference / targetRatio;
  const matches = relativeDiff <= tolerance;

  return {
    matches,
    actualRatio: Math.round(actualRatio * 10000) / 10000,
    targetRatio: Math.round(targetRatio * 10000) / 10000,
    tolerance,
    difference: Math.round(difference * 10000) / 10000,
    label,
  };
}

/**
 * Unified image validation function
 * Validates file type, file size, and optionally aspect ratio
 */
export function validateImage(
  input: {
    size: number;
    mimeType: string;
    width?: number;
    height?: number;
    name?: string;
  },
  options?: Partial<ImageValidationOptions>
): ImageValidationResult {
  const opts = ImageValidationOptionsSchema.parse(options ?? {});
  const errors: string[] = [];

  // 1. File Type Check
  const typeResult = validateFileType(input.mimeType, opts.allowedMimeTypes);
  if (!typeResult.valid && typeResult.error) {
    errors.push(typeResult.error);
  }

  // 2. File Size Check
  const sizeResult = validateFileSize(input.size, opts.maxSizeBytes);
  if (!sizeResult.valid && sizeResult.error) {
    errors.push(sizeResult.error);
  }

  // 3. Aspect Ratio Check (if width & height provided and target specified)
  let aspectRatioResult: AspectRatioCheckResult | undefined;
  if (input.width && input.height && opts.targetAspectRatio) {
    aspectRatioResult = checkAspectRatio(
      input.width,
      input.height,
      opts.targetAspectRatio,
      opts.aspectRatioTolerance
    );

    if (!aspectRatioResult.matches) {
      const targetDesc = aspectRatioResult.label || `${opts.targetAspectRatio}`;
      errors.push(
        `Aspect ratio mismatch: Expected ${targetDesc} (~${aspectRatioResult.targetRatio}), but received ${input.width}x${input.height} (~${aspectRatioResult.actualRatio})`
      );
    }
  }

  // Build metadata
  const format = input.mimeType.split('/')[1] || undefined;
  const metadata: ImageMetadata = {
    size: input.size,
    mimeType: input.mimeType,
    name: input.name,
    format,
    width: input.width,
    height: input.height,
    aspectRatio:
      input.width && input.height ? Math.round((input.width / input.height) * 10000) / 10000 : undefined,
  };

  return {
    valid: errors.length === 0,
    errors,
    metadata,
    aspectRatioResult,
  };
}
