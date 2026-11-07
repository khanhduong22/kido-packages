// =========================================================
// Gemini Cookie Sync - Content Script
// =========================================================

// Mark extension presence in DOM and window (CSP-safe, no inline script injection)
document.documentElement.dataset.geminiExtensionInstalled = "true";
document.documentElement.dataset.geminiExtensionVersion = "1.2.4";
try {
  window.__GEMINI_EXTENSION_INSTALLED__ = true;
} catch (_) {}

// Notify dashboard page that extension is ready
function notifyExtensionReady() {
  window.dispatchEvent(
    new CustomEvent("gemini-extension-detected", {
      detail: { version: "1.2.4", installed: true },
    })
  );
}

notifyExtensionReady();
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", notifyExtensionReady);
}

// Tự động đồng bộ serverUrl và token người dùng theo domain hiện tại
try {
  if (window.location && window.location.origin) {
    chrome.runtime.sendMessage({
      action: "setServerUrl",
      url: window.location.origin,
    });
  }
  const token = localStorage.getItem("auth_token");
  if (token) {
    chrome.runtime.sendMessage({
      action: "setUserToken",
      token: token.trim(),
    });
  }
} catch (_) {}

// Listen for messages from dashboard page
window.addEventListener("message", (event) => {
  if (event.source !== window || !event.data || !event.data.type) return;

  const { type, requestId } = event.data;

  // 1. Ping / Health check
  if (type === "GEMINI_PING_REQUEST") {
    window.postMessage(
      {
        type: "GEMINI_PING_RESPONSE",
        requestId,
        installed: true,
        version: "1.2.4",
      },
      "*"
    );
    return;
  }

  // 2. Cookie Sync Request
  if (type === "GEMINI_SYNC_REQUEST") {
    try {
      const token = localStorage.getItem("auth_token") || "";
      const targetUrl = event.data.targetUrl || window.location.origin;
      chrome.runtime.sendMessage({ action: "syncNow", token, targetUrl }, (response) => {
        const lastErr = chrome.runtime.lastError;
        if (lastErr) {
          const msg = lastErr.message || "";
          const isContextInvalidated = msg.includes("context invalidated") || msg.includes("Extension context");
          window.postMessage(
            {
              type: "GEMINI_SYNC_RESPONSE",
              requestId,
              payload: {
                ok: false,
                isContextInvalidated,
                message: isContextInvalidated
                  ? "Extension vừa được cập nhật/nạp lại. Vui lòng F5 (tải lại trang này) để hoàn tất nạp Extension v1.2.4!"
                  : msg || "Lỗi giao tiếp với Extension",
              },
            },
            "*"
          );
          return;
        }
        window.postMessage(
          {
            type: "GEMINI_SYNC_RESPONSE",
            requestId,
            payload: response || { ok: false, message: "Không nhận được dữ liệu từ Extension" },
          },
          "*"
        );
      });
    } catch (err) {
      const msg = err?.message || "";
      const isContextInvalidated = msg.includes("context invalidated") || msg.includes("Extension context");
      window.postMessage(
        {
          type: "GEMINI_SYNC_RESPONSE",
          requestId,
          payload: {
            ok: false,
            isContextInvalidated,
            message: isContextInvalidated
              ? "Extension vừa được cập nhật/nạp lại. Vui lòng F5 (tải lại trang này) để hoàn tất nạp Extension v1.2.4!"
              : "Extension error: " + msg,
          },
        },
        "*"
      );
    }
    return;
  }

  // 3. Update manual cookies from localStorage
  if (type === "GEMINI_UPDATE_COOKIES_REQUEST") {
    try {
      chrome.runtime.sendMessage({
        action: "saveManualCookies",
        cookies: event.data.cookies,
      });
    } catch (_) {}
    return;
  }
});
