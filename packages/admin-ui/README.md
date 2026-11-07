# @kido/admin-ui (v1.0.0)

Thư viện thành phần giao diện quản trị (Admin UI Component System) chuẩn hóa cho các ứng dụng SME (FastFood, Spa Booking, Quản lý kho, POS, CRM) trong hệ sinh thái monorepo `kido-packages`.

Kiến trúc chuẩn hóa theo Shadcn UI / Radix UI / TanStack Table cho các dashboard quản trị hiệu năng cao.

---

## 📦 Cài đặt & Sử dụng

Khai báo dependency trong `package.json` của workspace app:

```json
{
  "dependencies": {
    "@kido/admin-ui": "workspace:*"
  }
}
```

Import trực tiếp các component:

```tsx
import {
  AdminLayout,
  StatCard,
  MetricsGrid,
  DataTable,
  DateRangeFilter,
  StatusBadge,
  Button,
  Card,
  Badge,
} from '@kido/admin-ui';
```

---

## 🚀 Các module cốt lõi

### 1. `AdminLayout` / `AdminShell`
Layout quản trị hiện đại, responsive hoàn chỉnh trên cả Mobile và Desktop:
- **Sidebar**: Hỗ trợ thu gọn (icon-only mode trên desktop, sliding drawer trên mobile), nhóm menu phân cấp, badge trạng thái, submenu accordion.
- **Header**: Nút thu phóng Sidebar, Breadcrumbs tự động, ô tìm kiếm nhanh (hỗ trợ phím tắt `⌘K`), Dark/Light mode toggle, chuông thông báo (kèm badge số lượng), menu người dùng (Avatar, thông tin, phân quyền, đăng xuất).
- **Page Container**: Tiêu đề trang, mô tả ngắn, khu vực nút hành động (Export, Thêm mới).

```tsx
<AdminLayout
  brand={{
    name: 'Kido FastFood Hub',
    subtitle: 'Hệ thống quản lý chuỗi',
    badge: 'PRO',
  }}
  navigation={[
    {
      label: 'Tổng quan',
      items: [
        { title: 'Dashboard', href: '/dashboard', icon: LayoutDashboard, isActive: true },
        { title: 'Đơn hàng', href: '/orders', icon: ShoppingBag, badge: '12 mới' },
      ],
    },
  ]}
  user={{
    name: 'Nguyễn Văn Quản Lý',
    email: 'admin@kidofood.vn',
    role: 'Quản trị viên',
  }}
  breadcrumbs={[
    { label: 'Trang chủ', href: '/' },
    { label: 'Quản lý đơn hàng' },
  ]}
  title="Danh sách đơn hàng"
  description="Xem và xử lý tất cả đơn hàng trực tiếp và giao hàng"
  notificationsCount={5}
  onSearchClick={() => console.log('Open search dialog')}
  onLogout={() => console.log('Logout')}
>
  {/* Page Content */}
</AdminLayout>
```

### 2. `StatCard` & `MetricsGrid`
Thẻ hiển thị chỉ số kinh doanh kèm xu hướng tăng trưởng:
- Tự động nhận diện xu hướng (`up` / `down` / `neutral`) từ tỉ lệ % thay đổi.
- Badge màu xanh/đỏ chuẩn UX.
- Loading skeleton tích hợp sẵn.

```tsx
<MetricsGrid columns={4}>
  <StatCard
    title="Doanh thu hôm nay"
    value="48.520.000 ₫"
    change={15.4}
    description="so với hôm qua"
    icon={DollarSign}
  />
  <StatCard
    title="Tổng đơn hàng"
    value="1.240"
    change={-2.1}
    description="so với 7 ngày trước"
    icon={ShoppingBag}
  />
  <StatCard
    title="Khách hàng mới"
    value="385"
    change={8.7}
    description="tăng trưởng tuần"
    icon={Users}
  />
  <StatCard
    title="Tỉ lệ hoàn đơn"
    value="1.2%"
    change={0.0}
    description="mức an toàn"
    icon={RotateCcw}
  />
</MetricsGrid>
```

