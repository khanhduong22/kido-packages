import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { Hono } from 'hono';
import {
  ApiAuditService,
  FileAuditStorageAdapter,
  createAuditLogsRouter,
  honoAuditMiddleware,
  sanitizePayload,
} from '../index';

describe('1. Sanitizer Engine (sanitizePayload)', () => {
  it('should return null for null or undefined input', () => {
    assert.equal(sanitizePayload(null), null);
    assert.equal(sanitizePayload(undefined), null);
  });

  it('should pass through primitive types untouched', () => {
    assert.equal(sanitizePayload('hello'), 'hello');
    assert.equal(sanitizePayload(12345), 12345);
    assert.equal(sanitizePayload(true), true);
  });

  it('should redact sensitive keys (password, token, authorization, secret, etc.)', () => {
    const raw = {
      username: 'johndoe',
      password: 'super-secret-password',
      accessToken: 'jwt.token.abc',
      refreshToken: 'refresh.token.xyz',
      authorization: 'Bearer secret-jwt',
      privateKey: '-----BEGIN RSA PRIVATE KEY-----',
      apiKey: 'sk-1234567890',
      nested: {
        secret: 'hidden_value',
        publicNote: 'visible',
      },
    };

    const sanitized = sanitizePayload(raw);

    assert.equal(sanitized.username, 'johndoe');
    assert.equal(sanitized.password, '[REDACTED]');
    assert.equal(sanitized.accessToken, '[REDACTED]');
    assert.equal(sanitized.refreshToken, '[REDACTED]');
    assert.equal(sanitized.authorization, '[REDACTED]');
    assert.equal(sanitized.privateKey, '[REDACTED]');
    assert.equal(sanitized.apiKey, '[REDACTED]');
    assert.equal(sanitized.nested.secret, '[REDACTED]');
    assert.equal(sanitized.nested.publicNote, 'visible');
  });

  it('should prevent circular reference crashes', () => {
    const obj: any = { name: 'circular-test' };
    obj.self = obj;

    const sanitized = sanitizePayload(obj);
    assert.equal(sanitized.name, 'circular-test');
    assert.equal(sanitized.self, '[CIRCULAR_REFERENCE]');
  });

  it('should cap recursive depth at 5 ([NESTED_TOO_DEEP])', () => {
    const deepObj = {
      l1: {
        l2: {
          l3: {
            l4: {
              l5: {
                l6: {
                  val: 'too deep',
                },
              },
            },
          },
        },
      },
    };

    const sanitized = sanitizePayload(deepObj);
    assert.equal(sanitized.l1.l2.l3.l4.l5.l6, '[NESTED_TOO_DEEP]');
  });

  it('should slice large arrays to at most 20 elements', () => {
    const largeArray = Array.from({ length: 50 }, (_, i) => ({ index: i }));
    const sanitized = sanitizePayload(largeArray);

    assert.equal(Array.isArray(sanitized), true);
    assert.equal(sanitized.length, 20);
    assert.equal(sanitized[0].index, 0);
    assert.equal(sanitized[19].index, 19);
  });

  it('should clamp payloads exceeding 2KB with _truncated and preview', () => {
    const hugePayload = {
      description: 'A'.repeat(3000),
    };

    const sanitized = sanitizePayload(hugePayload, { maxBytes: 2048 });
    assert.equal(sanitized._truncated, true);
    assert.equal(typeof sanitized.preview, 'string');
    assert.equal(sanitized.preview.endsWith('...'), true);
  });
});

