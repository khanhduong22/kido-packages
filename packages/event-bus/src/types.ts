import { z } from 'zod';

// ==========================================
// 1. Core Event & Envelope Models
// ==========================================

export const EventMetadataSchema = z.object({
  correlationId: z.string().optional(),
  causationId: z.string().optional(),
  timestamp: z.number().default(() => Date.now()),
  userId: z.string().optional(),
  traceId: z.string().optional(),
  source: z.string().optional(),
  tenantId: z.string().optional(),
}).catchall(z.unknown());

export type EventMetadata = z.infer<typeof EventMetadataSchema>;

export const EventEnvelopeSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  payload: z.unknown(),
  metadata: EventMetadataSchema,
  version: z.number().int().positive().default(1),
});

export interface EventEnvelope<T = unknown> {
  id: string;
  name: string;
  payload: T;
  metadata: EventMetadata;
  version: number;
}

export type EventHandler<T = unknown> = (event: EventEnvelope<T>) => Promise<void> | void;

export type UnsubscribeFn = () => Promise<void>;

export interface SubscribeOptions {
  consumerGroup?: string;
  durable?: boolean;
  batchSize?: number;
  once?: boolean;
  filter?: (event: EventEnvelope) => boolean;
}

export interface PublishOptions {
  correlationId?: string;
  causationId?: string;
  userId?: string;
  traceId?: string;
  source?: string;
  tenantId?: string;
  version?: number;
  metadata?: Record<string, unknown>;
}

// ==========================================
// 2. Middleware & Context
// ==========================================

export interface EventContext<T = unknown> {
  event: EventEnvelope<T>;
  topic: string;
  metadata: EventMetadata;
  attributes: Record<string, unknown>;
}

export type NextFunction = () => Promise<void>;

export interface EventMiddleware {
  name?: string;
  onPublish?: (context: EventContext, next: NextFunction) => Promise<void>;
  onConsume?: (context: EventContext, next: NextFunction) => Promise<void>;
  onError?: (error: Error, context: EventContext) => Promise<void>;
}

// ==========================================
// 3. Driver Interface
// ==========================================

export interface EventBusDriver {
  readonly name: string;
  publish(topic: string, event: EventEnvelope): Promise<void>;
  subscribe(
    topic: string,
    handler: (event: EventEnvelope) => Promise<void>,
    options?: SubscribeOptions
  ): Promise<UnsubscribeFn>;
  disconnect(): Promise<void>;
}

// ==========================================
// 4. Transactional Outbox Models
// ==========================================

export type OutboxStatus = 'PENDING' | 'PUBLISHED' | 'FAILED';

export const OutboxRecordSchema = z.object({
  id: z.string(),
  eventId: z.string(),
  eventName: z.string(),
  payload: z.unknown(),
  metadata: EventMetadataSchema,
  status: z.enum(['PENDING', 'PUBLISHED', 'FAILED']),
  retryCount: z.number().int().nonnegative().default(0),
  maxRetries: z.number().int().positive().default(3),
  lastError: z.string().optional(),
  nextRetryAt: z.date().optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type OutboxRecord = z.infer<typeof OutboxRecordSchema>;

export interface OutboxStorage {
  save(record: OutboxRecord, transaction?: unknown): Promise<void>;
  fetchPending(batchSize: number): Promise<OutboxRecord[]>;
  markAsPublished(id: string): Promise<void>;
  markAsFailed(id: string, error: string, nextRetryAt?: Date): Promise<void>;
}

// ==========================================
// 5. Idempotent Consumer Models
// ==========================================

export const ProcessedEventRecordSchema = z.object({
  eventId: z.string(),
  consumerName: z.string(),
  processedAt: z.date(),
  metadata: z.record(z.unknown()).optional(),
});

export type ProcessedEventRecord = z.infer<typeof ProcessedEventRecordSchema>;

export interface IdempotencyStorage {
  isProcessed(eventId: string, consumerName: string): Promise<boolean>;
  markProcessed(eventId: string, consumerName: string, ttlSeconds?: number): Promise<void>;
}

// ==========================================
// 6. Dead Letter Queue (DLQ) Models
// ==========================================

export type DLQStatus = 'QUEUED' | 'REPLAYED' | 'DISCARDED';

export const DLQRecordSchema = z.object({
  id: z.string(),
  eventId: z.string(),
  topic: z.string(),
  payload: z.unknown(),
  metadata: EventMetadataSchema,
  failureReason: z.string(),
  stackTrace: z.string().optional(),
  consumerName: z.string().optional(),
  retryCount: z.number().int().nonnegative(),
  status: z.enum(['QUEUED', 'REPLAYED', 'DISCARDED']),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type DLQRecord = z.infer<typeof DLQRecordSchema>;

export interface DLQFilter {
  topic?: string;
  status?: DLQStatus;
  consumerName?: string;
  limit?: number;
  offset?: number;
}

export interface DLQStorage {
  enqueue(record: DLQRecord): Promise<void>;
  list(filter?: DLQFilter): Promise<DLQRecord[]>;
  getById(id: string): Promise<DLQRecord | null>;
  markReplayed(id: string): Promise<void>;
  markDiscarded(id: string): Promise<void>;
}
