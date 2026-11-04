import type { EventContext, EventMiddleware, NextFunction } from '../types';

export interface LoggingMiddlewareOptions {
  logger?: {
    info: (message: string, ...args: unknown[]) => void;
    error: (message: string, ...args: unknown[]) => void;
  };
  logPayload?: boolean;
}

export function createLoggingMiddleware(options: LoggingMiddlewareOptions = {}): EventMiddleware {
  const logger = options.logger || console;
  const logPayload = options.logPayload ?? false;

  return {
    name: 'logging',
    onPublish: async (context: EventContext, next: NextFunction) => {
      const startTime = performance.now();
      const { event, topic } = context;

      try {
        await next();
        const duration = (performance.now() - startTime).toFixed(2);
        logger.info(
          `[EventBus:Publish] topic="${topic}" eventId="${event.id}" duration="${duration}ms"`,
          logPayload ? { payload: event.payload } : undefined
        );
      } catch (error) {
        const duration = (performance.now() - startTime).toFixed(2);
        logger.error(
          `[EventBus:Publish:Error] topic="${topic}" eventId="${event.id}" duration="${duration}ms" error="${(error as Error).message}"`
        );
        throw error;
      }
    },

    onConsume: async (context: EventContext, next: NextFunction) => {
      const startTime = performance.now();
      const { event, topic } = context;

      try {
        await next();
        const duration = (performance.now() - startTime).toFixed(2);
        logger.info(
          `[EventBus:Consume] topic="${topic}" eventId="${event.id}" duration="${duration}ms"`
        );
      } catch (error) {
        const duration = (performance.now() - startTime).toFixed(2);
        logger.error(
          `[EventBus:Consume:Error] topic="${topic}" eventId="${event.id}" duration="${duration}ms" error="${(error as Error).message}"`
        );
        throw error;
      }
    },

    onError: async (error: Error, context: EventContext) => {
      logger.error(
        `[EventBus:Error] topic="${context.topic}" eventId="${context.event.id}" error="${error.message}"`,
        error.stack
      );
    },
  };
}
