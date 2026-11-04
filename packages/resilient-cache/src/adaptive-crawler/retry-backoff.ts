export interface RetryBackoffOptions {
  /** Maximum number of retry attempts (not including initial attempt). Default: 5 */
  maxRetries?: number;
  /** Initial delay in milliseconds before the first retry. Default: 1000ms */
  initialDelayMs?: number;
  /** Maximum delay cap in milliseconds between retries. Default: 180,000ms */
  maxDelayMs?: number;
  /** Exponential base multiplier per attempt. Default: 2 */
  exponentialBase?: number;
  /** Random jitter factor in [0, 1] (e.g. 0.3 = ±30% variance). Default: 0.3 */
  jitterFactor?: number;
  /** Custom predicate to decide if an error is retryable */
  shouldRetry?: (error: Error) => boolean;
  /** Optional hook invoked before sleeping for a retry attempt */
  onRetry?: (attempt: number, delayMs: number, error: Error) => void;
}

export type RetryOptions = RetryBackoffOptions;

export interface RetryResult<T> {
  success: boolean;
  data?: T;
  error?: Error;
  attempts: number;
  totalDelayMs: number;
}

export type CrawlerHttpError = Error & {
  response?: {
    status?: number;
    headers?: Record<string, string | string[] | number | undefined>;
  };
  headers?: Record<string, string | string[] | number | undefined>;
  status?: number;
  statusCode?: number;
  code?: string;
  rateLimitInfo?: { retryAfter?: number };
};

const RETRYABLE_SOCKET_CODES = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'ECONNABORTED',
  'EPIPE',
  'EPROTO',
  'EAI_AGAIN',
]);

const RETRYABLE_MESSAGE_PATTERNS = [
  'timeout',
  'econnreset',
  'econnrefused',
  'enotfound',
  'epipe',
  'socket hang up',
  'network error',
];

/**
 * Calculate exponential backoff delay with `maxDelayMs` cap and `±jitterFactor` variance.
 * Formula: `min(initialDelayMs * (exponentialBase ^ attempt), maxDelayMs) ± jitter`
 */
export function calculateBackoffDelay(
  attempt: number,
  options: RetryBackoffOptions = {},
): number {
  const initialDelayMs = Math.max(0, options.initialDelayMs ?? 1000);
  const maxDelayMs = Math.max(initialDelayMs, options.maxDelayMs ?? 180_000);
  const exponentialBase = Math.max(1, options.exponentialBase ?? 2);
  const jitterFactor = Math.min(1, Math.max(0, options.jitterFactor ?? 0.3));

  const exponentialDelay =
    initialDelayMs * Math.pow(exponentialBase, Math.max(0, attempt));
  const cappedDelay = Math.min(exponentialDelay, maxDelayMs);

  const jitterRange = cappedDelay * jitterFactor;
  const jitter = (Math.random() * 2 - 1) * jitterRange;

  return Math.max(0, Math.floor(cappedDelay + jitter));
}

function hasHeaderGetter(
  obj: unknown,
): obj is { get: (key: string) => string | null | undefined } {
  return (
    Boolean(obj) &&
    typeof obj === 'object' &&
    typeof (obj as { get?: unknown }).get === 'function'
  );
}

/**
 * Extract `Retry-After` delay in milliseconds from an Error object or HTTP headers.
 * Supports both HTTP delta-seconds (`Retry-After: 30`) and HTTP-date (`Retry-After: Wed, 21 Oct...`).
 */
export function extractRetryAfterMs(errorOrHeaders: unknown): number | null {
  if (!errorOrHeaders || typeof errorOrHeaders !== 'object') {
    return null;
  }

  const candidate = errorOrHeaders as CrawlerHttpError &
    Record<string, unknown>;

  let rawHeader: unknown;

  // 1. Check standard Fetch Headers API (.get)
  if (hasHeaderGetter(errorOrHeaders)) {
    rawHeader = errorOrHeaders.get('retry-after');
  }

  // 2. Check error.response.headers or error.headers or plain headers object
  if (rawHeader === undefined || rawHeader === null) {
    const headersObj: unknown =
      (candidate.response &&
      typeof candidate.response === 'object' &&
      candidate.response.headers
        ? candidate.response.headers
        : undefined) ??
      (candidate.headers && typeof candidate.headers === 'object'
        ? candidate.headers
        : undefined) ??
      (!(candidate instanceof Error) ? candidate : undefined);

    if (headersObj && typeof headersObj === 'object') {
      if (hasHeaderGetter(headersObj)) {
        rawHeader = headersObj.get('retry-after');
      } else {
        for (const [key, value] of Object.entries(
          headersObj as Record<string, unknown>,
        )) {
          if (key.toLowerCase() === 'retry-after') {
            rawHeader = Array.isArray(value) ? value[0] : value;
            break;
          }
        }
      }
    }
  }

  if (rawHeader !== undefined && rawHeader !== null) {
    if (typeof rawHeader === 'number' && !isNaN(rawHeader)) {
      return Math.max(0, Math.floor(rawHeader * 1000));
    }

    if (typeof rawHeader === 'string') {
      const trimmed = rawHeader.trim();
      if (/^\d+(\.\d+)?$/.test(trimmed)) {
        const seconds = parseFloat(trimmed);
        return Math.max(0, Math.floor(seconds * 1000));
      }

      const dateMs = Date.parse(trimmed);
      if (!isNaN(dateMs)) {
        return Math.max(0, dateMs - Date.now());
      }
    }
  }

  // 3. Fallback to rateLimitInfo.retryAfter (in seconds)
  if (
    candidate.rateLimitInfo &&
    typeof candidate.rateLimitInfo.retryAfter === 'number' &&
    !isNaN(candidate.rateLimitInfo.retryAfter)
  ) {
    return Math.max(0, Math.floor(candidate.rateLimitInfo.retryAfter * 1000));
  }

  return null;
}

