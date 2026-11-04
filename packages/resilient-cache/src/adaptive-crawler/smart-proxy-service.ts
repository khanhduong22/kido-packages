export interface ProxyConfig {
  host: string;
  port: number;
  auth?: { username: string; password: string };
  protocol?: 'http' | 'https';
}

export interface SmartCrawlStats {
  totalRequests: number;
  successCount: number;
  failureCount: number;
  rateLimitCount: number;
  lastResetAt: number;
}

export interface CrawlSummaryBoxStats {
  totalRecords?: number;
  validRecords?: number;
  invalidRecords?: number;
  created?: number;
  updated?: number;
  skipped?: number;
  failed?: number;
  successRate?: number;
  failedSymbols?: Array<{ symbol: string; reason: string }>;
  rateLimitedSymbols?: string[];
  warnings?: string[];
}

export interface BrowserHeaderProfile {
  id: string;
  userAgent: string;
  secChUa?: string;
  secChUaMobile: string;
  secChUaPlatform: string;
  acceptLanguage: string;
}

/**
 * Coherent Browser Fingerprint Profiles to prevent WAF / Cloudflare header mismatch blocks.
 * Never mix a Firefox User-Agent with Chrome Client Hints (`Sec-CH-UA`).
 */
export const BROWSER_HEADER_PROFILES: readonly BrowserHeaderProfile[] = [
  {
    id: 'chrome-win-135',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
    secChUa: '"Google Chrome";v="135", "Not-A.Brand";v="8", "Chromium";v="135"',
    secChUaMobile: '?0',
    secChUaPlatform: '"Windows"',
    acceptLanguage: 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
  },
  {
    id: 'chrome-mac-135',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
    secChUa: '"Google Chrome";v="135", "Not-A.Brand";v="8", "Chromium";v="135"',
    secChUaMobile: '?0',
    secChUaPlatform: '"macOS"',
    acceptLanguage: 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
  },
  {
    id: 'firefox-win-138',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:138.0) Gecko/20100101 Firefox/138.0',
    secChUaMobile: '?0',
    secChUaPlatform: '"Windows"',
    acceptLanguage: 'vi-VN,vi;q=0.8,en-US;q=0.5,en;q=0.3',
  },
  {
    id: 'firefox-mac-138',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:138.0) Gecko/20100101 Firefox/138.0',
    secChUaMobile: '?0',
    secChUaPlatform: '"macOS"',
    acceptLanguage: 'vi-VN,vi;q=0.8,en-US;q=0.5,en;q=0.3',
  },
  {
    id: 'chrome-linux-135',
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
    secChUa: '"Google Chrome";v="135", "Not-A.Brand";v="8", "Chromium";v="135"',
    secChUaMobile: '?0',
    secChUaPlatform: '"Linux"',
    acceptLanguage: 'en-US,en;q=0.9,vi;q=0.8',
  },
];

export interface ProxyAgentSocketOptions {
  keepAlive: boolean;
  keepAliveMsecs: number;
  timeout: number;
  rejectUnauthorized: boolean;
  maxSockets: number;
  maxFreeSockets: number;
  scheduling: 'fifo' | 'lifo';
  family: 4 | 6;
}

export const DEFAULT_PROXY_SOCKET_OPTIONS: Readonly<ProxyAgentSocketOptions> = {
  keepAlive: true,
  keepAliveMsecs: 30_000,
  timeout: 15_000,
  rejectUnauthorized: true,
  maxSockets: 30,
  maxFreeSockets: 3,
  scheduling: 'fifo',
  family: 4,
};

export interface DestroyableProxyAgent {
  destroy?: () => void;
  [key: string]: unknown;
}

export type ProxyAgentFactory<TAgent extends DestroyableProxyAgent = DestroyableProxyAgent> = (
  proxyUrl: string,
  options: ProxyAgentSocketOptions,
) => TAgent;

export interface ProxyRequestConfig<TAgent = unknown> {
  timeout?: number;
  maxRedirects?: number;
  validateStatus?: (status: number) => boolean;
  family?: 4 | 6;
  headers?: Record<string, string>;
  proxy?: false;
  httpAgent?: TAgent;
  httpsAgent?: TAgent;
  [key: string]: unknown;
}

export interface ProxyNodeHealth {
  index: number;
  proxyKey: string;
  consecutiveFailures: number;
  ejectionCount: number;
  quarantinedUntil: number;
  ewmaLatencyMs: number | null;
  totalSuccesses: number;
  totalFailures: number;
}

