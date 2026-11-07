import type { CSSProperties } from 'react';

/**
 * Item describing a single update or change in a release
 */
export interface VersionChangeItem {
  icon?: string;
  badge?: string;
  badgeColor?: string;
  title: string;
  description: string;
}

/**
 * Release metadata containing version tag, release date, and changelog items
 */
export interface VersionRelease {
  version: string;
  releaseDate: string;
  title: string;
  subtitle?: string;
  changes: VersionChangeItem[];
}

/**
 * Structure of the version.json file generated or fetched from server
 */
export interface VersionFileInfo {
  version: string;
  buildId?: string;
  buildTime?: string | number;
  gitCommit?: string;
  release?: VersionRelease;
  metadata?: Record<string, unknown>;
}

/**
 * Keys used for session / local storage bypass guards
 */
export interface VersionGuardBypassKeys {
  /**
   * LocalStorage key indicating a mock / test user session that should bypass version check
   * default: 'workspace_hub_mock_user'
   */
  mockUserKey?: string;
  /**
   * SessionStorage key indicating an ongoing login flow that should prevent interruption
   * default: 'is_logging_in'
   */
  isLoggingInKey?: string;
  /**
   * SessionStorage key storing the timestamp of the last reload triggered by version guard
   * default: 'last_version_reload_ts'
   */
  lastReloadTsKey?: string;
}

/**
 * Configuration options for checking SPA version
 */
export interface CheckSpaVersionOptions {
  /**
   * Server endpoint to fetch version info (e.g. '/version.json' or '/api/version')
   * default: '/version.json'
   */
  endpoint?: string;
  /**
   * Current version of the running client application
   */
  clientVersion: string;
  /**
   * Optional build ID of the client application
   */
  clientBuildId?: string;
  /**
   * Cooldown period in ms to prevent infinite reload loops
   * default: 300,000 (5 minutes)
   */
  cooldownMs?: number;
  /**
   * AbortSignal for the fetch request
   */
  signal?: AbortSignal;
  /**
   * Timeout in ms for the version fetch request
   * default: 5,000ms
   */
  fetchTimeoutMs?: number;
  /**
   * Whether to skip checking when document tab is hidden / not visible
   * default: true
   */
  checkVisibility?: boolean;
  /**
   * Custom storage bypass keys
   */
  bypassKeys?: VersionGuardBypassKeys;
  /**
   * Custom fetch implementation (useful for testing or custom auth/proxies)
   */
  customFetch?: typeof fetch;
}

/**
 * Alias for CheckSpaVersionOptions
 */
export type VersionGuardConfig = CheckSpaVersionOptions;

/**
 * Outcome of a version check
 */
export interface VersionCheckResult {
  hasNewVersion: boolean;
  clientVersion: string;
  clientBuildId?: string;
  serverVersion?: string;
  serverBuildId?: string;
  serverRelease?: VersionRelease;
  data?: VersionFileInfo;
  skipped?: boolean;
  skippedReason?:
    | 'not_visible'
    | 'cooldown'
    | 'mock_user'
    | 'logging_in'
    | 'fetch_error'
    | 'already_reloading'
    | 'disabled'
    | 'not_modified';
}

/**
 * Options for the useAppVersionGuard React hook
 */
export interface UseAppVersionGuardOptions {
  /**
   * Current version of the client app (fallback to window.__APP_BUILD_ID__ if defined)
   */
  clientVersion?: string;
  /**
   * Build ID of the client app
   */
  clientBuildId?: string;
  /**
   * Version file or API endpoint (default: '/version.json')
   */
  endpoint?: string;
  /**
   * Interval for periodic background polling in ms (default: 180,000 - 3 minutes)
   * Set to 0 or null to disable periodic polling
   */
  pollIntervalMs?: number;
  /**
   * Initial delay in ms before first check on mount to yield bandwidth to critical path (default: 3,000ms)
   */
  initialDelayMs?: number;
  /**
   * Delay in ms before reloading the window once a new version is confirmed (default: 1,500ms)
   */
  reloadDelayMs?: number;
  /**
   * Cooldown period in ms between reloads to prevent infinite reload loops (default: 300,000ms)
   */
  cooldownMs?: number;
  /**
   * Master enable flag (default: true)
   */
  enabled?: boolean;
  /**
   * Whether to automatically clean caches and reload window when new version is detected (default: true)
   */
  autoReload?: boolean;
  /**
   * Whether to delete all CacheStorage keys on update (default: true)
   */
  cleanCachesOnUpdate?: boolean;
  /**
   * Whether to trigger navigator.serviceWorker.update() on update (default: true)
   */
  updateServiceWorkerOnUpdate?: boolean;
  /**
   * Custom storage bypass keys
   */
  bypassKeys?: VersionGuardBypassKeys;
  /**
   * Callback fired when a new version is detected
   */
  onNewVersionDetected?: (result: VersionCheckResult) => void;
  /**
   * Hook callback called right before window reload (can return a promise to delay reload until resolved)
   */
  onBeforeReload?: () => void | Promise<void>;
  /**
   * Custom fetch function
   */
  customFetch?: typeof fetch;
}