### 3. `DataTable` & `Pagination`
Bảng dữ liệu mạnh mẽ xây dựng trên nền tảng `@tanstack/react-table`:
- Tìm kiếm tức thì (Client-side hoặc Server-side search query).
- Sắp xếp cột linh hoạt với biểu tượng mũi tên trực quan.
- Ẩn/hiện cột tùy chỉnh qua dropdown menu.
- Cột số thứ tự `#` tự động đánh số theo trang.
- Hàng skeleton mượt mà khi `loading={true}`.
- Giao diện trống thân thiện khi không có bản ghi nào.
- Bộ phân trang đầy đủ: Cỡ trang (10, 20, 50, 100), chuyển trang số, trang đầu/cuối, thu gọn ellipsis.

```tsx
<DataTable
  columns={columns}
  data={orders}
  searchKey="customerName"
  searchPlaceholder="Tìm theo tên khách hàng hoặc mã đơn..."
  loading={isLoading}
  showIndexColumn={true}
  toolbarActions={
    <Button size="sm">
      <Plus className="size-4 mr-1" /> Tạo đơn mới
    </Button>
  }
/>
```

### 4. `DateRangeFilter`
Bộ lọc khoảng thời gian thiết kế tối ưu cho doanh nghiệp bán lẻ & SME:
- 7 bộ chọn nhanh: **Hôm nay**, **Hôm qua**, **7 ngày qua**, **30 ngày qua**, **Tháng này**, **Tháng trước**, **Tất cả thời gian**.
- Chọn ngày tùy biến với ô nhập `Từ ngày` - `Đến ngày`.
- Nút đặt lại & áp dụng tiện lợi.

```tsx
<DateRangeFilter
  value={dateRange}
  onChange={(newRange) => {
    console.log(newRange.from, newRange.to, newRange.preset);
  }}
/>
```

### 5. `StatusBadge`
Huy hiệu trạng thái đơn hàng & thanh toán chuẩn hóa cho hệ thống SME:
- `PENDING` ("Chờ xử lý") - Badge vàng cảnh báo.
- `PROCESSING` ("Đang thực hiện") - Badge xanh dương.
- `COMPLETED` ("Hoàn thành") - Badge xanh lá thành công.
- `CANCELLED` ("Đã hủy") - Badge đỏ hủy đơn.
- `PAID` ("Đã thanh toán") - Badge xanh ngọc.
- `UNPAID` ("Chưa thanh toán") - Badge vàng/đỏ.
- `REFUNDED` ("Đã hoàn tiền") - Badge tím.
- `SHIPPING` ("Đang giao hàng") - Badge xanh da trời.
- `DELIVERED` ("Đã giao hàng") - Badge xanh lá.
- Hỗ trợ chấm trạng thái nhấp nháy động (`showDot={true}`).

```tsx
<StatusBadge status="PAID" />
<StatusBadge status="PENDING" showDot={true} />
<StatusBadge status="Đang giao hàng" showIcon={true} />
```

### 6. UI Primitives
Bộ thành phần giao diện nền tảng:
- `Button`, `buttonVariants`
- `Badge`, `badgeVariants`
- `Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardContent`, `CardFooter`, `CardAction`
- `Input`
- `Avatar`, `AvatarImage`, `AvatarFallback`
- `Skeleton`
- `Separator`
- `Table`, `TableHeader`, `TableBody`, `TableFooter`, `TableRow`, `TableHead`, `TableCell`, `TableCaption`
- `Dialog`, `DialogTrigger`, `DialogContent`, `DialogHeader`, `DialogFooter`, `DialogTitle`, `DialogDescription`
- `DropdownMenu`, `DropdownMenuTrigger`, `DropdownMenuContent`, `DropdownMenuItem`, `DropdownMenuCheckboxItem`, v.v.
- `Select`, `SelectTrigger`, `SelectContent`, `SelectItem`, `SelectValue`
- `Tooltip`, `TooltipTrigger`, `TooltipContent`, `TooltipProvider`
- `Popover`, `PopoverTrigger`, `PopoverContent`
- `Breadcrumb`, `BreadcrumbList`, `BreadcrumbItem`, `BreadcrumbLink`, `BreadcrumbPage`, `BreadcrumbSeparator`

---

## 🛠 Lệnh phát triển & Kiểm thử

Tại thư mục `packages/admin-ui`:

- `pnpm run build`: Build song song định dạng ESM (`dist/index.mjs`), CJS (`dist/index.js`), DTS (`dist/index.d.ts`).
- `pnpm run typecheck`: Kiểm tra TypeScript strict mode không sinh code emit (`tsc --noEmit`).
- `pnpm run test`: Chạy unit tests thông qua `node:test` và `tsx`.
