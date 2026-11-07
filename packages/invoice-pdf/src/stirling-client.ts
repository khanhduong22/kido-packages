/**
 * Stirling-PDF High-Performance REST Client
 * Provides PDF compression, watermarking, and HTML-to-PDF conversion
 * with graceful fallback support for 2026 microservice deployments.
 */

export class StirlingPdfError extends Error {
  public readonly statusCode?: number;
  public readonly endpoint: string;

  constructor(message: string, endpoint: string, statusCode?: number, cause?: unknown) {
    super(`[Stirling-PDF] ${message} (endpoint: ${endpoint}${statusCode ? `, status: ${statusCode}` : ''})`);
    this.name = 'StirlingPdfError';
    this.endpoint = endpoint;
    this.statusCode = statusCode;
    if (cause) {
      this.cause = cause;
    }
  }
}

export interface StirlingPdfClientOptions {
  /**
   * Base URL of Stirling-PDF instance
   * Default: process.env.STIRLING_PDF_URL || 'http://localhost:8080'
   */
  baseUrl?: string;
  /**
   * Optional API Key if Stirling-PDF authentication is enabled
   */
  apiKey?: string;
  /**
   * Request timeout in milliseconds (default: 15000ms)
   */
  timeoutMs?: number;
  /**
   * Whether to fallback gracefully to original input or alternative handler if Stirling-PDF is down
   * Default: true
   */
  fallbackOnFailure?: boolean;
  /**
   * Custom logger for warnings and errors
   */
  logger?: {
    warn: (message: string, ...args: unknown[]) => void;
    error: (message: string, ...args: unknown[]) => void;
  };
}

export interface CompressPdfOptions {
  /**
   * Compression optimization level:
   * 0 = low compression (fast)
   * 1 = medium compression
   * 2 = high compression (recommended for Telegram/Zalo invoices)
   * 3 = extreme compression
   */
  optimizeLevel?: 0 | 1 | 2 | 3;
  /**
   * If Stirling-PDF fails, return original uncompressed buffer rather than throwing
   * Default: true (or client-level fallbackOnFailure)
   */
  fallbackToOriginal?: boolean;
}

export interface WatermarkOptions {
  /**
   * Watermark text (e.g. 'ĐÃ THANH TOÁN', 'BẢO HÀNH 12 THÁNG')
   */
  fontSize?: number;
  rotation?: number;
  opacity?: number;
  widthSpacer?: number;
  heightSpacer?: number;
  /**
   * If Stirling-PDF fails, return original buffer rather than throwing
   * Default: true (or client-level fallbackOnFailure)
   */
  fallbackToOriginal?: boolean;
}

export interface HtmlToPdfOptions {
  /**
   * Zoom factor (default: 1.0)
   */
  zoom?: number;
  /**
   * Optional fallback function when Stirling-PDF server is unreachable
   */
  fallbackHandler?: (html: string) => Promise<Uint8Array>;
}

