import type { SanitizeOptions } from './types';

const DEFAULT_SENSITIVE_KEYS = new Set([
  'password',
  'token',
  'secret',
  'refreshtoken',
  'authorization',
  'accesstoken',
  'idtoken',
  'privatekey',
  'cookie',
  'cookies',
  'apikey',
  'credential',
]);

/**
 * Sanitizes arbitrary request/response payload:
 * 1. Redacts credentials, tokens, and sensitive keys.
 * 2. Prevents circular reference crashes using WeakSet tracking.
 * 3. Caps object traversal depth at 5 ([NESTED_TOO_DEEP]).
 * 4. Slices large arrays to at most 20 elements.
 * 5. Clamps serialized JSON string length to maxBytes (default 2KB).
 */
export function sanitizePayload(data: any, options: SanitizeOptions = {}): any {
  if (data === null || data === undefined) return null;

  const maxBytes = options.maxBytes ?? 2048;
  const maxDepth = options.maxDepth ?? 5;
  const maxArrayLength = options.maxArrayLength ?? 20;

  const sensitiveKeySet = options.sensitiveKeys
    ? new Set([
        ...DEFAULT_SENSITIVE_KEYS,
        ...Array.from(options.sensitiveKeys).map((k) => k.toLowerCase()),
      ])
    : DEFAULT_SENSITIVE_KEYS;

  const seen = new WeakSet<object>();

  const clean = (val: any, depth = 0): any => {
    if (depth > maxDepth) return '[NESTED_TOO_DEEP]';
    if (val === null || val === undefined) return val;

    if (typeof val === 'object') {
      if (seen.has(val)) {
        return '[CIRCULAR_REFERENCE]';
      }
      seen.add(val);

      if (Array.isArray(val)) {
        return val.slice(0, maxArrayLength).map((item) => clean(item, depth + 1));
      }

      const result: Record<string, any> = {};
      for (const [k, v] of Object.entries(val)) {
        if (sensitiveKeySet.has(k.toLowerCase())) {
          result[k] = '[REDACTED]';
        } else {
          result[k] = clean(v, depth + 1);
        }
      }
      return result;
    }

    return val;
  };

  try {
    const cleaned = clean(data);
    const serialized = JSON.stringify(cleaned);
    // Clamp to max 2KB (2048 bytes)
    if (serialized && serialized.length > maxBytes) {
      const previewLimit = Math.max(maxBytes - 48, 100);
      return {
        _truncated: true,
        preview: serialized.slice(0, previewLimit) + '...',
      };
    }
    return cleaned;
  } catch {
    return null;
  }
}