describe('2. ApiAuditService & Batching Engine', () => {
  it('should enqueue log entries and auto-assign id and createdAt', async () => {
    const service = new ApiAuditService({ flushIntervalMs: 0 });

    await service.enqueueLog({
      method: 'GET',
      endpoint: '/api/v1/users',
      statusCode: 200,
      durationMs: 15,
      userId: 'user_123',
    });

    const res = await service.getAuditLogs();
    assert.equal(res.total, 1);
    assert.ok(res.logs[0].id);
    assert.ok(res.logs[0].createdAt);
    assert.equal(res.logs[0].method, 'GET');
    assert.equal(res.logs[0].endpoint, '/api/v1/users');
    assert.equal(res.logs[0].userId, 'user_123');

    await service.destroy();
  });

  it('should filter logs by userId, endpoint, method, and statusCode', async () => {
    const service = new ApiAuditService({ flushIntervalMs: 0 });

    await service.enqueueLog({
      method: 'GET',
      endpoint: '/api/v1/users',
      statusCode: 200,
      durationMs: 10,
      userId: 'user_alice',
    });

    await service.enqueueLog({
      method: 'POST',
      endpoint: '/api/v1/orders',
      statusCode: 201,
      durationMs: 45,
      userId: 'user_bob',
    });

    await service.enqueueLog({
      method: 'GET',
      endpoint: '/api/v1/orders/123',
      statusCode: 404,
      durationMs: 5,
      userId: 'user_bob',
    });

    // Filter by userId
    const aliceLogs = await service.getAuditLogs({ userId: 'user_alice' });
    assert.equal(aliceLogs.total, 1);
    assert.equal(aliceLogs.logs[0].userId, 'user_alice');

    // Filter by endpoint substring
    const orderLogs = await service.getAuditLogs({ endpoint: 'orders' });
    assert.equal(orderLogs.total, 2);

    // Filter by method
    const postLogs = await service.getAuditLogs({ method: 'POST' });
    assert.equal(postLogs.total, 1);
    assert.equal(postLogs.logs[0].method, 'POST');

    // Filter by statusCode
    const notFoundLogs = await service.getAuditLogs({ statusCode: 404 });
    assert.equal(notFoundLogs.total, 1);
    assert.equal(notFoundLogs.logs[0].statusCode, 404);

    await service.destroy();
  });

  it('should paginate logs with limit and offset', async () => {
    const service = new ApiAuditService({ flushIntervalMs: 0 });

    for (let i = 1; i <= 10; i++) {
      await service.enqueueLog({
        method: 'GET',
        endpoint: `/api/item/${i}`,
        statusCode: 200,
        durationMs: i * 2,
      });
    }

    const page1 = await service.getAuditLogs({ limit: 4, offset: 0 });
    assert.equal(page1.total, 10);
    assert.equal(page1.limit, 4);
    assert.equal(page1.offset, 0);
    assert.equal(page1.logs.length, 4);

    const page2 = await service.getAuditLogs({ limit: 4, offset: 4 });
    assert.equal(page2.total, 10);
    assert.equal(page2.logs.length, 4);

    await service.destroy();
  });

  it('should auto-flush when queue length hits threshold', async () => {
    const flushedBatches: any[][] = [];
    const storageAdapter = {
      saveBatch: async (batch: any[]) => {
        flushedBatches.push(batch);
      },
    };

    const service = new ApiAuditService({
      flushThreshold: 5,
      flushIntervalMs: 0,
      storageAdapter,
    });

    for (let i = 0; i < 5; i++) {
      await service.enqueueLog({
        method: 'POST',
        endpoint: `/api/batch/${i}`,
        statusCode: 200,
        durationMs: 10,
      });
    }

    // Wait a tick for microtask
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.ok(flushedBatches.length >= 1);
    assert.equal(flushedBatches[0].length, 5);

    await service.destroy();
  });

  it('should re-queue items on storage adapter flush failure', async () => {
    let failOnce = true;
    let errorCaught: any = null;

    const storageAdapter = {
      saveBatch: async (_batch: any[]) => {
        if (failOnce) {
          failOnce = false;
          throw new Error('Database temporarily unavailable');
        }
      },
    };

    const service = new ApiAuditService({
      flushIntervalMs: 0,
      storageAdapter,
      onFlushError: (err) => {
        errorCaught = err;
      },
    });

    await service.enqueueLog({
      method: 'POST',
      endpoint: '/api/fail-test',
      statusCode: 200,
      durationMs: 12,
    });

    // First flush fails
    const count1 = await service.flushLogs();
    assert.equal(count1, 0);
    assert.ok(errorCaught);
    assert.equal(service.getQueueLength(), 1);

    // Second flush succeeds
    const count2 = await service.flushLogs();
    assert.equal(count2, 1);
    assert.equal(service.getQueueLength(), 0);

    await service.destroy();
  });

  it('should support atomic FileAuditStorageAdapter persistence', async () => {
    const testFilePath = path.join(__dirname, '../.test-data/audit_logs.json');
    if (fs.existsSync(testFilePath)) {
      fs.unlinkSync(testFilePath);
    }

    const fileAdapter = new FileAuditStorageAdapter(testFilePath);
    const service = new ApiAuditService({
      flushIntervalMs: 0,
      storageAdapter: fileAdapter,
    });

    await service.enqueueLog({
      method: 'PUT',
      endpoint: '/api/settings',
      statusCode: 200,
      durationMs: 25,
      userId: 'admin_user',
    });

    await service.flushLogs();

    assert.equal(fs.existsSync(testFilePath), true);
    const queryRes = await fileAdapter.query({ userId: 'admin_user' });
    assert.equal(queryRes.total, 1);
    assert.equal(queryRes.logs[0].endpoint, '/api/settings');

    await fileAdapter.clear();
    const afterClear = await fileAdapter.query({});
    assert.equal(afterClear.total, 0);

    // Cleanup
    if (fs.existsSync(testFilePath)) {
      fs.unlinkSync(testFilePath);
      fs.rmdirSync(path.dirname(testFilePath));
    }

    await service.destroy();
  });
});

