/**
 * Sentry Noise Filter & Performance Guard
 *
 * High-ROI Sentry client filters for:
 * 1. Third-party injected webview script errors (Cốc Cốc ccbrMediaMenu, Zalo zaloJSV2).
 * 2. Browser extension noise (chrome-extension://, moz-extension://, safari-extension://).
 * 3. Core Web Vitals anomaly suppression (background tab LCP/TTFB clamp, runaway transactions).
 * 4. Sentry event ID to Microsoft Clarity session replay bridging.
 */

export const DEFAULT_SENTRY_IGNORE_ERRORS: Array<string | RegExp> = [
  /zaloJSV2/i,
  /ccbrMediaMenu/i,
  /Cannot read properties of undefined \(reading 'M_ID'\)/i,
  /reading 'M_ID'/i,
  /ResizeObserver loop/i,
  /Non-Error exception captured/i,
];

export const DEFAULT_SENTRY_DENY_URLS: Array<string | RegExp> = [
  /extensions\//i,
  /^chrome:\/\//i,
  /^chrome-extension:\/\//i,
  /^moz-extension:\/\//i,
  /^safari-extension:\/\//i,
  /^safari-web-extension:\/\//i,
  /\/executors\/200\.js/i,
];

export interface SentryStackFrame {
  filename?: string;
  abs_path?: string;
  function?: string;
  lineno?: number;
  colno?: number;
}

export interface SentryExceptionValue {
  type?: string;
  value?: string;
  stacktrace?: {
    frames?: SentryStackFrame[];
  };
}

export interface SentryErrorEventLike {
  event_id?: string;
  message?: string;
  exception?: {
    values?: SentryExceptionValue[];
  };
  stacktrace?: {
    frames?: SentryStackFrame[];
  };
  [key: string]: any;
}

export interface SentryTransactionEventLike {
  transaction?: string;
  timestamp?: number;
  start_timestamp?: number;
  contexts?: {
    trace?: {
      op?: string;
      [key: string]: any;
    };
    [key: string]: any;
  };
  measurements?: {
    lcp?: { value: number; unit?: string };
    fcp?: { value: number; unit?: string };
    ttfb?: { value: number; unit?: string };
    inp?: { value: number; unit?: string };
    cls?: { value: number; unit?: string };
    [key: string]: { value: number; unit?: string } | undefined;
  };
  [key: string]: any;
}

export interface SentryNoiseFilterOptions {
  customIgnoreErrors?: Array<string | RegExp>;
  customDenyUrls?: Array<string | RegExp>;
  bridgeToClarity?: boolean;
}

function matchesPattern(text: string | undefined, patterns: Array<string | RegExp>): boolean {
  if (!text || typeof text !== 'string') return false;
  return patterns.some((pattern) =>
    typeof pattern === 'string' ? text.includes(pattern) : pattern.test(text)
  );
}

/**
 * Checks if a Sentry error event originates from injected webview scripts,
 * known third-party browser noise, or browser extensions.
 */
export function shouldDropSentryEvent(
  event: SentryErrorEventLike | null | undefined,
  options?: SentryNoiseFilterOptions
): boolean {
  if (!event) return false;

  const ignoreErrors = [
    ...DEFAULT_SENTRY_IGNORE_ERRORS,
    ...(options?.customIgnoreErrors || []),
  ];

  const denyUrls = [
    ...DEFAULT_SENTRY_DENY_URLS,
    ...(options?.customDenyUrls || []),
  ];

  // 1. Check top-level message
  if (matchesPattern(event.message, ignoreErrors)) {
    return true;
  }

  // 2. Check exception values (type and error message)
  const exceptionValues = event.exception?.values;
  if (Array.isArray(exceptionValues)) {
    for (const ex of exceptionValues) {
      if (
        matchesPattern(ex.value, ignoreErrors) ||
        matchesPattern(ex.type, ignoreErrors)
      ) {
        return true;
      }

      // Check stack frames under each exception
      const frames = ex.stacktrace?.frames;
      if (Array.isArray(frames)) {
        for (const frame of frames) {
          if (
            matchesPattern(frame.filename, denyUrls) ||
            matchesPattern(frame.abs_path, denyUrls)
          ) {
            return true;
          }
        }
      }
    }
  }

  // 3. Check top-level stacktrace frames
  const topFrames = event.stacktrace?.frames;
  if (Array.isArray(topFrames)) {
    for (const frame of topFrames) {
      if (
        matchesPattern(frame.filename, denyUrls) ||
        matchesPattern(frame.abs_path, denyUrls)
      ) {
        return true;
      }
    }
  }

  return false;
}