export class StirlingPdfClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly fallbackOnFailure: boolean;
  private readonly logger: {
    warn: (message: string, ...args: unknown[]) => void;
    error: (message: string, ...args: unknown[]) => void;
  };

  constructor(options: StirlingPdfClientOptions = {}) {
    const rawUrl = options.baseUrl || (typeof process !== 'undefined' ? process.env.STIRLING_PDF_URL : undefined) || 'http://localhost:8080';
    this.baseUrl = rawUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey || (typeof process !== 'undefined' ? process.env.STIRLING_PDF_API_KEY : undefined);
    this.timeoutMs = options.timeoutMs ?? 15000;
    this.fallbackOnFailure = options.fallbackOnFailure ?? true;
    this.logger = options.logger ?? {
      warn: (msg, ...args) => console.warn(`[Stirling-PDF Warn] ${msg}`, ...args),
      error: (msg, ...args) => console.error(`[Stirling-PDF Error] ${msg}`, ...args),
    };
  }

  /**
   * Check if Stirling-PDF service is accessible and responsive
   */
  public async isAvailable(): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(this.timeoutMs, 3000));
    timer.unref?.();

    try {
      const headers: Record<string, string> = {};
      if (this.apiKey) {
        headers['X-API-KEY'] = this.apiKey;
      }

      const response = await fetch(`${this.baseUrl}/api/v1/info/status`, {
        method: 'GET',
        headers,
        signal: controller.signal,
      }).catch(async () => {
        return fetch(`${this.baseUrl}/`, {
          method: 'GET',
          headers,
          signal: controller.signal,
        });
      });

      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Compress PDF size for high-speed transmission via Telegram / Zalo / Email
   * Stirling-PDF REST API: POST /api/v1/general/compress-pdf
   */
  public async compressPdf(
    pdfBuffer: Uint8Array,
    options: CompressPdfOptions = {}
  ): Promise<Uint8Array> {
    const endpoint = `${this.baseUrl}/api/v1/general/compress-pdf`;
    const fallbackToOriginal = options.fallbackToOriginal ?? this.fallbackOnFailure;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();

    try {
      const formData = new FormData();
      const blob = new Blob([pdfBuffer.buffer as ArrayBuffer], { type: 'application/pdf' });
      formData.append('fileInput', blob, 'document.pdf');
      formData.append('optimizeLevel', String(options.optimizeLevel ?? 2));

      const headers: Record<string, string> = {};
      if (this.apiKey) {
        headers['X-API-KEY'] = this.apiKey;
      }

      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: formData,
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new StirlingPdfError(
          `Compression failed with HTTP ${response.status}: ${errorText || response.statusText}`,
          endpoint,
          response.status
        );
      }

      const arrayBuffer = await response.arrayBuffer();
      return new Uint8Array(arrayBuffer);
    } catch (err: unknown) {
      if (fallbackToOriginal) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Stirling-PDF compression failed or server unavailable (${errorMsg}). Gracefully falling back to original PDF buffer.`
        );
        return pdfBuffer;
      }

      if (err instanceof StirlingPdfError) {
        throw err;
      }
      throw new StirlingPdfError(
        `Failed to communicate with Stirling-PDF server: ${err instanceof Error ? err.message : String(err)}`,
        endpoint,
        undefined,
        err
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Stamp watermark onto PDF (e.g. 'ĐÃ THANH TOÁN', 'BẢO HÀNH 12 THÁNG')
   * Stirling-PDF REST API: POST /api/v1/security/add-watermark
   */
  public async addWatermark(
    pdfBuffer: Uint8Array,
    watermarkText: string,
    options: WatermarkOptions = {}
  ): Promise<Uint8Array> {
    const endpoint = `${this.baseUrl}/api/v1/security/add-watermark`;
    const fallbackToOriginal = options.fallbackToOriginal ?? this.fallbackOnFailure;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();

    try {
      const formData = new FormData();
      const blob = new Blob([pdfBuffer.buffer as ArrayBuffer], { type: 'application/pdf' });
      formData.append('fileInput', blob, 'document.pdf');
      formData.append('watermarkText', watermarkText);
      formData.append('fontSize', String(options.fontSize ?? 30));
      formData.append('rotation', String(options.rotation ?? 45));
      formData.append('opacity', String(options.opacity ?? 0.3));
      formData.append('widthSpacer', String(options.widthSpacer ?? 50));
      formData.append('heightSpacer', String(options.heightSpacer ?? 50));

      const headers: Record<string, string> = {};
      if (this.apiKey) {
        headers['X-API-KEY'] = this.apiKey;
      }

      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: formData,
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new StirlingPdfError(
          `Watermark addition failed with HTTP ${response.status}: ${errorText || response.statusText}`,
          endpoint,
          response.status
        );
      }

      const arrayBuffer = await response.arrayBuffer();
      return new Uint8Array(arrayBuffer);
    } catch (err: unknown) {
      if (fallbackToOriginal) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Stirling-PDF watermark stamp failed (${errorMsg}). Gracefully falling back to unwatermarked PDF buffer.`
        );
        return pdfBuffer;
      }

      if (err instanceof StirlingPdfError) {
        throw err;
      }
      throw new StirlingPdfError(
        `Failed to add watermark via Stirling-PDF: ${err instanceof Error ? err.message : String(err)}`,
        endpoint,
        undefined,
        err
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Convert HTML string (e.g. formatted invoice template) into production PDF
   * Stirling-PDF REST API: POST /api/v1/convert/html/pdf
   */
  public async convertHtmlToPdf(
    html: string,
    options: HtmlToPdfOptions = {}
  ): Promise<Uint8Array> {
    const endpoint = `${this.baseUrl}/api/v1/convert/html/pdf`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();

    try {
      const formData = new FormData();
      const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
      formData.append('fileInput', blob, 'invoice.html');
      formData.append('zoom', String(options.zoom ?? 1.0));

      const headers: Record<string, string> = {};
      if (this.apiKey) {
        headers['X-API-KEY'] = this.apiKey;
      }

      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: formData,
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new StirlingPdfError(
          `HTML to PDF conversion failed with HTTP ${response.status}: ${errorText || response.statusText}`,
          endpoint,
          response.status
        );
      }

      const arrayBuffer = await response.arrayBuffer();
      return new Uint8Array(arrayBuffer);
    } catch (err: unknown) {
      if (options.fallbackHandler) {
        this.logger.warn('Stirling-PDF conversion failed; executing custom fallbackHandler.');
        return await options.fallbackHandler(html);
      }

      if (err instanceof StirlingPdfError) {
        throw err;
      }
      throw new StirlingPdfError(
        `Failed to convert HTML to PDF via Stirling-PDF: ${err instanceof Error ? err.message : String(err)}`,
        endpoint,
        undefined,
        err
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Factory helper to instantiate StirlingPdfClient
 */
export function createStirlingPdfClient(options?: StirlingPdfClientOptions): StirlingPdfClient {
  return new StirlingPdfClient(options);
}

/**
 * Default shared singleton instance
 */
export const defaultStirlingPdfClient = new StirlingPdfClient();