/**
 * Parse a proxy string (`http://user:pass@host:port`, `https://host:port`, `host:port`)
 * into a structured `ProxyConfig` object.
 */
export function parseProxyString(proxyStr: string): ProxyConfig | null {
  if (!proxyStr || typeof proxyStr !== 'string') return null;
  const trimmed = proxyStr.trim();
  if (!trimmed) return null;

  try {
    let protocol: 'http' | 'https' = 'http';
    let remaining = trimmed;
    if (trimmed.startsWith('http://')) {
      remaining = trimmed.substring(7);
    } else if (trimmed.startsWith('https://')) {
      protocol = 'https';
      remaining = trimmed.substring(8);
    } else if (trimmed.includes('://')) {
      return null;
    }

    const slashIndex = remaining.indexOf('/');
    if (slashIndex !== -1) remaining = remaining.substring(0, slashIndex);

    let auth: { username: string; password: string } | undefined;
    if (remaining.includes('@')) {
      const atIndex = remaining.lastIndexOf('@');
      const authPart = remaining.substring(0, atIndex);
      const colonIndex = authPart.indexOf(':');
      if (colonIndex === -1) return null;
      const username = authPart.substring(0, colonIndex);
      const password = authPart.substring(colonIndex + 1);
      if (!username || !password) return null;
      auth = { username, password };
      remaining = remaining.substring(atIndex + 1);
    }

    const parts = remaining.split(':');
    if (parts.length !== 2) return null;
    const [host, portStr] = parts;
    if (!host || !/^\d+$/.test(portStr)) return null;
    const port = parseInt(portStr, 10);
    if (isNaN(port) || port <= 0 || port > 65535) return null;
    return { host, port, protocol, auth };
  } catch {
    return null;
  }
}

export function formatProxyUrl(proxy: ProxyConfig): string {
  const protocol = proxy.protocol || 'http';
  return proxy.auth?.username && proxy.auth?.password
    ? `${protocol}://${proxy.auth.username}:${proxy.auth.password}@${proxy.host}:${proxy.port}`
    : `${protocol}://${proxy.host}:${proxy.port}`;
}

export function maskProxyUrl(proxyOrUrl: ProxyConfig | string): string {
  const proxy = typeof proxyOrUrl === 'string' ? parseProxyString(proxyOrUrl) : proxyOrUrl;
  if (!proxy) {
    return typeof proxyOrUrl === 'string'
      ? proxyOrUrl.replace(/(\/\/[^:/@]+):[^@]+@/g, '$1:****@')
      : '';
  }
  const protocol = proxy.protocol || 'http';
  return proxy.auth?.username
    ? `${protocol}://${proxy.auth.username}:****@${proxy.host}:${proxy.port}`
    : `${protocol}://${proxy.host}:${proxy.port}`;
}

export function parseBooleanConfig(value: string | undefined | null): boolean | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
  return undefined;
}

export function resolveProxyTlsVerification(
  env: Record<string, string | undefined> = typeof process !== 'undefined' ? process.env : {},
): boolean {
  const verifyTls = parseBooleanConfig(env.PROXY_TLS_VERIFY);
  if (verifyTls !== undefined) return verifyTls;
  const rejectUnauthorized = parseBooleanConfig(env.PROXY_REJECT_UNAUTHORIZED);
  if (rejectUnauthorized !== undefined) return rejectUnauthorized;
  return true;
}

