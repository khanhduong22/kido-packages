import type { EventBusDriver, EventEnvelope, SubscribeOptions, UnsubscribeFn } from '../types';

export interface RedisClientLike {
  xadd(key: string, id: string, ...args: (string | number)[]): Promise<string | null>;
  xgroup(
    command: string,
    key: string,
    group: string,
    idOrOption?: string,
    option?: string
  ): Promise<unknown>;
  xreadgroup(
    ...args: (string | number)[]
  ): Promise<[string, [string, string[]][]][] | null>;
  xack(key: string, group: string, ...ids: string[]): Promise<number>;
  quit?(): Promise<unknown>;
  disconnect?(): void;
  status?: string;
}

export interface RedisDriverOptions {
  client: RedisClientLike;
  streamPrefix?: string;
  defaultConsumerGroup?: string;
  consumerName?: string;
  blockTimeoutMs?: number;
  maxStreamLength?: number;
  onError?: (error: Error, topic: string) => void;
}

export class RedisEventBusDriver implements EventBusDriver {
  readonly name = 'redis-streams';
  private client: RedisClientLike;
  private streamPrefix: string;
  private defaultConsumerGroup: string;
  private consumerName: string;
  private blockTimeoutMs: number;
  private maxStreamLength: number;
  private onError?: (error: Error, topic: string) => void;
  private isRunning = true;
  private activeLoops: Set<{ stop: () => void }> = new Set();

  constructor(options: RedisDriverOptions) {
    this.client = options.client;
    this.streamPrefix = options.streamPrefix || 'eventbus:stream:';
    this.defaultConsumerGroup = options.defaultConsumerGroup || 'kt-consumer-group';
    this.consumerName =
      options.consumerName || `worker-${Math.random().toString(36).slice(2, 9)}`;
    this.blockTimeoutMs = options.blockTimeoutMs ?? 1000;
    this.maxStreamLength = options.maxStreamLength ?? 100000;
    this.onError = options.onError;
  }

  private getStreamKey(topic: string): string {
    return `${this.streamPrefix}${topic}`;
  }

  async publish(topic: string, event: EventEnvelope): Promise<void> {
    const streamKey = this.getStreamKey(topic);
    const serialized = JSON.stringify(event);

    if (this.maxStreamLength > 0) {
      await this.client.xadd(
        streamKey,
        'MAXLEN',
        '~',
        this.maxStreamLength,
        '*',
        'event',
        serialized
      );
    } else {
      await this.client.xadd(streamKey, '*', 'event', serialized);
    }
  }

  async subscribe(
    topic: string,
    handler: (event: EventEnvelope) => Promise<void>,
    options?: SubscribeOptions
  ): Promise<UnsubscribeFn> {
    const streamKey = this.getStreamKey(topic);
    const groupName = options?.consumerGroup || this.defaultConsumerGroup;

    // Ensure consumer group exists
    try {
      await this.client.xgroup('CREATE', streamKey, groupName, '$', 'MKSTREAM');
    } catch (err: unknown) {
      const errorMsg = (err as Error)?.message || '';
      // Ignore BUSYGROUP error (Consumer Group name already exists)
      if (!errorMsg.includes('BUSYGROUP')) {
        throw err;
      }
    }

    let active = true;
    const loopControl = {
      stop: () => {
        active = false;
      },
    };
    this.activeLoops.add(loopControl);

    // Background polling loop using XREADGROUP
    const pollLoop = async () => {
      while (active && this.isRunning) {
        try {
          // XREADGROUP GROUP <group> <consumer> BLOCK <ms> COUNT <count> STREAMS <key> >
          const response = await this.client.xreadgroup(
            'GROUP',
            groupName,
            this.consumerName,
            'BLOCK',
            this.blockTimeoutMs,
            'COUNT',
            options?.batchSize || 10,
            'STREAMS',
            streamKey,
            '>'
          );

          if (!active || !this.isRunning) break;

          if (response && Array.isArray(response) && response.length > 0) {
            for (const streamEntry of response) {
              const [, messages] = streamEntry;
              for (const [messageId, fields] of messages) {
                try {
                  // fields format in ioredis: ['event', '{"id":...}']
                  let eventData: EventEnvelope | null = null;
                  for (let i = 0; i < fields.length; i += 2) {
                    if (fields[i] === 'event') {
                      eventData = JSON.parse(fields[i + 1]) as EventEnvelope;
                      break;
                    }
                  }

                  if (eventData) {
                    if (options?.filter && !options.filter(eventData)) {
                      await this.client.xack(streamKey, groupName, messageId);
                      continue;
                    }

                    await handler(eventData);
                    await this.client.xack(streamKey, groupName, messageId);

                    if (options?.once) {
                      loopControl.stop();
                      break;
                    }
                  }
                } catch (handlerErr) {
                  this.onError?.(handlerErr as Error, topic);
                }
              }
            }
          } else {
            // Stream had no new messages, brief pause to prevent busy-spinning
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
        } catch (pollErr) {
          if (!active || !this.isRunning) break;
          this.onError?.(pollErr as Error, topic);
          // Backoff slightly on Redis communication error
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }
    };

    // Fire non-blocking polling loop
    void pollLoop();

    return async () => {
      loopControl.stop();
      this.activeLoops.delete(loopControl);
    };
  }

  async disconnect(): Promise<void> {
    this.isRunning = false;
    for (const loop of this.activeLoops) {
      loop.stop();
    }
    this.activeLoops.clear();

    if (this.client.quit) {
      await this.client.quit();
    } else if (this.client.disconnect) {
      this.client.disconnect();
    }
  }
}
