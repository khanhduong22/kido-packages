import type { EventContext, EventMiddleware, NextFunction } from '../types';

export interface EventBusMetricsData {
  publishedCount: number;
  consumedCount: number;
  errorCount: number;
  totalPublishDurationMs: number;
  totalConsumeDurationMs: number;
  byTopic: Record<
    string,
    {
      published: number;
      consumed: number;
      errors: number;
    }
  >;
}

export interface MetricsMiddlewareInstance extends EventMiddleware {
  getMetrics(): EventBusMetricsData;
  reset(): void;
}

export function createMetricsMiddleware(): MetricsMiddlewareInstance {
  const metrics: EventBusMetricsData = {
    publishedCount: 0,
    consumedCount: 0,
    errorCount: 0,
    totalPublishDurationMs: 0,
    totalConsumeDurationMs: 0,
    byTopic: {},
  };

  const getTopicMetrics = (topic: string) => {
    if (!metrics.byTopic[topic]) {
      metrics.byTopic[topic] = { published: 0, consumed: 0, errors: 0 };
    }
    return metrics.byTopic[topic];
  };

  return {
    name: 'metrics',
    onPublish: async (context: EventContext, next: NextFunction) => {
      const start = performance.now();
      const topicStats = getTopicMetrics(context.topic);

      try {
        await next();
        const duration = performance.now() - start;
        metrics.publishedCount++;
        metrics.totalPublishDurationMs += duration;
        topicStats.published++;
      } catch (error) {
        metrics.errorCount++;
        topicStats.errors++;
        throw error;
      }
    },

    onConsume: async (context: EventContext, next: NextFunction) => {
      const start = performance.now();
      const topicStats = getTopicMetrics(context.topic);

      try {
        await next();
        const duration = performance.now() - start;
        metrics.consumedCount++;
        metrics.totalConsumeDurationMs += duration;
        topicStats.consumed++;
      } catch (error) {
        metrics.errorCount++;
        topicStats.errors++;
        throw error;
      }
    },

    onError: async (_error: Error, context: EventContext) => {
      metrics.errorCount++;
      const topicStats = getTopicMetrics(context.topic);
      topicStats.errors++;
    },

    getMetrics: () => JSON.parse(JSON.stringify(metrics)),
    reset: () => {
      metrics.publishedCount = 0;
      metrics.consumedCount = 0;
      metrics.errorCount = 0;
      metrics.totalPublishDurationMs = 0;
      metrics.totalConsumeDurationMs = 0;
      metrics.byTopic = {};
    },
  };
}
