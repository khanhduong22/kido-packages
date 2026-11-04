import type {
  EventEnvelope,
  EventHandler,
  IdempotencyStorage,
} from './types';

export class InMemoryIdempotencyStorage implements IdempotencyStorage {
  private processedMap: Map<string, number> = new Map(); // key -> expiresAt

  private makeKey(eventId: string, consumerName: string): string {
    return `${consumerName}:${eventId}`;
  }

  async isProcessed(eventId: string, consumerName: string): Promise<boolean> {
    const key = this.makeKey(eventId, consumerName);
    const expiresAt = this.processedMap.get(key);

    if (expiresAt === undefined) {
      return false;
    }

    if (expiresAt !== 0 && Date.now() > expiresAt) {
      this.processedMap.delete(key);
      return false;
    }

    return true;
  }

  async markProcessed(
    eventId: string,
    consumerName: string,
    ttlSeconds?: number
  ): Promise<void> {
    const key = this.makeKey(eventId, consumerName);
    const expiresAt = ttlSeconds ? Date.now() + ttlSeconds * 1000 : 0;
    this.processedMap.set(key, expiresAt);
  }

  async clear(): Promise<void> {
    this.processedMap.clear();
  }

  size(): number {
    return this.processedMap.size;
  }
}

export interface IdempotentConsumerOptions<T> {
  consumerName: string;
  storage?: IdempotencyStorage;
  handler: EventHandler<T>;
  ttlSeconds?: number;
  onDuplicate?: (event: EventEnvelope<T>, consumerName: string) => void | Promise<void>;
}

export function createIdempotentHandler<T>(
  options: IdempotentConsumerOptions<T>
): EventHandler<T> {
  const storage = options.storage || new InMemoryIdempotencyStorage();
  const { consumerName, handler, ttlSeconds, onDuplicate } = options;

  return async (event: EventEnvelope<T>): Promise<void> => {
    const alreadyProcessed = await storage.isProcessed(event.id, consumerName);

    if (alreadyProcessed) {
      if (onDuplicate) {
        await onDuplicate(event, consumerName);
      }
      return;
    }

    // Execute actual business logic
    await handler(event);

    // Atomically mark as processed upon successful completion
    await storage.markProcessed(event.id, consumerName, ttlSeconds);
  };
}
