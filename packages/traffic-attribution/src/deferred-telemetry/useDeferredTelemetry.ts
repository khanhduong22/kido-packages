import { useEffect, useRef, useState } from 'react';
import type { DeferredTelemetryConfig } from './types';
import {
  setupInteractionLoader,
  isTelemetryLoaded,
  trackEvent,
  trackPageView,
  trackClarity,
  trackMetaPixel,
} from './core';

export interface UseDeferredTelemetryReturn {
  isLoaded: boolean;
  trackEvent: typeof trackEvent;
  trackPageView: typeof trackPageView;
  trackClarity: typeof trackClarity;
  trackMetaPixel: typeof trackMetaPixel;
}

/**
 * React hook to safely initialize Zero-TBT Deferred Telemetry in Client Components.
 *
 * Automatically:
 * 1. Prepares window.dataLayer, window.clarity, and window.fbq queues immediately for zero event loss.
 * 2. Listens for the user's first interaction ('scroll', 'touchstart', 'pointerdown', 'keydown', 'wheel').
 * 3. Defers script loading until interaction occurs (pure interaction-only by default for 0ms TBT).
 */
export function useDeferredTelemetry(
  config: DeferredTelemetryConfig = {}
): UseDeferredTelemetryReturn {
  const [loaded, setLoaded] = useState(() => isTelemetryLoaded());
  const configRef = useRef(config);
  configRef.current = config;

  useEffect(() => {
    const wrappedConfig: DeferredTelemetryConfig = {
      ...configRef.current,
      onLoaded: () => {
        setLoaded(true);
        configRef.current.onLoaded?.();
      },
    };

    const cleanup = setupInteractionLoader(wrappedConfig);

    if (isTelemetryLoaded()) {
      setLoaded(true);
    }

    return () => {
      cleanup();
    };
  }, [
    config.gaId,
    config.gtmId,
    config.clarityId,
    config.metaPixelId,
    config.timeoutMs,
    config.delayMs,
    config.disabled,
  ]);

  return {
    isLoaded: loaded,
    trackEvent,
    trackPageView,
    trackClarity,
    trackMetaPixel,
  };
}