export const shouldIgnoreSentryErrorEvent = shouldDropSentryEvent;

/**
 * Bridges Sentry Event ID to Microsoft Clarity session replay tag.
 */
export function bridgeSentryToClarity(eventId?: string): void {
  if (!eventId || typeof window === 'undefined') return;

  try {
    const clarity = (window as any).clarity;
    if (typeof clarity === 'function') {
      clarity('set', 'sentry_event_id', eventId);
    }
  } catch {
    // Graceful swallow
  }
}

export interface DeferredWebVitalsBackfillOptions {
  getEarlyLcpMs?: () => number | undefined;
  getEarlyCls?: () => number | undefined;
  getEarlyFcpMs?: () => number | undefined;
  getEarlyTtfbMs?: () => number | undefined;
}

export interface SentryTransactionFilterOptions extends DeferredWebVitalsBackfillOptions {
  maxDurationMs?: number;
  filterBackgroundTabs?: boolean;
  clampThresholds?: {
    lcp?: number;
    fcp?: number;
    ttfb?: number;
    inp?: number;
  };
  enrichDeferredWebVitals?: boolean;
}

/**
 * Backfills missing Core Web Vitals (LCP, CLS, TTFB, FCP) into Sentry pageload transactions
 * when Sentry is loaded lazily via requestIdleCallback.
 */
export function enrichDeferredWebVitals(
  event: SentryTransactionEventLike,
  options?: DeferredWebVitalsBackfillOptions
): SentryTransactionEventLike {
  if (!event) return event;

  const isPageload =
    event.contexts?.trace?.op === 'pageload' ||
    event.transaction === '/' ||
    (typeof event.transaction === 'string' && event.transaction.startsWith('/'));

  if (!isPageload) return event;

  event.measurements = event.measurements || {};

  // 1. LCP backfill
  if (event.measurements.lcp?.value === undefined) {
    const customLcp = options?.getEarlyLcpMs?.();
    const globalLcp =
      typeof window !== 'undefined'
        ? ((window as any).__earlyLcpMs ?? (window as any).__winterArcLcpMs)
        : undefined;
    const lcpVal =
      typeof customLcp === 'number'
        ? customLcp
        : typeof globalLcp === 'number'
          ? globalLcp
          : undefined;
    if (lcpVal !== undefined) {
      event.measurements.lcp = { value: lcpVal, unit: 'millisecond' };
    }
  }

  // 2. CLS backfill
  if (event.measurements.cls?.value === undefined) {
    const customCls = options?.getEarlyCls?.();
    const globalCls =
      typeof window !== 'undefined'
        ? ((window as any).__earlyCls ?? (window as any).__winterArcCls)
        : undefined;
    const clsVal =
      typeof customCls === 'number'
        ? customCls
        : typeof globalCls === 'number'
          ? globalCls
          : 0;
    event.measurements.cls = { value: clsVal, unit: '' };
  }

  // 3. TTFB backfill
  if (event.measurements.ttfb?.value === undefined) {
    const customTtfb = options?.getEarlyTtfbMs?.();
    let ttfbVal = typeof customTtfb === 'number' ? customTtfb : undefined;
    if (
      ttfbVal === undefined &&
      typeof performance !== 'undefined' &&
      typeof performance.getEntriesByType === 'function'
    ) {
      const nav = performance.getEntriesByType('navigation')[0] as
        | PerformanceNavigationTiming
        | undefined;
      if (nav && nav.responseStart > 0) {
        ttfbVal = nav.responseStart;
      }
    }
    if (ttfbVal !== undefined) {
      event.measurements.ttfb = { value: ttfbVal, unit: 'millisecond' };
    }
  }

  // 4. FCP backfill
  if (event.measurements.fcp?.value === undefined) {
    const customFcp = options?.getEarlyFcpMs?.();
    let fcpVal = typeof customFcp === 'number' ? customFcp : undefined;
    if (
      fcpVal === undefined &&
      typeof performance !== 'undefined' &&
      typeof performance.getEntriesByType === 'function'
    ) {
      const fcpEntry = performance
        .getEntriesByType('paint')
        .find((e) => e.name === 'first-contentful-paint');
      if (fcpEntry && fcpEntry.startTime > 0) {
        fcpVal = fcpEntry.startTime;
      }
    }
    if (fcpVal !== undefined) {
      event.measurements.fcp = { value: fcpVal, unit: 'millisecond' };
    }
  }

  return event;
}