/**
 * Return signature of useAppVersionGuard
 */
export interface UseAppVersionGuardReturn {
  /**
   * True when a newer version has been detected and reload is in progress
   */
  isUpdating: boolean;
  /**
   * True if a newer version exists on the server
   */
  hasNewVersion: boolean;
  /**
   * Server version string if detected
   */
  serverVersion: string | null;
  /**
   * Server build ID if detected
   */
  serverBuildId: string | null;
  /**
   * Server release details if returned
   */
  serverRelease: VersionRelease | null;
  /**
   * Manually trigger a version check
   */
  checkNow: () => Promise<VersionCheckResult>;
  /**
   * Manually clean caches, update service workers, and reload window
   */
  reloadNow: () => Promise<void>;
}

/**
 * Props for VersionGuardBanner component
 */
export interface VersionGuardBannerProps {
  /**
   * Whether the updating state is active (typically from useAppVersionGuard().isUpdating)
   */
  isUpdating: boolean;
  /**
   * Custom notification message
   * default: 'Đang cập nhật phiên bản mới nhất...'
   */
  message?: string;
  /**
   * Spinner border color
   */
  spinnerColor?: string;
  /**
   * Additional Tailwind / CSS class names
   */
  className?: string;
  /**
   * Inline style overrides
   */
  style?: CSSProperties;
  /**
   * Whether to display the spinner icon (default: true)
   */
  showSpinner?: boolean;
}

/**
 * Props for WhatsNewModal changelog dialog component
 */
export interface WhatsNewModalProps {
  /**
   * Release information to display
   */
  release?: VersionRelease;
  /**
   * Force the modal to open regardless of localStorage seen version
   */
  forceOpen?: boolean;
  /**
   * Controlled open state
   */
  isOpen?: boolean;
  /**
   * LocalStorage key to track seen version
   * default: 'kt_seen_app_version'
   */
  storageKey?: string;
  /**
   * Callback fired when modal is closed
   */
  onClose?: () => void;
  /**
   * Callback fired when action button is clicked (e.g. start tour)
   */
  onAction?: () => void;
  /**
   * Action button label (default: 'BẮT ĐẦU TRẢI NGHIỆM')
   */
  actionLabel?: string;
  /**
   * Custom modal title override
   */
  title?: string;
  /**
   * Additional dialog class names
   */
  className?: string;
}

/**
 * Options for Vite Version Plugin
 */
export interface ViteVersionPluginOptions {
  /**
   * Name of output version file (default: 'version.json')
   */
  fileName?: string;
  /**
   * Semantic version string (e.g. '1.2.0')
   */
  version?: string;
  /**
   * Unique build ID (defaults to timestamp or git commit hash)
   */
  buildId?: string;
  /**
   * Optional full changelog release info to embed in version.json
   */
  release?: VersionRelease;
  /**
   * Whether to automatically capture git commit hash, or custom commit string
   */
  gitCommit?: string | boolean;
  /**
   * Whether to include build timestamp in output (default: true)
   */
  includeTimestamp?: boolean;
  /**
   * Additional metadata fields to embed in version.json
   */
  customData?: Record<string, unknown>;
  /**
   * Global constant name to define in client code (default: '__APP_BUILD_ID__')
   */
  defineConstant?: string;
}
