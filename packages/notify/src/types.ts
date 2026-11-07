import { z } from 'zod';

// ==========================================
// 1. Order Notification Schema
// ==========================================
export const OrderItemSchema = z.object({
  name: z.string(),
  quantity: z.number().int().positive(),
  price: z.number().nonnegative(),
  note: z.string().optional(),
});

export type OrderItem = z.infer<typeof OrderItemSchema>;

export const OrderNotificationSchema = z.object({
  orderId: z.string(),
  customerName: z.string(),
  phone: z.string(),
  items: z.array(OrderItemSchema),
  totalAmount: z.number().nonnegative(),
  paymentMethod: z.string().default('VIETQR'),
  paymentStatus: z.enum(['PAID', 'PENDING', 'FAILED']).default('PENDING'),
  deliveryAddress: z.string().optional(),
  note: z.string().optional(),
  createdAt: z.union([z.string(), z.date()]).optional(),
  appTitle: z.string().default('FAST FOOD EXPRESS').optional(),
});

export type OrderNotificationPayload = z.infer<typeof OrderNotificationSchema>;

// ==========================================
// 2. Appointment Notification Schema (Spa/Clinic)
// ==========================================
export const AppointmentNotificationSchema = z.object({
  appointmentId: z.string(),
  customerName: z.string(),
  phone: z.string(),
  serviceName: z.string(),
  staffName: z.string().optional(),
  appointmentTime: z.union([z.string(), z.date()]),
  totalAmount: z.number().nonnegative(),
  depositAmount: z.number().nonnegative().optional(),
  depositStatus: z.enum(['PAID', 'PENDING', 'NOT_REQUIRED']).default('NOT_REQUIRED').optional(),
  branch: z.string().optional(),
  note: z.string().optional(),
  createdAt: z.union([z.string(), z.date()]).optional(),
  appTitle: z.string().default('SPA & CLINIC BOOKING').optional(),
});

export type AppointmentNotificationPayload = z.infer<typeof AppointmentNotificationSchema>;

// ==========================================
// 3. Stay/Villa Booking Notification Schema
// ==========================================
export const StayBookingNotificationSchema = z.object({
  bookingId: z.string(),
  bookingCode: z.string(),
  customerName: z.string(),
  phone: z.string(),
  email: z.string().optional(),
  roomName: z.string(),
  checkInDate: z.string(),
  checkOutDate: z.string(),
  nights: z.number().int().positive(),
  guests: z.object({
    adults: z.number().int().nonnegative(),
    children: z.number().int().nonnegative().default(0),
  }),
  extraServices: z.array(z.object({
    name: z.string(),
    price: z.number().nonnegative(),
  })).optional(),
  totalAmount: z.number().nonnegative(),
  depositAmount: z.number().nonnegative(),
  depositStatus: z.enum(['PAID', 'PENDING', 'CONFIRMED']).default('PENDING').optional(),
  smartLockPin: z.string(),
  villaAddress: z.string().optional(),
  gpsCoordinates: z.string().optional(),
  wifiSsid: z.string().optional(),
  wifiPassword: z.string().optional(),
  note: z.string().optional(),
  appTitle: z.string().default('PINE FOREST RETREAT VILLA').optional(),
});

export type StayBookingNotificationPayload = z.infer<typeof StayBookingNotificationSchema>;

// ==========================================
// 4. System Alert Schema
// ==========================================
export const SystemAlertSchema = z.object({
  service: z.string(),
  title: z.string(),
  message: z.string(),
  level: z.enum(['INFO', 'WARN', 'ERROR', 'CRITICAL']).default('ERROR'),
  context: z.record(z.unknown()).optional(),
  timestamp: z.union([z.string(), z.date()]).optional(),
  stack: z.string().optional(),
});

export type SystemAlertPayload = z.infer<typeof SystemAlertSchema>;

// ==========================================
// 5. Telegram Options & Config
// ==========================================
export interface TelegramConfig {
  botToken: string;
  defaultChatId?: string | number;
}

export interface TelegramSendOptions {
  botToken?: string;
  chatId: string | number;
  text: string;
  parseMode?: 'HTML' | 'Markdown' | 'MarkdownV2';
  disableWebPagePreview?: boolean;
}

export interface TelegramSendResult {
  success: boolean;
  messageId?: number;
  error?: string;
}

// ==========================================
// 6. Web Push (VAPID) Schema & Types
// ==========================================
export const WebPushSubscriptionSchema = z.object({
  endpoint: z.string().min(1, 'Endpoint is required'),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({
    p256dh: z.string().min(1, 'p256dh key is required'),
    auth: z.string().min(1, 'auth key is required'),
  }),
});

export type WebPushSubscription = z.infer<typeof WebPushSubscriptionSchema>;

export const WebPushPayloadSchema = z.object({
  title: z.string().min(1, 'Title is required'),
  body: z.string().min(1, 'Body is required'),
  icon: z.string().optional(),
  badge: z.string().optional(),
  image: z.string().optional(),
  url: z.string().optional(),
  tag: z.string().optional(),
  data: z.record(z.unknown()).optional(),
  actions: z.array(
    z.object({
      action: z.string(),
      title: z.string(),
      icon: z.string().optional(),
    })
  ).optional(),
}).passthrough();

export type WebPushPayload = z.infer<typeof WebPushPayloadSchema>;

export const VapidConfigSchema = z.object({
  subject: z.string().min(1, 'Subject is required (mailto: or https:)'),
  publicKey: z.string().min(1, 'Public key is required'),
  privateKey: z.string().min(1, 'Private key is required'),
});

export type VapidConfig = z.infer<typeof VapidConfigSchema>;

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

export interface WebPushOptions {
  TTL?: number;
  urgency?: 'very-low' | 'low' | 'normal' | 'high';
  topic?: string;
  headers?: Record<string, string>;
  proxy?: string;
  timeout?: number;
}

export interface WebPushSendResult {
  success: boolean;
  statusCode?: number;
  isExpired?: boolean;
  error?: string;
}

