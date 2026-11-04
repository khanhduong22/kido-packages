import {
  BROWSER_HEADER_PROFILES,
  type BrowserHeaderProfile,
  type CrawlSummaryBoxStats,
  DEFAULT_PROXY_SOCKET_OPTIONS,
  type DestroyableProxyAgent,
  formatCrawlSummaryBox,
  formatProxyUrl,
  maskProxyUrl,
  parseProxyString,
  type ProxyAgentFactory,
  type ProxyAgentSocketOptions,
  type ProxyConfig,
  type ProxyNodeHealth,
  type ProxyRequestConfig,
  resolveProxyTlsVerification,
  SmartCrawlLogger,
  type SmartCrawlLoggerOptions,
  type SmartCrawlStats,
} from './smart-proxy-service';

export {
  type CrawlSummaryBoxStats,
  formatCrawlSummaryBox,
  formatProxyUrl,
  maskProxyUrl,
  parseProxyString,
  type ProxyConfig,
  type SmartCrawlStats,
};

export type AdaptiveProxyMode = 'direct' | 'proxy';

export interface AdaptiveProxyOptions {
  proxies?: string | Array<string | ProxyConfig>;
  directFailureThreshold?: number;
  directCooldownMs?: number;
  requestTimeoutMs?: number;
  userAgents?: string[];
  browserProfiles?: readonly BrowserHeaderProfile[];
  verifyProxyTls?: boolean;
  socketOptions?: Partial<ProxyAgentSocketOptions>;
  agentFactory?: ProxyAgentFactory;
  ejectionBaseMs?: number;
  ejectionMaxMs?: number;
  nonBlockingCooldown?: boolean;
  loggerOptions?: SmartCrawlLoggerOptions;
}

export interface AdaptiveProxyStatus {
  mode: AdaptiveProxyMode;
  directFailureCount: number;
  directCooldownRemainingSec: number;
  isInCooldown: boolean;
  currentProxyIndex: number;
  totalProxies: number;
  currentProxy: ProxyConfig | null;
  currentProxyUrl: string | null;
  maskedProxyUrl: string | null;
}

export const DEFAULT_CRAWLER_USER_AGENTS: readonly string[] = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:138.0) Gecko/20100101 Firefox/138.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:138.0) Gecko/20100101 Firefox/138.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
];

/**
 * Adaptive Proxy Rotator & Service for resilient outbound crawling.
 * Supports direct-first fast path, automatic failover to proxy pool,
 * Envoy-style outlier quarantine with exponential backoff, EWMA latency tracking,
 * coherent browser fingerprint headers, and socket lifecycle management.
 */
export class AdaptiveProxyRotator {
  private mode: AdaptiveProxyMode = 'direct';
  private currentProxyIndex = 0;
  private directFailureCount = 0;
  private directCooldownUntil = 0;
  private currentProxyAgent: DestroyableProxyAgent | null = null;

  private readonly proxyList: ProxyConfig[] = [];
  private readonly proxyHealth: ProxyNodeHealth[] = [];
  private readonly directFailureThreshold: number;
  private readonly directCooldownMs: number;
  private readonly requestTimeoutMs: number;
  private readonly userAgents: readonly string[];
  private readonly browserProfiles: readonly BrowserHeaderProfile[];
  private readonly verifyProxyTls: boolean;
  private readonly socketOptions: ProxyAgentSocketOptions;
  private readonly agentFactory?: ProxyAgentFactory;
  private readonly ejectionBaseMs: number;
  private readonly ejectionMaxMs: number;
  private readonly nonBlockingCooldown: boolean;
  private readonly smartLogger: SmartCrawlLogger;

  constructor(options: AdaptiveProxyOptions = {}) {
    this.directFailureThreshold = Math.max(1, options.directFailureThreshold ?? 7);
    this.directCooldownMs = Math.max(0, options.directCooldownMs ?? 60_000);
    this.requestTimeoutMs = Math.max(1000, options.requestTimeoutMs ?? 30_000);
    this.userAgents =
      options.userAgents && options.userAgents.length > 0
        ? options.userAgents
        : DEFAULT_CRAWLER_USER_AGENTS;
    this.browserProfiles =
      options.browserProfiles && options.browserProfiles.length > 0
        ? options.browserProfiles
        : BROWSER_HEADER_PROFILES;
    this.verifyProxyTls = options.verifyProxyTls ?? resolveProxyTlsVerification();
    this.socketOptions = {
      ...DEFAULT_PROXY_SOCKET_OPTIONS,
      rejectUnauthorized: this.verifyProxyTls,
      ...options.socketOptions,
    };
    this.agentFactory = options.agentFactory;
    this.ejectionBaseMs = Math.max(0, options.ejectionBaseMs ?? 0);
    this.ejectionMaxMs = Math.max(this.ejectionBaseMs, options.ejectionMaxMs ?? 300_000);
    this.nonBlockingCooldown = options.nonBlockingCooldown ?? false;
    this.smartLogger = new SmartCrawlLogger(options.loggerOptions);

    if (options.proxies) this.loadProxies(options.proxies);
  }

