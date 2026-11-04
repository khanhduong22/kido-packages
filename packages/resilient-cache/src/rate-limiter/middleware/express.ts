import { getRateLimitHeaders } from '../headers';
import { MemoryRateLimitStore } from '../stores/memory-store';
import { RateLimitConfig, RateLimitResult, RateLimitStore } from '../types';

/**
 * Extract client IP from Express/Connect request
 */
export function extractExpressIp(req: any): string {
  if (req.ip) return req.ip;

  const xForwardedFor = req.headers?.['x-forwarded-for'];
  if (typeof xForwardedFor === 'string' && xForwardedFor.length > 0) {
    const [first] = xForwardedFor.split(',');
    if (first && first.trim()) return first.trim();
  }

  const xRealIp = req.headers?.['x-real-ip'];
  if (typeof xRealIp === 'string' && xRealIp.length > 0) {
    return xRealIp.trim();
  }

  return req.socket?.remoteAddress || req.connection?.remoteAddress || '127.0.0.1';
}

/**
 * Create Express/Connect compatible Rate Limiter Middleware
 */
export function createExpressRateLimiter(config: RateLimitConfig) {
  const store: RateLimitStore =
    config.store ??
    new MemoryRateLimitStore({
      defaultMax: config.max,
      progressiveCooldown: config.progressiveCooldown,
    });

  const statusCode = config.statusCode ?? 429;
  const sendHeaders = config.headers !== false;

  return async (req: any, res: any, next: (err?: any) => void) => {
    try {
      // 1. Skip condition check
      if (config.skip && (await config.skip(req))) {
        return next();
      }

      // 2. Resolve client key
      const key = config.keyGenerator
        ? await config.keyGenerator(req)
        : extractExpressIp(req);

      // 3. Increment counter
      const result: RateLimitResult = await store.increment(
        key,
        config.windowMs,
        config.max,
      );

      // 4. Attach result to req object
      req.rateLimit = result;

      // 5. Attach RateLimit headers
      if (sendHeaders) {
        const headers = getRateLimitHeaders(result);
        for (const [headerName, headerValue] of Object.entries(headers)) {
          if (typeof res.setHeader === 'function') {
            res.setHeader(headerName, headerValue);
          } else if (typeof res.header === 'function') {
            res.header(headerName, headerValue);
          }
        }
      }

      // 6. Block if rate limit exceeded
      if (!result.isAllowed) {
        if (config.onLimitReached) {
          await config.onLimitReached(result, key, req);
        }

        if (config.handler) {
          return config.handler(req, res, next);
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

        if (typeof res.status === 'function') {
          return res.status(statusCode).json(payload);
        }

        res.statusCode = statusCode;
        if (typeof res.setHeader === 'function') {
          res.setHeader('Content-Type', 'application/json');
        }
        return res.end(JSON.stringify(payload));
      }

      // 7. Track skipFailedRequests on response finish
      if (config.skipFailedRequests && store.decrement && typeof res.on === 'function') {
        res.on('finish', async () => {
          if (res.statusCode >= 400 && store.decrement) {
            await store.decrement(key);
          }
        });
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}
