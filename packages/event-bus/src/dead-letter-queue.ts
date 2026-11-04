import { randomUUID } from 'node:crypto';
import type { EventBus } from './event-bus';
import type {
  DLQFilter,
  DLQRecord,
  DLQStatus,
  DLQStorage,
  EventEnvelope,
} from './types';

export class InMemoryDLQStorage implements DLQStorage {
  private records: Map<string, DLQRecord> = new Map();

  async enqueue(record: DLQRecord): Promise<void> {
    this.records.set(record.id, { ...record });
  }

  async list(filter?: DLQFilter): Promise<DLQRecord[]> {
    let items = Array.from(this.records.values());

    if (filter?.topic) {
      items = items.filter((r) => r.topic === filter.topic);
    }
    if (filter?.status) {
      items = items.filter((r) => r.status === filter.status);
    }
    if (filter?.consumerName) {
      items = items.filter((r) => r.consumerName === filter.consumerName);
    }

    // Sort descending by createdAt
    items.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const offset = filter?.offset ?? 0;
    const limit = filter?.limit ?? 50;

    return items.slice(offset, offset + limit);
  }

  async getById(id: string): Promise<DLQRecord | null> {
    const item = this.records.get(id);
    return item ? { ...item } : null;
  }

  async markReplayed(id: string): Promise<void> {
    const record = this.records.get(id);
    if (record) {
      record.status = 'REPLAYED';
      record.updatedAt = new Date();
    }
  }

  async markDiscarded(id: string): Promise<void> {
    const record = this.records.get(id);
    if (record) {
      record.status = 'DISCARDED';
      record.updatedAt = new Date();
    }
  }

  async clear(): Promise<void> {
    this.records.clear();
  }
}

export interface SendToDLQInput {
  event: EventEnvelope;
  error: Error | string;
  topic: string;
  retryCount: number;
  consumerName?: string;
}

export class DeadLetterQueue {
  private storage: DLQStorage;

  constructor(storage?: DLQStorage) {
    this.storage = storage || new InMemoryDLQStorage();
  }

  getStorage(): DLQStorage {
    return this.storage;
  }

  async sendToDLQ(input: SendToDLQInput): Promise<DLQRecord> {
    const failureReason =
      typeof input.error === 'string' ? input.error : input.error.message;
    const stackTrace =
      typeof input.error === 'object' && input.error.stack
        ? input.error.stack
        : undefined;

    const record: DLQRecord = {
      id: randomUUID(),
      eventId: input.event.id,
      topic: input.topic,
      payload: input.event.payload,
      metadata: {
        ...input.event.metadata,
        dlqEnqueuedAt: Date.now(),
        dlqOriginalError: failureReason,
      },
      failureReason,
      stackTrace,
      consumerName: input.consumerName,
      retryCount: input.retryCount,
      status: 'QUEUED',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await this.storage.enqueue(record);
    return record;
  }

  async replay(id: string, bus: EventBus): Promise<boolean> {
    const record = await this.storage.getById(id);
    if (!record || record.status !== 'QUEUED') {
      return false;
    }

    // Replay back to the original topic
    await bus.publish(record.topic, record.payload, {
      ...record.metadata,
      causationId: record.eventId,
      metadata: {
        replayedFromDlqId: record.id,
        replayedAt: Date.now(),
      },
    });

    await this.storage.markReplayed(id);
    return true;
  }

  async replayAll(
    filter: { topic?: string; consumerName?: string } = {},
    bus: EventBus
  ): Promise<number> {
    const queuedItems = await this.storage.list({
      ...filter,
      status: 'QUEUED',
      limit: 1000,
    });

    let replayedCount = 0;
    for (const item of queuedItems) {
      const success = await this.replay(item.id, bus);
      if (success) {
        replayedCount++;
      }
    }

    return replayedCount;
  }

  async discard(id: string): Promise<boolean> {
    const record = await this.storage.getById(id);
    if (!record || record.status !== 'QUEUED') {
      return false;
    }

    await this.storage.markDiscarded(id);
    return true;
  }

  async list(filter?: DLQFilter): Promise<DLQRecord[]> {
    return await this.storage.list(filter);
  }

  async getById(id: string): Promise<DLQRecord | null> {
    return await this.storage.getById(id);
  }

  async getStats(): Promise<{
    total: number;
    queued: number;
    replayed: number;
    discarded: number;
  }> {
    const all = await this.storage.list({ limit: 10000 });
    return {
      total: all.length,
      queued: all.filter((r) => r.status === 'QUEUED').length,
      replayed: all.filter((r) => r.status === 'REPLAYED').length,
      discarded: all.filter((r) => r.status === 'DISCARDED').length,
    };
  }
}
