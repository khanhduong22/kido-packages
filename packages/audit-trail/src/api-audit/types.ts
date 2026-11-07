import type { Context } from 'hono';

export interface AuditLogEntry {
  id?: string;
  userId?: string | null;
  method: string;
  endpoint: string;
  statusCode: number;
  durationMs: number;
  ip?: string | null;
  userAgent?: string | null;
  payload?: any;
  errorMessage?: string | null;
  createdAt?: Date | string;
}

export interface QueryAuditLogsParams {
  userId?: string;
  endpoint?: string;
  method?: string;
  statusCode?: number;
  limit?: number;
  offset?: number;
}

export interface PaginatedAuditLogsResponse {
  total: number;
  limit: number;
  offset: number;
  logs: AuditLogEntry[];
}

export interface AuditStorageAdapter {
  saveBatch(entries: AuditLogEntry[]): Promise<void> | void;
  query?(params: QueryAuditLogsParams): Promise<PaginatedAuditLogsResponse> | PaginatedAuditLogsResponse;
  clear?(): Promise<void> | void;
}

export interface ApiAuditServiceOptions {
  /** Maximum number of logs retained in memory ring buffer for instant queries (default: 1000) */
  maxInMemoryLogs?: number;
  /** Queue length threshold to trigger auto-flush (default: 50) */
  flushThreshold?: number;
  /** Periodic flush interval in milliseconds (default: 30000; set <= 0 to disable) */
  flushIntervalMs?: number;
  /** Optional custom storage adapter for batch flush & queries (e.g., PostgreSQL, SQLite, File) */
  storageAdapter?: AuditStorageAdapter;
  /** Optional file path for file-based JSON storage */
  filePath?: string;
  /** Callback invoked on batch flush error */
  onFlushError?: (error: any) => void;
}

export interface SanitizeOptions {
  /** Maximum serialized payload size in bytes before truncating (default: 2048) */
  maxBytes?: number;
  /** Maximum recursive object depth before marking [NESTED_TOO_DEEP] (default: 5) */
  maxDepth?: number;
  /** Maximum array length inspected before slicing (default: 20) */
  maxArrayLength?: number;
  /** Additional or custom sensitive keys to redact */
  sensitiveKeys?: Iterable<string>;
}

export interface HonoAuditMiddlewareOptions {
  /** Paths or regex patterns to exclude from audit logging (e.g. /health, /metrics) */
  excludePaths?: (string | RegExp)[];
  /** Custom user ID extractor from Hono context */
  getUserId?: (c: Context) => string | null | undefined;
  /** Custom payload extractor from Hono context */
  getPayload?: (c: Context) => any;
  /** Maximum serialized payload size in bytes before truncating (default: 2048) */
  maxPayloadBytes?: number;
  /** Additional sensitive keys to redact */
  sensitiveKeys?: string[];
}
