# @kido/spa-version-guard

> **Zero-dependency SPA version guard, auto-reload, cache buster, service worker updater, and changelog modal for React & Vite.**

[![Type-safe](https://img.shields.io/badge/TypeScript-Strict%20Type--safe-blue.svg)](https://www.typescriptlang.org/)
[![Zero Dependencies](https://img.shields.io/badge/Dependencies-Zero-green.svg)](#)
[![Tests Passing](https://img.shields.io/badge/Tests-100%25%20Passing-brightgreen.svg)](#)

---

## 🎯 Bài Toán Giải Quyết (Problem Solved)

Trong các ứng dụng Single Page Application (React / Vite), khi có bản cập nhật mới được deploy lên production/staging:
1. **Lỗi `Failed to fetch dynamically imported module` (Chunk Load Error)**: Người dùng đang mở tab cũ, khi click chuyển trang hoặc mở modal lazy-load, trình duyệt cố tải các file chunk JS cũ đã bị hash khác hoặc bị xóa trên server, dẫn đến crash trang trắng.
2. **Kẹt Cache Trình Duyệt & Service Worker (PWA Stale Cache)**: `CacheStorage` và Service Worker vẫn giữ code cũ, người dùng F5 thủ công nhiều lần vẫn không thấy tính năng mới.
3. **Vòng lặp Reload Vô Tận (Infinite Reload Loop)**: Nếu server deploy lỗi hoặc version endpoint trả về sai lệch, các script auto-reload ngây thơ sẽ reload liên tục gây giật lag hoặc quá tải server.
4. **Gián đoạn Trải nghiệm Người Dùng**: Tự động reload bất ngờ khi người dùng đang nhập form, đang login, hoặc trong các session test E2E.

`@kido/spa-version-guard` giải quyết triệt để tất cả các vấn đề trên với tiêu chuẩn **Zero-Dependency**, kiến trúc đa tầng (Headless Logic + React Hook + UI Components + Vite Plugin).

---

## ⚡ Tính Năng Nổi Bật (Key Features)

1. **Anti-Infinite-Loop Guard (Khóa Cooldown Chống Loop)**:
   - Sử dụng `sessionStorage` cooldown (mặc định 5 phút).
   - Ngăn chặn reload liên tục nếu server trả về version không khớp hoặc deploy dang dở.
2. **Zero-Trust Cache & Worker Purge (Dọn Dẹp Triệt Để)**:
   - Tự động xóa sạch toàn bộ `window.caches` (Workbox, PWA runtime caches).
   - Gọi `reg.update()` trên tất cả Service Worker đăng ký.
3. **Bypass Guards Cho E2E & Luồng Đăng Nhập**:
   - Tự động bỏ qua version check khi phát hiện flag test user (`mockUserKey`) hoặc đang trong luồng OAuth/login (`is_logging_in`).
4. **Kiểm Tra Thông Minh (Bandwidth & Battery Friendly)**:
   - Trì hoãn 3,000ms khi mount để nhường băng thông frame 1 cho API quan trọng.
   - Chỉ kiểm tra khi tab đang active (`document.visibilityState === 'visible'`).
   - Tự động check khi user quay lại tab (`visibilitychange`, `window.focus`).
   - Polling ngầm định kỳ (mặc định 3 phút).
5. **UI Components Dựng Sẵn (Zero-CSS Dependency)**:
   - `<VersionGuardBanner />`: Banner nổi bo góc với spinner SVG và `role="status"` trợ năng (a11y), hỗ trợ Tailwind CSS lẫn inline style fallback.
   - `<WhatsNewModal />`: Modal changelog thông báo tính năng mới, tự động mở khi phát hiện version mới chưa xem, lưu trạng thái vào `localStorage`.
6. **Vite Plugin Tích Hợp Sẵn (`viteVersionPlugin`)**:
   - Tự động sinh file `version.json` vào thư mục `dist/` khi build.
   - Tự động define hằng số `__APP_BUILD_ID__` và `__APP_VERSION__` cho client code.
   - Hỗ trợ middleware giả lập `/version.json` ngay trong môi trường dev server (`vite dev`).

---

## 📦 Cài Đặt (Installation)

```bash
# Trong monorepo
pnpm add @kido/spa-version-guard

# Hoặc qua bun/npm
bun add @kido/spa-version-guard
```

---

## 🚀 Hướng Dẫn Nhanh (Quickstart)

### 1. Cấu hình Vite (`vite.config.ts`)

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteVersionPlugin } from '@kido/spa-version-guard';

export default defineConfig({
  plugins: [
    react(),
    viteVersionPlugin({
      fileName: 'version.json',
      version: '2.2.0',
      gitCommit: true, // Tự động lấy git commit hash
    }),
  ],
});
```

### 2. Tích hợp trong Root Layout / App Component

```tsx
import React from 'react';
import {
  useAppVersionGuard,
  VersionGuardBanner,
  WhatsNewModal,
  type VersionRelease,
} from '@kido/spa-version-guard';

const CURRENT_RELEASE: VersionRelease = {
  version: 'v2.2.0',
  releaseDate: '10/10/2026',
  title: 'Cập Nhật Phiên Bản v2.2',
  subtitle: 'Viết Bù & Chỉnh Sửa Nhật Ký 14 Ngày • Hoàn Thiện Trải Nghiệm',
  changes: [
    {
      icon: 'edit_calendar',
      badge: 'MỚI • v2.2',
      badgeColor: 'text-amber-400 border-amber-500/30 bg-amber-500/10',
      title: 'Viết Bù & Sửa Nhật Ký 14 Ngày',
      description: 'Bạn có thể xem lại, chỉnh sửa hoặc viết bù nhật ký trong 14 ngày gần nhất.',
    },
    {
      icon: 'lock_open',
      badge: 'MỚI • v2.2',
      badgeColor: 'text-sky-400 border-sky-500/30 bg-sky-500/10',
      title: 'Mở Khóa Chỉnh Sửa Hôm Nay',
      description: 'Bổ sung suy ngẫm và bài học bất cứ lúc nào trong ngày.',
    },
  ],
};

export function App() {
  const { isUpdating } = useAppVersionGuard({
    endpoint: '/version.json',
    pollIntervalMs: 180_000, // 3 phút kiểm tra 1 lần
  });

  return (
    <div className="min-h-screen bg-slate-900 text-white">
      {/* Banner thông báo đang tải bản mới */}
      <VersionGuardBanner isUpdating={isUpdating} />

      {/* Modal giới thiệu tính năng mới sau khi reload */}
      <WhatsNewModal release={CURRENT_RELEASE} />

      <main>
        <h1>My Awesome SPA</h1>
      </main>
    </div>
  );
}
```

---

## 🛠️ Sử Dụng Headless (Không cần React)

Bạn có thể sử dụng các hàm headless trong bất kỳ framework nào (Vue, Svelte, Vanilla TS):

```ts
import {
  checkSpaVersion,
  cleanBrowserCaches,
  updateServiceWorkers,
} from '@kido/spa-version-guard';

async function verifyVersion() {
  const result = await checkSpaVersion({
    endpoint: '/version.json',
    clientVersion: '1.0.0',
    cooldownMs: 300_000,
  });

  if (result.hasNewVersion) {
    console.log('Phát hiện bản mới:', result.serverVersion);
    await cleanBrowserCaches();
    await updateServiceWorkers();
    window.location.reload();
  }
}
```

---

## 📖 Chi Tiết API (API Reference)

### `useAppVersionGuard(options)`

React Hook quản lý toàn bộ vòng đời kiểm tra phiên bản và tự động reload.

| Tùy chọn | Kiểu | Mặc định | Mô tả |
| :--- | :--- | :--- | :--- |
| `endpoint` | `string` | `'/version.json'` | Đường dẫn API hoặc file JSON chứa thông tin phiên bản |
| `clientVersion` | `string` | `window.__APP_VERSION__` \| `1.0.0` | Phiên bản hiện tại của client |
| `clientBuildId` | `string` | `window.__APP_BUILD_ID__` | Build ID hiện tại của client |
| `pollIntervalMs` | `number` | `180000` (3 phút) | Chu kỳ polling ngầm (ms). Đặt `0` để tắt |
| `initialDelayMs` | `number` | `3000` (3 giây) | Trì hoãn lần kiểm tra đầu tiên khi mount |
| `reloadDelayMs` | `number` | `1500` (1.5 giây) | Trì hoãn trước khi reload để user kịp thấy banner |
| `cooldownMs` | `number` | `300000` (5 phút) | Thời gian khóa cooldown chống lặp reload vô tận |
| `autoReload` | `boolean` | `true` | Tự động dọn cache và reload khi có bản mới |
| `cleanCachesOnUpdate` | `boolean` | `true` | Tự động xóa toàn bộ `CacheStorage` |
| `updateServiceWorkerOnUpdate` | `boolean` | `true` | Tự động kích hoạt `reg.update()` trên Service Worker |
| `onNewVersionDetected` | `(res) => void` | `undefined` | Callback khi phát hiện bản mới |
| `onBeforeReload` | `() => void \| Promise<void>` | `undefined` | Hook chạy trước khi gọi reload |

**Giá trị trả về:**
- `isUpdating`: `boolean` - Đang trong quá trình cập nhật và chuẩn bị reload.
- `hasNewVersion`: `boolean` - Server có phiên bản mới hơn.
- `serverVersion`: `string | null` - Phiên bản mới trên server.
- `serverBuildId`: `string | null` - Build ID trên server.
- `serverRelease`: `VersionRelease | null` - Thông tin release notes từ server.
- `checkNow`: `() => Promise<VersionCheckResult>` - Kích hoạt kiểm tra thủ công ngay lập tức.
- `reloadNow`: `() => Promise<void>` - Dọn cache và reload ngay lập tức.

---

### `<VersionGuardBanner />`

Floating update notification banner.

| Prop | Kiểu | Mặc định | Mô tả |
| :--- | :--- | :--- | :--- |
| `isUpdating` | `boolean` | **Bắt buộc** | Trạng thái hiển thị banner |
| `message` | `string` | `'Đang cập nhật phiên bản mới nhất...'` | Nội dung thông báo |
| `spinnerColor` | `string` | `'#F97316'` (Orange 500) | Màu spinner SVG |
| `className` | `string` | `''` | Class CSS bổ sung |
| `style` | `CSSProperties` | `undefined` | Inline style tùy biến |
| `showSpinner` | `boolean` | `true` | Bật/tắt biểu tượng xoay spinner |

---

### `<WhatsNewModal />`

Modal hiển thị tính năng mới và changelog phát hành.

| Prop | Kiểu | Mặc định | Mô tả |
| :--- | :--- | :--- | :--- |
| `release` | `VersionRelease` | `undefined` | Dữ liệu phiên bản và danh sách tính năng mới |
| `forceOpen` | `boolean` | `false` | Bắt buộc mở modal bỏ qua localStorage |
| `storageKey` | `string` | `'kt_seen_app_version'` | Key localStorage lưu phiên bản đã xem |
| `onClose` | `() => void` | `undefined` | Callback khi đóng modal |
| `onAction` | `() => void` | `undefined` | Callback khi bấm nút hành động chính |
| `actionLabel` | `string` | `'BẮT ĐẦU TRẢI NGHIỆM'` | Nhãn trên nút hành động |

---

### `viteVersionPlugin(options)`

Vite plugin cấu hình build-time.

```ts
viteVersionPlugin({
  fileName?: string;       // Mặc định: 'version.json'
  version?: string;        // Mặc định lấy từ package.json
  buildId?: string;        // Mặc định: 'YYYY.MM.DD.version.commit'
  gitCommit?: boolean | string; // Tự động đọc git HEAD commit
  includeTimestamp?: boolean;   // Mặc định: true
  defineConstant?: string; // Mặc định: '__APP_BUILD_ID__'
})
```

---

## 🧪 Kiểm Thử (Unit Tests)

Chạy bộ test 100% passing bằng Bun:

```bash
bun test
```

Kết quả:
```text
32 pass, 0 fail, 85 expect() calls
Ran 32 tests across 1 file. [160.00ms]
```

---

## 📄 Bản Quyền (License)

MIT © Kido
