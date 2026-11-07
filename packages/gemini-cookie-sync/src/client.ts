import {
  COOKIE_HEADER_NAME,
  COOKIE_STORAGE_KEY,
  DEFAULT_AI_ENDPOINTS,
  DEFAULT_SYNC_ENDPOINT,
  GEMINI_EVENT_TYPES,
  GeminiCookies,
  REQUIRED_COOKIE_KEY,
} from './constants';


export interface FetchInterceptorOptions {
  storageKey?: string;
  headerName?: string;
  syncEndpoint?: string;
  aiEndpoints?: (string | RegExp)[];
  syncTimeoutMs?: number;
  onToast?: (message: string, isError?: boolean) => void;
  onSyncSuccess?: (cookies: GeminiCookies) => void;
  onSyncError?: (error: Error) => void;
}

export interface RequestCookieSyncOptions {
  timeoutMs?: number;
  syncEndpoint?: string;
  storageKey?: string;
  targetUrl?: string;
}

export interface PingExtensionOptions {
  timeoutMs?: number;
}

export interface ExtensionPingResult {
  installed: boolean;
  version?: string;
}

/**
 * Retrieve saved Gemini cookies from localStorage.
 */
export function getStoredCookies(storageKey: string = COOKIE_STORAGE_KEY): GeminiCookies | null {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') {
    return null;
  }
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as GeminiCookies;
    }
  } catch {
    // Ignore JSON parse errors or access denied
  }
  return null;
}

/**
 * Persist Gemini cookies to localStorage and notify the Chrome Extension content script.
 */
export function saveStoredCookies(
  cookies: GeminiCookies,
  storageKey: string = COOKIE_STORAGE_KEY
): void {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') {
    return;
  }
  if (!cookies || typeof cookies !== 'object' || Array.isArray(cookies)) {
    return;
  }
  try {
    localStorage.setItem(storageKey, JSON.stringify(cookies));
    window.postMessage(
      {
        type: GEMINI_EVENT_TYPES.UPDATE_COOKIES_REQUEST,
        cookies,
      },
      '*'
    );
  } catch (err) {
    console.warn('[GeminiCookieSync] Failed to save cookies to localStorage:', err);
  }
}

/**
 * Remove saved Gemini cookies from localStorage.
 */
export function clearStoredCookies(storageKey: string = COOKIE_STORAGE_KEY): void {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') {
    return;
  }
  try {
    localStorage.removeItem(storageKey);
  } catch {
    // Ignore
  }
}

/**
 * Check if the Gemini Cookie Sync Chrome Extension is installed and active in the page.
 */
export function isExtensionAvailable(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  const win = window as unknown as { __GEMINI_EXTENSION_INSTALLED__?: boolean };
  const docInstalled =
    typeof document !== 'undefined' &&
    document.documentElement?.dataset?.geminiExtensionInstalled === 'true';

  return Boolean(win.__GEMINI_EXTENSION_INSTALLED__ || docInstalled);
}

/**
 * Retrieve the active Gemini Cookie Sync Extension version from the DOM dataset if available.
 */
export function getExtensionVersion(): string | null {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return null;
  }
  return document.documentElement?.dataset?.geminiExtensionVersion || null;
}

/**
 * Ping the Chrome extension content script to verify connectivity and version.
 */
export function pingExtension(
  options: PingExtensionOptions = {}
): Promise<ExtensionPingResult> {
  const timeoutMs = options.timeoutMs ?? 3000;

  if (typeof window === 'undefined') {
    return Promise.resolve({ installed: false });
  }

  return new Promise((resolve) => {
    const requestId = 'ping_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
    let timer: ReturnType<typeof setTimeout> | null = null;

    function onMessage(event: MessageEvent) {
      if (event.source !== window || !event.data) return;
      if (event.data.type === GEMINI_EVENT_TYPES.PING_RESPONSE) {
        if (event.data.requestId && event.data.requestId !== requestId) return;

        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        window.removeEventListener('message', onMessage);

        (window as unknown as { __GEMINI_EXTENSION_INSTALLED__?: boolean }).__GEMINI_EXTENSION_INSTALLED__ = true;
        if (typeof document !== 'undefined') {
          document.documentElement.dataset.geminiExtensionInstalled = 'true';
          if (event.data.version) {
            document.documentElement.dataset.geminiExtensionVersion = event.data.version;
          }
        }

        resolve({
          installed: true,
          version: event.data.version,
        });
      }
    }

    timer = setTimeout(() => {
      timer = null;
      if (typeof window !== 'undefined') {
        window.removeEventListener('message', onMessage);
      }
      resolve({
        installed: isExtensionAvailable(),
        version: getExtensionVersion() || undefined,
      });
    }, timeoutMs);

    window.addEventListener('message', onMessage);
    window.postMessage({ type: GEMINI_EVENT_TYPES.PING_REQUEST, requestId }, '*');
  });
}