  private loadProxies(proxies: string | Array<string | ProxyConfig>): void {
    const rawList =
      typeof proxies === 'string'
        ? proxies.split(',').map((p) => p.trim()).filter(Boolean)
        : proxies;

    for (const item of rawList) {
      const parsed =
        typeof item === 'string'
          ? parseProxyString(item)
          : item && typeof item === 'object' && item.host && item.port
            ? { ...item, protocol: item.protocol || 'http' }
            : null;
      if (parsed) {
        const index = this.proxyList.length;
        this.proxyList.push(parsed);
        this.proxyHealth.push({
          index,
          proxyKey: maskProxyUrl(parsed),
          consecutiveFailures: 0,
          ejectionCount: 0,
          quarantinedUntil: 0,
          ewmaLatencyMs: null,
          totalSuccesses: 0,
          totalFailures: 0,
        });
      }
    }
  }

  public getSmartLogger(): SmartCrawlLogger { return this.smartLogger; }
  public parseProxyString(proxyStr: string): ProxyConfig | null { return parseProxyString(proxyStr); }
  public maskProxyUrl(proxyOrUrl: ProxyConfig | string): string { return maskProxyUrl(proxyOrUrl); }
  public getRandomUserAgent(): string { return this.userAgents[Math.floor(Math.random() * this.userAgents.length)]; }
  public getRandomBrowserProfile(): BrowserHeaderProfile { return this.browserProfiles[Math.floor(Math.random() * this.browserProfiles.length)]; }

  public getCoherentRequestHeaders(extraHeaders: Record<string, string> = {}): Record<string, string> {
    const profile = this.getRandomBrowserProfile();
    const headers: Record<string, string> = {
      'User-Agent': profile.userAgent,
      'Accept-Language': profile.acceptLanguage,
      'Sec-CH-UA-Mobile': profile.secChUaMobile,
      'Sec-CH-UA-Platform': profile.secChUaPlatform,
      ...extraHeaders,
    };
    if (profile.secChUa) headers['Sec-CH-UA'] = profile.secChUa;
    return headers;
  }

  public isDirectInCooldown(): boolean {
    if (this.directCooldownUntil > Date.now()) return true;
    if (this.directCooldownUntil > 0) this.directCooldownUntil = 0;
    return false;
  }

  public recordRequest(success: boolean, isRateLimit = false): void {
    this.smartLogger.recordRequest(success, isRateLimit);
  }

  public handleRateLimitError(): void {
    this.recordRequest(false, true);

    if (this.mode === 'direct') {
      this.directFailureCount++;
      if (this.directFailureCount >= this.directFailureThreshold && this.proxyList.length > 0) {
        this.mode = 'proxy';
        this.currentProxyIndex = this.findNextHealthyProxyIndex(0) ?? 0;
        this.directCooldownUntil = 0;
        this.refreshProxyAgent();
      } else {
        this.directCooldownUntil = Date.now() + this.directCooldownMs;
      }
      return;
    }

    if (this.proxyList.length === 0) {
      this.switchToDirectWithCooldown();
      return;
    }

    const currentHealth = this.proxyHealth[this.currentProxyIndex];
    if (currentHealth) {
      currentHealth.consecutiveFailures++;
      currentHealth.totalFailures++;
      if (this.ejectionBaseMs > 0) {
        currentHealth.ejectionCount++;
        const backoff = Math.min(
          this.ejectionMaxMs,
          this.ejectionBaseMs * Math.pow(2, currentHealth.ejectionCount - 1),
        );
        currentHealth.quarantinedUntil = Date.now() + backoff;
      }
    }

    const nextCandidate = this.currentProxyIndex + 1;
    if (nextCandidate >= this.proxyList.length) {
      this.switchToDirectWithCooldown();
      return;
    }

    const nextHealthy = this.findNextHealthyProxyIndex(nextCandidate);
    if (nextHealthy === null) {
      this.switchToDirectWithCooldown();
    } else {
      this.currentProxyIndex = nextHealthy;
      this.refreshProxyAgent();
    }
  }

  private findNextHealthyProxyIndex(startIndex: number): number | null {
    const now = Date.now();
    for (let i = startIndex; i < this.proxyList.length; i++) {
      const health = this.proxyHealth[i];
      if (!health || health.quarantinedUntil <= now) return i;
    }
    return null;
  }

  private switchToDirectWithCooldown(): void {
    this.destroyCurrentAgent();
    this.mode = 'direct';
    this.currentProxyIndex = 0;
    this.directFailureCount = 0;
    this.directCooldownUntil = Date.now() + this.directCooldownMs;
  }

