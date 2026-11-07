import { z } from 'zod';

// ==========================================
// MUTATION & OUTBOX TYPES
// ==========================================

export const MutationActionSchema = z.enum(['CREATE', 'UPDATE', 'DELETE']);
export type MutationAction = z.infer<typeof MutationActionSchema>;

export const MutationStatusSchema = z.enum(['PENDING', 'SYNCING', 'SYNCED', 'FAILED']);
export type MutationStatus = z.infer<typeof MutationStatusSchema>;

export const OutboxMutationSchema = z.object({
  id: z.string().uuid().or(z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)),
  entityType: z.string().min(1),
  action: MutationActionSchema,
  payload: z.record(z.unknown()),
  timestamp: z.number().int().nonnegative(),
  status: MutationStatusSchema.default('PENDING'),
  retryCount: z.number().int().nonnegative().default(0),
  lastAttemptAt: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
  version: z.number().int().nonnegative().optional(),
  vectorClock: z.record(z.number().int().nonnegative()).optional(),
  isFinancial: z.boolean().optional(),
});
export type OutboxMutation = z.infer<typeof OutboxMutationSchema>;

export type CreateMutationInput = Omit<OutboxMutation, 'id' | 'timestamp' | 'status' | 'retryCount'> & {
  id?: string;
  timestamp?: number;
  status?: MutationStatus;
  retryCount?: number;
};

export interface OutboxFilter {
  status?: MutationStatus;
  entityType?: string;
  limit?: number;
  offset?: number;
}

export interface IOutboxStorage {
  add(mutation: OutboxMutation): Promise<void>;
  get(id: string): Promise<OutboxMutation | null>;
  update(id: string, updates: Partial<OutboxMutation>): Promise<void>;
  delete(id: string): Promise<void>;
  list(filter?: OutboxFilter): Promise<OutboxMutation[]>;
  getPending(limit?: number): Promise<OutboxMutation[]>;
  count(status?: MutationStatus): Promise<number>;
  clear(): Promise<void>;
}

// ==========================================
// SYNC & NETWORK TYPES
// ==========================================

export interface SyncPushResult {
  mutationId: string;
  success: boolean;
  serverVersion?: number;
  conflict?: boolean;
  error?: string;
}

export interface ISyncRemoteAdapter {
  push(mutations: OutboxMutation[]): Promise<SyncPushResult[]>;
}

export interface INetworkDetector {
  isOnline(): Promise<boolean>;
  subscribe(callback: (online: boolean) => void): () => void;
}

export interface SyncEngineOptions {
  storage: IOutboxStorage;
  remote: ISyncRemoteAdapter;
  networkDetector?: INetworkDetector;
  batchSize?: number;
  syncIntervalMs?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  backoffMultiplier?: number;
  maxRetries?: number;
  autoStart?: boolean;
  onSyncStart?: () => void;
  onSyncComplete?: (results: SyncPushResult[]) => void;
  onError?: (error: Error) => void;
  onConflict?: (conflict: { mutation: OutboxMutation; serverVersion?: number }) => void;
}

// ==========================================
// CONFLICT RESOLUTION TYPES
// ==========================================

export interface VersionedEntity<T = Record<string, unknown>> {
  id: string;
  data: T;
  version: number;
  updatedAt: number;
  vectorClock?: Record<string, number>;
  isFinancial?: boolean;
}

export type ConflictStrategy = 'LAST_WRITE_WINS' | 'APPEND_ONLY' | 'VECTOR_CLOCK' | 'MANUAL';

export interface ConflictResolution<T = Record<string, unknown>> {
  winner: 'local' | 'remote' | 'merged';
  entity: VersionedEntity<T>;
  auditLog: string;
  isAppendOnly?: boolean;
  supplementaryRecords?: VersionedEntity<T>[];
}

// ==========================================
// OFFLINE POS STORE TYPES
// ==========================================

export const POSOrderItemSchema = z.object({
  productId: z.string().min(1),
  productName: z.string().min(1),
  sku: z.string().optional(),
  quantity: z.number().int().positive(),
  unitPrice: z.number().nonnegative(),
  discount: z.number().nonnegative().default(0),
  lineTotal: z.number().nonnegative(),
});
export type POSOrderItem = z.infer<typeof POSOrderItemSchema>;

export const POSPaymentMethodSchema = z.enum(['CASH', 'VIETQR', 'DEPOSIT_VIETQR', 'TRANSFER']);
export type POSPaymentMethod = z.infer<typeof POSPaymentMethodSchema>;

export const POSPaymentStatusSchema = z.enum(['UNPAID', 'PARTIALLY_PAID', 'PAID']);
export type POSPaymentStatus = z.infer<typeof POSPaymentStatusSchema>;

export const POSOrderStatusSchema = z.enum(['DRAFT', 'CONFIRMED', 'COMPLETED', 'CANCELLED']);
export type POSOrderStatus = z.infer<typeof POSOrderStatusSchema>;

export const POSOrderSchema = z.object({
  id: z.string(),
  orderCode: z.string(),
  items: z.array(POSOrderItemSchema).min(1),
  subtotal: z.number().nonnegative(),
  discountAmount: z.number().nonnegative().default(0),
  taxRate: z.number().nonnegative().default(0.08), // default 8% VAT
  taxAmount: z.number().nonnegative(),
  totalAmount: z.number().nonnegative(),
  depositAmount: z.number().nonnegative().default(0),
  paymentMethod: POSPaymentMethodSchema,
  paymentStatus: POSPaymentStatusSchema,
  status: POSOrderStatusSchema,
  vietQrPayload: z.string().optional(),
  k80Receipt: z.string().optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  cashierId: z.string().optional(),
  notes: z.string().optional(),
});
export type POSOrder = z.infer<typeof POSOrderSchema>;

export interface TempStockReservation {
  productId: string;
  orderId: string;
  quantity: number;
  reservedAt: number;
}

export interface FinancialLedgerEntry {
  id: string;
  orderId: string;
  transactionType: 'ORDER_PAYMENT' | 'DEPOSIT' | 'REFUND' | 'ADJUSTMENT';
  amount: number;
  referenceCode: string;
  timestamp: number;
  balanceAfter?: number;
  note?: string;
}
