import type {
  DeferredTelemetryConfig,
  DeferredTelemetryCleanup,
  TelemetryState,
} from './types';

export const DEFAULT_DEFERRED_EVENTS: string[] = [
  'scroll',
  'touchstart',
  'pointerdown',
  'keydown',
  'wheel',
];

let isLoaded = false;
let isQueueReady = false;
let activeCleanup: DeferredTelemetryCleanup | null = null;
const initializedDataLayerIds = new Set<string>();
const initializedMetaPixelIds = new Set<string>();

/**
 * Initializes window.dataLayer and window.gtag for lossless event queueing.
 * Safe to call in SSR and multiple times.
 */
export function initDataLayer(gaId?: string, gtmId?: string): any[] {
  if (typeof window === 'undefined') {
    return [];
  }

  window.dataLayer = window.dataLayer || [];

  if (typeof window.gtag !== 'function') {
    window.gtag = function () {
      // arguments is pushed to dataLayer per Google Analytics standard
      window.dataLayer!.push(arguments);
    };
  }

  if (gaId && !initializedDataLayerIds.has(`ga:${gaId}`)) {
    initializedDataLayerIds.add(`ga:${gaId}`);
    window.gtag('js', new Date());
    window.gtag('config', gaId);
  }

  if (gtmId && !initializedDataLayerIds.has(`gtm:${gtmId}`)) {
    initializedDataLayerIds.add(`gtm:${gtmId}`);
    window.dataLayer.push({
      'gtm.start': new Date().getTime(),
      event: 'gtm.js',
    });
  }

  isQueueReady = true;
  return window.dataLayer;
}

/**
 * Initializes window.clarity queue for Microsoft Clarity.
 * Safe to call in SSR and multiple times.
 */
export function initClarityQueue(): void {
  if (typeof window === 'undefined') {
    return;
  }

  if (typeof window.clarity !== 'function') {
    const queue: any[] = [];
    const clarityFn = function () {
      queue.push(arguments);
    };
    (clarityFn as any).q = queue;
    window.clarity = clarityFn as any;
  }

  isQueueReady = true;
}

/**
 * Initializes window.fbq and window._fbq queue for Meta / Facebook Pixel.
 * Safe to call in SSR and multiple times.
 */
export function initMetaPixelQueue(metaPixelId?: string): void {
  if (typeof window === 'undefined') {
    return;
  }

  if (typeof window.fbq !== 'function') {
    const fbqFn: any = function () {
      if (fbqFn.callMethod) {
        fbqFn.callMethod.apply(fbqFn, arguments);
      } else {
        fbqFn.queue.push(arguments);
      }
    };
    if (!window._fbq) {
      window._fbq = fbqFn;
    }
    fbqFn.push = fbqFn;
    fbqFn.loaded = true;
    fbqFn.version = '2.0';
    fbqFn.queue = [];
    window.fbq = fbqFn;
  }

  if (metaPixelId && !initializedMetaPixelIds.has(metaPixelId)) {
    initializedMetaPixelIds.add(metaPixelId);
    if (typeof window.fbq === 'function') {
      window.fbq('init', metaPixelId);
      window.fbq('track', 'PageView');
    }
  }

  isQueueReady = true;
}

/**
 * Injects an external script tag into <head> asynchronously.
 * Prevents duplicate tags with the same id or src.
 */
export function loadScript(src: string, id?: string): HTMLScriptElement | null {
  if (typeof document === 'undefined') {
    return null;
  }

  if (id) {
    const existingById = document.getElementById(id) as HTMLScriptElement | null;
    if (existingById) {
      return existingById;
    }
  }

  const existingBySrc = document.querySelector(
    `script[src="${src}"]`
  ) as HTMLScriptElement | null;
  if (existingBySrc) {
    return existingBySrc;
  }

  const script = document.createElement('script');
  script.async = true;
  script.src = src;
  if (id) {
    script.id = id;
  }

  const target =
    document.head || document.getElementsByTagName('head')[0] || document.body;
  if (target) {
    target.appendChild(script);
  }

  return script;
}

/**
 * Returns current telemetry load and queue status.
 */
export function getTelemetryState(): TelemetryState {
  return {
    isLoaded,
    isQueueReady,
  };
}

/**
 * Checks if deferred scripts have finished being loaded.
 */
export function isTelemetryLoaded(): boolean {
  return isLoaded;
}

/**
 * Dispatches tracking events to GA4 dataLayer losslessly.
 */
export function trackEvent(eventName: string, params: Record<string, any> = {}): void {
  initDataLayer();
  if (typeof window !== 'undefined' && typeof window.gtag === 'function') {
    window.gtag('event', eventName, params);
  }
}

/**
 * Dispatches page view to GA4 dataLayer losslessly.
 */