  private destroyCurrentAgent(): void {
    if (this.currentProxyAgent?.destroy) this.currentProxyAgent.destroy();
    this.currentProxyAgent = null;
  }

  private refreshProxyAgent(): void {
    this.destroyCurrentAgent();
    const proxy = this.proxyList[this.currentProxyIndex];
    if (proxy && this.agentFactory) {
      this.currentProxyAgent = this.agentFactory(formatProxyUrl(proxy), this.socketOptions);
    }
  }

  public handleSuccess(): void {
    this.recordRequest(true, false);
    if (this.mode === 'direct' && this.directFailureCount > 0) {
      this.directFailureCount = 0;
    } else if (this.mode === 'proxy') {
      const health = this.proxyHealth[this.currentProxyIndex];
      if (health) {
        health.consecutiveFailures = 0;
        health.totalSuccesses++;
      }
    }
  }

  public markCurrentProxySuccess(): void {
    this.handleSuccess();
  }

  public recordProxyLatency(latencyMs: number): void {
    if (this.mode !== 'proxy' || latencyMs < 0) return;
    const health = this.proxyHealth[this.currentProxyIndex];
    if (health) {
      health.ewmaLatencyMs =
        health.ewmaLatencyMs === null ? latencyMs : health.ewmaLatencyMs * 0.8 + latencyMs * 0.2;
    }
  }

  public getProxyHealth(): ProxyNodeHealth[] {
    return this.proxyHealth.map((h) => ({ ...h }));
  }

  public async getRequestConfig<TConfig extends ProxyRequestConfig = ProxyRequestConfig>(
    config: TConfig = {} as TConfig,
  ): Promise<TConfig & ProxyRequestConfig> {
    if (this.mode === 'direct' && this.isDirectInCooldown()) {
      if (this.nonBlockingCooldown && this.proxyList.length > 0) {
        this.mode = 'proxy';
        this.currentProxyIndex = this.findNextHealthyProxyIndex(0) ?? 0;
        this.directCooldownUntil = 0;
        this.refreshProxyAgent();
      } else {
        const waitMs = Math.max(0, this.directCooldownUntil - Date.now());
        if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
        this.directCooldownUntil = 0;
      }
    }

    const requestConfig: TConfig & ProxyRequestConfig = {
      timeout: this.requestTimeoutMs,
      maxRedirects: 2,
      validateStatus: (status: number) => status >= 200 && status < 400,
      family: 4,
      ...config,
      headers: {
        'User-Agent': this.getRandomUserAgent(),
        ...(config.headers || {}),
      },
    };

    if (this.mode === 'proxy' && this.proxyList.length > 0) {
      if (!this.currentProxyAgent && this.agentFactory) this.refreshProxyAgent();
      requestConfig.proxy = false;
      if (this.currentProxyAgent) {
        requestConfig.httpsAgent = this.currentProxyAgent;
        requestConfig.httpAgent = this.currentProxyAgent;
      }
    }

    return requestConfig;
  }

  public async mergeProxyConfig<TConfig extends ProxyRequestConfig = ProxyRequestConfig>(
    config: TConfig = {} as TConfig,
  ): Promise<TConfig & ProxyRequestConfig> {
    return this.getRequestConfig(config);
  }

  public getStatus(): AdaptiveProxyStatus {
    const inCooldown = this.isDirectInCooldown();
    const remainingSec = inCooldown
      ? Math.max(0, Math.ceil((this.directCooldownUntil - Date.now()) / 1000))
      : 0;
    const currentProxy =
      this.mode === 'proxy' && this.proxyList.length > 0
        ? this.proxyList[this.currentProxyIndex]
        : null;

    return {
      mode: this.mode,
      directFailureCount: this.directFailureCount,
      directCooldownRemainingSec: remainingSec,
      isInCooldown: inCooldown,
      currentProxyIndex: this.currentProxyIndex,
      totalProxies: this.proxyList.length,
      currentProxy,
      currentProxyUrl: currentProxy ? formatProxyUrl(currentProxy) : null,
      maskedProxyUrl: currentProxy ? maskProxyUrl(currentProxy) : null,
    };
  }

  public getStats(): SmartCrawlStats {
    return this.smartLogger.getStats();
  }

  public resetStats(): void {
    this.smartLogger.resetStats();
  }

  public formatCrawlSummaryBox(title: string, stats: CrawlSummaryBoxStats): string {
    return formatCrawlSummaryBox(title, stats);
  }

  public getRequestHeaders(extraHeaders: Record<string, string> = {}): Record<string, string> {
    return { ...extraHeaders, 'User-Agent': this.getRandomUserAgent() };
  }

  public getRequestTimeoutMs(): number {
    return this.requestTimeoutMs;
  }

  public destroy(): void {
    this.destroyCurrentAgent();
  }

  public onModuleDestroy(): void {
    this.destroy();
  }
}

export { AdaptiveProxyRotator as AdaptiveProxyService };
