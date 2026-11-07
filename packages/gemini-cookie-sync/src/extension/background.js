// =========================================================
// Gemini Cookie Sync - Background Service Worker
// Lightweight & Fast: Chỉ đảm nhiệm đồng bộ Cookie lên server
// =========================================================

const COOKIE_KEYS = [
  "__Secure-1PSID",
  "__Secure-1PSIDTS",
  "__Secure-1PSIDCC",
  "__Secure-1PAPISID",
  "__Secure-3PSID",
  "__Secure-3PSIDTS",
  "__Secure-3PSIDCC",
  "SID",
  "HSID",
  "SSID",
  "APISID",
  "SAPISID",
  "SIDCC",
];

// Lấy toàn bộ cookie Gemini hiện tại
async function collectGeminiCookies() {
  const cookies = {};

  // 1. Quét toàn bộ cookie từ các domain Google vô điều kiện
  const searchDomains = [".google.com", "google.com", "gemini.google.com"];
  for (const domain of searchDomains) {
    try {
      const dotCookies = await chrome.cookies.getAll({ domain });
      for (const c of dotCookies) {
        if (COOKIE_KEYS.includes(c.name) && c.value) {
          cookies[c.name] = c.value;
        }
      }
    } catch (_) {}
  }

  // 2. Quét bổ sung theo exact URL gemini.google.com và google.com
  const searchUrls = ["https://gemini.google.com", "https://google.com"];
  for (const url of searchUrls) {
    try {
      const urlCookies = await chrome.cookies.getAll({ url });
      for (const c of urlCookies) {
        if (COOKIE_KEYS.includes(c.name) && c.value) {
          cookies[c.name] = c.value;
        }
      }
    } catch (_) {}
  }

  // 3. Quét riêng từng key nếu còn sót
  for (const name of COOKIE_KEYS) {
    if (!cookies[name]) {
      try {
        let cookie = await chrome.cookies.get({
          url: "https://gemini.google.com",
          name,
        });
        if (!cookie || !cookie.value) {
          cookie = await chrome.cookies.get({
            url: "https://google.com",
            name,
          });
        }
        if (cookie && cookie.value) {
          cookies[name] = cookie.value;
        }
      } catch (_) {}
    }
  }

  // 4. Fallback lấy từ manualCookies lưu thủ công trong Storage nếu thiếu __Secure-1PSID
  if (!cookies["__Secure-1PSID"]) {
    try {
      const data = await chrome.storage.local.get(["manualCookies"]);
      if (data && data.manualCookies && data.manualCookies["__Secure-1PSID"]) {
        Object.assign(cookies, data.manualCookies);
      }
    } catch (_) {}
  }

  return cookies;
}

// Helper fetch với timeout tránh treo service worker
async function fetchWithTimeout(url, options = {}, timeoutMs = 3000) {
  let signal;
  let timeoutId;
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    signal = AbortSignal.timeout(timeoutMs);
  } else {
    const controller = new AbortController();
    timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    signal = controller.signal;
  }
  try {
    const res = await fetch(url, { ...options, signal });
    return res;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

// Lấy URL server từ storage (mặc định http://localhost:8000)
async function getServerUrl() {
  const data = await chrome.storage.local.get(["serverUrl"]);
  return data.serverUrl || "http://localhost:8000";
}

// Xác định duy nhất 1 server đích để đồng bộ cookie (Domain Isolation)
async function resolveTargetServerUrl(targetUrl) {
  if (targetUrl && typeof targetUrl === "string" && targetUrl.trim()) {
    return targetUrl.trim().replace(/\/$/, "");
  }

  // Nếu không có targetUrl (vd: bấm từ popup), thử lấy URL từ active tab
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs && tabs.length > 0 && tabs[0].url) {
      const tabUrl = new URL(tabs[0].url);
      const host = tabUrl.hostname.toLowerCase();
      if (host === "staging-app.example.com") {
        return tabUrl.origin;
      }
      if (host === "app.example.com" || host === "fb.example.com") {
        return tabUrl.origin;
      }
      if (host === "localhost" || host === "127.0.0.1") {
        return tabUrl.origin;
      }
      if (host.endsWith("example.com")) {
        return tabUrl.origin;
      }
    }
  } catch (_) {}

  // Fallback: dùng serverUrl đã lưu trong storage (mặc định http://localhost:8000)
  const storedUrl = await getServerUrl();
  return (storedUrl || "http://localhost:8000").replace(/\/$/, "");
}

