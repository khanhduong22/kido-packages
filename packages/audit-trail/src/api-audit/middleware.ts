import type { Context, MiddlewareHandler } from 'hono';
import { sanitizePayload } from './sanitizer';
import type { ApiAuditService } from './service';
import type { HonoAuditMiddlewareOptions } from './types';

const DEFAULT_EXCLUDE_PATHS = [
  '/health',
  '/api/health',
  '/metrics',
  '/favicon.ico',
  '/api/audit-logs',
  '/audit-logs',
];

/**
 * Hono v4 Audit Logging Middleware.
 * Captures request details, duration, IP, user-agent, sanitized payload, and status code / error.
 * Enqueues log entries asynchronously and non-blockingly.
 */
export function honoAuditMiddleware(
  service: ApiAuditService,
  options: HonoAuditMiddlewareOptions = {}
): MiddlewareHandler {
  const excludePaths = [...DEFAULT_EXCLUDE_PATHS, ...(options.excludePaths ?? [])];

  return async function auditMiddleware(c: Context, next: () => Promise<void>) {
    const path = c.req.path;

    // Check if path should be excluded
    const shouldSkip = excludePaths.some((pattern) => {
      if (typeof pattern === 'string') {
        return path === pattern || path.startsWith(pattern.endsWith('/') ? pattern : pattern + '/');
      }
      return pattern.test(path);
    });

    if (shouldSkip) {
      return next();
    }

    const startTime = Date.now();
    const method = c.req.method;
    const endpoint = path;

    // Extract client IP address
    const ip =
      c.req.header('x-forwarded-for')?.split(',')[0].trim() ||
      c.req.header('x-real-ip') ||
      c.req.header('cf-connecting-ip') ||
      null;

    const userAgent = c.req.header('user-agent') || null;

    // Extract and sanitize request payload
    let rawPayload: any = null;

    if (options.getPayload) {
      try {
        rawPayload = options.getPayload(c);
      } catch {
        rawPayload = null;
      }
    } else if (method === 'GET') {
      try {
        const query = c.req.query();
        if (query && Object.keys(query).length > 0) {
          rawPayload = query;
        }
      } catch {
        rawPayload = null;
      }
    } else if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      const contentType = c.req.header('content-type') || '';
      if (contentType.includes('application/json')) {
        try {
          rawPayload = await c.req.raw.clone().json();
        } catch {
          rawPayload = null;
        }
      } else if (
        contentType.includes('application/x-www-form-urlencoded') ||
        contentType.includes('multipart/form-data')
      ) {
        try {
          const formData = await c.req.raw.clone().formData();
          const obj: Record<string, any> = {};
          formData.forEach((value: any, key: string) => {
            obj[key] = typeof value === 'object' && 'name' in value ? `[File: ${value.name}]` : value;
          });
          rawPayload = obj;
        } catch {
          rawPayload = null;
        }
      }
    }

    const payload = sanitizePayload(rawPayload, {
      maxBytes: options.maxPayloadBytes,
      sensitiveKeys: options.sensitiveKeys,
    });

    try {
      await next();

      const durationMs = Date.now() - startTime;
      const statusCode = c.res.status || 200;
      const errorMessage = c.error?.message || null;
      const userId =
        options.getUserId?.(c) ||
        (c.get as any)('userId') ||
        (c.get as any)('user')?.id ||
        (c.get as any)('user')?.uid ||
        c.req.header('x-user-id') ||
        null;

      // Non-blocking asynchronous enqueue
      service
        .enqueueLog({
          userId,
          method,
          endpoint,
          statusCode,
          durationMs,
          ip,
          userAgent,
          payload,
          errorMessage,
        })
        .catch(() => {});
    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      const statusCode = err?.status || err?.statusCode || 500;
      const errorMessage = err?.message || String(err);
      const userId =
        options.getUserId?.(c) ||
        (c.get as any)('userId') ||
        (c.get as any)('user')?.id ||
        (c.get as any)('user')?.uid ||
        c.req.header('x-user-id') ||
        null;

      // Non-blocking error log enqueue
      service
        .enqueueLog({
          userId,
          method,
          endpoint,
          statusCode,
          durationMs,
          ip,
          userAgent,
          payload,
          errorMessage,
        })
        .catch(() => {});

      throw err;
    }
  };
}
