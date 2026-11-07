import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  // Utils
  cn,
  formatCurrencyVND,
  formatCompactNumber,
  // Status Badge
  getStatusBadgeConfig,
  normalizeStatusKey,
  STATUS_CONFIG_MAP,
  StatusBadge,
  // Date Range
  DATE_PRESETS,
  getDatePresetRange,
  formatDateRange,
  DateRangeFilter,
  // Stats
  StatCard,
  MetricsGrid,
  // Table
  DataTable,
  Pagination,
  // Shell
  AdminLayout,
  AdminShell,
  AdminSidebar,
  AdminHeader,
  useAdminShell,
  // UI Primitives
  Button,
  buttonVariants,
  Badge,
  badgeVariants,
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardFooter,
  Input,
  Avatar,
  AvatarImage,
  AvatarFallback,
  Dialog,
  DialogContent,
  DropdownMenu,
  Table,
  TableHeader,
  TableRow,
  TableCell,
  Breadcrumb,
  Select,
  Tooltip,
  Popover,
  Skeleton,
  Separator,
} from './index';

describe('@kido/admin-ui Package Test Suite', () => {
  describe('1. Core Utilities & Formatting', () => {
    it('should correctly merge tailwind classes with cn()', () => {
      const result = cn('px-4 py-2', 'bg-blue-500', { 'bg-red-500': true });
      assert.ok(result.includes('px-4'));
      assert.ok(result.includes('py-2'));
      // tailwind-merge resolves conflicts: bg-red-500 replaces bg-blue-500
      assert.ok(result.includes('bg-red-500'));
      assert.ok(!result.includes('bg-blue-500'));
    });

    it('should format VND currency accurately', () => {
      const formatted = formatCurrencyVND(150000);
      assert.ok(formatted.includes('150.000'));
      assert.ok(formatted.includes('₫') || formatted.includes('VND'));
    });

    it('should format compact numbers in Vietnamese', () => {
      const compact1 = formatCompactNumber(1500);
      assert.ok(compact1.length > 0);

      const compact2 = formatCompactNumber(2500000);
      assert.ok(compact2.includes('2,5') || compact2.includes('2.5') || compact2.includes('tr'));
    });
  });

  describe('2. SME StatusBadge Configuration & Mapping', () => {
    it('should normalize status keys reliably', () => {
      assert.equal(normalizeStatusKey('pending'), 'PENDING');
      assert.equal(normalizeStatusKey('in-progress'), 'IN_PROGRESS');
      assert.equal(normalizeStatusKey('  paid  '), 'PAID');
    });

    it('should resolve standard SME statuses', () => {
      const pending = getStatusBadgeConfig('PENDING');
      assert.equal(pending.label, 'Chờ xử lý');
      assert.equal(pending.variant, 'warning');
      assert.ok(pending.dotColor.includes('amber'));

      const processing = getStatusBadgeConfig('PROCESSING');
      assert.equal(processing.label, 'Đang thực hiện');
      assert.equal(processing.variant, 'info');

      const completed = getStatusBadgeConfig('COMPLETED');
      assert.equal(completed.label, 'Hoàn thành');
      assert.equal(completed.variant, 'success');

      const cancelled = getStatusBadgeConfig('CANCELLED');
      assert.equal(cancelled.label, 'Đã hủy');
      assert.equal(cancelled.variant, 'destructive');

      const paid = getStatusBadgeConfig('PAID');
      assert.equal(paid.label, 'Đã thanh toán');
      assert.equal(paid.variant, 'success');

      const unpaid = getStatusBadgeConfig('UNPAID');
      assert.equal(unpaid.label, 'Chưa thanh toán');
      assert.equal(unpaid.variant, 'warning');

      const refunded = getStatusBadgeConfig('REFUNDED');
      assert.equal(refunded.label, 'Đã hoàn tiền');
      assert.equal(refunded.variant, 'purple');

      const shipping = getStatusBadgeConfig('SHIPPING');
      assert.equal(shipping.label, 'Đang giao hàng');
      assert.equal(shipping.variant, 'info');

      const delivered = getStatusBadgeConfig('DELIVERED');
      assert.equal(delivered.label, 'Đã giao hàng');
      assert.equal(delivered.variant, 'success');
    });

    it('should fallback gracefully for Vietnamese textual inputs', () => {
      const config1 = getStatusBadgeConfig('Chờ xác nhận');
      assert.equal(config1.label, 'Chờ xử lý');

      const config2 = getStatusBadgeConfig('Đang giao hàng tận nơi');
      assert.equal(config2.label, 'Đang giao hàng');

      const config3 = getStatusBadgeConfig('Đã hủy đơn bởi khách');
      assert.equal(config3.label, 'Đã hủy');
    });

    it('should provide default fallback for unknown statuses', () => {
      const config = getStatusBadgeConfig('CUSTOM_STATE_XYZ');
      assert.equal(config.label, 'CUSTOM_STATE_XYZ');
      assert.equal(config.variant, 'secondary');
    });
  });

  describe('3. DateRangeFilter Presets & Formatting', () => {
    it('should have 7 standard SME date presets defined', () => {
      assert.equal(DATE_PRESETS.length, 7);
      const keys = DATE_PRESETS.map((p) => p.key);
      assert.deepEqual(keys, [
        'today',
        'yesterday',
        'last7days',
        'last30days',
        'thisMonth',
        'lastMonth',
        'all',
      ]);
    });

    it('should compute valid date range for "today"', () => {
      const range = getDatePresetRange('today');
      assert.ok(range.from);
      assert.ok(range.to);
      assert.equal(range.from, range.to);
      assert.match(range.from!, /^\d{4}-\d{2}-\d{2}$/);
    });

    it('should compute valid date range for "last7days"', () => {
      const range = getDatePresetRange('last7days');
      assert.ok(range.from);
      assert.ok(range.to);
      assert.notEqual(range.from, range.to);
      const fromDate = new Date(range.from!);
      const toDate = new Date(range.to!);
      assert.ok(fromDate < toDate);
    });

    it('should format date range label appropriately', () => {
      assert.equal(formatDateRange(null), 'Tất cả thời gian');
      assert.equal(formatDateRange({ from: null, to: null }), 'Tất cả thời gian');
      assert.equal(
        formatDateRange({ from: '2026-09-01', to: '2026-09-30', preset: 'thisMonth' }),
        'Tháng này'
      );
      assert.equal(
        formatDateRange({ from: '2026-09-15', to: '2026-09-15' }),
        '15/09/2026'
      );
      assert.equal(
        formatDateRange({ from: '2026-09-01', to: '2026-09-15' }),
        '01/09/2026 - 15/09/2026'
      );
    });
  });

  describe('4. Component Exports & Integrity Verification', () => {
    it('should properly export all UI Primitives', () => {
      assert.ok(Button, 'Button should be defined');
      assert.ok(buttonVariants, 'buttonVariants should be defined');
      assert.ok(Badge, 'Badge should be defined');
      assert.ok(badgeVariants, 'badgeVariants should be defined');
      assert.ok(Card, 'Card should be defined');
      assert.ok(CardHeader, 'CardHeader should be defined');
      assert.ok(CardTitle, 'CardTitle should be defined');
      assert.ok(CardContent, 'CardContent should be defined');
      assert.ok(CardFooter, 'CardFooter should be defined');
      assert.ok(Input, 'Input should be defined');
      assert.ok(Avatar, 'Avatar should be defined');
      assert.ok(AvatarImage, 'AvatarImage should be defined');
      assert.ok(AvatarFallback, 'AvatarFallback should be defined');
      assert.ok(Dialog, 'Dialog should be defined');
      assert.ok(DialogContent, 'DialogContent should be defined');
      assert.ok(DropdownMenu, 'DropdownMenu should be defined');
      assert.ok(Table, 'Table should be defined');
      assert.ok(TableHeader, 'TableHeader should be defined');
      assert.ok(TableRow, 'TableRow should be defined');
      assert.ok(TableCell, 'TableCell should be defined');
      assert.ok(Breadcrumb, 'Breadcrumb should be defined');
      assert.ok(Select, 'Select should be defined');
      assert.ok(Tooltip, 'Tooltip should be defined');
      assert.ok(Popover, 'Popover should be defined');
      assert.ok(Skeleton, 'Skeleton should be defined');
      assert.ok(Separator, 'Separator should be defined');
    });

    it('should properly export all Admin & Business Components', () => {
      assert.ok(StatusBadge, 'StatusBadge should be defined');
      assert.ok(StatCard, 'StatCard should be defined');
      assert.ok(MetricsGrid, 'MetricsGrid should be defined');
      assert.ok(DateRangeFilter, 'DateRangeFilter should be defined');
      assert.ok(DataTable, 'DataTable should be defined');
      assert.ok(Pagination, 'Pagination should be defined');
      assert.ok(AdminLayout, 'AdminLayout should be defined');
      assert.ok(AdminShell, 'AdminShell should be defined');
      assert.ok(AdminSidebar, 'AdminSidebar should be defined');
      assert.ok(AdminHeader, 'AdminHeader should be defined');
      assert.ok(useAdminShell, 'useAdminShell should be defined');
      assert.equal(AdminShell, AdminLayout, 'AdminShell should alias AdminLayout');
    });
  });
});