/**
 * Check whether an HTTP response status or error body indicates expired, invalid, or missing Gemini cookies.
 */
export function isAuthOrCookieExpiredError(status: number, errData?: unknown): boolean {
  if (status === 401 || status === 403) {
    return true;
  }

  let msg = '';
  if (typeof errData === 'string') {
    msg = errData;
  } else if (errData && typeof errData === 'object') {
    const rec = errData as Record<string, unknown>;
    msg = String(rec.detail || rec.message || rec.error || JSON.stringify(errData));
  } else if (errData != null) {
    msg = String(errData);
  }

  const normalized = msg.toLowerCase();
  const keywords = [
    'cookie_expired',
    'cookie',
    'hết hạn',
    'đăng nhập',
    'unauthenticated',
    'snlm0e',
    'token expired',
    'secure-1psid',
    'chưa cấu hình',
    'không thể khởi tạo',
    'xác thực',
    'phải có cookie',
    'invalid cookie',
    'auth failure',
    'unauthorized',
  ];

  return keywords.some((kw) => normalized.includes(kw));
}

/**
 * Send a sync request message to the Chrome extension to retrieve fresh Google Gemini cookies.
 */
export function requestCookieSyncFromExtension(
  options: RequestCookieSyncOptions = {}
): Promise<GeminiCookies> {
  const timeoutMs = options.timeoutMs ?? 15000;
  const storageKey = options.storageKey ?? COOKIE_STORAGE_KEY;

  if (typeof window === 'undefined') {
    return Promise.reject(new Error('Window environment is required for extension message passing.'));
  }

  return new Promise((resolve, reject) => {
    const requestId = 'sync_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
    let timer: ReturnType<typeof setTimeout> | null = null;

    function onMessage(event: MessageEvent) {
      if (event.source !== window || !event.data) return;
      if (event.data.type === GEMINI_EVENT_TYPES.SYNC_RESPONSE) {
        if (event.data.requestId && event.data.requestId !== requestId) return;

        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        window.removeEventListener('message', onMessage);

        const payload = event.data.payload;
        if (payload && payload.ok && payload.cookies) {
          (window as unknown as { __GEMINI_EXTENSION_INSTALLED__?: boolean }).__GEMINI_EXTENSION_INSTALLED__ = true;
          if (typeof document !== 'undefined') {
            document.documentElement.dataset.geminiExtensionInstalled = 'true';
          }
          saveStoredCookies(payload.cookies, storageKey);

          // Optionally post to backend sync endpoint if provided
          if (options.syncEndpoint && typeof fetch === 'function') {
            try {
              let endpoint = options.syncEndpoint;
              const hasOrigin = typeof window !== 'undefined' && (window as unknown as { location?: { origin?: string } }).location?.origin;
              if (endpoint.startsWith('/') && hasOrigin) {
                endpoint = (window as unknown as { location: { origin: string } }).location.origin + endpoint;
              }
              if (endpoint.startsWith('http://') || endpoint.startsWith('https://')) {
                fetch(endpoint, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ cookies: payload.cookies }),
                }).catch(() => {});
              }
            } catch {
              // Ignore synchronous dispatch error
            }
          }

          resolve(payload.cookies);
        } else {
          reject(
            new Error(
              payload?.message ||
                'Extension không thể lấy được cookie Google. Vui lòng đăng nhập tại gemini.google.com trước.'
            )
          );
        }
      }
    }

    timer = setTimeout(() => {
      timer = null;
      if (typeof window !== 'undefined') {
        window.removeEventListener('message', onMessage);
      }
      reject(
        new Error(
          `Hết thời gian chờ phản hồi từ Extension (${Math.round(timeoutMs / 1000)}s). Vui lòng đảm bảo Chrome Extension đã được tải và bật Developer Mode.`
        )
      );
    }, timeoutMs);

    window.addEventListener('message', onMessage);
    window.postMessage(
      {
        type: GEMINI_EVENT_TYPES.SYNC_REQUEST,
        requestId,
        targetUrl: options.targetUrl,
      },
      '*'
    );
  });
}

/**
 * Setup a global fetch interceptor to:
 * 1. Automatically inject the `X-Gemini-Cookies` header on API requests.
 * 2. Intercept 401/cookie expiration errors on AI generation endpoints.
 * 3. Request fresh cookies from the Chrome Extension and seamlessly retry in flight.
 *
 * Returns a teardown function to restore the original fetch implementation.
 */
