/**
 * Cookie keys used by Google Gemini and related session authentication.
 */
export const COOKIE_KEYS = [
  '__Secure-1PSID',
  '__Secure-1PSIDTS',
  '__Secure-1PSIDCC',
  '__Secure-1PAPISID',
  '__Secure-3PSID',
  '__Secure-3PSIDTS',
  '__Secure-3PSIDCC',
  'SID',
  'HSID',
  'SSID',
  'APISID',
  'SAPISID',
  'SIDCC',
] as const;

export type CookieKey = typeof COOKIE_KEYS[number];

/**
 * Standard cookie key-value map for Google Gemini authentication.
 */
export type GeminiCookies = Record<string, string>;

/**
 * Mapping from Google Gemini cookie names to application environment variables.
 */
export const COOKIE_ENV_MAP: Record<string, string> = {
  '__Secure-1PSID': 'SECURE_1PSID',
  '__Secure-1PSIDTS': 'SECURE_1PSIDTS',
  '__Secure-1PSIDCC': 'SECURE_1PSIDCC',
  '__Secure-1PAPISID': 'SECURE_1PAPISID',
};

/**
 * Primary mandatory cookie and environment variable key.
 */
export const REQUIRED_COOKIE_KEY = '__Secure-1PSID' as const;
export const REQUIRED_ENV_KEY = 'SECURE_1PSID' as const;

/**
 * Default HTTP header used to pass browser-stored Gemini cookies to backend APIs.
 */
export const COOKIE_HEADER_NAME = 'X-Gemini-Cookies' as const;

/**
 * Default browser localStorage key for persisting Gemini cookies.
 */
export const COOKIE_STORAGE_KEY = 'kido_gemini_cookies' as const;

/**
 * Default server port and endpoints.
 */
export const DEFAULT_SERVER_PORT = 8000;
export const DEFAULT_SERVER_URL = 'http://localhost:8000';
export const DEFAULT_SYNC_ENDPOINT = '/api/v1/settings/sync-cookies';
export const DEFAULT_ACTIVE_COOKIES_ENDPOINT = '/api/v1/settings/active-cookies';
export const DEFAULT_ENV_STATUS_ENDPOINT = '/api/v1/settings/env-status';
export const DEFAULT_DOWNLOAD_EXTENSION_ENDPOINT = '/api/v1/settings/download-extension';

/**
 * Extension metadata
 */
export const EXTENSION_VERSION = '1.2.4';

/**
 * Window postMessage event types for communication between Web App and Chrome Extension Content Script.
 */
export const GEMINI_EVENT_TYPES = {
  DETECTED: 'gemini-extension-detected',
  PING_REQUEST: 'GEMINI_PING_REQUEST',
  PING_RESPONSE: 'GEMINI_PING_RESPONSE',
  SYNC_REQUEST: 'GEMINI_SYNC_REQUEST',
  SYNC_RESPONSE: 'GEMINI_SYNC_RESPONSE',
  UPDATE_COOKIES_REQUEST: 'GEMINI_UPDATE_COOKIES_REQUEST',
} as const;

export type GeminiEventType = typeof GEMINI_EVENT_TYPES[keyof typeof GEMINI_EVENT_TYPES];

/**
 * Common AI generation endpoints that require valid Gemini cookies.
 */
export const DEFAULT_AI_ENDPOINTS: readonly string[] = [
  '/api/v1/posts',
  '/api/v1/content-styles',
  '/api/v1/images',
  '/api/v1/gemini',
];
