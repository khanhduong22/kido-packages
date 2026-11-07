import React from 'react';
import { MetricsGrid, StatCard, formatCurrencyVND } from '@kido/admin-ui';
import {
  DollarSign,
  ShoppingBag,
  Clock,
  Truck,
  PackageCheck,
} from 'lucide-react';
import type { EcommerceMetrics } from '../../types';

export interface MetricCardsProps {
  metrics: EcommerceMetrics | null;
  isLoading?: boolean;
}

export function MetricCards({ metrics, isLoading = false }: MetricCardsProps) {
  const totalRevenueUsd = metrics?.totalRevenueUsd ?? 0;
  const totalRevenueVnd = metrics?.totalRevenueVnd ?? Math.round(totalRevenueUsd * 25400);
  const totalOrders = metrics?.totalOrders ?? 0;
  const paidOrders = metrics?.paidOrders ?? 0;
  const pendingOrders = metrics?.pendingOrders ?? 0;
  const deliveredOrders = metrics?.deliveredOrders ?? 0;
  const unitsSold = metrics?.unitsSold ?? 0;
  const conversionRate = metrics?.conversionRate ?? 0;

  return (
    <div className="space-y-4">
      <MetricsGrid columns={4}>
        {/* Doanh thu */}
        <StatCard
          title="Doanh Thu Đã Thu"
          value={`$${totalRevenueUsd.toFixed(2)}`}
          description={formatCurrencyVND(totalRevenueVnd)}
          icon={<DollarSign className="size-5" />}
          iconBgClassName="bg-emerald-50 text-emerald-600 border border-emerald-100"
          badgeText="+18.4%"
          trend="up"
          loading={isLoading}
        />

        {/* Đơn hàng */}
        <StatCard
          title="Tổng Đơn Hàng"
          value={totalOrders}
          description={`${paidOrders} đơn đã thanh toán`}
          icon={<ShoppingBag className="size-5" />}
          iconBgClassName="bg-blue-50 text-blue-600 border border-blue-100"
          badgeText={`${conversionRate}% Paid`}
          trend="neutral"
          loading={isLoading}
        />

        {/* Chờ duyệt tiền */}
        <StatCard
          title="Chờ Duyệt Tiền"
          value={pendingOrders}
          description={
            pendingOrders > 0
              ? 'Cần đối soát VietQR / Chuyển khoản'
              : 'Đã hoàn tất đối soát'
          }
          icon={<Clock className="size-5" />}
          iconBgClassName="bg-amber-50 text-amber-600 border border-amber-100"
          badgeText={pendingOrders > 0 ? 'Cần xử lý' : 'OK'}
          trend={pendingOrders > 0 ? 'down' : 'up'}
          loading={isLoading}
        />

        {/* Sản phẩm bán ra */}
        <StatCard
          title="Sản Phẩm Đã Bán"
          value={unitsSold}
          description={`${deliveredOrders} đơn đã giao thành công`}
          icon={<PackageCheck className="size-5" />}
          iconBgClassName="bg-purple-50 text-purple-600 border border-purple-100"
          badgeText={`${conversionRate}% CVR`}
          trend="up"
          loading={isLoading}
        />
      </MetricsGrid>
    </div>
  );
}