/**
 * Detect whether an error represents an HTTP 429 Too Many Requests / rate limit error.
 */
export function isRateLimitError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const httpError = error as CrawlerHttpError;
  const status =
    httpError.response?.status ?? httpError.statusCode ?? httpError.status;

  if (status === 429) {
    return true;
  }

  const message = (httpError.message ?? '').toLowerCase();
  return (
    message.includes('rate limit') ||
    message.includes('too many requests') ||
    message.includes('status code 429')
  );
}

/**
 * Detect whether an error is a retryable crawler error:
 * HTTP 429, HTTP 5xx, or transient network socket errors (`ETIMEDOUT`, `ECONNRESET`, `ECONNREFUSED`, `ENOTFOUND`, `EPIPE`).
 */
export function isRetryableCrawlerError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  if (isRateLimitError(error)) {
    return true;
  }

  const httpError = error as CrawlerHttpError;
  const status =
    httpError.response?.status ?? httpError.statusCode ?? httpError.status;

  if (typeof status === 'number' && status >= 500 && status < 600) {
    return true;
  }

  const errorCode =
    typeof httpError.code === 'string'
      ? httpError.code.toUpperCase()
      : undefined;
  if (errorCode && RETRYABLE_SOCKET_CODES.has(errorCode)) {
    return true;
  }

  const message = (httpError.message ?? '').toLowerCase();
  return RETRYABLE_MESSAGE_PATTERNS.some((pattern) =>
    message.includes(pattern),
  );
}

/**
 * Execute an async function respecting `Retry-After` headers first,
 * falling back to jittered exponential backoff.
 */
export async function executeWithRateLimitRetry<T>(
  fn: () => Promise<T>,
  options: RetryBackoffOptions = {},
): Promise<RetryResult<T>> {
  const maxRetries = Math.max(0, options.maxRetries ?? 5);
  const maxAttempts = maxRetries + 1;
  const shouldRetry = options.shouldRetry ?? isRetryableCrawlerError;

  let lastError: Error | undefined;
  let totalDelayMs = 0;
  let attempt = 0;

  for (attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      if (attempt > 0) {
        const retryAfterMs = lastError ? extractRetryAfterMs(lastError) : null;
        const delayMs =
          retryAfterMs !== null
            ? retryAfterMs
            : calculateBackoffDelay(attempt - 1, options);

        totalDelayMs += delayMs;
        if (options.onRetry && lastError) {
          options.onRetry(attempt, delayMs, lastError);
        }

        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }

      const data = await fn();
      return {
        success: true,
        data,
        attempts: attempt + 1,
        totalDelayMs,
      };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (!shouldRetry(lastError)) {
        attempt++;
        break;
      }
    }
  }

  return {
    success: false,
    error: lastError,
    attempts: attempt,
    totalDelayMs,
  };
}

/**
 * Retry-After & Jittered Exponential Backoff Engine for outbound HTTP crawlers.
 */
export class RetryAfterBackoffEngine {
  private readonly defaultOptions: RetryBackoffOptions;

  constructor(defaultOptions: RetryBackoffOptions = {}) {
    this.defaultOptions = defaultOptions;
  }

  public calculateBackoffDelay(
    attempt: number,
    options?: RetryBackoffOptions,
  ): number {
    return calculateBackoffDelay(attempt, {
      ...this.defaultOptions,
      ...options,
    });
  }

  public extractRetryAfterMs(errorOrHeaders: unknown): number | null {
    return extractRetryAfterMs(errorOrHeaders);
  }

  public isRateLimitError(error: unknown): boolean {
    return isRateLimitError(error);
  }

  public isRetryableCrawlerError(error: unknown): boolean {
    return isRetryableCrawlerError(error);
  }

  public async executeWithRateLimitRetry<T>(
    fn: () => Promise<T>,
    options?: RetryBackoffOptions,
  ): Promise<RetryResult<T>> {
    return executeWithRateLimitRetry(fn, {
      ...this.defaultOptions,
      ...options,
    });
  }

  public async executeWithRetry<T>(
    fn: () => Promise<T>,
    options?: RetryBackoffOptions,
  ): Promise<RetryResult<T>> {
    const merged: RetryBackoffOptions = {
      ...this.defaultOptions,
      ...options,
      shouldRetry: options?.shouldRetry ?? (() => true),
    };
    return executeWithRateLimitRetry(fn, merged);
  }
}