let isSyncingCookies = false;
let syncPromise: Promise<GeminiCookies> | null = null;

export function setupFetchInterceptor(options: FetchInterceptorOptions = {}): () => void {
  if (typeof window === 'undefined' || typeof window.fetch !== 'function') {
    return () => {};
  }

  const win = window as unknown as {
    __FETCH_INTERCEPTOR_SETUP__?: boolean;
    __ORIGINAL_FETCH__?: typeof window.fetch;
  };

  if (win.__FETCH_INTERCEPTOR_SETUP__) {
    return () => teardownFetchInterceptor();
  }

  const storageKey = options.storageKey ?? COOKIE_STORAGE_KEY;
  const headerName = options.headerName ?? COOKIE_HEADER_NAME;
  const syncTimeoutMs = options.syncTimeoutMs ?? 15000;
  const syncEndpoint = options.syncEndpoint ?? DEFAULT_SYNC_ENDPOINT;
  const aiEndpoints = options.aiEndpoints ?? DEFAULT_AI_ENDPOINTS;

  const originalFetch = window.fetch.bind(window);
  win.__ORIGINAL_FETCH__ = originalFetch;
  win.__FETCH_INTERCEPTOR_SETUP__ = true;

  function matchesAiEndpoint(urlStr: string): boolean {
    return aiEndpoints.some((pattern) => {
      if (typeof pattern === 'string') {
        return urlStr.includes(pattern);
      }
      return pattern.test(urlStr);
    });
  }

  window.fetch = async function interceptedFetch(
    input: RequestInfo | URL,
    init: RequestInit = {}
  ): Promise<Response> {
    const opt: RequestInit = { ...init };
    const headers = new Headers(opt.headers || {});
    const stored = getStoredCookies(storageKey);

    if (stored && stored[REQUIRED_COOKIE_KEY] && !headers.has(headerName)) {
      headers.set(headerName, encodeURIComponent(JSON.stringify(stored)));
    }
    opt.headers = headers;

    let response = await originalFetch(input, opt);

    const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const isAiEndpoint = matchesAiEndpoint(urlStr);

    if (
      !response.ok &&
      isAiEndpoint &&
      (response.status === 401 ||
        response.status === 400 ||
        response.status === 403 ||
        response.status === 500 ||
        response.status === 502 ||
        response.status === 503)
    ) {
      let errData: unknown = null;
      try {
        const clone = response.clone();
        try {
          errData = await clone.json();
        } catch {
          errData = await clone.text();
        }
      } catch {
        // Body reading failed
      }

      if (isAuthOrCookieExpiredError(response.status, errData)) {
        if (options.onToast) {
          options.onToast('Cookie AI hết hạn. Đang tự động lấy lại cookie mới từ Extension...', false);
        }

        try {
          if (!isSyncingCookies || !syncPromise) {
            isSyncingCookies = true;
            syncPromise = requestCookieSyncFromExtension({
              timeoutMs: syncTimeoutMs,
              syncEndpoint,
              storageKey,
            });
          }

          const freshCookies = await syncPromise;
          isSyncingCookies = false;
          syncPromise = null;

          if (freshCookies && freshCookies[REQUIRED_COOKIE_KEY]) {
            if (options.onToast) {
              options.onToast('Đã tự động lấy cookie mới từ Extension! Đang chạy tiếp yêu cầu...');
            }
            if (options.onSyncSuccess) {
              options.onSyncSuccess(freshCookies);
            }

            // Retry original request with updated headers
            headers.set(headerName, encodeURIComponent(JSON.stringify(freshCookies)));
            opt.headers = headers;
            response = await originalFetch(input, opt);
          }
        } catch (syncErr) {
          isSyncingCookies = false;
          syncPromise = null;
          const err = syncErr instanceof Error ? syncErr : new Error(String(syncErr));
          if (options.onSyncError) {
            options.onSyncError(err);
          }
          console.error('[GeminiCookieSync] Auto cookie sync from extension failed:', syncErr);
        }
      }
    }

    return response;
  };

  return () => teardownFetchInterceptor();
}

/**
 * Teardown the global fetch interceptor and restore the original fetch function.
 */
export function teardownFetchInterceptor(): void {
  if (typeof window === 'undefined') return;
  const win = window as unknown as {
    __FETCH_INTERCEPTOR_SETUP__?: boolean;
    __ORIGINAL_FETCH__?: typeof window.fetch;
  };

  if (win.__ORIGINAL_FETCH__) {
    window.fetch = win.__ORIGINAL_FETCH__;
    delete win.__ORIGINAL_FETCH__;
  }
  win.__FETCH_INTERCEPTOR_SETUP__ = false;
  isSyncingCookies = false;
  syncPromise = null;
}
