import fs from 'node:fs';
import path from 'node:path';
import type {
  ApiAuditServiceOptions,
  AuditLogEntry,
  AuditStorageAdapter,
  PaginatedAuditLogsResponse,
  QueryAuditLogsParams,
} from './types';

/**
 * Built-in atomic file-based storage adapter for audit logs.
 */
export class FileAuditStorageAdapter implements AuditStorageAdapter {
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, JSON.stringify([]), 'utf-8');
    }
  }

  private readAll(): AuditLogEntry[] {
    try {
      if (!fs.existsSync(this.filePath)) return [];
      const content = fs.readFileSync(this.filePath, 'utf-8');
      return JSON.parse(content) || [];
    } catch {
      return [];
    }
  }

  private writeAll(entries: AuditLogEntry[]): void {
    const tmpPath = `${this.filePath}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(entries, null, 2), 'utf-8');
    fs.renameSync(tmpPath, this.filePath);
  }

  async saveBatch(entries: AuditLogEntry[]): Promise<void> {
    if (!entries.length) return;
    const existing = this.readAll();
    const updated = [...entries, ...existing];
    // Keep max 5000 logs in single file to avoid bloating
    if (updated.length > 5000) {
      updated.length = 5000;
    }
    this.writeAll(updated);
  }

  async query(params: QueryAuditLogsParams): Promise<PaginatedAuditLogsResponse> {
    const all = this.readAll();
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
    const offset = Math.max(params.offset ?? 0, 0);

    let filtered = all;
    if (params.userId) {
      filtered = filtered.filter((l) => l.userId === params.userId);
    }
    if (params.endpoint) {
      const q = params.endpoint.toLowerCase();
      filtered = filtered.filter((l) => l.endpoint.toLowerCase().includes(q));
    }
    if (params.method) {
      const m = params.method.toUpperCase();
      filtered = filtered.filter((l) => l.method.toUpperCase() === m);
    }
    if (typeof params.statusCode === 'number') {
      filtered = filtered.filter((l) => l.statusCode === params.statusCode);
    }

    const total = filtered.length;
    const logs = filtered.slice(offset, offset + limit);

    return { total, limit, offset, logs };
  }

  async clear(): Promise<void> {
    this.writeAll([]);
  }
}

/**
 * Enterprise API Audit Service.
 * Buffers incoming audit log entries in memory and flushes them in batches to prevent DB/I-O thrashing.
 */
export class ApiAuditService {
  private queue: AuditLogEntry[] = [];
  private inMemoryLogs: AuditLogEntry[] = [];
  private flushTimer: any = null;
  private isFlushing = false;
  private options: Required<Omit<ApiAuditServiceOptions, 'storageAdapter' | 'filePath' | 'onFlushError'>> &
    ApiAuditServiceOptions;

  constructor(options: ApiAuditServiceOptions = {}) {
    this.options = {
      maxInMemoryLogs: options.maxInMemoryLogs ?? 1000,
      flushThreshold: options.flushThreshold ?? 50,
      flushIntervalMs: options.flushIntervalMs ?? 30000,
      storageAdapter: options.storageAdapter,
      filePath: options.filePath,
      onFlushError: options.onFlushError,
    };

    // If filePath is specified without custom adapter, initialize FileAuditStorageAdapter
    if (this.options.filePath && !this.options.storageAdapter) {
      this.options.storageAdapter = new FileAuditStorageAdapter(this.options.filePath);
    }

    // Periodic flush timer
    if (this.options.flushIntervalMs > 0) {
      this.flushTimer = setInterval(() => {
        this.flushLogs().catch((err) => {
          if (this.options.onFlushError) {
            this.options.onFlushError(err);
          }
        });
      }, this.options.flushIntervalMs);

      if (this.flushTimer && typeof this.flushTimer.unref === 'function') {
        this.flushTimer.unref();
      }
    }
  }

  /**
   * Enqueue an audit log entry.
   * Runs asynchronously and non-blocking.
   */
  async enqueueLog(entry: AuditLogEntry): Promise<void> {
    const logRecord: AuditLogEntry = {
      ...entry,
      id:
        entry.id ||
        (typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : `audit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
      createdAt: entry.createdAt || new Date(),
    };

    // Keep in-memory ring buffer (newest first)
    this.inMemoryLogs.unshift(logRecord);
    if (this.inMemoryLogs.length > this.options.maxInMemoryLogs) {
      this.inMemoryLogs.length = this.options.maxInMemoryLogs;
    }

    // Push to pending batch queue
    this.queue.push(logRecord);

    // If threshold reached, schedule immediate flush
    if (this.queue.length >= this.options.flushThreshold) {
      queueMicrotask(() => {
        this.flushLogs().catch((err) => {
          if (this.options.onFlushError) {
            this.options.onFlushError(err);
          }
        });
      });
    }
  }

  /**
   * Pops up to 100 items from queue and flushes to storage adapter.
   */
  async flushLogs(): Promise<number> {
    if (this.isFlushing || this.queue.length === 0) return 0;
    this.isFlushing = true;

    const batch = this.queue.splice(0, 100);

    try {
      if (this.options.storageAdapter) {
        await this.options.storageAdapter.saveBatch(batch);
      }
      return batch.length;
    } catch (err: any) {
      // Re-queue items at the front to avoid data loss
      this.queue.unshift(...batch);
      if (this.options.onFlushError) {
        this.options.onFlushError(err);
      }
      return 0;
    } finally {
      this.isFlushing = false;
    }
  }

  /**
   * Query paginated audit logs.
   */
  async getAuditLogs(params: QueryAuditLogsParams = {}): Promise<PaginatedAuditLogsResponse> {
    if (this.options.storageAdapter && typeof this.options.storageAdapter.query === 'function') {
      return this.options.storageAdapter.query(params);
    }

    const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
    const offset = Math.max(params.offset ?? 0, 0);

    let filtered = this.inMemoryLogs;

    if (params.userId) {
      filtered = filtered.filter((l) => l.userId === params.userId);
    }
    if (params.endpoint) {
      const q = params.endpoint.toLowerCase();
      filtered = filtered.filter((l) => l.endpoint.toLowerCase().includes(q));
    }
    if (params.method) {
      const m = params.method.toUpperCase();
      filtered = filtered.filter((l) => l.method.toUpperCase() === m);
    }
    if (typeof params.statusCode === 'number') {
      filtered = filtered.filter((l) => l.statusCode === params.statusCode);
    }

    const total = filtered.length;
    const logs = filtered.slice(offset, offset + limit);

    return {
      total,
      limit,
      offset,
      logs,
    };
  }

  /**
   * Clears in-memory buffer, queue, and underlying storage adapter if supported.
   */
  async clear(): Promise<void> {
    this.queue = [];
    this.inMemoryLogs = [];
    if (this.options.storageAdapter && typeof this.options.storageAdapter.clear === 'function') {
      await this.options.storageAdapter.clear();
    }
  }

  /**
   * Graceful shutdown / cleanup.
   * Flushes all remaining items in queue and stops intervals.
   */
  async destroy(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    let drainLoops = 0;
    while (this.queue.length > 0 && drainLoops < 50) {
      const flushedCount = await this.flushLogs();
      if (flushedCount === 0) break;
      drainLoops++;
    }
  }

  getQueueLength(): number {
    return this.queue.length;
  }

  getInMemoryCount(): number {
    return this.inMemoryLogs.length;
  }

  isHealthy(): boolean {
    return true;
  }
}
