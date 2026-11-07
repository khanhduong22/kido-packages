# @kido/geocoding-routing

> Bộ công cụ định tuyến, tính khoảng cách, OSRM client với graceful fallback, dữ liệu sân bay trọng điểm Việt Nam và thuật toán tính cước taxi / xe hợp đồng bậc thang.

## 📦 Tính Năng Chính

1. **Haversine & Road Curvature (`haversine.ts`)**:
   - Tính khoảng cách chim bay theo bán kính Trái Đất (6,371 km).
   - Ước tính cự ly đường bộ với hệ số uốn lượn đường sá Việt Nam (1.25 - 1.35x).
   - Ước tính thời gian hành trình theo tốc độ đô thị (28 km/h) và đường dài (55 km/h).

2. **OSRM Route Client (`osrm-client.ts`)**:
   - Gọi API OpenStreetMap OSRM Route v1 (chuẩn driving miễn phí $0).
   - Tự động fallback sang công thức Haversine road estimation nếu mạng timeout hoặc mất kết nối.

3. **Vietnam Airport Hubs & Fixed Routes (`airports.ts`)**:
   - Danh sách tọa độ 7 sân bay trọng điểm: Nội Bài (HAN), Tân Sơn Nhất (SGN), Đà Nẵng (DAD), Cam Ranh (CXR), Phú Quốc (PQC), Cát Bi (HPH), Liên Khương (DLI).
   - Chặng cố định phổ biến trọn gói vé cầu đường và sảnh đón ga T1/T2.

4. **Tiered Fare Calculator (`fare-calculator.ts`)**:
   - Giá cố định theo chặng sân bay.
   - Bậc thang km: 1-5km mở cửa, 6-30km cự ly chuẩn, >30km đường dài (giảm 15% km vượt).
   - Hệ số loại xe: 4 chỗ Sedan (1.0x), 7 chỗ SUV/MPV (1.25x), Chuyên cơ VIP Carnival (1.9x).
   - Phụ thu đêm muộn (22:00 - 05:00) +50k, Giờ cao điểm +30k.
   - Giảm 20% tổng cước cho chuyến khứ hồi trong ngày.
   - Tính tiền cọc giữ xe 100k - 200k.

## 🧪 Kiểm Thử

```bash
pnpm test
pnpm build
pnpm typecheck
```
