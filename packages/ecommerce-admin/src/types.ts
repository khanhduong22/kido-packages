import { z } from 'zod';

export type OrderStatus =
  | 'PENDING'
  | 'PENDING_PAYMENT'
  | 'PAID'
  | 'PAYMENT_FAILED'
  | 'REFUNDED'
  | 'SHIPPED'
  | 'DELIVERED'
  | 'CANCELLED';

export interface OrderCustomer {
  name: string;
  email: string;
  phone?: string;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
}

export interface OrderSlot {
  slotIndex: number;
  selectedVariantId: string;
  variantName?: string;
  price?: number;
  options?: Record<string, any>;
}

/**
 * Raw SQLite database table representation (snake_case)
 */
export interface OrderRecord {
  id: string;
  tier_id: string;
  tier_name?: string | null;
  quantity: number;
  unit_price: number;
  subtotal: number;
  shipping_fee: number;
  discount_amount: number;
  total_amount: number;
  currency: string;
  status: OrderStatus | string;
  payment_method: string;
  payment_ref?: string | null;
  notes?: string | null;
  slots_json?: string | null;
  customer_name: string;
  customer_email: string;
  customer_phone?: string | null;
  shipping_address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  metadata_json?: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Normalized domain model for Frontend & API responses (camelCase)
 */
export interface AdminOrder {
  id: string;
  tierId: string;
  tierName?: string;
  quantity: number;
  unitPrice: number;
  subtotal: number;
  shippingFee: number;
  discountAmount?: number;
  totalAmount: number;
  currency: string;
  status: OrderStatus | string;
  paymentMethod: string;
  paymentRef?: string;
  notes?: string;
  slots: OrderSlot[];
  customer: OrderCustomer;
  metadata?: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}

/**
 * Aggregated business & performance metrics for Admin KPI Dashboard
 */
export interface EcommerceMetrics {
  totalRevenueUsd: number;
  totalRevenueVnd: number;
  totalOrders: number;
  paidOrders: number;
  pendingOrders: number;
  shippedOrders: number;
  deliveredOrders: number;
  cancelledOrders: number;
  unitsSold: number;
  conversionRate: number; // e.g. 75.25 (%)
  averageOrderValueUsd: number;
  averageOrderValueVnd: number;
  recentOrders?: AdminOrder[];
}

export interface OrderFilterParams {
  search?: string;
  status?: string;
  paymentMethod?: string;
  limit?: number;
  offset?: number;
  page?: number;
  sortBy?: 'created_at' | 'total_amount';
  sortOrder?: 'asc' | 'desc';
}

export interface OrderListResult {
  orders: AdminOrder[];
  total: number;
  limit: number;
  offset: number;
  page: number;
  totalPages: number;
}

export interface CreateOrderInput {
  id?: string;
  tierId: string;
  tierName?: string;
  quantity?: number;
  unitPrice?: number;
  subtotal?: number;
  shippingFee?: number;
  discountAmount?: number;
  totalAmount?: number;
  currency?: string;
  status?: OrderStatus | string;
  paymentMethod?: string;
  paymentRef?: string;
  notes?: string;
  slots?: OrderSlot[];
  customer: OrderCustomer;
  metadata?: Record<string, any>;
}

export interface UpdateOrderStatusInput {
  status: OrderStatus | string;
  notes?: string;
  paymentRef?: string;
}

export interface BankConfig {
  bank: string;
  accountNumber: string;
  accountName: string;
  template?: 'compact2' | 'compact' | 'qr_only' | 'print';
}

// ============================================================================
// Runtime Zod Schemas
// ============================================================================

export const orderCustomerSchema = z.object({
  name: z.string().min(1, 'Customer name is required'),
  email: z.string().email('Valid email is required'),
  phone: z.string().optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  zip: z.string().optional(),
});

export const orderSlotSchema = z.object({
  slotIndex: z.number().int().positive(),
  selectedVariantId: z.string().min(1),
  variantName: z.string().optional(),
  price: z.number().optional(),
  options: z.record(z.any()).optional(),
});

export const createOrderSchema = z.object({
  id: z.string().optional(),
  tierId: z.string().min(1, 'tierId is required'),
  tierName: z.string().optional(),
  quantity: z.number().int().positive().optional().default(1),
  unitPrice: z.number().nonnegative().optional().default(0),
  subtotal: z.number().nonnegative().optional(),
  shippingFee: z.number().nonnegative().optional().default(0),
  discountAmount: z.number().nonnegative().optional().default(0),
  totalAmount: z.number().nonnegative().optional(),
  currency: z.string().optional().default('USD'),
  status: z.string().optional().default('PENDING_PAYMENT'),
  paymentMethod: z.string().optional().default('card'),
  paymentRef: z.string().optional(),
  notes: z.string().optional(),
  slots: z.array(orderSlotSchema).optional().default([]),
  customer: orderCustomerSchema,
  metadata: z.record(z.any()).optional(),
});

export const updateOrderStatusSchema = z.object({
  status: z.string().min(1, 'Status is required'),
  notes: z.string().optional(),
  paymentRef: z.string().optional(),
});

export const updatePaymentInfoSchema = z.object({
  paymentMethod: z.string().min(1, 'Payment method is required'),
  paymentRef: z.string().optional(),
  status: z.string().optional(),
});

export const orderFilterQuerySchema = z.object({
  search: z.string().optional(),
  status: z.string().optional(),
  paymentMethod: z.string().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  page: z.coerce.number().int().positive().optional(),
  sortBy: z.enum(['created_at', 'total_amount']).optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
});