export function trackPageView(pagePath?: string, title?: string): void {
  initDataLayer();
  if (typeof window !== 'undefined' && typeof window.gtag === 'function') {
    window.gtag('event', 'page_view', {
      page_path: pagePath ?? (typeof window !== 'undefined' ? window.location.pathname : ''),
      page_title: title ?? (typeof document !== 'undefined' ? document.title : ''),
    });
  }
}

/**
 * Pushes event to Microsoft Clarity queue losslessly.
 */
export function trackClarity(action: string, value?: string): void {
  initClarityQueue();
  if (typeof window !== 'undefined' && typeof window.clarity === 'function') {
    window.clarity(action, value);
  }
}

/**
 * Pushes event to Meta / Facebook Pixel queue losslessly.
 */
export function trackMetaPixel(eventName: string, params: Record<string, any> = {}): void {
  initMetaPixelQueue();
  if (typeof window !== 'undefined' && typeof window.fbq === 'function') {
    window.fbq('track', eventName, params);
  }
}

/**
 * Triggers loading all configured scripts immediately.
 */
export async function triggerDeferredLoad(config: DeferredTelemetryConfig): Promise<void> {
  if (isLoaded || typeof window === 'undefined') {
    return;
  }

  isLoaded = true;

  // 1. Google Analytics 4
  if (config.gaId) {
    loadScript(
      `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(config.gaId)}`,
      'ga4-deferred-script'
    );
  }

  // 2. Google Tag Manager
  if (config.gtmId) {
    loadScript(
      `https://www.googletagmanager.com/gtm.js?id=${encodeURIComponent(config.gtmId)}`,
      'gtm-deferred-script'
    );
  }

  // 3. Microsoft Clarity
  if (config.clarityId) {
    loadScript(
      `https://www.clarity.ms/tag/${encodeURIComponent(config.clarityId)}`,
      'clarity-deferred-script'
    );
  }

  // 4. Meta Pixel
  if (config.metaPixelId) {
    loadScript(
      'https://connect.facebook.net/en_US/fbevents.js',
      'meta-pixel-deferred-script'
    );
  }

  // 5. Sentry Lazy Init
  if (config.sentryInit) {
    try {
      await config.sentryInit();
    } catch (err) {
      console.error('[DeferredTelemetry] Sentry lazy initialization error:', err);
    }
  }

  if (typeof config.onLoaded === 'function') {
    config.onLoaded();
  }
}

/**
 * Sets up the Zero-TBT Interaction-Driven Telemetry Loader.
 * 1. Losslessly prepares analytics queues (dataLayer, clarity.q, fbq.queue) immediately.
 * 2. Waits for user interaction (scroll, touch, keydown, pointerdown, wheel).
 *    BY DEFAULT: Pure interaction-only! No automatic timer runs, so bots / Lighthouse audits
 *    will NEVER load external tracking scripts (0ms TBT guarantee).
 * 3. If explicit timeoutMs/delayMs is provided (> 0), registers an optional fallback timer.
 * 4. Injects scripts only when triggered, ensuring scripts load once and only once.
 *
 * Returns a cleanup function to tear down listeners and timer if unmounted early.
 */
export function setupInteractionLoader(
  config: DeferredTelemetryConfig = {}
): DeferredTelemetryCleanup {
  if (typeof window === 'undefined' || config.disabled) {
    return () => {};
  }

  // Lossless queue preparation (runs immediately during initial load/hydration)
  initDataLayer(config.gaId, config.gtmId);
  if (config.clarityId) {
    initClarityQueue();
  }
  if (config.metaPixelId) {
    initMetaPixelQueue(config.metaPixelId);
  }

  // If already loaded in current session, no need to re-register listeners
  if (isLoaded) {
    return () => {};
  }

  const events = config.events ?? DEFAULT_DEFERRED_EVENTS;
  const timeoutMs = config.timeoutMs ?? config.delayMs ?? 0;

  let timerId: ReturnType<typeof setTimeout> | null = null;
  let hasTriggered = false;

  const handleTrigger = () => {
    if (hasTriggered) return;
    hasTriggered = true;
    cleanup();
    triggerDeferredLoad(config);
  };

  const cleanup = () => {
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
    for (const eventName of events) {
      window.removeEventListener(eventName, handleTrigger);
    }
    if (activeCleanup === cleanup) {
      activeCleanup = null;
    }
  };

  // Register passive interaction event listeners
  for (const eventName of events) {
    window.addEventListener(eventName, handleTrigger, { passive: true, once: true });
  }

  // Optional fallback timeout (only if timeoutMs > 0, default is 0/disabled)
  if (timeoutMs > 0) {
    timerId = setTimeout(handleTrigger, timeoutMs);
  }

  activeCleanup = cleanup;
  return cleanup;
}

/**
 * Resets internal state for unit testing or test runners.
 */
export function resetTelemetryState(): void {
  if (activeCleanup) {
    activeCleanup();
    activeCleanup = null;
  }
  isLoaded = false;
  isQueueReady = false;
  initializedDataLayerIds.clear();
  initializedMetaPixelIds.clear();
}
