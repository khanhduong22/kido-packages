import type { EventBusDriver, EventEnvelope, SubscribeOptions, UnsubscribeFn } from '../types';

interface SubscriptionRecord {
  pattern: string;
  regex: RegExp;
  handler: (event: EventEnvelope) => Promise<void>;
  options?: SubscribeOptions;
}

export class InMemoryEventBusDriver implements EventBusDriver {
  readonly name = 'in-memory';
  private subscriptions: Set<SubscriptionRecord> = new Set();
  private isDisconnected = false;

  private patternToRegex(pattern: string): RegExp {
    // If exact match
    if (!pattern.includes('*') && !pattern.includes('#')) {
      return new RegExp(`^${this.escapeRegex(pattern)}$`);
    }

    // Convert AMQP/MQTT style wildcards to regex:
    // '*' matches single token (separated by '.')
    // '#' or '**' matches zero or more tokens
    const parts = pattern.split('.');
    const regexParts = parts.map((part) => {
      if (part === '#' || part === '**') {
        return '.*';
      }
      if (part === '*') {
        return '[^.]+';
      }
      return this.escapeRegex(part);
    });

    return new RegExp(`^${regexParts.join('\\.')}$`);
  }

  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  async publish(topic: string, event: EventEnvelope): Promise<void> {
    if (this.isDisconnected) {
      throw new Error(`[InMemoryEventBusDriver] Cannot publish to topic "${topic}": driver is disconnected`);
    }

    const matchedSubs: SubscriptionRecord[] = [];
    for (const sub of this.subscriptions) {
      if (sub.regex.test(topic)) {
        matchedSubs.push(sub);
      }
    }

    // Deliver event to matched subscribers with async concurrency and error isolation
    const promises = matchedSubs.map(async (sub) => {
      if (sub.options?.filter && !sub.options.filter(event)) {
        return;
      }
      if (sub.options?.once) {
        this.subscriptions.delete(sub);
      }
      await sub.handler(event);
    });

    await Promise.all(promises);
  }

  async subscribe(
    topicPattern: string,
    handler: (event: EventEnvelope) => Promise<void>,
    options?: SubscribeOptions
  ): Promise<UnsubscribeFn> {
    if (this.isDisconnected) {
      throw new Error(`[InMemoryEventBusDriver] Cannot subscribe to "${topicPattern}": driver is disconnected`);
    }

    const record: SubscriptionRecord = {
      pattern: topicPattern,
      regex: this.patternToRegex(topicPattern),
      handler,
      options,
    };

    this.subscriptions.add(record);

    return async () => {
      this.subscriptions.delete(record);
    };
  }

  getSubscriptionsCount(): number {
    return this.subscriptions.size;
  }

  async disconnect(): Promise<void> {
    this.isDisconnected = true;
    this.subscriptions.clear();
  }
}
