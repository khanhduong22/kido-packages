import React from 'react';
import { AdminShell, Button, Badge } from '@kido/admin-ui';
import {
  ArrowLeft,
  RefreshCw,
  ShoppingBag,
  TrendingUp,
  Package,
  Layers,
  Settings,
  Store,
  CheckCircle2,
  AlertCircle,
} from 'lucide-react';
import type { AdminOrder, BankConfig, EcommerceMetrics, OrderStatus } from '../types';
import { useEcommerceAdmin } from './useEcommerceAdmin';
import { MetricCards } from './components/MetricCards';
import { OrderTable } from './components/OrderTable';
import { ReceiptModal } from './components/ReceiptModal';

export interface EcommerceAdminDashboardProps {
  brandName?: string;
  brandSubtitle?: string;
  storeTagline?: string;
  storeHotline?: string;
  storeAddress?: string;
  apiBaseUrl?: string;
  initialOrders?: AdminOrder[];
  initialMetrics?: EcommerceMetrics | null;
  bankConfig?: BankConfig;
  exchangeRate?: number;
  onBackToStore?: () => void;
}

export function EcommerceAdminDashboard({
  brandName = 'FLASHBUY PRO',
  brandSubtitle = 'Quản Trị Đơn Hàng & Doanh Thu',
  storeTagline = 'Official Sales & Fulfillment Center',
  storeHotline = '1900 6868',
  storeAddress = 'Vietnam',
  apiBaseUrl = '/api/admin',
  initialOrders = [],
  initialMetrics = null,
  bankConfig = {
    bank: 'MBBank',
    accountNumber: '0912345678',
    accountName: 'KIDO ECOMMERCE',
    template: 'compact2',
  },
  exchangeRate = 25400,
  onBackToStore,
}: EcommerceAdminDashboardProps) {
  const {
    filteredOrders,
    metrics,
    isLoading,
    searchQuery,
    setSearchQuery,
    selectedStatus,
    setSelectedStatus,
    activeReceiptOrder,
    setActiveReceiptOrder,
    serverIsLive,
    lastUpdated,
    refreshData,
    updateOrderStatus,
    deleteOrder,
  } = useEcommerceAdmin({
    apiBaseUrl,
    initialOrders,
    initialMetrics,
    autoFetch: true,
    exchangeRate,
  });

  const navigation = [
    {
      label: 'Tổng Quan & Nghiệp Vụ',
      items: [
        {
          title: 'Quản Lý Đơn Hàng',
          href: '#orders',
          icon: ShoppingBag,
          badge: filteredOrders.length,
          isActive: true,
        },
        {
          title: 'Báo Cáo Doanh Thu',
          href: '#metrics',
          icon: TrendingUp,
        },
        {
          title: 'Kho & Biến Thể',
          href: '#inventory',
          icon: Package,
        },
      ],
    },
    {
      label: 'Hệ Thống',
      items: [
        {
          title: 'Cài Đặt Cổng Thanh Toán',
          href: '#settings',
          icon: Settings,
        },
      ],
    },
  ];

  const headerActions = (
    <div className="flex items-center gap-2">
      {/* Live Server Indicator */}
      <div className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-white border border-slate-200 shadow-2xs">
        {serverIsLive ? (
          <>
            <span className="size-2 rounded-full bg-emerald-500 animate-pulse" />
            <span className="text-emerald-700">API Live</span>
          </>
        ) : (
          <>
            <span className="size-2 rounded-full bg-amber-500" />
            <span className="text-amber-700">Chế độ Offline / Fallback</span>
          </>
        )}
      </div>

      {lastUpdated && (
        <span className="text-[11px] text-slate-500 hidden md:inline">
          Cập nhật: {lastUpdated}
        </span>
      )}

      {/* Refresh Button */}
      <Button
        variant="outline"
        size="sm"
        onClick={refreshData}
        disabled={isLoading}
        className="h-8 gap-1.5 text-xs border-slate-300 hover:border-slate-400 cursor-pointer"
        title="Làm mới dữ liệu"
      >
        <RefreshCw className={`size-3.5 ${isLoading ? 'animate-spin' : ''}`} />
        <span className="hidden sm:inline">Làm mới</span>
      </Button>

      {/* Back to Store Action */}
      {onBackToStore && (
        <Button
          variant="default"
          size="sm"
          onClick={onBackToStore}
          className="h-8 gap-1.5 text-xs bg-slate-900 hover:bg-black text-white cursor-pointer"
        >
          <Store className="size-3.5" />
          <span>Về Gian Hàng</span>
        </Button>
      )}
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-50/60 font-sans text-slate-900">
      <AdminShell
        brand={{
          name: brandName,
          subtitle: brandSubtitle,
          badge: 'Golden Standard',
        }}
        navigation={navigation}
        breadcrumbs={[
          { label: 'Trang Chủ', href: '/' },
          { label: 'Quản Trị Bán Hàng', href: '#orders' },
        ]}
        title="Bảng Điều Khiển Thương Mại Điện Tử"
        description="Theo dõi doanh thu, đối soát VietQR / Thẻ Quốc Tế, quản lý trạng thái đơn hàng & in bill nhiệt K80"
        headerActions={headerActions}
      >
        <div className="space-y-6">
          {/* 1. KPI Metrics Grid */}
          <section id="metrics">
            <MetricCards metrics={metrics} isLoading={isLoading} />
          </section>

          {/* 2. Interactive Orders Table with Search & Status Filters */}
          <section id="orders">
            <OrderTable
              orders={filteredOrders}
              selectedStatus={selectedStatus}
              onSelectStatus={setSelectedStatus}
              searchQuery={searchQuery}
              onSearchChange={setSearchQuery}
              onViewReceipt={(order) => setActiveReceiptOrder(order)}
              onUpdateStatus={(orderId, status) => updateOrderStatus(orderId, status)}
              onDeleteOrder={(orderId) => deleteOrder(orderId)}
              exchangeRate={exchangeRate}
            />
          </section>
        </div>

        {/* 3. K80 Thermal Receipt Modal with Dynamic VietQR */}
        <ReceiptModal
          order={activeReceiptOrder}
          isOpen={!!activeReceiptOrder}
          onClose={() => setActiveReceiptOrder(null)}
          storeName={brandName}
          storeTagline={storeTagline}
          storeHotline={storeHotline}
          storeAddress={storeAddress}
          bankConfig={bankConfig}
          exchangeRate={exchangeRate}
        />
      </AdminShell>
    </div>
  );
}

export default EcommerceAdminDashboard;