export function formatCrawlSummaryBox(title: string, stats: CrawlSummaryBoxStats): string {
  const lines: string[] = [];
  const separator = '══════════════════════════════════════════════════════════════════════';
  lines.push(`📈 ${title}:`, separator);

  if (stats.totalRecords !== undefined) lines.push(`   Total records received: ${stats.totalRecords}`);
  if (stats.created === 0 && stats.skipped !== undefined && stats.skipped > 0) {
    lines.push(`⚠️  All records were duplicates - no new data crawled`);
  }
  if (stats.validRecords !== undefined) lines.push(`   Valid records: ${stats.validRecords}`);
  if (stats.invalidRecords !== undefined) lines.push(`   Invalid records: ${stats.invalidRecords}`);
  if (stats.created !== undefined) lines.push(`   ✅ Created: ${stats.created}`);
  if (stats.updated !== undefined) lines.push(`   🔄 Updated: ${stats.updated}`);
  if (stats.skipped !== undefined) lines.push(`   ⏭️  Skipped (duplicates): ${stats.skipped}`);
  if (stats.failed !== undefined && stats.failed > 0) lines.push(`   ❌ Failed: ${stats.failed}`);

  if (stats.successRate !== undefined) {
    const emoji = stats.successRate >= 90 ? '🎉' : stats.successRate >= 70 ? '✅' : '⚠️';
    lines.push(`   ${emoji} Success rate: ${stats.successRate.toFixed(1)}%`);
  }

  if (stats.rateLimitedSymbols?.length) {
    lines.push(`   🚫 Rate limited symbols (${stats.rateLimitedSymbols.length}):`);
    stats.rateLimitedSymbols.slice(0, 10).forEach((s) => lines.push(`      - ${s}`));
    if (stats.rateLimitedSymbols.length > 10) {
      lines.push(`      ... and ${stats.rateLimitedSymbols.length - 10} more`);
    }
  }

  if (stats.failedSymbols?.length) {
    lines.push(`   💥 Failed symbols (${stats.failedSymbols.length}):`);
    stats.failedSymbols.slice(0, 10).forEach((i) => lines.push(`      - ${i.symbol}: ${i.reason}`));
    if (stats.failedSymbols.length > 10) {
      lines.push(`      ... and ${stats.failedSymbols.length - 10} more`);
    }
  }

  if (stats.warnings?.length) {
    lines.push(`   ⚠️  Warnings:`);
    stats.warnings.forEach((w) => lines.push(`      - ${w}`));
  }

  lines.push(separator);
  return lines.join('\n');
}

export interface SmartLoggerSink {
  log: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
}

export interface SmartCrawlLoggerOptions {
  logIntervalMs?: number;
  sampleRate?: number;
  sink?: SmartLoggerSink;
  randomFn?: () => number;
}

export class SmartCrawlLogger {
  private stats: SmartCrawlStats = {
    totalRequests: 0,
    successCount: 0,
    failureCount: 0,
    rateLimitCount: 0,
    lastResetAt: Date.now(),
  };

  private readonly logIntervalMs: number;
  private readonly defaultSampleRate: number;
  private readonly sink: SmartLoggerSink;
  private readonly randomFn: () => number;

  constructor(options: SmartCrawlLoggerOptions = {}) {
    this.logIntervalMs = Math.max(1000, options.logIntervalMs ?? 60_000);
    this.defaultSampleRate = Math.min(1, Math.max(0, options.sampleRate ?? 0.1));
    this.sink = options.sink ?? {
      log: (msg: string) => console.log(msg),
      warn: (msg: string) => console.warn(msg),
      error: (msg: string) => console.error(msg),
    };
    this.randomFn = options.randomFn ?? Math.random;
  }

  public logSampled(message: string, sampleRate: number = this.defaultSampleRate): boolean {
    if (this.randomFn() < sampleRate) {
      this.sink.log(message);
      return true;
    }
    return false;
  }

  public logImportant(message: string): void {
    this.sink.log(message);
  }

  public recordRequest(success: boolean, isRateLimit = false, now = Date.now()): void {
    this.stats.totalRequests++;
    if (success) this.stats.successCount++;
    else this.stats.failureCount++;
    if (isRateLimit) this.stats.rateLimitCount++;
    if (now - this.stats.lastResetAt >= this.logIntervalMs) this.flushStats(now);
  }

  public flushStats(now = Date.now()): string | null {
    const { totalRequests, successCount, failureCount, rateLimitCount } = this.stats;
    if (totalRequests === 0) {
      this.stats.lastResetAt = now;
      return null;
    }
    const successRate = ((successCount / totalRequests) * 100).toFixed(1);
    const failureRate = ((failureCount / totalRequests) * 100).toFixed(1);
    const summary = `📊 Stats (last ${Math.round(this.logIntervalMs / 1000)}s): ${totalRequests} requests | ✅ ${successCount} (${successRate}%) | ❌ ${failureCount} (${failureRate}%) | 🚫 ${rateLimitCount} rate limits`;
    this.sink.log(summary);
    this.resetStats(now);
    return summary;
  }

  public resetStats(now = Date.now()): void {
    this.stats = {
      totalRequests: 0,
      successCount: 0,
      failureCount: 0,
      rateLimitCount: 0,
      lastResetAt: now,
    };
  }

  public getStats(): SmartCrawlStats {
    return { ...this.stats };
  }

  public logSummary(title: string, stats: CrawlSummaryBoxStats): string {
    const formatted = formatCrawlSummaryBox(title, stats);
    this.sink.log(formatted);
    return formatted;
  }
}

export { SmartCrawlLogger as SmartLogger };
