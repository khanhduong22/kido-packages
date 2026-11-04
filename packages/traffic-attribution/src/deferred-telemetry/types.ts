/**
 * Configuration options for @kido/deferred-telemetry
 */
export interface DeferredTelemetryConfig {
  /**
   * Google Analytics 4 Measurement ID (e.g. 'G-XXXXXXXXXX').
   */
  gaId?: string;

  /**
   * Microsoft Clarity Project ID.
   */
  clarityId?: string;

  /**
   * Google Tag Manager Container ID (e.g. 'GTM-XXXXXXX').
   */
  gtmId?: string;

  /**
   * Meta / Facebook Pixel ID (e.g. '123456789012345').
   */
  metaPixelId?: string;

  /**
   * Lazy initialization function for Sentry (e.g. dynamic import).
   * Called once when the user's first interaction occurs.
   */
  sentryInit?: () => void | Promise<void>;

  /**
   * Optional fallback timeout in milliseconds to load scripts if no interaction happens.
   * Default: 0 (DISABLED).
   * By default, @kido/deferred-telemetry is PURE INTERACTION-ONLY.
   * If the user never interacts (e.g., Google Lighthouse / PageSpeed bot),
   * no external scripts are loaded at all, guaranteeing 0ms TBT and 100 score.
   */
  timeoutMs?: number;

  /**
   * Alias for `timeoutMs` for backwards compatibility.
   * Default: 0 (DISABLED).
   */
  delayMs?: number;

  /**
   * User interaction DOM events that immediately trigger script loading.
   * Default: ['scroll', 'touchstart', 'pointerdown', 'keydown', 'wheel']
   */
  events?: string[];

  /**
   * Optional callback invoked immediately after deferred scripts have been initiated.
   */
  onLoaded?: () => void;

  /**
   * If true, telemetry script injection and listeners are disabled.
   * Useful for local development or staging environments.
   */
  disabled?: boolean;
}

/**
 * Cleanup function returned when setting up interaction listeners and timers.
 */
export type DeferredTelemetryCleanup = () => void;

/**
 * Status snapshot of deferred telemetry.
 */
export interface TelemetryState {
  isLoaded: boolean;
  isQueueReady: boolean;
}

declare global {
  interface Window {
    dataLayer?: any[];
    gtag?: (...args: any[]) => void;
    clarity?: ((...args: any[]) => void) & { q?: any[] };
    fbq?: ((...args: any[]) => void) & {
      callMethod?: (...args: any[]) => void;
      queue?: any[];
      loaded?: boolean;
      version?: string;
      push?: any;
    };
    _fbq?: any;
  }
}