// Gửi cookies lên đúng 1 server mục tiêu đã xác định (TUYỆT ĐỐI KHÔNG gửi đồng thời Prod & Staging)
async function syncCookiesToServer(cookies, explicitToken, targetUrl) {
  const baseUrl = await resolveTargetServerUrl(targetUrl);
  const targetHost = baseUrl.replace(/^https?:\/\//, "");

  const stored = await chrome.storage.local.get(["userToken", "lastCookies"]);
  const token = explicitToken || stored.userToken;

  const headers = { "Content-Type": "application/json" };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const endpoint = `${baseUrl}/api/v1/settings/sync-cookies`;
  let result;
  try {
    const res = await fetchWithTimeout(
      endpoint,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ cookies }),
      },
      4000
    );
    const data = await res.json().catch(() => ({}));
    result = { url: baseUrl, ok: res.ok, status: res.status, data };
  } catch (err) {
    const isTimeout = err?.name === "AbortError";
    result = {
      url: baseUrl,
      ok: false,
      error: isTimeout ? "Kết nối quá hạn (4s timeout)" : (err?.message || "Lỗi kết nối"),
    };
  }

  const isSuccess = result.ok;

  // Kiểm tra cookies có thay đổi so với lần trước không
  const prevCookies = stored.lastCookies || {};
  const cookiesIdentical =
    prevCookies["__Secure-1PSID"] === cookies["__Secure-1PSID"] &&
    prevCookies["__Secure-1PSIDTS"] === cookies["__Secure-1PSIDTS"] &&
    prevCookies["__Secure-1PSIDCC"] === cookies["__Secure-1PSIDCC"];

  const isChanged = isSuccess
    ? (result.data?.changed !== undefined ? result.data.changed === true : !cookiesIdentical)
    : false;

  const successList = isSuccess ? [targetHost] : [];
  const failedReasons = !isSuccess ? [`${targetHost} (${result.error || "Thất bại"})`] : [];

  await chrome.storage.local.set({
    lastSyncTime: new Date().toISOString(),
    lastSyncStatus: isSuccess ? "success" : "error",
    lastSyncMessage: isSuccess
      ? (isChanged
          ? `Đã đồng bộ cookie mới lên ${targetHost}`
          : `Cookie không thay đổi trên ${targetHost}`)
      : `Lỗi kết nối server: ${result.error || "Không thể gửi cookie"} (${targetHost})`,
    lastCookies: cookies,
    serverUrl: baseUrl,
  });

  return {
    ok: isSuccess,
    changed: isChanged,
    results: [result],
    successList,
    failedReasons,
    targetUrl: baseUrl,
  };
}

