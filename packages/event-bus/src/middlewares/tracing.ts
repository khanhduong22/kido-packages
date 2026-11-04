import { randomUUID } from 'node:crypto';
import type { EventContext, EventMiddleware, NextFunction } from '../types';

export interface TracingMiddlewareOptions {
  serviceName?: string;
}

export function createTracingMiddleware(options: TracingMiddlewareOptions = {}): EventMiddleware {
  const serviceName = options.serviceName || 'kt-service';

  return {
    name: 'tracing',
    onPublish: async (context: EventContext, next: NextFunction) => {
      // Ensure traceId and correlationId exist on publishing
      if (!context.event.metadata.traceId) {
        context.event.metadata.traceId = randomUUID();
      }
      if (!context.event.metadata.correlationId) {
        context.event.metadata.correlationId = context.event.metadata.traceId;
      }
      if (!context.event.metadata.source) {
        context.event.metadata.source = serviceName;
      }

      await next();
    },

    onConsume: async (context: EventContext, next: NextFunction) => {
      // Propagate context into context attributes for downstream handlers
      context.attributes['traceId'] = context.event.metadata.traceId;
      context.attributes['correlationId'] = context.event.metadata.correlationId;
      context.attributes['causationId'] = context.event.id;

      await next();
    },
  };
}
