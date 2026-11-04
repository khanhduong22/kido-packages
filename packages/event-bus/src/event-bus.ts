import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { InMemoryEventBusDriver } from './drivers/in-memory-driver';
import type {
  EventBusDriver,
  EventContext,
  EventEnvelope,
  EventHandler,
  EventMetadata,
  EventMiddleware,
  PublishOptions,
  SubscribeOptions,
  UnsubscribeFn,
} from './types';

export interface TypedTopic<T> {
  readonly name: string;
  readonly schema?: z.ZodType<T>;
}

export interface EventBusOptions {
  driver?: EventBusDriver;
  middlewares?: EventMiddleware[];
  errorHandler?: (error: Error, context: EventContext) => void | Promise<void>;
  defaultSource?: string;
}

export class EventBus {
  private driver: EventBusDriver;
  private middlewares: EventMiddleware[] = [];
  private errorHandler?: (error: Error, context: EventContext) => void | Promise<void>;
  private defaultSource: string;

  constructor(options: EventBusOptions = {}) {
    this.driver = options.driver || new InMemoryEventBusDriver();
    this.middlewares = [...(options.middlewares || [])];
    this.errorHandler = options.errorHandler;
    this.defaultSource = options.defaultSource || 'kt-event-bus';
  }

  getDriverName(): string {
    return this.driver.name;
  }

  use(middleware: EventMiddleware): this {
    this.middlewares.push(middleware);
    return this;
  }

  defineTopic<T>(name: string, schema?: z.ZodType<T>): TypedTopic<T> {
    return { name, schema };
  }

  async publish<T>(
    topicOrDef: string | TypedTopic<T>,
    payload: T,
    options: PublishOptions = {}
  ): Promise<EventEnvelope<T>> {
    const topicName = typeof topicOrDef === 'string' ? topicOrDef : topicOrDef.name;

    // Validate payload against schema if present
    if (typeof topicOrDef !== 'string' && topicOrDef.schema) {
      payload = topicOrDef.schema.parse(payload);
    }

    const metadata: EventMetadata = {
      correlationId: options.correlationId,
      causationId: options.causationId,
      timestamp: Date.now(),
      userId: options.userId,
      traceId: options.traceId,
      source: options.source,
      tenantId: options.tenantId,
      ...(options.metadata || {}),
    };

    const envelope: EventEnvelope<T> = {
      id: randomUUID(),
      name: topicName,
      payload,
      metadata,
      version: options.version || 1,
    };

    const context: EventContext<T> = {
      event: envelope,
      topic: topicName,
      metadata,
      attributes: {},
    };

    // Execute onPublish middlewares onion-style
    const publishChain = this.middlewares
      .filter((m) => !!m.onPublish)
      .map((m) => m.onPublish!);

    let index = 0;
    const next = async (): Promise<void> => {
      if (index < publishChain.length) {
        const current = publishChain[index++];
        await current(context as EventContext, next);
      } else {
        if (!envelope.metadata.source) {
          envelope.metadata.source = this.defaultSource;
        }
        await this.driver.publish(topicName, envelope as EventEnvelope);
      }
    };

    try {
      await next();
    } catch (err) {
      await this.handleError(err as Error, context as EventContext);
      throw err;
    }

    return envelope;
  }

  async subscribe<T>(
    topicOrDef: string | TypedTopic<T>,
    handler: EventHandler<T>,
    options: SubscribeOptions = {}
  ): Promise<UnsubscribeFn> {
    const topicPattern = typeof topicOrDef === 'string' ? topicOrDef : topicOrDef.name;
    const schema = typeof topicOrDef !== 'string' ? topicOrDef.schema : undefined;

    // Wrapped handler executing middleware onion-style
    const wrappedHandler = async (rawEvent: EventEnvelope): Promise<void> => {
      let typedPayload = rawEvent.payload as T;

      if (schema) {
        try {
          typedPayload = schema.parse(typedPayload);
        } catch (validationErr) {
          const err = new Error(
            `[EventBus] Schema validation failed for topic "${topicPattern}": ${(validationErr as Error).message}`
          );
          await this.handleError(err, {
            event: rawEvent,
            topic: topicPattern,
            metadata: rawEvent.metadata,
            attributes: {},
          });
          throw err;
        }
      }

      const event: EventEnvelope<T> = {
        ...rawEvent,
        payload: typedPayload,
      };

      const context: EventContext<T> = {
        event,
        topic: topicPattern,
        metadata: event.metadata,
        attributes: {},
      };

      const consumeChain = this.middlewares
        .filter((m) => !!m.onConsume)
        .map((m) => m.onConsume!);

      let index = 0;
      const next = async (): Promise<void> => {
        if (index < consumeChain.length) {
          const current = consumeChain[index++];
          await current(context as EventContext, next);
        } else {
          await handler(event);
        }
      };

      try {
        await next();
      } catch (err) {
        await this.handleError(err as Error, context as EventContext);
        throw err;
      }
    };

    return await this.driver.subscribe(topicPattern, wrappedHandler, options);
  }

  private async handleError(error: Error, context: EventContext): Promise<void> {
    for (const middleware of this.middlewares) {
      if (middleware.onError) {
        try {
          await middleware.onError(error, context);
        } catch {
          // Prevent middleware error from swallowing main error
        }
      }
    }

    if (this.errorHandler) {
      try {
        await this.errorHandler(error, context);
      } catch {
        // Ignore secondary error in error handler
      }
    }
  }

  async close(): Promise<void> {
    await this.driver.disconnect();
    this.middlewares = [];
  }
}
