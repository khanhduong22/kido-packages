# @kido/lead-crm

Package hỗ trợ xử lý luồng Lead cho các hệ thống bán hàng và CRM tại thị trường Việt Nam:
1. **Lead Ingestion & Validator**: Làm sạch, chuẩn hóa số điện thoại di động Việt Nam (chuẩn 10 số đầu 03, 05, 07, 08, 09), nhận diện nhà mạng (Viettel, Mobifone, Vinaphone, Vietnamobile, Wintel, Gmobile), và chuẩn hóa UTM parameters từ Facebook Ads / TikTok Ads.
2. **Google Sheets Realtime Sync Payload Formatter**: Định dạng dữ liệu gửi sang Google Apps Script Webhook để tự động thêm dòng mới vào bảng tính, bảo toàn số `0` ở đầu số điện thoại (`'098...`) và format thời gian theo múi giờ Việt Nam.
3. **Round-Robin Lead Distribution**: Phân bổ khách hàng tiềm năng xoay vòng đều cho đội ngũ nhân viên tư vấn/telesale, hỗ trợ trọng số (weighted round-robin), bỏ qua nhân viên không hoạt động (`isActive = false`), và lưu vết trạng thái (export/load state).
4. **Type-safe Zod Schemas**: Schemas runtime validation và types cho `LeadInput`, `LeadRecord`, `SalesAgent`, `GoogleSheetPayload`.

---

## Cài đặt

```bash
pnpm add @kido/lead-crm
```

## Hướng dẫn sử dụng

### 1. Ingestion & Kiểm tra Số điện thoại / UTM

```typescript
import { ingestLead, cleanPhoneNumber, isValidVietnamesePhone, getVietnameseCarrier } from '@kido/lead-crm';

// Kiểm tra và làm sạch số điện thoại
cleanPhoneNumber('+84 987 654 321'); // '0987654321'
isValidVietnamesePhone('0987654321'); // true
getVietnameseCarrier('0987654321'); // 'Viettel'

// Ingest Lead từ Web Form / Landing Page / Webhook
const result = ingestLead({
  fullName: 'Nguyễn Văn A',
  phone: '+84 987 654 321',
  productInterest: 'Bộ chăm sóc da',
  utm: {
    utm_source: 'Facebook',
    utm_campaign: 'flash_sale',
    fbclid: 'IwAR...',
  },
});

if (result.success) {
  console.log('Lead Record:', result.data);
} else {
  console.error('Lỗi validation:', result.errors);
}
```

### 2. Phân bổ Lead theo Round-Robin

```typescript
import { RoundRobinDistributor, SalesAgent } from '@kido/lead-crm';

const agents: SalesAgent[] = [
  { id: 'sale-01', name: 'Nguyễn Văn An', isActive: true, weight: 2 },
  { id: 'sale-02', name: 'Trần Thị Bình', isActive: true, weight: 1 },
  { id: 'sale-03', name: 'Lê Văn Cường', isActive: false, weight: 1 }, // Nghỉ phép -> tự động bỏ qua
];

const distributor = new RoundRobinDistributor(agents);

// Gán từng lead cho sale tiếp theo
const assignedLead = distributor.assignLead(leadRecord);
console.log(`Lead được phân bổ cho: ${assignedLead.assignedAgentName}`);

// Lưu trạng thái để sync với Redis / Database
const state = distributor.exportState();
distributor.loadState(state);
```

### 3. Đồng bộ Google Sheets Realtime qua Webhook

```typescript
import { formatGoogleSheetPayload, createGoogleSheetsWebhookRequest } from '@kido/lead-crm';

const payload = formatGoogleSheetPayload(assignedLead, {
  sheetName: 'Data Leads',
  preservePhoneLeadingZero: true, // Thêm dấu ' để Google Sheets không làm mất số 0 đầu
});

// Gửi tới Google Apps Script Webhook
const reqConfig = createGoogleSheetsWebhookRequest({
  webhookUrl: 'https://script.google.com/macros/s/AKfycb.../exec',
  payload,
  secretToken: 'secret_token_here',
});

await fetch(reqConfig.url, {
  method: reqConfig.method,
  headers: reqConfig.headers,
  body: reqConfig.body,
});
```

---

## Scripts

- `pnpm run build`: Build ESM, CJS, DTS với tsup.
- `pnpm run typecheck`: Kiểm tra TypeScript types (`tsc --noEmit`).
- `pnpm run test`: Chạy unit test với Node native test runner (`node --test`).
