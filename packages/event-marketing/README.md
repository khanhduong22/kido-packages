# @kido/event-marketing

Event Lifecycle Drip Engine & Post-Event ROI Telemetry Reporter for **T-RED Media** ([tred.vn](https://tred.vn)) & **T-RED Photobooth** ([fotobooth.vn](https://fotobooth.vn)).

## 1. Giới Thiệu & Triết Lý Thiết Kế

Ngành truyền thông sự kiện và photobooth không phù hợp với chiến lược email marketing spam hàng tuần. Tỷ lệ mở và chuyển đổi cao nhất chỉ xuất hiện khi thông điệp được kích hoạt theo **"Trigger Thời Điểm Vàng"** gắn liền với vòng đời sự kiện:

- **T-24h (Briefing Ekip)**: Nhắc nhở danh sách nhân sự, call time, định vị sảnh tiệc, checklist thiết bị in/mạng (qua Telegram / Email).
- **T+2h (Cứu Báo Giá Bỏ Dở)**: Nhắc nhở khách hàng chưa cọc hợp đồng sau 2 tiếng, đính kèm clip hậu trường (Behind-The-Scenes) các show lớn (qua Zalo ZNS).
- **T+24h (B2B ROI Telemetry)**: Bắn Báo Cáo Hiệu Quả Truyền Thông & Đo Lường Điểm Chạm cho Giám đốc Marketing (CMO) nhãn hàng để chốt show Year-End Party (qua Craft Minimalist HTML Email).
- **T+3d (B2C Tiệc Cưới)**: Gửi link Cloud Gallery tải toàn bộ ảnh & video 4K chất lượng cao không nén kèm mã PIN riêng tư (qua Email).
- **T+365d (B2C Tiệc Cưới)**: Chúc mừng kỷ niệm 1 năm ngày cưới, tặng voucher giảm 20% gói chụp ảnh em bé / studio gia đình (qua Zalo ZNS).

---

## 2. Kiến Trúc & Core Exports

```
@kido/event-marketing/
├── types.ts                  # Zod schemas & TypeScript types
├── lifecycle-drip-engine.ts  # Máy trạng thái lên lịch & lọc trigger theo thời gian
├── roi-calculator.ts         # Tính toán điểm chạm, CVR, viral reach MXH, CPI & CPL
├── email-builder.ts          # Bộ sinh mã HTML Email chuẩn Craft Minimalism (Stripe/Linear style)
└── adapters/
    ├── zalo-zns-adapter.ts   # Chuẩn hóa payload & gửi tin Zalo Notification Service
    ├── telegram-adapter.ts   # Soạn thảo Markdown & gửi Telegram cho ekip & ban giám đốc
    └── email-adapter.ts      # Adapter gửi email (Mock, Resend, SendGrid)
```

---

## 3. Hướng Dẫn Sử Dụng

### 3.1. Máy Trạng Thái Vòng Đời Drip (`EventLifecycleDripEngine`)

```typescript
import { EventLifecycleDripEngine, EventDetails } from '@kido/event-marketing';

const engine = new EventLifecycleDripEngine();

const event: EventDetails = {
  id: 'evt-vinfast-gala-2026',
  name: 'VinFast Global Partner Summit',
  category: 'B2B_CORPORATE',
  clientName: 'Trần Minh Quân',
  clientEmail: 'quan.tm@vinfast.vn',
  eventDate: new Date('2026-11-20T18:00:00.000Z'),
};

// Tự động sinh lịch gửi tin theo các rule áp dụng cho event category
const schedule = engine.generateSchedule(event);

// Lọc các tin nhắn đến hạn gửi tại thời điểm hiện tại
const dueMessages = engine.filterDueMessages(schedule, new Date());
```

### 3.2. Tính Toán Báo Cáo ROI Telemetry (`calculateEventRoiTelemetry`)

```typescript
import { calculateEventRoiTelemetry } from '@kido/event-marketing';

const telemetry = calculateEventRoiTelemetry({
  eventCost: 15000000,           // 15,000,000 VND
  totalSessions: 450,            // Lượt quay/chụp
  totalPhotosPrinted: 900,       // Bản in lấy liền
  qrScans: 600,                  // Khách quét QR tải ảnh
  leadsCaptured: 360,            // Thu thập 360 SĐT/Email
  estimatedAttendance: 1000,     // 1,000 khách tham dự
  avgSocialSharesPerGuest: 2.5,  // 2.5 lượt đăng story/post
  avgFollowersPerGuest: 350,     // 350 followers trung bình
});

console.log(telemetry.totalInteractions);     // 1,950 điểm chạm
console.log(telemetry.conversionRatePercent); // 60%
console.log(telemetry.estimatedSocialReach);  // 525,000 lượt hiển thị
console.log(telemetry.costPerImpressionVnd);  // 28.57 VND / impression
console.log(telemetry.cpiRating);             // 'EXCELLENT' (< 100 VND)
```

### 3.3. Sinh Mã Email Chuẩn Craft Minimalism

```typescript
import { renderB2bRoiEmail } from '@kido/event-marketing';

const emailHtml = renderB2bRoiEmail({
  clientName: 'Anh Trần Minh Quân',
  eventName: 'VinFast Global Partner Summit',
  roi: telemetry,
  ctaUrl: 'https://tred.vn/dashboard/vinfast-gala-2026',
});
```

### 3.4. Gửi Tin Nhắn Zalo ZNS & Telegram

```typescript
import { ZaloZnsAdapter, TelegramAdapter } from '@kido/event-marketing';

// Zalo ZNS
const zns = new ZaloZnsAdapter({ mode: 'production' });
const payload = zns.buildAnniversaryPayload({
  phone: '0905123456',
  clientName: 'Hoàng Nam & Tuyết Mai',
  weddingDate: '20/11/2025',
  voucherCode: 'WEDDING1YEAR',
});
await zns.send(payload, process.env.ZALO_ACCESS_TOKEN);

// Telegram Briefing
const telegram = new TelegramAdapter({ botToken: process.env.TELEGRAM_BOT_TOKEN });
const markdown = telegram.formatCrewBriefingMarkdown(event);
await telegram.sendMessage('@tred_crew_ops', markdown);
```

---

## 4. Kiểm Thử & Đóng Gói

- **Kiểm thử**: `pnpm test` (18 unit test cases pass 100%).
- **Kiểm tra types**: `pnpm run typecheck` (tsc `--noEmit` pass 100%).
- **Build**: `pnpm run build` (xuất CJS, ESM và TypeScript definitions `.d.ts`).
