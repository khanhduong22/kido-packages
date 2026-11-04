import { randomUUID } from 'node:crypto';
import type { DeadLetterQueue } from './dead-letter-queue';
import type { EventBus } from './event-bus';
import type {
  EventMetadata,
  OutboxRecord,
  OutboxStorage,
  PublishOptions,
} from './types';

export class InMemoryOutboxStorage implements OutboxStorage {
  private records: Map<string, OutboxRecord> = new Map();

  async save(record: OutboxRecord, _transaction?: unknown): Promise<void> {
    this.records.set(record.id, { ...record });
  }

  async fetchPending(batchSize: number): Promise<OutboxRecord[]> {
    const now = new Date();
    const pending = Array.from(this.records.values())
      .filter((r) => {
        if (r.status !== 'PENDING') return false;
        if (r.nextRetryAt && r.nextRetryAt > now) return false;
        return true;
      })
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, batchSize);

    return pending.map((r) => ({ ...r }));
  }

  async markAsPublished(id: string): Promise<void> {
    const record = this.records.get(id);
    if (record) {
      record.status = 'PUBLISHED';
      record.updatedAt = new Date();
    }
  }

  async markAsFailed(id: string, error: string, nextRetryAt?: Date): Promise<void> {
    const record = this.records.get(id);
    if (record) {
      record.retryCount++;
      record.lastError = error;
      record.updatedAt = new Date();

      if (record.retryCount >= record.maxRetries) {
        record.status = 'FAILED';
        record.nextRetryAt = undefined;
      } else {
        record.nextRetryAt = nextRetryAt;
      }
    }
  }

  async getAll(): Promise<OutboxRecord[]> {
    return Array.from(this.records.values()).map((r) => ({ ...r }));
  }

  async getById(id: string): Promise<OutboxRecord | null> {
    const r = this.records.get(id);
    return r ? { ...r } : null;
  }

  async clear(): Promise<void> {
    this.records.clear();
  }
}

export interface OutboxCreateOptions {
  eventId?: string;
  metadata?: Partial<EventMetadata>;
  maxRetries?: number;
}

export class TransactionalOutbox {
  private storage: OutboxStorage;

  constructor(storage?: OutboxStorage) {
    this.storage = storage || new InMemoryOutboxStorage();
  }

  getStorage(): OutboxStorage {
    return this.storage;
  }

  createRecord(
    eventName: string,
    payload: unknown,
    options: OutboxCreateOptions = {}
  ): OutboxRecord {
    const now = new Date();
    const eventId = options.eventId || randomUUID();

    const metadata: EventMetadata = {
      correlationId: options.metadata?.correlationId || eventId,
      causationId: options.metadata?.causationId,
      timestamp: Date.now(),
      userId: options.metadata?.userId,
      traceId: options.metadata?.traceId,
      source: options.metadata?.source || 'transactional-outbox',
      tenantId: options.metadata?.tenantId,
      ...options.metadata,
    };

    return {
      id: randomUUID(),
      eventId,
      eventName,
      payload,
      metadata,
      status: 'PENDING',
      retryCount: 0,
      maxRetries: options.maxRetries ?? 3,
      createdAt: now,
      updatedAt: now,
    };
  }

  async saveEvent(
    eventName: string,
    payload: unknown,
    options: OutboxCreateOptions = {},
    transaction?: unknown
  ): Promise<OutboxRecord> {
    const record = this.createRecord(eventName, payload, options);
    await this.storage.save(record, transaction);
    return record;
  }
}

export interface OutboxDispatcherOptions {
  storage: OutboxStorage;
  eventBus: EventBus;
  dlq?: DeadLetterQueue;
  pollIntervalMs?: number;
  batchSize?: number;
  maxRetries?: number;
  backoffFactorMs?: number;
  onDispatchSuccess?: (record: OutboxRecord) => void;
  onDispatchError?: (record: OutboxRecord, error: Error) => void;
}

export class OutboxDispatcher {
  private storage: OutboxStorage;
  private eventBus: EventBus;
  private dlq?: DeadLetterQueue;
  private pollIntervalMs: number;
  private batchSize: number;
  private maxRetries: number;
  private backoffFactorMs: number;
  private onDispatchSuccess?: (record: OutboxRecord) => void;
  private onDispatchError?: (record: OutboxRecord, error: Error) => void;

  private timer: NodeJS.Timeout | null = null;
  private isProcessing = false;
  private shouldRun = false;

  constructor(options: OutboxDispatcherOptions) {
    this.storage = options.storage;
    this.eventBus = options.eventBus;
    this.dlq = options.dlq;
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
    this.batchSize = options.batchSize ?? 50;
    this.maxRetries = options.maxRetries ?? 3;
    this.backoffFactorMs = options.backoffFactorMs ?? 500;
    this.onDispatchSuccess = options.onDispatchSuccess;
    this.onDispatchError = options.onDispatchError;
  }

  start(): void {
    if (this.shouldRun) return;
    this.shouldRun = true;

    const scheduleNext = () => {
      if (!this.shouldRun) return;
      this.timer = setTimeout(async () => {
        try {
          await this.pollOnce();
        } catch {
          // Polling errors handled inside pollOnce
        } finally {
          scheduleNext();
        }
      }, this.pollIntervalMs);
    };

    scheduleNext();
  }

  async stop(): Promise<void> {
    this.shouldRun = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    // Wait if a poll execution is currently in-flight
    while (this.isProcessing) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  async pollOnce(): Promise<number> {
    if (this.isProcessing) return 0;
    this.isProcessing = true;

    let publishedCount = 0;

    try {
      const records = await this.storage.fetchPending(this.batchSize);
      if (records.length === 0) {
        return 0;
      }

      for (const record of records) {
        try {
          const publishOpts: PublishOptions = {
            correlationId: record.metadata.correlationId,
            causationId: record.metadata.causationId,
            userId: record.metadata.userId,
            traceId: record.metadata.traceId,
            source: record.metadata.source,
            tenantId: record.metadata.tenantId,
            metadata: record.metadata,
          };

          await this.eventBus.publish(record.eventName, record.payload, publishOpts);
          await this.storage.markAsPublished(record.id);

          publishedCount++;
          this.onDispatchSuccess?.(record);
        } catch (dispatchErr) {
          const error = dispatchErr as Error;
          const nextRetryCount = record.retryCount + 1;
          const maxRetries = record.maxRetries || this.maxRetries;

          if (nextRetryCount >= maxRetries) {
            // Exceeded retries -> mark as failed
            await this.storage.markAsFailed(record.id, error.message);

            // Move to DLQ if configured
            if (this.dlq) {
              await this.dlq.sendToDLQ({
                event: {
                  id: record.eventId,
                  name: record.eventName,
                  payload: record.payload,
                  metadata: record.metadata,
                  version: 1,
                },
                error,
                topic: record.eventName,
                retryCount: nextRetryCount,
                consumerName: 'outbox-dispatcher',
              });
            }
          } else {
            // Exponential backoff
            const delay = this.backoffFactorMs * Math.pow(2, record.retryCount);
            const nextRetryAt = new Date(Date.now() + delay);
            await this.storage.markAsFailed(record.id, error.message, nextRetryAt);
          }

          this.onDispatchError?.(record, error);
        }
      }
    } finally {
      this.isProcessing = false;
    }

    return publishedCount;
  }
}
