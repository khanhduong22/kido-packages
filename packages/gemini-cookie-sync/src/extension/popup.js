// =========================================================
// Gemini Cookie Sync - Popup Script
// =========================================================

const statusDot  = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const statusMsg  = document.getElementById('statusMsg');
const statusTime = document.getElementById('statusTime');
const cookieList = document.getElementById('cookieList');
const btnSync    = document.getElementById('btnSync');
const btnIcon    = document.getElementById('btnIcon');
const btnText    = document.getElementById('btnText');
const serverInput = document.getElementById('serverInput');
const btnSave    = document.getElementById('btnSave');
const linkGemini = document.getElementById('linkGemini');

// Mở gemini.google.com trong tab mới khi click link
linkGemini.addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://gemini.google.com' });
});

// Load trạng thái từ storage khi popup mở
chrome.runtime.sendMessage({ action: 'getStatus' }, (data) => {
  if (!data) return;

  if (data.serverUrl) serverInput.value = data.serverUrl;

  if (data.lastSyncStatus === 'success') {
    setStatus('success', 'Đồng bộ thành công', data.lastSyncMessage, data.lastSyncTime);
    renderCookies(data.lastCookies);
  } else if (data.lastSyncStatus === 'error') {
    setStatus('error', 'Lỗi đồng bộ', data.lastSyncMessage, data.lastSyncTime);
  }
});

// Lưu server URL
btnSave.addEventListener('click', () => {
  const url = serverInput.value.trim();
  if (!url) return;
  chrome.runtime.sendMessage({ action: 'setServerUrl', url }, () => {
    btnSave.textContent = '✓';
    setTimeout(() => { btnSave.textContent = 'Lưu'; }, 1500);
  });
});

// Đồng bộ ngay
btnSync.addEventListener('click', () => {
  setLoading(true);
  chrome.runtime.sendMessage({ action: 'syncNow' }, (result) => {
    setLoading(false);
    if (result?.ok) {
      setStatus('success', 'Đồng bộ thành công!', result.message, new Date().toISOString());
      renderCookies(result.cookies);
    } else {
      setStatus('error', 'Đồng bộ thất bại', result?.message || 'Lỗi không xác định', new Date().toISOString());
      cookieList.style.display = 'none';
    }
  });
});

function setStatus(type, text, msg, time) {
  statusDot.className = `dot dot-${type}`;
  statusText.textContent = text;
  statusMsg.textContent = msg || '';
  if (time) {
    const d = new Date(time);
    statusTime.textContent = `Lần cuối: ${d.toLocaleTimeString('vi-VN')} ${d.toLocaleDateString('vi-VN')}`;
  }
}

function setLoading(loading) {
  btnSync.disabled = loading;
  if (loading) {
    btnIcon.outerHTML = '<div class="spinner" id="btnIcon"></div>';
    btnText.textContent = 'Đang đồng bộ...';
    statusDot.className = 'dot dot-loading';
    statusText.textContent = 'Đang gửi cookie...';
    statusMsg.textContent = '';
  } else {
    const span = document.createElement('span');
    span.id = 'btnIcon';
    span.textContent = '🔄';
    document.getElementById('btnIcon').replaceWith(span);
    btnText.textContent = 'Đồng bộ Cookie ngay';
  }
}

function renderCookies(cookies) {
  if (!cookies || Object.keys(cookies).length === 0) {
    cookieList.style.display = 'none';
    return;
  }
  cookieList.style.display = 'flex';
  cookieList.innerHTML = '';
  for (const name of Object.keys(cookies)) {
    const badge = document.createElement('span');
    badge.className = 'cookie-badge';
    badge.textContent = name.replace('__Secure-', '').replace('__Host-', '');
    cookieList.appendChild(badge);
  }
}
