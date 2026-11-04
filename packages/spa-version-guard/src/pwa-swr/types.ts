export interface SwrServiceWorkerConfig {
  /** Cache Storage bucket versioned name (e.g. 'winter-arc-v13') */
  cacheName: string;
  /** Offline fallback HTML route (default: '/offline.html') */
  offlineFallbackUrl?: string;
  /** Core static assets to precache during Service Worker install */
  precacheAssets?: string[];
  /** Primary HTML shell routes to warm non-blockingly on activate */
  warmShellRoutes?: string[];
  /** Route prefixes whose query strings are stripped for canonical HTML caching */
  canonicalPathPrefixes?: string[];
  /** Immutable hashed asset prefixes eligible for 404 Self-Healing & zero background revalidation */
  immutableChunkPrefixes?: string[];
  /** API or backend path prefixes that must NEVER be intercepted by the Service Worker */
  bypassPathPrefixes?: string[];
  /** External/analytics hostnames that must NEVER be intercepted by the Service Worker */
  bypassHostnames?: string[];
  /** Enable browser NavigationPreload on activate (default: true) */
  enableNavigationPreload?: boolean;
}

export interface PreloadableTriggerHandlers {
  onPointerEnter: () => void;
  onTouchStart: () => void;
  onFocus: () => void;
}

export interface PreloadableResource<T> extends PreloadableTriggerHandlers {
  /** Starts loading the module or returns the existing in-flight/resolved promise */
  preload: () => Promise<T>;
  /** Returns the resolved resource synchronously in 0ms if already preloaded, or null */
  getSync: () => T | null;
  /** Returns true when the resource has finished loading into memory */
  isLoaded: () => boolean;
  /** Resets the cached resource and in-flight state */
  reset: () => void;
  /** Spreadable React/DOM interaction props to trigger preload on hover/touch/focus */
  triggerHandlers: PreloadableTriggerHandlers;
}

export interface FontSubsetDefinition {
  /** Optional subset label (e.g. 'vietnamese', 'latin') */
  name?: string;
  /** URL to the subset woff2 font file */
  srcUrl: string;
  /** Font format (default: 'woff2') */
  format?: string;
  /** Optional unicode-range descriptor */
  unicodeRange?: string;
  /** Font weight range (default: '100 900') */
  fontWeight?: string;
  /** Font style (default: 'normal') */
  fontStyle?: string;
}

export interface FontMetricPreset {
  fallbackFamilyName: string;
  localFontSource: string;
  ascentOverride: string;
  descentOverride: string;
  lineGapOverride: string;
  sizeAdjust: string;
}

export interface FontMetricOverrideConfig {
  /** Primary web font family name (e.g. 'Inter') */
  fontFamily: string;
  /** Fallback @font-face name (default: `${fontFamily} Fallback`) */
  fallbackFamilyName?: string;
  /** Local system font used as metric-calibrated fallback (default: 'Arial') */
  localFontSource?: string;
  /** Calibrated ascent-override percentage (e.g. '90.44%') */
  ascentOverride: string;
  /** Calibrated descent-override percentage (e.g. '22.52%') */
  descentOverride: string;
  /** Calibrated line-gap-override percentage (e.g. '0.00%') */
  lineGapOverride: string;
  /** Calibrated size-adjust percentage (e.g. '107.12%') */
  sizeAdjust: string;
  /** Font display strategy (default: 'optional' for Zero-CLS) */
  fontDisplay?: 'optional' | 'swap' | 'fallback' | 'block' | 'auto';
  /** Optional CSS variable name (e.g. '--font-inter') */
  cssVariableName?: string;
  /** Optional woff2 subsets to emit before the fallback @font-face rule */
  subsets?: FontSubsetDefinition[];
}

export interface StorageLike {
  getItem(key: string): string | null;
  removeItem(key: string): void;
  setItem?(key: string, value: string): void;
}

export interface ZombieAuthHealOptions {
  /** LocalStorage keys storing optimistic user/session snapshots */
  storageKeys: string[];
  /** Custom Storage implementation (defaults to globalThis.localStorage if available) */
  storage?: StorageLike;
  /** Optional auth hint cookies to expire when zombie state is detected */
  cookieNames?: string[];
  /** Optional cookie domains to expire */
  cookieDomains?: string[];
  /** HTTP status code from `/auth/me` or session verification endpoint */
  status?: number;
  /** Explicit authentication flag returned by backend payload */
  isAuthenticated?: boolean;
  /** Callback invoked with the list of removed keys */
  onPurged?: (purgedKeys: string[]) => void;
}
