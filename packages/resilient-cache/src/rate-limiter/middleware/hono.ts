import { getRateLimitHeaders } from '../headers';
import { MemoryRateLimitStore } from '../stores/memory-store';
import { RateLimitConfig, RateLimitResult, RateLimitStore } from '../types';

/**
 * Extract client IP from Hono request context
 */
export function extractClientIp(c: any): string {
  const cfConnectingIp = c.req.header('cf-connecting-ip');
  if (cfConnectingIp) return cfConnectingIp.trim();

  const xRealIp = c.req.header('x-real-ip');
  if (xRealIp) return xRealIp.trim();

  const xForwardedFor = c.req.header('x-forwarded-for');
  if (xForwardedFor) {
    const [firstIp] = xForwardedFor.split(',');
    if (firstIp && firstIp.trim().length > 0) {
      return firstIp.trim();
    }
  }

  const xClientIp = c.req.header('x-client-ip');
  if (xClientIp) return xClientIp.trim();

  return '127.0.0.1';
}

/**
 * Create Hono v4 Rate Limiter Middleware
 * RFC 6585 & IETF draft compliant with Sliding Window and Progressive Cooldown
 */
export function createHonoRateLimiter(config: RateLimitConfig) {
  const store: RateLimitStore =
    config.store ??
    new MemoryRateLimitStore({
      defaultMax: config.max,
      progressiveCooldown: config.progressiveCooldown,
    });

  const statusCode = config.statusCode ?? 429;
  const sendHeaders = config.headers !== false;

  return async (c: any, next: () => Promise<void>) => {
    // 1. Skip condition check
    if (config.skip && (await config.skip(c))) {
      return next();
    }

    // 2. Resolve client key
    const key = config.keyGenerator
      ? await config.keyGenerator(c)
      : extractClientIp(c);

    // 3. Increment counter
    const result: RateLimitResult = await store.increment(
      key,
      config.windowMs,
      config.max,
    );

    // 4. Attach result to context
    if (typeof c.set === 'function') {
      c.set('rateLimit', result);
    }

    // 5. Attach RateLimit headers
    const headers = sendHeaders ? getRateLimitHeaders(result) : {};
    if (sendHeaders) {
      for (const [headerName, headerValue] of Object.entries(headers)) {
        c.header(headerName, headerValue);
      }
    }

    // 6. Block if rate limit exceeded
    if (!result.isAllowed) {
      if (config.onLimitReached) {
        await config.onLimitReached(result, key, c);
      }

      if (config.handler) {
        return config.handler(c, result);
      }

      let payload: any;
      if (typeof config.message === 'function') {
        payload = config.message(result);
      } else if (typeof config.message === 'object' && config.message !== null) {
        payload = config.message;
      } else {
        payload = {
          error: 'Too Many Requests',
          message:
            config.message ?? 'Rate limit exceeded. Please try again later.',
          statusCode,
          retryAfter: result.retryAfterSec,
        };
      }

      return c.json(payload, statusCode, headers);
    }

    // 7. Proceed to next handler
    try {
      await next();

      // Check skipFailedRequests after handler completes
      if (config.skipFailedRequests && store.decrement) {
        const resStatus = c.res?.status;
        if (typeof resStatus === 'number' && resStatus >= 400) {
          await store.decrement(key);
        }
      }

      // Ensure headers persist on final response
      if (sendHeaders && c.res && c.res.headers) {
        for (const [headerName, headerValue] of Object.entries(headers)) {
          if (!c.res.headers.has(headerName)) {
            c.res.headers.set(headerName, headerValue);
          }
        }
      }
    } catch (error) {
      if (config.skipFailedRequests && store.decrement) {
        await store.decrement(key);
      }
      throw error;
    }
  };
}
