import React from 'react';
import {
  StatusBadge,
  Button,
  Badge,
  formatCurrencyVND,
} from '@kido/admin-ui';
import {
  Search,
  CheckCircle2,
  Clock,
  Truck,
  Printer,
  Trash2,
  CreditCard,
  QrCode,
  ShoppingBag,
  X,
  PackageCheck,
  Ban,
} from 'lucide-react';
import type { AdminOrder, OrderStatus } from '../../types';

export interface OrderTableProps {
  orders: AdminOrder[];
  selectedStatus: string;
  onSelectStatus: (status: string) => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  onViewReceipt: (order: AdminOrder) => void;
  onUpdateStatus: (orderId: string, status: OrderStatus | string) => void;
  onDeleteOrder: (orderId: string) => void;
  exchangeRate?: number;
}

export function OrderTable({
  orders,
  selectedStatus,
  onSelectStatus,
  searchQuery,
  onSearchChange,
  onViewReceipt,
  onUpdateStatus,
  onDeleteOrder,
  exchangeRate = 25400,
}: OrderTableProps) {
  const filterPills = [
    { id: 'ALL', label: 'Tất cả', icon: null, color: 'slate' },
    {
      id: 'PAID',
      label: 'Đã thanh toán',
      icon: <CheckCircle2 className="size-3" />,
      color: 'emerald',
    },
    {
      id: 'PENDING',
      label: 'Chờ thanh toán',
      icon: <Clock className="size-3" />,
      color: 'amber',
    },
    {
      id: 'SHIPPED',
      label: 'Đã gửi hàng',
      icon: <Truck className="size-3" />,
      color: 'blue',
    },
    {
      id: 'DELIVERED',
      label: 'Đã giao',
      icon: <PackageCheck className="size-3" />,
      color: 'teal',
    },
    {
      id: 'CANCELLED',
      label: 'Đã hủy',
      icon: <Ban className="size-3" />,
      color: 'rose',
    },
    {
      id: 'VIETQR',
      label: 'VietQR',
      icon: <QrCode className="size-3" />,
      color: 'teal',
    },
    {
      id: 'CARD',
      label: 'Thẻ / Airwallex',
      icon: <CreditCard className="size-3" />,
      color: 'indigo',
    },
  ];

  return (
    <div className="space-y-4">
      {/* Filter and Search Bar */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs">
        <div className="flex flex-col md:flex-row gap-3 items-stretch md:items-center justify-between">
          {/* Status Filter Pills */}
          <div className="flex flex-wrap items-center gap-1.5 overflow-x-auto pb-1 md:pb-0">
            {filterPills.map((pill) => {
              const isActive = selectedStatus === pill.id;
              return (
                <button
                  key={pill.id}
                  type="button"
                  onClick={() => onSelectStatus(pill.id)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition cursor-pointer flex items-center gap-1 shrink-0 ${
                    isActive
                      ? 'bg-slate-900 text-white shadow-xs'
                      : 'bg-slate-100 hover:bg-slate-200 text-slate-700'
                  }`}
                >
                  {pill.icon}
                  <span>{pill.label}</span>
                </button>
              );
            })}
          </div>

          {/* Search Input */}
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-2.5 size-4 text-slate-400" />
            <input
              type="text"
              placeholder="Tìm theo mã đơn, tên, sđt, email..."
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              className="w-full pl-9 pr-8 py-2 rounded-lg bg-slate-50 border border-slate-300 text-xs text-slate-900 focus:bg-white focus:border-orange-500 focus:ring-1 focus:ring-orange-500 focus:outline-none transition"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => onSearchChange('')}
                className="absolute right-2.5 top-2.5 text-slate-400 hover:text-slate-600 cursor-pointer"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Orders Table Container */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-xs">
        <div className="px-4 py-3 border-b border-slate-200 bg-slate-50/70 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="font-bold text-sm text-slate-900">Danh sách Đơn Hàng</span>
            <Badge variant="secondary" className="text-xs">
              {orders.length} bản ghi
            </Badge>
          </div>
          <span className="text-xs text-slate-500 hidden sm:inline">
            Tự động đồng bộ trạng thái đơn và in bill K80 chuẩn thương mại
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="bg-slate-100/80 border-b border-slate-200 text-slate-600 font-bold uppercase tracking-wider text-[11px]">
                <th className="py-3 px-3.5">Mã Đơn / Thời Gian</th>
                <th className="py-3 px-3.5">Khách Hàng & Địa Chỉ</th>
                <th className="py-3 px-3.5">Chi Tiết Gói & Biến Thể</th>
                <th className="py-3 px-3.5 text-right">Tổng Tiền ($ / ₫)</th>
                <th className="py-3 px-3.5 text-center">Cổng Thanh Toán</th>
                <th className="py-3 px-3.5 text-center">Trạng Thái</th>
                <th className="py-3 px-3.5 text-right">Thao Tác</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {orders.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-slate-400">
                    <ShoppingBag className="size-8 mx-auto mb-2 opacity-30" />
                    <p className="font-semibold text-slate-600">Không tìm thấy đơn hàng nào</p>
                    <p className="text-[11px] mt-0.5">Thử đổi bộ lọc hoặc từ khóa tìm kiếm</p>
                  </td>
                </tr>
              ) : (
                orders.map((order) => {
                  const isVietQr = order.paymentMethod.toLowerCase().includes('vietqr');
                  const orderTotalVnd = Math.round(order.totalAmount * exchangeRate);

                  return (
                    <tr key={order.id} className="hover:bg-slate-50/80 transition-colors">
                      {/* Mã đơn & Thời gian */}
                      <td className="py-3.5 px-3.5 align-top">
                        <div className="font-mono font-bold text-slate-900 flex items-center gap-1">
                          <span>{order.id}</span>
                        </div>
                        <div className="text-[11px] text-slate-500 mt-1 flex items-center gap-1">
                          <Clock className="size-3 text-slate-400" />
                          <span>{new Date(order.createdAt).toLocaleString('vi-VN')}</span>
                        </div>
                        {order.paymentRef && (
                          <div className="mt-1 text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 inline-block border border-slate-200">
                            Ref: {order.paymentRef}
                          </div>
                        )}
                      </td>

                      {/* Khách hàng & Địa chỉ */}
                      <td className="py-3.5 px-3.5 align-top max-w-[220px]">
                        <div className="font-bold text-slate-900">{order.customer.name}</div>
                        <div className="text-slate-600 text-[11px] truncate mt-0.5">
                          {order.customer.email}
                        </div>
                        {order.customer.phone && (
                          <div className="text-slate-600 text-[11px] font-mono mt-0.5">
                            {order.customer.phone}
                          </div>
                        )}
                        {order.customer.address && (
                          <div className="text-slate-500 text-[10px] mt-1 line-clamp-2 leading-relaxed bg-slate-50 p-1.5 rounded border border-slate-100">
                            📍 {order.customer.address}, {order.customer.city || ''}
                          </div>
                        )}
                      </td>

                      {/* Chi tiết gói & Biến thể */}
                      <td className="py-3.5 px-3.5 align-top max-w-[240px]">
                        <div className="font-bold text-slate-800">
                          {order.tierName || `Gói x${order.quantity} sản phẩm`}
                        </div>
                        <div className="text-[11px] text-slate-500">
                          Số lượng: x{order.quantity}
                        </div>
                        {order.slots && order.slots.length > 0 && (
                          <div className="mt-1.5 flex flex-wrap gap-1">
                            {order.slots.map((s, idx) => (
                              <span
                                key={idx}
                                className="inline-flex items-center text-[10px] px-1.5 py-0.5 rounded bg-orange-50 text-orange-700 border border-orange-200 font-medium"
                              >
                                #{idx + 1}: {s.variantName || s.selectedVariantId}
                              </span>
                            ))}
                          </div>
                        )}
                      </td>

                      {/* Tổng tiền */}
                      <td className="py-3.5 px-3.5 align-top text-right">
                        <div className="font-black text-slate-900 font-mono text-sm">
                          ${order.totalAmount.toFixed(2)}
                        </div>
                        <div className="text-[11px] font-bold text-emerald-700 font-mono mt-0.5">
                          {formatCurrencyVND(orderTotalVnd)}
                        </div>
                        <div className="text-[10px] text-slate-400 mt-1">
                          {order.shippingFee === 0 ? 'Freeship' : `Ship $${order.shippingFee.toFixed(2)}`}
                        </div>
                      </td>

                      {/* Cổng thanh toán */}
                      <td className="py-3.5 px-3.5 align-top text-center">
                        {isVietQr ? (
                          <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-bold bg-teal-50 text-teal-700 border border-teal-200 shadow-2xs">
                            <QrCode className="size-3.5 text-teal-600" />
                            <span>VietQR Chuyển Khoản</span>
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-bold bg-blue-50 text-blue-700 border border-blue-200 shadow-2xs">
                            <CreditCard className="size-3.5 text-blue-600" />
                            <span>{order.paymentMethod.toUpperCase()}</span>
                          </span>
                        )}
                      </td>

                      {/* Trạng thái */}
                      <td className="py-3.5 px-3.5 align-top text-center">
                        <StatusBadge
                          status={
                            order.status === 'PENDING_PAYMENT'
                              ? 'PENDING'
                              : (order.status as any)
                          }
                          showDot={true}
                          className="text-xs font-bold"
                        />
                      </td>

                      {/* Thao tác */}
                      <td className="py-3.5 px-3.5 align-top text-right space-y-1.5 whitespace-nowrap">
                        <div className="flex items-center justify-end gap-1.5">
                          {/* Xem Hóa Đơn K80 */}
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => onViewReceipt(order)}
                            className="h-7 px-2 text-[11px] gap-1 border-slate-300 hover:border-slate-400 text-slate-700 cursor-pointer"
                            title="Xem hóa đơn in nhiệt K80"
                          >
                            <Printer className="size-3" />
                            <span>Hóa đơn</span>
                          </Button>

                          {/* Duyệt thanh toán cho đơn pending */}
                          {(order.status === 'PENDING' || order.status === 'PENDING_PAYMENT') && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => onUpdateStatus(order.id, 'PAID')}
                              className="h-7 px-2 text-[11px] gap-1 border-emerald-300 bg-emerald-50 hover:bg-emerald-100 text-emerald-800 font-semibold cursor-pointer"
                              title="Xác nhận đã nhận tiền chuyển khoản"
                            >
                              <CheckCircle2 className="size-3 text-emerald-600" />
                              <span>Duyệt tiền</span>
                            </Button>
                          )}

                          {/* Gửi hàng cho đơn đã thanh toán */}
                          {order.status === 'PAID' && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => onUpdateStatus(order.id, 'SHIPPED')}
                              className="h-7 px-2 text-[11px] gap-1 border-blue-200 bg-blue-50 hover:bg-blue-100 text-blue-700 cursor-pointer"
                              title="Đánh dấu đã giao hàng cho shipper"
                            >
                              <Truck className="size-3" />
                              <span>Gửi hàng</span>
                            </Button>
                          )}

                          {/* Khách đã nhận cho đơn đang giao */}
                          {order.status === 'SHIPPED' && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => onUpdateStatus(order.id, 'DELIVERED')}
                              className="h-7 px-2 text-[11px] gap-1 border-teal-200 bg-teal-50 hover:bg-teal-100 text-teal-700 cursor-pointer"
                              title="Đánh dấu khách đã nhận thành công"
                            >
                              <CheckCircle2 className="size-3" />
                              <span>Đã nhận</span>
                            </Button>
                          )}

                          {/* Xóa đơn */}
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              if (confirm(`Xác nhận xóa đơn hàng ${order.id}?`)) {
                                onDeleteOrder(order.id);
                              }
                            }}
                            className="h-7 size-7 p-0 text-slate-400 hover:text-rose-600 hover:bg-rose-50 cursor-pointer"
                            title="Xóa đơn hàng"
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
