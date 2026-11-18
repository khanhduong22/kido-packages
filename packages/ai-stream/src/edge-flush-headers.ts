/**
 * @kido/ai-stream - Canonical Edge Buffer Flushing & Anti-Buffering Headers
 *
 * Configures HTTP responses and reverse proxies (Nginx, Caddy, Cloudflare Edge)
 * to immediately flush streaming chunks without TCP socket buffering or 4KB coalescing.
 */

export const CANONICAL_SSE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  'Connection': 'keep-alive',
  'X-Accel-Buffering': 'no',
  'X-Content-Type-Options': 'nosniff',
});

/**
 * Builds HTTP response headers guaranteed to bypass buffering across Cloudflare, Nginx, and Caddy.
 * Merges optional user-provided extra headers.
 */
export function buildSseResponseHeaders(
  extraHeaders?: Record<string, string>
): Record<string, string> {
  return {
    ...CANONICAL_SSE_HEADERS,
    ...(extraHeaders ?? {}),
  };
}

/**
 * Generates production Nginx configuration snippet with proxy buffering disabled
 * and chunked transfer encoding enabled for sub-10ms TTFT streaming.
 */
export function generateNginxSseLocationConfig(
  locationPath: string = '/api/ai/stream'
): string {
  const cleanPath = locationPath.trim() || '/api/ai/stream';
  return [
    `# Tier-1 Nginx SSE & Token Streaming Anti-Buffering Directives`,
    `location ${cleanPath} {`,
    `    proxy_pass http://upstream_backend;`,
    `    proxy_http_version 1.1;`,
    `    proxy_set_header Connection '';`,
    `    proxy_buffering off;`,
    `    proxy_cache off;`,
    `    chunked_transfer_encoding on;`,
    `    proxy_read_timeout 600s;`,
    `    proxy_send_timeout 600s;`,
    `}`,
  ].join('\n');
}

/**
 * Generates production Caddy reverse proxy configuration snippet with flush_interval -1
 * ensuring each SSE frame is immediately flushed to the client socket.
 */
export function generateCaddySseProxyConfig(
  matcherPath: string = '/api/ai/stream*'
): string {
  const cleanPath = matcherPath.trim() || '/api/ai/stream*';
  return [
    `# Tier-1 Caddy SSE Directives (Immediate socket flush)`,
    `@sse path ${cleanPath}`,
    `reverse_proxy @sse http://upstream_backend {`,
    `    flush_interval -1`,
    `}`,
  ].join('\n');
}