// Lắng nghe message từ popup.js hoặc content_script.js
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "syncNow") {
    (async () => {
      try {
        // 1. Quản lý tab gemini.google.com để làm mới phiên Google
        try {
          const tabs = await chrome.tabs.query({ url: "*://gemini.google.com/*" });
          if (tabs && tabs.length > 0) {
            // Có tab gemini.google.com -> reload tab và đợi 2.0s trước khi lấy cookie
            await chrome.tabs.reload(tabs[0].id);
            await new Promise((r) => setTimeout(r, 2000));
          } else {
            // Không có tab gemini.google.com -> mở tab ngầm và đợi 2.5s để Google cấp fresh session cookies
            await chrome.tabs.create({
              url: "https://gemini.google.com",
              active: false,
            });
            await new Promise((r) => setTimeout(r, 2500));
          }
        } catch (_) {}

        // 2. Thu thập cookies đầy đủ
        const cookies = await collectGeminiCookies();
        if (Object.keys(cookies).length === 0 || !cookies["__Secure-1PSID"]) {
          sendResponse({
            ok: false,
            needsLogin: true,
            message: "Không tìm thấy cookie Google (__Secure-1PSID). Vui lòng đăng nhập tại gemini.google.com trước.",
          });
          return;
        }

        // 3. Gửi đồng bộ lên đúng server mục tiêu (cách ly hoàn toàn Staging / Prod)
        if (message.token) {
          await chrome.storage.local.set({ userToken: message.token });
        }
        const result = await syncCookiesToServer(cookies, message.token, message.targetUrl);
        sendResponse({
          ok: result.ok,
          changed: result.changed,
          message: result.ok
            ? (result.changed
                ? `Đồng bộ cookie mới thành công lên ${result.successList?.join(", ")}!`
                : `Cookie chưa thay đổi so với phiên trước (${result.successList?.join(", ")})`)
            : `Đồng bộ thất bại: ${result.failedReasons?.join("; ") || "Không thể kết nối máy chủ"}`,
          cookies,
          results: result.results,
        });
      } catch (err) {
        sendResponse({
          ok: false,
          message: `Lỗi Extension: ${err?.message || "Không thể xử lý yêu cầu đồng bộ"}`,
        });
      }
    })();
    return true; // async response
  }

  if (message.action === "getStatus") {
    (async () => {
      const data = await chrome.storage.local.get([
        "lastSyncTime",
        "lastSyncStatus",
        "lastSyncMessage",
        "serverUrl",
        "lastCookies",
      ]);
      data.version = "1.2.4";
      sendResponse(data);
    })();
    return true;
  }

  if (message.action === "setUserToken") {
    if (message.token) {
      chrome.storage.local.set({ userToken: message.token }, () => {
        sendResponse({ ok: true });
      });
    } else {
      sendResponse({ ok: false });
    }
    return true;
  }

  if (message.action === "setServerUrl") {
    chrome.storage.local.set({ serverUrl: message.url }, () => {
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.action === "saveManualCookies") {
    if (message.cookies && typeof message.cookies === "object") {
      chrome.storage.local.set({ manualCookies: message.cookies });
      sendResponse({ ok: true });
    }
    return true;
  }
});

// =========================================================
// Lắng nghe xoay vòng Cookie Realtime (chrome.cookies.onChanged)
// Khi người dùng lướt web Google tự nhiên, Google tự động cấp mới/xoay vòng cookie (__Secure-1PSIDTS, etc.).
// Extension sẽ bắt sự kiện này và tự động đồng bộ lên server local (debounced 2s).
// TUYỆT ĐỐI KHÔNG DÙNG robotic warm-up, alarms hoặc tự ý fetch tới Google.
// =========================================================
let cookieChangeDebounceTimer = null;
if (chrome.cookies && chrome.cookies.onChanged) {
  chrome.cookies.onChanged.addListener((changeInfo) => {
    if (changeInfo.removed) return;
    const cookie = changeInfo.cookie;
    if (!cookie || !cookie.domain || !cookie.domain.includes("google.com")) return;
    if (!COOKIE_KEYS.includes(cookie.name)) return;

    if (cookieChangeDebounceTimer) {
      clearTimeout(cookieChangeDebounceTimer);
    }

    cookieChangeDebounceTimer = setTimeout(async () => {
      try {
        const cookies = await collectGeminiCookies();
        if (cookies["__Secure-1PSID"]) {
          console.log("🔄 [Realtime] Phát hiện Google xoay vòng cookie phiên tự nhiên, tự động đồng bộ lên server...");
          await syncCookiesToServer(cookies);
        }
      } catch (err) {
        console.warn("Lỗi tự động đồng bộ cookie xoay vòng:", err);
      }
    }, 2000);
  });
}

