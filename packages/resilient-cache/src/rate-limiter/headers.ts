import { RateLimitHeaders, RateLimitResult } from './types';

export interface HeaderOptions {
  /**
   * Whether to include legacy X-RateLimit-* headers alongside IETF standard headers (default: true)
   */
  includeLegacy?: boolean;

  /**
   * Format for RateLimit-Reset header:
   * 'seconds' -> Delta seconds until reset (IETF standard)
   * 'timestamp' -> Unix timestamp in seconds
   * default: 'seconds'
   */
  resetFormat?: 'seconds' | 'timestamp';
}

/**
 * Generate standard RFC 6585 and IETF RateLimit HTTP headers from RateLimitResult
 */
export function getRateLimitHeaders(
  result: RateLimitResult,
  options: HeaderOptions = {},
): Record<string, string> {
  const includeLegacy = options.includeLegacy ?? true;
  const resetFormat = options.resetFormat ?? 'seconds';

  const nowMs = Date.now();
  const resetMs = result.resetTime.getTime();
  const secondsUntilReset = Math.max(0, Math.ceil((resetMs - nowMs) / 1000));
  const unixResetSeconds = Math.ceil(resetMs / 1000);

  const resetHeaderVal =
    resetFormat === 'timestamp'
      ? String(unixResetSeconds)
      : String(secondsUntilReset);

  const headers: Record<string, string> = {
    'RateLimit-Limit': String(result.limit),
    'RateLimit-Remaining': String(Math.max(0, result.remaining)),
    'RateLimit-Reset': resetHeaderVal,
  };

  // RFC 6585 Section 4: Retry-After header on 429 Too Many Requests
  if (!result.isAllowed) {
    const retrySec = result.retryAfterSec > 0 ? result.retryAfterSec : Math.max(1, secondsUntilReset);
    headers['Retry-After'] = String(retrySec);
  }

  // Legacy headers (GitHub / Twitter / Stripe convention)
  if (includeLegacy) {
    headers['X-RateLimit-Limit'] = String(result.limit);
    headers['X-RateLimit-Remaining'] = String(Math.max(0, result.remaining));
    headers['X-RateLimit-Reset'] = String(unixResetSeconds);
  }

  return headers;
}
