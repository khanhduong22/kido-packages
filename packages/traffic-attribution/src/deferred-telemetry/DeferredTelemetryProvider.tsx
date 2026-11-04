'use client';

import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { DeferredTelemetryConfig } from './types';
import {
  setupInteractionLoader,
  isTelemetryLoaded,
  trackEvent,
  trackPageView,
  trackClarity,
  trackMetaPixel,
} from './core';

export interface DeferredTelemetryContextValue {
  isLoaded: boolean;
  trackEvent: typeof trackEvent;
  trackPageView: typeof trackPageView;
  trackClarity: typeof trackClarity;
  trackMetaPixel: typeof trackMetaPixel;
}

const DeferredTelemetryContext = createContext<DeferredTelemetryContextValue>({
  isLoaded: false,
  trackEvent,
  trackPageView,
  trackClarity,
  trackMetaPixel,
});

export interface DeferredTelemetryProviderProps extends DeferredTelemetryConfig {
  children?: React.ReactNode;
}

/**
 * Client Component Provider for Next.js App Router and React SPAs.
 *
 * Automatically mounts Zero-TBT interaction-driven deferred telemetry.
 * Can be placed in RootLayout (`app/layout.tsx`) or App root.
 */
export function DeferredTelemetryProvider({
  children,
  ...config
}: DeferredTelemetryProviderProps): React.JSX.Element {
  const [loaded, setLoaded] = useState(() => isTelemetryLoaded());

  useEffect(() => {
    const wrappedConfig: DeferredTelemetryConfig = {
      ...config,
      onLoaded: () => {
        setLoaded(true);
        config.onLoaded?.();
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

  const value = useMemo<DeferredTelemetryContextValue>(
    () => ({
      isLoaded: loaded,
      trackEvent,
      trackPageView,
      trackClarity,
      trackMetaPixel,
    }),
    [loaded]
  );

  return (
    <DeferredTelemetryContext.Provider value={value}>
      {children}
    </DeferredTelemetryContext.Provider>
  );
}

/**
 * Hook to access telemetry utilities from within DeferredTelemetryProvider context.
 */
export function useTelemetry(): DeferredTelemetryContextValue {
  return useContext(DeferredTelemetryContext);
}