describe('3. Hono Middleware & Sub-Router Integration', () => {
  it('should capture normal HTTP requests with sanitized payload and status code', async () => {
    const service = new ApiAuditService({ flushIntervalMs: 0 });
    const app = new Hono();

    app.use('*', honoAuditMiddleware(service));

    app.post('/api/login', async (c) => {
      const body = await c.req.json();
      return c.json({ success: true, user: body.username }, 201);
    });

    const res = await app.request('/api/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-user-id': 'user_99',
        'user-agent': 'Antigravity-Audit-Tester/1.0',
      },
      body: JSON.stringify({
        username: 'alice',
        password: 'my-super-secret-password',
      }),
    });

    assert.equal(res.status, 201);

    const logs = await service.getAuditLogs();
    assert.equal(logs.total, 1);
    const log = logs.logs[0];
    assert.equal(log.endpoint, '/api/login');
    assert.equal(log.method, 'POST');
    assert.equal(log.statusCode, 201);
    assert.equal(log.userId, 'user_99');
    assert.ok(log.durationMs >= 0);
    assert.equal(log.payload.username, 'alice');
    assert.equal(log.payload.password, '[REDACTED]');
    assert.equal(log.errorMessage, null);

    await service.destroy();
  });

  it('should capture error requests with error status and errorMessage', async () => {
    const service = new ApiAuditService({ flushIntervalMs: 0 });
    const app = new Hono();

    app.use('*', honoAuditMiddleware(service));

    app.get('/api/broken', () => {
      const err = new Error('Database connection timeout');
      (err as any).status = 503;
      throw err;
    });

    // App error handler
    app.onError((err, c) => {
      return c.json({ error: err.message }, 503);
    });

    const res = await app.request('/api/broken', {
      method: 'GET',
    });

    assert.equal(res.status, 503);

    const logs = await service.getAuditLogs();
    assert.equal(logs.total, 1);
    const log = logs.logs[0];
    assert.equal(log.statusCode, 503);
    assert.equal(log.errorMessage, 'Database connection timeout');

    await service.destroy();
  });

  it('should skip excluded paths like /health and /metrics', async () => {
    const service = new ApiAuditService({ flushIntervalMs: 0 });
    const app = new Hono();

    app.use('*', honoAuditMiddleware(service));

    app.get('/health', (c) => c.text('OK'));
    app.get('/api/health', (c) => c.text('OK'));

    await app.request('/health');
    await app.request('/api/health');

    const logs = await service.getAuditLogs();
    assert.equal(logs.total, 0);

    await service.destroy();
  });

  it('should provide operational endpoints via createAuditLogsRouter', async () => {
    const service = new ApiAuditService({ flushIntervalMs: 0 });
    const app = new Hono();

    app.use('*', honoAuditMiddleware(service, { excludePaths: ['/audit'] }));
    app.route('/audit', createAuditLogsRouter(service));

    app.get('/api/data', (c) => c.json({ val: 42 }));

    // Generate 2 sample requests
    await app.request('/api/data');
    await app.request('/api/data');

    // Query audit router
    const listRes = await app.request('/audit');
    assert.equal(listRes.status, 200);
    const listData = await listRes.json();
    assert.equal(listData.total, 2);

    // Query stats
    const statsRes = await app.request('/audit/stats');
    assert.equal(statsRes.status, 200);
    const statsData = await statsRes.json();
    assert.equal(statsData.inMemoryCount, 2);
    assert.equal(statsData.healthy, true);

    // Clear logs
    const clearRes = await app.request('/audit/clear', { method: 'DELETE' });
    assert.equal(clearRes.status, 200);

    // Verify empty
    const afterClearRes = await app.request('/audit');
    const afterClearData = await afterClearRes.json();
    assert.equal(afterClearData.total, 0);

    await service.destroy();
  });
});
