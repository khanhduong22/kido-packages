import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import {
  initDataLayer,
  initClarityQueue,
  initMetaPixelQueue,
  loadScript,
  setupInteractionLoader,
  triggerDeferredLoad,
  getTelemetryState,
  isTelemetryLoaded,
  trackEvent,
  trackPageView,
  trackClarity,
  trackMetaPixel,
  resetTelemetryState,
  DEFAULT_DEFERRED_EVENTS,
  useDeferredTelemetry,
  DeferredTelemetryProvider,
  useTelemetry,
} from './index';
import React from 'react';

// Minimal DOM Mock for Bun test environment
interface MockElement {
  tagName: string;
  id?: string;
  src?: string;
  async?: boolean;
  parentNode?: any;
  children: MockElement[];
  appendChild: (child: MockElement) => MockElement;
}

function createMockElement(tagName: string): MockElement {
  const children: MockElement[] = [];
  return {
    tagName: tagName.toUpperCase(),
    children,
    appendChild: (child: MockElement) => {
      children.push(child);
      child.parentNode = this;
      return child;
    },
  };
}

describe('@kido/deferred-telemetry Test Suite', () => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;

  let headElement: MockElement;
  let eventListeners: Map<string, Set<(e: any) => void>>;
  let elementsById: Map<string, MockElement>;

  beforeEach(() => {
    resetTelemetryState();

    headElement = createMockElement('head');
    eventListeners = new Map();
    elementsById = new Map();

    const mockWindow: any = {
      location: { pathname: '/dashboard', search: '' },
      addEventListener: (type: string, listener: any) => {
        if (!eventListeners.has(type)) {
          eventListeners.set(type, new Set());
        }
        eventListeners.get(type)!.add(listener);
      },
      removeEventListener: (type: string, listener: any) => {
        eventListeners.get(type)?.delete(listener);
      },
      dispatchEvent: (event: { type: string }) => {
        const listeners = eventListeners.get(event.type);
        if (listeners) {
          for (const fn of Array.from(listeners)) {
            fn(event);
          }
        }
      },
    };

    const mockDocument: any = {
      title: 'Dashboard Page',
      head: headElement,
      getElementsByTagName: (tag: string) => {
        if (tag.toLowerCase() === 'head') return [headElement];
        return [];
      },
      getElementById: (id: string) => elementsById.get(id) ?? null,
      querySelector: (selector: string) => {
        // Simple match for script[src="..."]
        const match = selector.match(/script\[src="(.+?)"\]/);
        if (match) {
          const src = match[1];
          return headElement.children.find((el) => el.src === src) ?? null;
        }
        return null;
      },
      createElement: (tag: string) => {
        const el = createMockElement(tag);
        let proxy: any;
        proxy = new Proxy(el, {
          set(target, prop, value) {
            (target as any)[prop] = value;
            if (prop === 'id' && typeof value === 'string') {
              elementsById.set(value, proxy);
            }
            return true;
          },
        });
        return proxy;
      },
    };

    (globalThis as any).window = mockWindow;
    (globalThis as any).document = mockDocument;
  });

  afterEach(() => {
    resetTelemetryState();
    (globalThis as any).window = originalWindow;
    (globalThis as any).document = originalDocument;
  });

  describe('1. Lossless Queue Initialization', () => {
    it('initializes window.dataLayer and window.gtag', () => {
      const dataLayer = initDataLayer();
      expect(dataLayer).toBeArray();
      expect(window.dataLayer).toBe(dataLayer);
      expect(typeof window.gtag).toBe('function');
    });

    it('pushes arguments to dataLayer when window.gtag is called', () => {
      initDataLayer();
      window.gtag!('event', 'user_signup', { method: 'google' });

      expect(window.dataLayer!.length).toBe(1);
      const firstArg = window.dataLayer![0];
      expect(firstArg[0]).toBe('event');
      expect(firstArg[1]).toBe('user_signup');
      expect(firstArg[2]).toEqual({ method: 'google' });
    });

    it('queues GA4 config when gaId is provided', () => {
      initDataLayer('G-TEST12345');
      expect(window.dataLayer!.length).toBe(2);
      expect(window.dataLayer![0][0]).toBe('js');
      expect(window.dataLayer![1][0]).toBe('config');
      expect(window.dataLayer![1][1]).toBe('G-TEST12345');
    });

    it('queues GTM start event when gtmId is provided', () => {
      initDataLayer(undefined, 'GTM-TEST999');
      const gtmEntry = window.dataLayer!.find((item: any) => item.event === 'gtm.js');
      expect(gtmEntry).toBeDefined();
      expect(gtmEntry['gtm.start']).toBeNumber();
    });

    it('initializes Microsoft Clarity queue with window.clarity.q', () => {
      initClarityQueue();
      expect(typeof window.clarity).toBe('function');
      expect(window.clarity!.q).toBeArray();

      window.clarity!('set', 'plan', 'enterprise');
      expect(window.clarity!.q!.length).toBe(1);
      expect(window.clarity!.q![0][0]).toBe('set');
      expect(window.clarity!.q![0][1]).toBe('plan');
      expect(window.clarity!.q![0][2]).toBe('enterprise');
    });

    it('initializes Meta Pixel queue with window.fbq.queue', () => {
      initMetaPixelQueue('1234567890');
      expect(typeof window.fbq).toBe('function');
      expect(window.fbq!.queue).toBeArray();
      expect(window.fbq!.loaded).toBe(true);

      // Meta Pixel automatically queues 'init' and 'track PageView'
      expect(window.fbq!.queue!.length).toBe(2);
      expect(window.fbq!.queue![0][0]).toBe('init');
      expect(window.fbq!.queue![0][1]).toBe('1234567890');
      expect(window.fbq!.queue![1][0]).toBe('track');
      expect(window.fbq!.queue![1][1]).toBe('PageView');

      // Custom tracking call
      window.fbq!('track', 'AddToCart', { currency: 'USD', value: 49.99 });
      expect(window.fbq!.queue!.length).toBe(3);
    });
  });

  describe('2. External Script Injection (loadScript)', () => {
    it('creates and appends script tag to document.head', () => {
      const script = loadScript('https://example.com/test.js', 'test-script');
      expect(script).not.toBeNull();
      expect(script!.src).toBe('https://example.com/test.js');
      expect(script!.id).toBe('test-script');
      expect(script!.async).toBe(true);
      expect(headElement.children.length).toBe(1);
    });

    it('deduplicates scripts with the same ID', () => {
      const script1 = loadScript('https://example.com/test.js', 'shared-id');
      const script2 = loadScript('https://example.com/different.js', 'shared-id');
      expect(script1).toBe(script2);
      expect(headElement.children.length).toBe(1);
    });

    it('deduplicates scripts with the same src', () => {
      const script1 = loadScript('https://example.com/same.js');
      const script2 = loadScript('https://example.com/same.js');
      expect(script1).toBe(script2);
      expect(headElement.children.length).toBe(1);
    });
  });

  describe('3. Zero-TBT Pure Interaction-Driven Telemetry', () => {
    it('attaches listeners to default interaction events', () => {
      setupInteractionLoader({ gaId: 'G-123' });

      for (const eventName of DEFAULT_DEFERRED_EVENTS) {
        expect(eventListeners.has(eventName)).toBe(true);
        expect(eventListeners.get(eventName)!.size).toBe(1);
      }
    });

    it('does NOT load scripts if no user interaction occurs (pure interaction default)', async () => {
      setupInteractionLoader({
        gaId: 'G-123',
        clarityId: 'clarity-abc',
        gtmId: 'GTM-xyz',
      });

      // No interaction simulated
      expect(isTelemetryLoaded()).toBe(false);
      expect(headElement.children.length).toBe(0);

      // Even waiting a tick, still no scripts injected
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(isTelemetryLoaded()).toBe(false);
      expect(headElement.children.length).toBe(0);
    });

    it('loads scripts immediately upon user interaction (e.g. scroll)', () => {
      const onLoaded = mock(() => {});
      setupInteractionLoader({
        gaId: 'G-12345',
        clarityId: 'clarity-test',
        metaPixelId: 'pixel-999',
        gtmId: 'GTM-test',
        onLoaded,
      });

      expect(isTelemetryLoaded()).toBe(false);
      expect(headElement.children.length).toBe(0);

      // Simulate user scroll
      window.dispatchEvent({ type: 'scroll' });

      expect(isTelemetryLoaded()).toBe(true);
      expect(onLoaded).toHaveBeenCalledTimes(1);

      // Verify scripts injected: GA4, GTM, Clarity, Meta Pixel = 4 scripts
      expect(headElement.children.length).toBe(4);

      // Check GA4 script
      const gaScript = headElement.children.find((s) => s.id === 'ga4-deferred-script');
      expect(gaScript).toBeDefined();
      expect(gaScript!.src).toContain('G-12345');

      // Check Clarity script
      const clarityScript = headElement.children.find((s) => s.id === 'clarity-deferred-script');
      expect(clarityScript).toBeDefined();
      expect(clarityScript!.src).toContain('clarity-test');

      // Check GTM script
      const gtmScript = headElement.children.find((s) => s.id === 'gtm-deferred-script');
      expect(gtmScript).toBeDefined();
      expect(gtmScript!.src).toContain('GTM-test');

      // Check Meta Pixel script
      const pixelScript = headElement.children.find((s) => s.id === 'meta-pixel-deferred-script');
      expect(pixelScript).toBeDefined();
    });

    it('loads scripts on touchstart or keydown interaction', () => {
      setupInteractionLoader({ gaId: 'G-TOUCH' });
      expect(isTelemetryLoaded()).toBe(false);

      window.dispatchEvent({ type: 'touchstart' });
      expect(isTelemetryLoaded()).toBe(true);
      expect(headElement.children.length).toBe(1);
    });

    it('cleans up event listeners after the first interaction trigger', () => {
      setupInteractionLoader({ gaId: 'G-CLEANUP' });

      window.dispatchEvent({ type: 'pointerdown' });
      expect(isTelemetryLoaded()).toBe(true);

      // Listeners should be cleared
      for (const eventName of DEFAULT_DEFERRED_EVENTS) {
        expect(eventListeners.get(eventName)?.size ?? 0).toBe(0);
      }
    });

    it('executes lazy Sentry initialization upon interaction', async () => {
      let sentryInitialized = false;
      const sentryInit = mock(async () => {
        sentryInitialized = true;
      });

      setupInteractionLoader({
        gaId: 'G-SENTRY',
        sentryInit,
      });

      expect(sentryInitialized).toBe(false);

      window.dispatchEvent({ type: 'keydown' });
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(sentryInitialized).toBe(true);
      expect(sentryInit).toHaveBeenCalledTimes(1);
    });

    it('handles Sentry init errors gracefully without crashing', async () => {
      const sentryInit = mock(() => {
        throw new Error('Sentry network failure');
      });

      setupInteractionLoader({
        gaId: 'G-FAIL',
        sentryInit,
      });

      // Should not throw
      expect(() => {
        window.dispatchEvent({ type: 'wheel' });
      }).not.toThrow();

      expect(isTelemetryLoaded()).toBe(true);
    });
  });

  describe('4. Optional Fallback Timeout', () => {
    it('triggers script load when timeoutMs is explicitly provided and no interaction occurs', async () => {
      setupInteractionLoader({
        gaId: 'G-TIMEOUT',
        timeoutMs: 30, // 30ms explicit fallback
      });

      expect(isTelemetryLoaded()).toBe(false);
      expect(headElement.children.length).toBe(0);

      // Wait for timer to expire
      await new Promise((resolve) => setTimeout(resolve, 60));

      expect(isTelemetryLoaded()).toBe(true);
      expect(headElement.children.length).toBe(1);
    });

    it('cancels timeout if user interaction happens first', async () => {
      const onLoaded = mock(() => {});
      setupInteractionLoader({
        gaId: 'G-EARLY',
        timeoutMs: 50,
        onLoaded,
      });

      // Immediate user interaction at 5ms
      window.dispatchEvent({ type: 'scroll' });
      expect(isTelemetryLoaded()).toBe(true);
      expect(onLoaded).toHaveBeenCalledTimes(1);

      // Wait past original timeout
      await new Promise((resolve) => setTimeout(resolve, 70));
      // Should not fire again
      expect(onLoaded).toHaveBeenCalledTimes(1);
    });
  });

  describe('5. Tracking Helpers & Lossless Pre-Load Queueing', () => {
    it('trackEvent pushes to dataLayer even before script load', () => {
      trackEvent('add_to_cart', { item_id: 'SKU_100', price: 250000 });
      expect(window.dataLayer!.length).toBe(1);
      const call = window.dataLayer![0];
      expect(call[0]).toBe('event');
      expect(call[1]).toBe('add_to_cart');
      expect(call[2]).toEqual({ item_id: 'SKU_100', price: 250000 });
    });

    it('trackPageView captures current pathname and title', () => {
      trackPageView('/checkout', 'Checkout Order');
      expect(window.dataLayer!.length).toBe(1);
      const call = window.dataLayer![0];
      expect(call[0]).toBe('event');
      expect(call[1]).toBe('page_view');
      expect(call[2].page_path).toBe('/checkout');
      expect(call[2].page_title).toBe('Checkout Order');
    });

    it('trackClarity pushes to window.clarity.q', () => {
      trackClarity('setTag', 'vip_tier');
      expect(window.clarity!.q!.length).toBe(1);
      expect(window.clarity!.q![0][0]).toBe('setTag');
      expect(window.clarity!.q![0][1]).toBe('vip_tier');
    });

    it('trackMetaPixel pushes to window.fbq.queue', () => {
      trackMetaPixel('InitiateCheckout', { num_items: 3 });
      const calls = window.fbq!.queue!;
      const match = calls.find((c: any) => c[0] === 'track' && c[1] === 'InitiateCheckout');
      expect(match).toBeDefined();
      expect(match[2]).toEqual({ num_items: 3 });
    });
  });

  describe('6. Teardown, Disabled Mode & Direct triggerDeferredLoad', () => {
    it('cleanup function removes all event listeners and timers', () => {
      const cleanup = setupInteractionLoader({ gaId: 'G-TEARDOWN', timeoutMs: 100 });

      // Before cleanup: listeners active
      expect(eventListeners.get('scroll')?.size).toBe(1);

      // Invoke cleanup
      cleanup();

      // Listeners removed
      for (const eventName of DEFAULT_DEFERRED_EVENTS) {
        expect(eventListeners.get(eventName)?.size ?? 0).toBe(0);
      }

      // Dispatching event now should not load scripts
      window.dispatchEvent({ type: 'scroll' });
      expect(isTelemetryLoaded()).toBe(false);
    });

    it('disabled config option skips all initialization', () => {
      const cleanup = setupInteractionLoader({ gaId: 'G-DISABLED', disabled: true });
      expect(eventListeners.size).toBe(0);
      expect(isTelemetryLoaded()).toBe(false);
      expect(cleanup).toBeFunction();
    });

    it('triggerDeferredLoad can be invoked directly', async () => {
      await triggerDeferredLoad({ gaId: 'G-DIRECT' });
      expect(isTelemetryLoaded()).toBe(true);
      expect(headElement.children.length).toBe(1);

      // Second direct call does not duplicate
      await triggerDeferredLoad({ gaId: 'G-DIRECT' });
      expect(headElement.children.length).toBe(1);
    });

    it('getTelemetryState reports accurate state', () => {
      expect(getTelemetryState().isLoaded).toBe(false);
      expect(getTelemetryState().isQueueReady).toBe(false);

      initDataLayer();
      expect(getTelemetryState().isQueueReady).toBe(true);

      setupInteractionLoader({ gaId: 'G-STATE' });
      window.dispatchEvent({ type: 'scroll' });
      expect(getTelemetryState().isLoaded).toBe(true);
    });
  });

  describe('7. React Integration (useDeferredTelemetry & DeferredTelemetryProvider)', () => {
    it('initializes useDeferredTelemetry inside a component tree without throwing', async () => {
      const { renderToString } = await import('react-dom/server');

      let capturedResult: any;
      function TestComponent() {
        capturedResult = useDeferredTelemetry({ gaId: 'G-REACT' });
        return React.createElement('div', { 'data-loaded': String(capturedResult.isLoaded) }, 'Telemetry Component');
      }

      const html = renderToString(React.createElement(TestComponent));
      expect(html).toContain('data-loaded="false"');
      expect(html).toContain('Telemetry Component');
      expect(capturedResult).toBeDefined();
      expect(capturedResult.isLoaded).toBe(false);
      expect(typeof capturedResult.trackEvent).toBe('function');
      expect(typeof capturedResult.trackPageView).toBe('function');
      expect(typeof capturedResult.trackClarity).toBe('function');
      expect(typeof capturedResult.trackMetaPixel).toBe('function');
    });

    it('DeferredTelemetryProvider renders React children and provides context hook', async () => {
      const { renderToString } = await import('react-dom/server');

      let contextValue: any;
      function ChildComponent() {
        contextValue = useTelemetry();
        return React.createElement('span', { id: 'inner-span' }, 'Inside Provider');
      }

      const tree = React.createElement(
        DeferredTelemetryProvider,
        { gaId: 'G-PROVIDER', clarityId: 'CLARITY-PROVIDER' },
        React.createElement(ChildComponent)
      );

      const html = renderToString(tree);
      expect(html).toContain('Inside Provider');
      expect(contextValue).toBeDefined();
      expect(typeof contextValue.trackEvent).toBe('function');
      expect(typeof contextValue.trackPageView).toBe('function');
      expect(typeof contextValue.trackClarity).toBe('function');
      expect(typeof contextValue.trackMetaPixel).toBe('function');
    });
  });
});
