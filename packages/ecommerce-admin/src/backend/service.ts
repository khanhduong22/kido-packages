import type {
  AdminOrder,
  CreateOrderInput,
  EcommerceMetrics,
  OrderFilterParams,
  OrderListResult,
  OrderRecord,
  OrderSlot,
  OrderStatus,
} from '../types';
import {
  type IEcommerceOrderRepository,
  SqliteOrderRepository,
} from './repository';

export interface IEcommerceOrderService {
  getOrder(id: string): AdminOrder | null;
  listOrders(filters?: OrderFilterParams): OrderListResult;
  createOrder(input: CreateOrderInput): AdminOrder;
  updateOrderStatus(
    id: string,
    status: OrderStatus | string,
    notes?: string,
    paymentRef?: string
  ): AdminOrder | null;
  updatePaymentInfo(
    id: string,
    paymentMethod: string,
    paymentRef?: string,
    status?: OrderStatus | string
  ): AdminOrder | null;
  deleteOrder(id: string): boolean;
  getMetrics(exchangeRate?: number): EcommerceMetrics;
  toAdminOrder(record: OrderRecord): AdminOrder;
  formatVnd(amount: number): string;
  formatUsd(amount: number): string;
}

export function mapRecordToAdminOrder(record: OrderRecord): AdminOrder {
  let slots: OrderSlot[] = [];
  if (record.slots_json) {
    try {
      slots = JSON.parse(record.slots_json);
    } catch {
      slots = [];
    }
  }

  let metadata: Record<string, any> | undefined;
  if (record.metadata_json) {
    try {
      metadata = JSON.parse(record.metadata_json);
    } catch {
      metadata = undefined;
    }
  }

  return {
    id: record.id,
    tierId: record.tier_id,
    tierName: record.tier_name || undefined,
    quantity: record.quantity,
    unitPrice: record.unit_price,
    subtotal: record.subtotal,
    shippingFee: record.shipping_fee,
    discountAmount: record.discount_amount,
    totalAmount: record.total_amount,
    currency: record.currency || 'USD',
    status: record.status as OrderStatus,
    paymentMethod: record.payment_method || 'card',
    paymentRef: record.payment_ref || undefined,
    notes: record.notes || undefined,
    slots,
    customer: {
      name: record.customer_name,
      email: record.customer_email,
      phone: record.customer_phone || undefined,
      address: record.shipping_address || undefined,
      city: record.city || undefined,
      state: record.state || undefined,
      zip: record.zip || undefined,
    },
    metadata,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

export function formatVndAmount(amount: number): string {
  return `${Math.round(amount).toLocaleString('vi-VN')} ₫`;
}

export function formatUsdAmount(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

export function formatOrderCurrency(amount: number, currency = 'USD'): string {
  if (currency.toUpperCase() === 'VND') {
    return formatVndAmount(amount);
  }
  return formatUsdAmount(amount);
}

export function isValidOrderStatus(status: string): boolean {
  const valid = [
    'PENDING',
    'PENDING_PAYMENT',
    'PAID',
    'PAYMENT_FAILED',
    'REFUNDED',
    'SHIPPED',
    'DELIVERED',
    'CANCELLED',
  ];
  return valid.includes(status.toUpperCase());
}

export function getOrderStatusColor(status: OrderStatus | string): {
  bg: string;
  text: string;
  border: string;
} {
  const s = status.toUpperCase();
  switch (s) {
    case 'PAID':
      return {
        bg: 'bg-emerald-50',
        text: 'text-emerald-700',
        border: 'border-emerald-200',
      };
    case 'PENDING':
    case 'PENDING_PAYMENT':
      return {
        bg: 'bg-amber-50',
        text: 'text-amber-700',
        border: 'border-amber-200',
      };
    case 'SHIPPED':
      return {
        bg: 'bg-blue-50',
        text: 'text-blue-700',
        border: 'border-blue-200',
      };
    case 'DELIVERED':
      return {
        bg: 'bg-teal-50',
        text: 'text-teal-700',
        border: 'border-teal-200',
      };
    case 'CANCELLED':
    case 'PAYMENT_FAILED':
      return {
        bg: 'bg-rose-50',
        text: 'text-rose-700',
        border: 'border-rose-200',
      };
    case 'REFUNDED':
      return {
        bg: 'bg-purple-50',
        text: 'text-purple-700',
        border: 'border-purple-200',
      };
    default:
      return {
        bg: 'bg-slate-50',
        text: 'text-slate-700',
        border: 'border-slate-200',
      };
  }
}

export function getOrderStatusLabel(status: OrderStatus | string): string {
  const s = status.toUpperCase();
  switch (s) {
    case 'PAID':
      return 'Đã thanh toán';
    case 'PENDING':
    case 'PENDING_PAYMENT':
      return 'Chờ thanh toán';
    case 'SHIPPED':
      return 'Đã gửi hàng';
    case 'DELIVERED':
      return 'Đã giao thành công';
    case 'CANCELLED':
      return 'Đã hủy';
    case 'PAYMENT_FAILED':
      return 'Thanh toán lỗi';
    case 'REFUNDED':
      return 'Đã hoàn tiền';
    default:
      return status;
  }
}

export class EcommerceOrderService implements IEcommerceOrderService {
  private repository: IEcommerceOrderRepository;

  constructor(repository?: IEcommerceOrderRepository) {
    this.repository = repository || new SqliteOrderRepository();
  }

  public getOrder(id: string): AdminOrder | null {
    const record = this.repository.getOrderById(id);
    return record ? mapRecordToAdminOrder(record) : null;
  }

  public listOrders(filters: OrderFilterParams = {}): OrderListResult {
    const { records, total, limit, offset } = this.repository.listOrders(filters);
    const orders = records.map(mapRecordToAdminOrder);
    const page = Math.floor(offset / limit) + 1;
    const totalPages = Math.ceil(total / limit) || 1;

    return {
      orders,
      total,
      limit,
      offset,
      page,
      totalPages,
    };
  }

  public createOrder(input: CreateOrderInput): AdminOrder {
    const record = this.repository.createOrder(input);
    return mapRecordToAdminOrder(record);
  }

  public updateOrderStatus(
    id: string,
    status: OrderStatus | string,
    notes?: string,
    paymentRef?: string
  ): AdminOrder | null {
    const record = this.repository.updateOrderStatus(id, status, notes, paymentRef);
    return record ? mapRecordToAdminOrder(record) : null;
  }

  public updatePaymentInfo(
    id: string,
    paymentMethod: string,
    paymentRef?: string,
    status?: OrderStatus | string
  ): AdminOrder | null {
    const record = this.repository.updatePaymentInfo(id, paymentMethod, paymentRef, status);
    return record ? mapRecordToAdminOrder(record) : null;
  }

  public deleteOrder(id: string): boolean {
    return this.repository.deleteOrder(id);
  }

  public getMetrics(exchangeRate?: number): EcommerceMetrics {
    const metrics = this.repository.getMetrics(exchangeRate);
    // Optionally attach recent 10 orders
    const recent = this.repository.listOrders({ limit: 10 });
    metrics.recentOrders = recent.records.map(mapRecordToAdminOrder);
    return metrics;
  }

  public toAdminOrder(record: OrderRecord): AdminOrder {
    return mapRecordToAdminOrder(record);
  }

  public formatVnd(amount: number): string {
    return formatVndAmount(amount);
  }

  public formatUsd(amount: number): string {
    return formatUsdAmount(amount);
  }
}