/**
 * Evaluates whether a Sentry transaction event should be dropped due to:
 * - Runaway execution (> maxDurationMs, default 28s).
 * - Background tab CWV distortion (visibilityState === 'hidden').
 * - Anomalous outlier measurements.
 */
export function filterSentryTransaction(
  event: SentryTransactionEventLike | null | undefined,
  options?: SentryTransactionFilterOptions
): SentryTransactionEventLike | null {
  if (!event) return null;

  if (options?.enrichDeferredWebVitals) {
    enrichDeferredWebVitals(event, options);
  }

  const maxDuration = options?.maxDurationMs ?? 28000;
  const durationMs =
    event.timestamp && event.start_timestamp
      ? (event.timestamp - event.start_timestamp) * 1000
      : 0;

  if (durationMs >= maxDuration) {
    return null;
  }

  const filterBackground = options?.filterBackgroundTabs ?? true;
  if (filterBackground) {
    const isHidden =
      (typeof document !== 'undefined' && document.visibilityState === 'hidden') ||
      (typeof window !== 'undefined' &&
        Boolean((window as any).__wasHidden || (window as any).__winterArcWasHidden));
    const measurements = event.measurements;
    if (
      isHidden &&
      measurements &&
      (measurements.lcp || measurements.fcp || measurements.ttfb)
    ) {
      return null;
    }
  }

  const thresholds = {
    lcp: 10000,
    fcp: 10000,
    ttfb: 8000,
    inp: 5000,
    ...(options?.clampThresholds || {}),
  };

  const lcp = event.measurements?.lcp?.value;
  const fcp = event.measurements?.fcp?.value;
  const ttfb = event.measurements?.ttfb?.value;
  const inp = event.measurements?.inp?.value;

  if (
    (typeof lcp === 'number' && lcp > thresholds.lcp) ||
    (typeof fcp === 'number' && fcp > thresholds.fcp) ||
    (typeof ttfb === 'number' && ttfb > thresholds.ttfb) ||
    (typeof inp === 'number' && inp > thresholds.inp)
  ) {
    return null;
  }

  return event;
}

/**
 * Creates a ready-to-use Sentry beforeSend hook.
 */
export function createSentryBeforeSend(
  options?: SentryNoiseFilterOptions
): (event: SentryErrorEventLike) => SentryErrorEventLike | null {
  const bridgeClarity = options?.bridgeToClarity ?? true;

  return (event: SentryErrorEventLike) => {
    if (shouldDropSentryEvent(event, options)) {
      return null;
    }

    if (bridgeClarity && event?.event_id) {
      bridgeSentryToClarity(event.event_id);
    }

    return event;
  };
}

/**
 * Creates a ready-to-use Sentry beforeSendTransaction hook.
 */
export function createSentryBeforeSendTransaction(
  options?: SentryTransactionFilterOptions
): (event: SentryTransactionEventLike) => SentryTransactionEventLike | null {
  return (event: SentryTransactionEventLike) => {
    return filterSentryTransaction(event, options);
  };
}
