// Components
export { VersionGuardBanner, VersionGuardBanner as VersionGuardBannerComponent } from './components/VersionGuardBanner';
export { WhatsNewModal, WhatsNewModal as WhatsNewModalComponent, DEFAULT_WHATS_NEW_STORAGE_KEY } from './components/WhatsNewModal';

// Hooks
export { useAppVersionGuard, useAppVersionGuard as useAppVersionGuardHook } from './hooks/useAppVersionGuard';

// Headless Checker & Cache Utilities
export {
  checkSpaVersion,
  cleanBrowserCaches,
  updateServiceWorkers,
  isVersionNewer,
  compareSemver,
  parseSemver,
  isCooldownActive,
  markReloadAttempt,
  clearReloadAttempt,
  shouldBypassVersionCheck,
  DEFAULT_ENDPOINT,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_INITIAL_DELAY_MS,
  DEFAULT_RELOAD_DELAY_MS,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_FETCH_TIMEOUT_MS,
  DEFAULT_BYPASS_KEYS,
} from './checker';

// Vite Plugin
export { viteVersionPlugin, viteVersionPlugin as viteVersionPluginDefault } from './vite-plugin';

// Types
export type {
  VersionChangeItem,
  VersionRelease,
  VersionFileInfo,
  VersionGuardBypassKeys,
  CheckSpaVersionOptions,
  VersionGuardConfig,
  VersionCheckResult,
  UseAppVersionGuardOptions,
  UseAppVersionGuardReturn,
  VersionGuardBannerProps,
  WhatsNewModalProps,
  ViteVersionPluginOptions,
} from './types';
export type { SpaVersionPluginOutput } from './vite-plugin';

// PWA SWR Guard, 404 Self-Heal SW, 0ms Preloadable Cache, Zero-CLS Font & Zombie Auth Guard
export * from './pwa-swr';

