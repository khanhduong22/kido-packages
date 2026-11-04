import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import {
  shouldDropSentryEvent,
  filterSentryTransaction,
  enrichDeferredWebVitals,
  bridgeSentryToClarity,
  createSentryBeforeSend,
  createSentryBeforeSendTransaction,
  DEFAULT_SENTRY_IGNORE_ERRORS,
  DEFAULT_SENTRY_DENY_URLS,
} from './index';

describe('Sentry Noise Filter & Performance Guard Test Suite', () => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;

  beforeEach(() => {
    // Setup clean window & document mocks
    (globalThis as any).window = {
      clarity: mock(() => {}),
    };
    (globalThis as any).document = {
      visibilityState: 'visible',
    };
  });

  afterEach(() => {
    (globalThis as any).window = originalWindow;
    (globalThis as any).document = originalDocument;
  });

  describe('1. Error Event Filtering (shouldDropSentryEvent)', () => {
    it('returns false for empty or null event', () => {
      expect(shouldDropSentryEvent(null)).toBe(false);
      expect(shouldDropSentryEvent(undefined)).toBe(false);
    });

    it('allows clean legitimate application errors', () => {
      const event = {
        message: 'Network request failed in checkout checkoutApi',
        exception: {
          values: [
            {
              type: 'FetchError',
              value: '500 Internal Server Error',
              stacktrace: {
                frames: [
                  { filename: 'https://app.khanhdp.com/static/js/main.js' },
                ],
              },
            },
          ],
        },
      };
      expect(shouldDropSentryEvent(event)).toBe(false);
    });

    it('drops events with Cốc Cốc ccbrMediaMenu error message', () => {
      const event = {
        message: 'Uncaught TypeError: ccbrMediaMenu.init is not a function',
      };
      expect(shouldDropSentryEvent(event)).toBe(true);
    });

    it('drops events with Zalo in-app webview zaloJSV2 injection error', () => {
      const event = {
        exception: {
          values: [
            {
              type: 'ReferenceError',
              value: 'zaloJSV2 is not defined',
            },
          ],
        },
      };
      expect(shouldDropSentryEvent(event)).toBe(true);
    });

    it('drops events with Cốc Cốc M_ID crash', () => {
      const event = {
        exception: {
          values: [
            {
              type: 'TypeError',
              value: "Cannot read properties of undefined (reading 'M_ID')",
            },
          ],
        },
      };
      expect(shouldDropSentryEvent(event)).toBe(true);
    });

    it('drops events originating from chrome-extension://', () => {
      const event = {
        message: 'Error inside extension content script',
        exception: {
          values: [
            {
              stacktrace: {
                frames: [
                  { filename: 'chrome-extension://abcdefghijklmnop/content.js' },
                ],
              },
            },
          ],
        },
      };
      expect(shouldDropSentryEvent(event)).toBe(true);
    });

    it('drops events originating from safari-extension:// and moz-extension://', () => {
      const safariEvent = {
        stacktrace: {
          frames: [
            { filename: 'safari-extension://xyz/injected.js' },
          ],
        },
      };
      expect(shouldDropSentryEvent(safariEvent)).toBe(true);

      const mozEvent = {
        stacktrace: {
          frames: [
            { abs_path: 'moz-extension://xyz/content.js' },
          ],
        },
      };
      expect(shouldDropSentryEvent(mozEvent)).toBe(true);
    });

    it('supports custom ignore errors and custom deny URLs', () => {
      const event1 = {
        message: 'ThirdPartyWidgetAborted',
      };
      expect(shouldDropSentryEvent(event1)).toBe(false);
      expect(
        shouldDropSentryEvent(event1, {
          customIgnoreErrors: [/ThirdPartyWidgetAborted/i],
        })
      ).toBe(true);

      const event2 = {
        stacktrace: {
          frames: [{ filename: 'https://cdn.thirdparty.com/tracker.js' }],
        },
      };
      expect(shouldDropSentryEvent(event2)).toBe(false);
      expect(
        shouldDropSentryEvent(event2, {
          customDenyUrls: [/thirdparty\.com/],
        })
      ).toBe(true);
    });
  });

  describe('2. Transaction & Performance Guard (filterSentryTransaction)', () => {
    it('returns null for null or undefined event', () => {
      expect(filterSentryTransaction(null)).toBe(null);
      expect(filterSentryTransaction(undefined)).toBe(null);
    });

    it('allows normal healthy transactions', () => {
      const event = {
        transaction: '/checkout',
        start_timestamp: 1000,
        timestamp: 1002, // 2s duration
        measurements: {
          lcp: { value: 1200 },
          fcp: { value: 800 },
          ttfb: { value: 150 },
          inp: { value: 45 },
        },
      };
      expect(filterSentryTransaction(event)).toEqual(event);
    });

    it('drops runaway transactions exceeding maxDurationMs', () => {
      const event = {
        transaction: '/dashboard',
        start_timestamp: 1000,
        timestamp: 1030, // 30s duration (> default 28s)
      };
      expect(filterSentryTransaction(event)).toBe(null);
    });

    it('drops transactions captured while tab was in background (hidden)', () => {
      (globalThis as any).document.visibilityState = 'hidden';

      const event = {
        transaction: '/',
        start_timestamp: 1000,
        timestamp: 1002,
        measurements: {
          lcp: { value: 2500 },
        },
      };
      expect(filterSentryTransaction(event)).toBe(null);
    });

    it('drops transactions with anomalous CWV measurements', () => {
      const anomalyEvent = {
        transaction: '/products',
        start_timestamp: 1000,
        timestamp: 1002,
        measurements: {
          lcp: { value: 15000 }, // > 10,000ms
        },
      };
      expect(filterSentryTransaction(anomalyEvent)).toBe(null);
    });
  });

  describe('3. Clarity Bridging & Hooks', () => {
    it('bridges Sentry event_id to window.clarity', () => {
      bridgeSentryToClarity('sentry-evt-12345');
      expect((globalThis as any).window.clarity).toHaveBeenCalledWith(
        'set',
        'sentry_event_id',
        'sentry-evt-12345'
      );
    });

    it('createSentryBeforeSend drops spam and bridges clean errors', () => {
      const beforeSend = createSentryBeforeSend();

      // Spam error
      const spamEvent = {
        event_id: 'spam-1',
        message: 'ccbrMediaMenu error',
      };
      expect(beforeSend(spamEvent)).toBe(null);

      // Clean error
      const cleanEvent = {
        event_id: 'clean-1',
        message: 'Real checkout error',
      };
      expect(beforeSend(cleanEvent)).toEqual(cleanEvent);
      expect((globalThis as any).window.clarity).toHaveBeenCalledWith(
        'set',
        'sentry_event_id',
        'clean-1'
      );
    });

    it('createSentryBeforeSendTransaction wraps transaction filtering', () => {
      const beforeSendTx = createSentryBeforeSendTransaction({ maxDurationMs: 5000 });
      const fastTx = { start_timestamp: 10, timestamp: 12 }; // 2s
      const slowTx = { start_timestamp: 10, timestamp: 20 }; // 10s

      expect(beforeSendTx(fastTx)).toEqual(fastTx);
      expect(beforeSendTx(slowTx)).toBe(null);
    });
  });

  describe('4. Deferred Core Web Vitals Backfill (enrichDeferredWebVitals)', () => {
    it('ignores non-pageload transactions', () => {
      const apiTx = {
        transaction: 'POST /api/checkout',
        contexts: { trace: { op: 'http.server' } },
        measurements: {},
      };
      const enriched = enrichDeferredWebVitals(apiTx);
      expect(enriched.measurements?.lcp).toBeUndefined();
      expect(enriched.measurements?.cls).toBeUndefined();
    });

    it('enriches missing LCP and CLS from global window metrics or custom getters', () => {
      (globalThis as any).window.__earlyLcpMs = 1250;
      (globalThis as any).window.__earlyCls = 0.02;

      const pageTx = {
        transaction: '/',
        contexts: { trace: { op: 'pageload' } },
        measurements: {},
      };

      const enriched = enrichDeferredWebVitals(pageTx);
      expect(enriched.measurements?.lcp?.value).toBe(1250);
      expect(enriched.measurements?.lcp?.unit).toBe('millisecond');
      expect(enriched.measurements?.cls?.value).toBe(0.02);
      expect(enriched.measurements?.cls?.unit).toBe('');
    });

    it('prefers custom getter over window globals', () => {
      (globalThis as any).window.__earlyLcpMs = 2500;

      const pageTx = {
        transaction: '/products',
        contexts: { trace: { op: 'pageload' } },
        measurements: {},
      };

      const enriched = enrichDeferredWebVitals(pageTx, {
        getEarlyLcpMs: () => 850,
        getEarlyCls: () => 0.01,
      });

      expect(enriched.measurements?.lcp?.value).toBe(850);
      expect(enriched.measurements?.cls?.value).toBe(0.01);
    });

    it('integrates seamlessly with filterSentryTransaction when enrichDeferredWebVitals is true', () => {
      (globalThis as any).window.__winterArcLcpMs = 1100;
      (globalThis as any).window.__winterArcCls = 0;

      const pageTx = {
        transaction: '/checkout',
        contexts: { trace: { op: 'pageload' } },
        start_timestamp: 100,
        timestamp: 101, // 1s
      };

      const result = filterSentryTransaction(pageTx, {
        enrichDeferredWebVitals: true,
      });

      expect(result).not.toBeNull();
      expect(result?.measurements?.lcp?.value).toBe(1100);
      expect(result?.measurements?.cls?.value).toBe(0);
    });
  });
});
