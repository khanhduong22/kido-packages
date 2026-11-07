# @kido/anti-spam

> **High-Performance Zero-Dependency Anti-Spam & Moderation Engine**
> Chuẩn hóa kiến trúc kiểm duyệt nội dung cộng đồng và chống spam hiệu năng cao.

[![TypeScript](https://img.shields.io/badge/TypeScript-Strict-blue.svg)](https://www.typescriptlang.org/)
[![Bun](https://img.shields.io/badge/Bun-1.3+-black.svg)](https://bun.sh/)
[![Zero Dependency](https://img.shields.io/badge/Dependencies-0-success.svg)](https://github.com/khanhduong22/kido-packages)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

---

## 1. Bài Toán & Động Lực Kiến Trúc

Các hệ sinh thái cộng đồng và micro-SaaS thường đối mặt với các vấn nạn spam nghiêm trọng:
1. **Thuật toán quét tuyến tính nông cạn $O(N \times M)$**: Lặp qua danh sách từ khóa bằng `for (const word of words) content.includes(word)` gây nghẽn hoàn toàn Event Loop của Node.js/Bun khi danh sách đạt hàng nghìn từ.
2. **Vấn nạn Scunthorpe (False Positives)**: Chặn "dm" nhưng vô tình chặn luôn "admin" hay "roadmap"; chặn "sex" nhưng chặn "Sussex"; chặn "bán" nhưng chặn "cơ bản" hay "bản sắc".
3. **Kỹ thuật lẩn tránh tinh vi (Evasion)**:
   - Chèn ký tự tàng hình, zero-width space (`\u200B`, `\u200C`, `\uFEFF`).
   - Lạm dụng biến thể Unicode (NFD decomposed form).
   - Homoglyphs: Thay chữ Latin bằng ký tự Cyrillic (`а`, `е`, `о`, `р`) hoặc Greek (`ο`).
   - Leetspeak và phân tách ký tự: `b.á.n`, `b-á-n`, `z a l o`, `@` -> `a`, `$` -> `s`.
4. **Spam lừa đảo & mời nhóm ngoài luồng**: Zalo group links (`zalo.me/g/...`), Telegram groups (`t.me/...`), link rút gọn rác (`bit.ly`, `tinyurl.com`, `is.gd`, `cutt.ly`, `rb.gy`).
5. **Hành vi Spam Bot Flood & Tần Suất Cao**: Tấn công copy-paste nội dung hàng loạt qua nhiều bài viết khác nhau hoặc spam liên tục hàng chục comment mỗi phút.
6. **Vùng xám ngữ nghĩa (Grey-Zone)**: Những nội dung không chứa từ tục tĩu nhưng mang tính chất lôi kéo đầu tư lãi khủng, đa cấp tài chính, kéo tài khoản 1-1, hoặc nhóm kín VIP.

`@kido/anti-spam` giải quyết triệt để tất cả các vấn đề trên với **0 runtime dependencies**, tốc độ xử lý **< 1ms**, và kiến trúc đa tầng chuẩn Enterprise.

---

## 2. Kiến Trúc Pipeline Đa Tầng (Multi-Tier Defense)

```mermaid
flowchart TD
    Req["Request (Nội dung, userId, targetId)"] --> L2_Rate["Layer 2: Velocity Rate Limiter"]
    
    L2_Rate -- "Vượt ngưỡng tần suất" --> D_BlockRate["BLOCK: 400 Bad Request (Thao tác quá nhanh)"]
    L2_Rate -- "Hợp lệ" --> L1_Norm["Layer 1: Normalizer & Canonicalization"]
    
    subgraph L1_Trie ["Layer 1: Linear Trie & Heuristics"]
        L1_Norm --> AC["Aho-Corasick Automaton O(M)"]
        L1_Norm --> Heuristics["Phishing Regex (Zalo/Tele/Shorteners/Phones)"]
    end
    
    AC -- "Chứa từ cấm BLOCK" --> D_BlockTrie["BLOCK: 400 Bad Request (Từ cấm)"]
    AC -- "Chứa từ cấm HIDE hoặc link rác" --> D_HideTrie["HIDE: Lưu ẩn chờ duyệt"]
    
    AC -- "Chưa vi phạm" --> L2_Dup["Layer 2: Duplicate Content Flood Across Targets"]
    L2_Dup -- "Flood >= 3 distinct targets" --> D_HideDup["HIDE: Trùng lặp liên tục trên nhiều mục tiêu"]
    
    L2_Dup -- "Chưa vi phạm" --> L3_Trigger{"Grey-Zone Trigger?"}
    L3_Trigger -- "Từ khóa nghi vấn HOẶC dài > 120 ký tự" --> L3_Gemini["Layer 3: Gemini Flash-Lite AI Semantic Check"]
    L3_Trigger -- "Văn bản ngắn sạch" --> D_Allow["ALLOW: Đăng tải bình thường"]
    
    L3_Gemini -- "isSpam=true & score >= 0.8" --> D_HideAI["HIDE: AI phát hiện lừa đảo / lôi kéo"]
    L3_Gemini -- "An toàn / Fail-open" --> D_Allow
```

---

## 3. Cài Đặt & Cấu Hình

```bash
# Trong monorepo KT Portfolio
pnpm add @kido/anti-spam --filter <your-app>
```

```typescript
// Core Engine & Utilities
import {
  AntiSpamEngine,
  AntiSpamError,
  TextNormalizer,
  AhoCorasickAutomaton,
  SpamVelocityGuard,
  MemoryVelocityCacheAdapter,
  GeminiSpamAnalyzer,
  hashContent,
  scanHeuristics,
  createHonoAntiSpamMiddleware,
  createExpressAntiSpamMiddleware,
} from '@kido/anti-spam';

// Curated Blacklist Presets (Subpath export)
import {
  getVietnamesePresets,
  getEnglishPresets,
  getAllPresets,
  getPresetsByCategory,
  createPresetRules,
  PRESET_CATEGORIES,
} from '@kido/anti-spam/presets';
```

---

## 4. Hướng Dẫn Sử Dụng Chi Tiết

### 4.1 Khởi Tạo Full Pipeline 3 Tầng

```typescript
import {
  AntiSpamEngine,
  SpamVelocityGuard,
  GeminiSpamAnalyzer,
} from '@kido/anti-spam';
import { getVietnamesePresets } from '@kido/anti-spam/presets';

const engine = new AntiSpamEngine({
  // Tầng 1: Load rules mẫu tiếng Việt (PROFANITY, GAMBLING, SCAM, SEXUAL)
  defaultRules: getVietnamesePresets(),

  // Tầng 2: Kiểm soát tần suất & flood nội dung
  velocityGuard: new SpamVelocityGuard({
    commentLimit: 10,       // Tối đa 10 comments / 60 giây
    commentWindowSec: 60,
    postLimit: 3,           // Tối đa 3 posts / 5 phút
    postWindowSec: 300,
    duplicateThreshold: 3,  // Chặn khi copy-paste qua >= 3 bài viết khác nhau
    duplicateWindowSec: 300,
  }),

  // Tầng 3: AI phân tích ngữ nghĩa vùng xám (Zero-dependency HTTP fetch, fail-open 2.5s)
  geminiAnalyzer: new GeminiSpamAnalyzer({
    apiKey: process.env.GEMINI_API_KEY,
    modelName: 'gemini-2.0-flash-lite',
    timeoutMs: 2500,
    thresholdScore: 0.8,
  }),
});
```

### 4.2 Validate Nội Dung Qua Pipeline

```typescript
const outcome = await engine.validate('Cam kết lãi ngày 5%, inbox Zalo nhận slot', {
  userId: 'user_123',
  targetId: 'post_456',
  actionType: 'comment',
});

if (outcome.shouldBlock) {
  // Bị chặn do từ cấm Tầng 1 hoặc vượt tần suất Tầng 2
  console.error('Bị chặn:', outcome.reason);
} else if (outcome.shouldHide) {
  // Được lưu vào DB nhưng ẩn chờ duyệt (link rác, spam bot flood, hoặc AI phát hiện)
  console.warn('Lưu ẩn duyệt:', outcome.reason);
} else {
  // Hợp lệ, hiển thị công khai
  console.log('Nội dung sạch!');
}
```

### 4.3 Đồng Bộ Fast-Path (Synchronous Layer 1 Only)

```typescript
// Chỉ chạy Trie Aho-Corasick + Heuristics cục bộ siêu tốc (< 0.1ms, không chờ I/O)
const syncOutcome = engine.validateSync('Nội dung bình luận mẫu');
if (syncOutcome.shouldBlock) {
  throw new AntiSpamError('Nội dung vi phạm');
}
```

### 4.4 Che Giấu Từ Cấm Tự Động (Censor / Masking)

```typescript
const censored = engine.censor('Thằng đm này chửi bậy');
// -> 'Thằng ** này chửi bậy'
```

---

## 5. Middleware Cho Web Frameworks (Hono & Express)

### 5.1 Hono v4 Middleware

```typescript
import { Hono } from 'hono';
import { AntiSpamEngine, createHonoAntiSpamMiddleware } from '@kido/anti-spam';

const app = new Hono();
const engine = new AntiSpamEngine({ ... });

// Tự động kiểm tra các trường body: content, title, comment, message, bio...
app.post('/api/comments', createHonoAntiSpamMiddleware(engine), async (c) => {
  const outcome = c.get('antiSpam');
  if (outcome.shouldHide) {
    // Lưu trạng thái PENDING_REVIEW
    return c.json({ status: 'PENDING_REVIEW' });
  }
  return c.json({ status: 'PUBLISHED' });
});
```

### 5.2 Express Middleware

```typescript
import express from 'express';
import { AntiSpamEngine, createExpressAntiSpamMiddleware } from '@kido/anti-spam';

const app = express();
app.use(express.json());

const engine = new AntiSpamEngine({ ... });

app.post('/api/posts', createExpressAntiSpamMiddleware(engine), (req, res) => {
  res.json({ success: true, antiSpam: req.antiSpam });
});
```

---

## 6. Bộ Từ Khóa Mẫu Chuẩn Hóa (`@kido/anti-spam/presets`)

Package cung cấp sẵn danh mục từ khóa chọn lọc:
- `PROFANITY`: từ ngữ thô tục, chửi thề phổ biến (Việt - Anh).
- `GAMBLING`: lô đề, soi cầu, cá độ bóng đá, tài xỉu, nổ hũ, casino online (kubet, thabet, sunwin, go88...).
- `SCAM`: lừa đảo tài chính, kéo tài khoản, ủy thác lợi nhuận khủng, app vay tiền nặng lãi, tín dụng đen.
- `SEXUAL`: nội dung khiêu dâm, gạ gẫm 18+, gái gọi, massage kích dục.

```typescript
import {
  getVietnamesePresets,
  getEnglishPresets,
  getAllPresets,
  getPresetsByCategory,
  PRESET_CATEGORIES,
} from '@kido/anti-spam/presets';

// Lấy toàn bộ từ khóa lừa đảo & cờ bạc tiếng Việt
const scamRules = getPresetsByCategory(PRESET_CATEGORIES.SCAM, 'vi');
const gamblingRules = getPresetsByCategory(PRESET_CATEGORIES.GAMBLING, 'vi');
```

---

## 7. Bảng Tra Cứu Core Exports

| Export Symbol | Module | Kiểu | Mô Tả & Nghiệp Vụ |
| :--- | :--- | :--- | :--- |
| `AntiSpamEngine` | `@kido/anti-spam` | Class | Engine điều phối 3 tầng: Trie Aho-Corasick, Heuristics, Velocity Guard, Gemini AI. |
| `AntiSpamError` | `@kido/anti-spam` | Class (Error) | Lỗi định danh vi phạm tiêu chuẩn cộng đồng (`statusCode: 400`, `blockedWords`, `fieldName`). |
| `TextNormalizer` | `@kido/anti-spam` | Class | Chuẩn hóa đa tầng: bóc zero-width, NFC unicode, Cyrillic/Greek homoglyphs, repeated chars, leetspeak. |
| `AhoCorasickAutomaton` | `@kido/anti-spam` | Class | Thuật toán Aho-Corasick đa mẫu $O(M)$ tuyến tính kèm kiểm tra biên từ Scunthorpe thông minh. |
| `SpamVelocityGuard` | `@kido/anti-spam` | Class | Kiểm soát tần suất đăng bài/bình luận & phát hiện bot spam duplicate flood qua nhiều targets. |
| `MemoryVelocityCacheAdapter` | `@kido/anti-spam` | Class | Bộ đệm RAM in-memory tự dọn dẹp TTL, zero-dependency. |
| `GeminiSpamAnalyzer` | `@kido/anti-spam` | Class | AI semantic analyzer dùng Gemini Flash-Lite, zero-dependency HTTP fetch, fail-open 2500ms. |
| `maskMatchedText` | `@kido/anti-spam` | Function | Helper thay thế từ cấm bằng dấu `*` hoặc ký tự tùy biến với thuật toán gom khoảng đè (merge intervals). |
| `hashContent` | `@kido/anti-spam` | Function | Hàm băm FNV-1a 64-bit siêu tốc sinh mã định danh nội dung chống copy-paste spam flood. |
| `scanHeuristics` | `@kido/anti-spam` | Function | Regex scanner bóc tách link Zalo/Telegram invites, link rút gọn rác (`bit.ly`, `tinyurl`), phone spam. |
| `createHonoAntiSpamMiddleware` | `@kido/anti-spam` | Function | Middleware Hono v4 tự động phân tích JSON body và chặn đứng request vi phạm. |
| `createExpressAntiSpamMiddleware`| `@kido/anti-spam` | Function | Middleware Express/Connect tương thích. |
| `validateRequestBody` | `@kido/anti-spam` | Function | Helper xác thực object bất kỳ theo danh sách field ưu tiên. |
| `getVietnamesePresets` | `@kido/anti-spam/presets`| Function | Trả về danh sách blacklist rules tiếng Việt phân loại chuẩn. |
| `getEnglishPresets` | `@kido/anti-spam/presets`| Function | Trả về danh sách blacklist rules tiếng Anh phân loại chuẩn. |
| `getAllPresets` | `@kido/anti-spam/presets`| Function | Trả về toàn bộ blacklist rules kết hợp Việt - Anh. |

---

## 8. Kiểm Thử & Hiệu Năng

```bash
# Chạy 54 unit tests với Bun
bun test packages/anti-spam
```

- **Độ phức tạp thời gian**: $O(M)$ với $M$ là chiều dài văn bản (hoàn toàn độc lập với số lượng từ cấm $N$).
- **Benchmark**: Quét đoạn văn 10,000 ký tự với 500 rules blacklist hoàn tất trong **< 1ms**.
- **Bộ nhớ RAM**: Trie nodes tối ưu bằng `Map<string, TrieNode>`, tiêu thụ ít hơn 2MB RAM cho 5,000 từ khóa.

---

## 9. License

MIT © Khanh Dương (KT Portfolio)
