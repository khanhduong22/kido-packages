import { Hono } from 'hono';
import type { ApiAuditService } from './service';

/**
 * Creates an admin / debug sub-router for querying and managing audit logs.
 */
export function createAuditLogsRouter(service: ApiAuditService): Hono {
  const router = new Hono();

  // GET / - Paginated audit logs with query filters
  router.get('/', async (c) => {
    const limitQuery = c.req.query('limit');
    const offsetQuery = c.req.query('offset');
    const statusCodeQuery = c.req.query('statusCode');
    const endpoint = c.req.query('endpoint');
    const method = c.req.query('method');
    const userId = c.req.query('userId');

    const limit = limitQuery ? parseInt(limitQuery, 10) : 50;
    const offset = offsetQuery ? parseInt(offsetQuery, 10) : 0;
    const statusCode = statusCodeQuery ? parseInt(statusCodeQuery, 10) : undefined;

    const result = await service.getAuditLogs({
      limit: Number.isNaN(limit) ? 50 : limit,
      offset: Number.isNaN(offset) ? 0 : offset,
      statusCode: statusCode !== undefined && !Number.isNaN(statusCode) ? statusCode : undefined,
      endpoint,
      method,
      userId,
    });

    return c.json(result);
  });

  // GET /stats - Telemetry and queue size status
  router.get('/stats', (c) => {
    return c.json({
      queueLength: service.getQueueLength(),
      inMemoryCount: service.getInMemoryCount(),
      healthy: service.isHealthy(),
      timestamp: new Date().toISOString(),
    });
  });

  // DELETE /clear - Clear in-memory logs and queues
  router.delete('/clear', async (c) => {
    await service.clear();
    return c.json({
      success: true,
      message: 'Audit logs cleared successfully',
      timestamp: new Date().toISOString(),
    });
  });

  return router;
}
