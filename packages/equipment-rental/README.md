# @kido/equipment-rental

> **Equipment Rental & Conflict Engine** chuyên biệt cho các đơn vị cho thuê máy ảnh, thiết bị sự kiện và hệ thống photobooth công nghệ cao (T-RED Media `tred.vn` & T-RED Photobooth `fotobooth.vn`).

---

## 🌟 Tính Năng Cốt Lõi

1. **Chống xung đột đặt trùng lịch (Double Booking Prevention)**:
   - Thuật toán **Interval Overlap Check** có tính thêm khoảng đệm an toàn (**Buffer Time**, mặc định 2 giờ) cho việc vận chuyển, setup và thu dọn/repack thiết bị giữa các show.
   - Hàm `findAvailableGear()` tìm kiếm nhanh thiết bị sẵn sàng theo kho (Đà Nẵng / TP.HCM) và danh mục thiết bị.
2. **Quản lý kho đa chi nhánh (Đà Nẵng & TP.HCM)**:
   - Theo dõi vòng đời toàn diện của thiết bị: `AVAILABLE`, `HOLD_PENDING`, `ASSIGNED_SHOW`, `IN_TRANSIT`, `MAINTENANCE`, `DAMAGED`.
   - Quy trình điều chuyển kho (**Transfer Order**) giữa chi nhánh Đà Nẵng và TP.HCM với các trạng thái `PENDING` -> `IN_TRANSIT` -> `COMPLETED`/`CANCELLED`.
3. **Đo đạc vật tư tiêu hao (Consumable Metering)**:
   - Quản lý cuộn giấy in nhiệt DNP DS620 (400 ảnh/cuộn 10x15cm), cuộn ruy băng mực (Ink Ribbon), pin sạc máy quay (Sony NP-FZ100 / V-Mount).
   - Tự động trừ số lượng bản in sau mỗi show, cảnh báo khi vật tư tiêu hao xuống dưới **20%** để kịp nạp cuộn mới.
4. **Biên bản bàn giao thiết bị xuất kho & thu hồi (Checklist Handover K80)**:
   - Sinh checklist bàn giao đi show (**Check-Out**) và kiểm tra thu hồi về kho (**Check-In**).
   - Tự động tính toán chi phí bồi thường hư hại máy hoặc làm mất phụ kiện (cáp HDMI, dây nguồn 3 pha, pin sạc, tripod).
   - Xuất hóa đơn/biên lai in nhiệt khổ K80 chuẩn 80mm có chữ ký xác nhận của hai bên.

---

## 📦 Cài Đặt

```bash
pnpm add @kido/equipment-rental zod
```

---

## 🚀 Hướng Dẫn Sử Dụng

### 1. Kiểm tra xung đột lịch & Tìm thiết bị trống (Conflict Detector)

```typescript
import {
  checkGearConflict,
  findAvailableGear,
  RentalBooking,
  GearItem,
} from '@kido/equipment-rental';

// Kiểm tra máy có bị trùng lịch với khoảng đệm 2h hay không
const conflict = checkGearConflict(
  'GEAR-GLAMBOT-01',
  new Date('2026-10-10T14:30:00Z'),
  new Date('2026-10-10T18:00:00Z'),
  existingBookings,
  2 // buffer 2 giờ
);

if (conflict.hasConflict) {
  console.warn('Xung đột lịch:', conflict.reason);
}

// Tìm tất cả máy Glambot còn trống tại kho Đà Nẵng
const availableGlambots = findAvailableGear(
  allGears,
  existingBookings,
  '2026-10-10T16:00:00Z',
  '2026-10-10T20:00:00Z',
  'PHOTOBOOTH_GLAMBOT',
  'DA_NANG',
  2 // 2h buffer
);
```

---

### 2. Quản lý kho & Điều chuyển chi nhánh (Inventory Tracker)

```typescript
import { InventoryTracker } from '@kido/equipment-rental';

const tracker = new InventoryTracker(gears);

// Tạo lệnh điều chuyển máy từ Đà Nẵng vào TP.HCM
const transfer = tracker.createTransferOrder({
  gearIds: ['GEAR-MIRROR-01'],
  sourceLocation: 'DA_NANG',
  targetLocation: 'HO_CHI_MINH',
  notes: 'Tăng cường máy cho show Marathon cuối tuần',
});

// Xuất kho gửi hàng
tracker.dispatchTransfer(transfer.id);

// Kho TP.HCM nhận máy thành công
tracker.receiveTransfer(transfer.id);
```

---

### 3. Quản lý cuộn giấy in DNP DS620 (Consumables Meter)

```typescript
import { ConsumablesMeter } from '@kido/equipment-rental';

const meter = new ConsumablesMeter();

// Khởi tạo cuộn giấy 400 ảnh DNP DS620
meter.createDnpPaperRoll({
  id: 'ROLL-01',
  totalPrints: 400,
  warningThresholdPercent: 20, // Báo động khi < 80 ảnh
});

// Ghi nhận sau show: in 350 ảnh + 10 ảnh test
const usage = meter.recordUsage('ROLL-01', 360, 'Gala Dinner Tech');
if (usage.isLowWarning) {
  console.warn(usage.warningMessage);
  // CẢNH BÁO VẬT TƯ: [Cuộn giấy in...] chỉ còn 40/400 prints (10.0%). Đã chạm ngưỡng báo động 20%! Cần thay mới...
}
```

---

### 4. Biên bản bàn giao & In hóa đơn K80 (Handover Audit)

```typescript
import { HandoverAuditService } from '@kido/equipment-rental';

// Check-In khi thu hồi máy về kho
const checkin = HandoverAuditService.createCheckInInspection({
  booking,
  gears,
  inspectorName: 'Kỹ thuật viên Nguyễn Văn A',
  customerRepresentative: 'Đại diện khách hàng Trần B',
  itemAudits: [
    {
      gearId: 'GEAR-GLAMBOT-01',
      condition: 'GOOD',
      missingAccessories: ['Cáp tín hiệu HDMI 10m'],
    },
    {
      gearId: 'GEAR-CAM-A7M4-SG',
      condition: 'SCRATCHED',
      damageNote: 'Xước thân máy và vỡ nắp che cổng HDMI',
    },
  ],
});

console.log('Tổng tiền phạt:', checkin.totalPenaltyFee);
console.log(checkin.k80ReceiptText); // Nội dung in bill K80
```

---

## 🧪 Chạy Kiểm Thử & Build

```bash
# Chạy Unit Tests (16/16 test cases)
pnpm run test

# Kiểm tra Type Safety
pnpm run typecheck

# Build bundle ESM, CJS, DTS
pnpm run build
```
