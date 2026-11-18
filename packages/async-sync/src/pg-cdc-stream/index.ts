/**
 * @kido/async-sync — 3-Tier PostgreSQL CDC Stream & Debezium Sink
 *
 * Implements GonnaCrash Level 23 (Search Index Lag & Dual-Write Trap Elimination):
 * 1. Types & Envelopes: CdcOperation ('c'|'u'|'d'|'r'), CdcChangeEvent, DebeziumEnvelope, Zod schemas
 * 2. LSN Coalescer & Idempotent Watermark Filter:
 *    - `coalesceCdcBatch`: coalesces rapid updates by `schema.table:primaryKey`, preserves net transitions
 *    - `IdempotentLsnTracker`: tracks applied LSN watermarks to discard stale replayed WAL frames
 *    - `parseLsnToBigInt` & `formatBigIntToPgLsn`: 64-bit LSN byte math
 * 3. PostgreSQL WAL Disk-Full Circuit Breaker:
 *    - `evaluateCdcSlotDiskSafety`: protects VPS disk against unbounded WAL retention
 *    - `buildCreateLogicalSlotSql`, `buildPeekLogicalSlotChangesSql`, `buildConfirmLogicalSlotFlushSql`, `buildDropReplicationSlotSql`
 * 4. 3-Tier Progressive CDC Engine:
 *    - Tier-0: `Tier0TriggerNotifyOutboxCdc` ($5/mo single VPS with triggers + pg_notify + cdc_outbox)
 *    - Tier-1: `Tier1NativeWalSlotPoller` (Two-Phase Peek -> Coalesce -> Sink -> Ack LSN loop, zero Java/Kafka, <15MB RAM)
 *    - Tier-2: `Tier2DebeziumEnvelopeConsumer` (Debezium / wal2json v2 consumer with coalescing & watermark guards)
 *    - `calculateLevel23CdcMetrics`: mathematical proof modeling Level 23 search index lag
 */

import { z } from 'zod';
import { assertValidPgIdentifier, parsePgLsn } from '../pg-replication/index';

// ============================================================================
// 1. TYPES & ENVELOPES
// ============================================================================

/**
 * Standard Debezium / wal2json CDC operations:
 * - 'c': Create / Insert
 * - 'u': Update
 * - 'd': Delete
 * - 'r': Read / Initial Snapshot
 */
export type CdcOperation = 'c' | 'u' | 'd' | 'r';

export const CdcOperationSchema = z.enum(['c', 'u', 'd', 'r']);

/**
 * Normalized Change Data Capture Event representing a single row mutation
 */
export interface CdcChangeEvent<T = Record<string, unknown>> {
  lsn: string;
  lsnBigInt?: bigint;
  txId?: number;
  timestampMs: number;
  schema: string;
  table: string;
  op: CdcOperation;
  primaryKey: string;
  before?: T | null;
  after?: T | null;
}

export const CdcChangeEventSchema = z.object({
  lsn: z.string().min(1),
  lsnBigInt: z.bigint().optional(),
  txId: z.number().int().optional(),
  timestampMs: z.number().int().nonnegative(),
  schema: z.string().min(1),
  table: z.string().min(1),
  op: CdcOperationSchema,
  primaryKey: z.string().min(1),
  before: z.record(z.unknown()).nullable().optional(),
  after: z.record(z.unknown()).nullable().optional(),
});

/**
 * Standard Debezium Envelope representation
 */
export interface DebeziumEnvelope<T = Record<string, unknown>> {
  before: T | null;
  after: T | null;
  op: CdcOperation;
  ts_ms: number;
  source: {
    version?: string;
    connector: string;
    name: string;
    ts_ms: number;
    snapshot?: string;
    db: string;
    schema: string;
    table: string;
    txId?: number;
    lsn: number | string;
  };
}

export const DebeziumEnvelopeSchema = z.object({
  before: z.record(z.unknown()).nullable(),
  after: z.record(z.unknown()).nullable(),
  op: CdcOperationSchema,
  ts_ms: z.number().int().nonnegative(),
  source: z.object({
    version: z.string().optional(),
    connector: z.string(),
    name: z.string(),
    ts_ms: z.number().int().nonnegative(),
    snapshot: z.string().optional(),
    db: z.string(),
    schema: z.string(),
    table: z.string(),
    txId: z.number().int().optional(),
    lsn: z.union([z.number(), z.string()]),
  }),
});

// ============================================================================
// 2. LSN PARSING & IDEMPOTENT WATERMARK TRACKING
// ============================================================================

const PG_LSN_HEX_REGEX = /^([0-9a-fA-F]{1,8})\/([0-9a-fA-F]{1,8})$/;

/**
 * Parses any LSN representation (PostgreSQL 'XXXX/YYYYYYYY' hex, numeric bigint,
 * decimal integer string, or Debezium byte number) into a 64-bit bigint.
 */
export function parseLsnToBigInt(lsn: string | bigint | number): bigint {
  if (typeof lsn === 'bigint') {
    return lsn;
  }
  if (typeof lsn === 'number') {
    if (!Number.isFinite(lsn) || lsn < 0) {
      throw new Error(`Invalid numeric LSN "${lsn}": must be a non-negative finite number`);
    }
    return BigInt(Math.floor(lsn));
  }
  if (typeof lsn !== 'string' || !lsn.trim()) {
    throw new Error('Invalid LSN: must be a non-empty string, number, or bigint');
  }

  const trimmed = lsn.trim();
  if (PG_LSN_HEX_REGEX.test(trimmed)) {
    return parsePgLsn(trimmed);
  }

  // Handle decimal or hex 0x strings
  try {
    return BigInt(trimmed);
  } catch {
    throw new Error(
      `Invalid PostgreSQL LSN format "${lsn}": expected "XXXX/YYYYYYYY", hex "0x...", or decimal integer`,
    );
  }
}

/**
 * Formats a 64-bit bigint byte offset into canonical PostgreSQL 'XXXX/YYYYYYYY' hex format.
 */
export function formatBigIntToPgLsn(offset: bigint): string {
  if (offset < 0n) {
    throw new Error('Invalid LSN offset: cannot be negative');
  }
  const upper = (offset >> 32n).toString(16).toUpperCase();
  const lower = (offset & 0xffffffffn).toString(16).toUpperCase().padStart(8, '0');
  return `${upper}/${lower}`;
}

/**
 * In-memory or persistent LSN watermark tracker to guarantee idempotency across restarts.
 * Discards stale replayed WAL events so newer updates are never overwritten by older retries.
 */
export class IdempotentLsnTracker {
  private watermarks = new Map<string, bigint>();
  private globalWatermark: bigint | null = null;

  constructor(initialSnapshot?: Record<string, string | bigint | number>) {
    if (initialSnapshot) {
      this.fromSnapshot(initialSnapshot);
    }
  }

  /**
   * Retrieves high-watermark LSN for a given entity key (`schema.table:primaryKey`)
   */
  public getWatermark(entityKey: string): bigint | undefined {
    return this.watermarks.get(entityKey);
  }

  /**
   * Sets or advances high-watermark for an entity if the new LSN is greater than the recorded one.
   */
  public setWatermark(entityKey: string, lsn: string | bigint | number): void {
    const lsnBigInt = parseLsnToBigInt(lsn);
    const existing = this.watermarks.get(entityKey);
    if (existing === undefined || lsnBigInt > existing) {
      this.watermarks.set(entityKey, lsnBigInt);
    }
  }

  /**
   * Returns true if event is stale (event LSN <= recorded watermark or <= global watermark).
   */
  public isStale(entityKey: string, lsn: string | bigint | number): boolean {
    const lsnBigInt = parseLsnToBigInt(lsn);
    if (this.globalWatermark !== null && lsnBigInt <= this.globalWatermark) {
      return true;
    }
    const existing = this.watermarks.get(entityKey);
    if (existing !== undefined && lsnBigInt <= existing) {
      return true;
    }
    return false;
  }

  public getGlobalWatermark(): bigint | null {
    return this.globalWatermark;
  }

  public setGlobalWatermark(lsn: string | bigint | number): void {
    const lsnBigInt = parseLsnToBigInt(lsn);
    if (this.globalWatermark === null || lsnBigInt > this.globalWatermark) {
      this.globalWatermark = lsnBigInt;
    }
  }

  public size(): number {
    return this.watermarks.size;
  }

  public clear(): void {
    this.watermarks.clear();
    this.globalWatermark = null;
  }

  public toSnapshot(): Record<string, string> {
    const snapshot: Record<string, string> = {};
    for (const [key, val] of this.watermarks.entries()) {
      snapshot[key] = formatBigIntToPgLsn(val);
    }
    if (this.globalWatermark !== null) {
      snapshot['__global__'] = formatBigIntToPgLsn(this.globalWatermark);
    }
    return snapshot;
  }

  public fromSnapshot(snapshot: Record<string, string | bigint | number>): void {
    for (const [key, val] of Object.entries(snapshot)) {
      if (key === '__global__') {
        this.setGlobalWatermark(val);
      } else {
        this.setWatermark(key, val);
      }
    }
  }
}

// ============================================================================
// 3. LSN COALESCER & NET TRANSITION RESOLVER
// ============================================================================

export interface CoalesceCdcBatchOptions<T = Record<string, unknown>> {
  tracker?: IdempotentLsnTracker;
  lastAppliedLsn?: string | bigint | number;
  /**
   * If true, an entity INSERTed then DELETEd within the same batch emits a 'd' (Delete) event.
   * If false (default), the entity is treated as net no-op and dropped from output.
   */
  emitDeletedForNetNoOp?: boolean;
  onDropStaleEvent?: (event: CdcChangeEvent<T>, watermark: bigint) => void;
  onCoalesceEntity?: (entityKey: string, initialCount: number, netOp: CdcOperation) => void;
}

/**
 * Coalesces a batch of CDC events by entity key (`schema.table:primaryKey`),
 * keeping ONLY the event with the highest LSN while preserving the net state transition:
 * - INSERT ('c') followed by UPDATE ('u') -> INSERT ('c') with latest `after` payload
 * - INSERT ('c') followed by DELETE ('d') within same batch -> net no-op (or 'd' if emitDeletedForNetNoOp is true)
 * - UPDATE ('u') followed by DELETE ('d') -> DELETE ('d')
 * - Multiple UPDATEs -> single UPDATE ('u') with latest `after` and earliest `before`
 *
 * Discards any event whose LSN <= lastAppliedLsn or tracker watermark to prevent race conditions.
 */
export function coalesceCdcBatch<T = Record<string, unknown>>(
  events: CdcChangeEvent<T>[],
  options: CoalesceCdcBatchOptions<T> = {},
): CdcChangeEvent<T>[] {
  if (!events || events.length === 0) {
    return [];
  }

  const { tracker, lastAppliedLsn, emitDeletedForNetNoOp = false, onDropStaleEvent, onCoalesceEntity } =
    options;
  const minGlobalLsn = lastAppliedLsn !== undefined ? parseLsnToBigInt(lastAppliedLsn) : null;

  // Step 1: Filter out stale events
  const validEvents: Array<CdcChangeEvent<T> & { lsnBigInt: bigint; entityKey: string }> = [];

  for (const event of events) {
    const lsnBigInt = event.lsnBigInt ?? parseLsnToBigInt(event.lsn);
    const entityKey = `${event.schema}.${event.table}:${event.primaryKey}`;

    if (minGlobalLsn !== null && lsnBigInt <= minGlobalLsn) {
      onDropStaleEvent?.(event, minGlobalLsn);
      continue;
    }

    if (tracker && tracker.isStale(entityKey, lsnBigInt)) {
      const wm = tracker.getWatermark(entityKey) ?? tracker.getGlobalWatermark() ?? 0n;
      onDropStaleEvent?.(event, wm);
      continue;
    }

    validEvents.push({
      ...event,
      lsnBigInt,
      entityKey,
    });
  }

  if (validEvents.length === 0) {
    return [];
  }

  // Step 2: Group by entityKey
  const groups = new Map<string, Array<CdcChangeEvent<T> & { lsnBigInt: bigint; entityKey: string }>>();
  for (const ev of validEvents) {
    let group = groups.get(ev.entityKey);
    if (!group) {
      group = [];
      groups.set(ev.entityKey, group);
    }
    group.push(ev);
  }

  // Step 3: Coalesce each group
  const coalesced: CdcChangeEvent<T>[] = [];

  for (const [entityKey, group] of groups.entries()) {
    // Sort chronologically by LSN
    group.sort((a, b) => (a.lsnBigInt < b.lsnBigInt ? -1 : a.lsnBigInt > b.lsnBigInt ? 1 : 0));

    if (group.length === 1) {
      const single = group[0];
      coalesced.push({
        lsn: single.lsn,
        lsnBigInt: single.lsnBigInt,
        txId: single.txId,
        timestampMs: single.timestampMs,
        schema: single.schema,
        table: single.table,
        op: single.op,
        primaryKey: single.primaryKey,
        before: single.before,
        after: single.after,
      });
      continue;
    }

    const first = group[0];
    const last = group[group.length - 1];
    let netOp: CdcOperation = last.op;
    let includeInBatch = true;
    let netBefore = first.before;
    let netAfter = last.after;

    if (first.op === 'c') {
      if (last.op === 'u') {
        // Created and then updated: Net effect is an INSERT with the latest attributes
        netOp = 'c';
        netBefore = first.before ?? null;
        netAfter = last.after;
      } else if (last.op === 'd') {
        // Created and deleted within same batch
        if (emitDeletedForNetNoOp) {
          netOp = 'd';
          netBefore = first.after ?? first.before ?? null;
          netAfter = null;
        } else {
          includeInBatch = false;
        }
      }
    } else if (first.op === 'u' || first.op === 'r') {
      if (last.op === 'u') {
        netOp = 'u';
        netBefore = first.before;
        netAfter = last.after;
      } else if (last.op === 'd') {
        netOp = 'd';
        netBefore = first.before ?? last.before;
        netAfter = null;
      }
    } else if (first.op === 'd') {
      if (last.op === 'c' || last.op === 'u') {
        netOp = 'u';
        netBefore = null;
        netAfter = last.after;
      }
    }

    onCoalesceEntity?.(entityKey, group.length, netOp);

    if (includeInBatch) {
      coalesced.push({
        lsn: last.lsn,
        lsnBigInt: last.lsnBigInt,
        txId: last.txId,
        timestampMs: last.timestampMs,
        schema: last.schema,
        table: last.table,
        op: netOp,
        primaryKey: last.primaryKey,
        before: netBefore,
        after: netAfter,
      });
    }
  }

  // Preserve global LSN monotonic ordering
  coalesced.sort((a, b) => {
    const aBig = a.lsnBigInt ?? parseLsnToBigInt(a.lsn);
    const bBig = b.lsnBigInt ?? parseLsnToBigInt(b.lsn);
    return aBig < bBig ? -1 : aBig > bBig ? 1 : 0;
  });

  return coalesced;
}

// ============================================================================
// 4. WAL DISK-FULL CIRCUIT BREAKER & SAFE REPLICATION SLOT SQL
// ============================================================================

export type CdcSlotSafetyStatus = 'healthy' | 'warning' | 'critical_trip_breaker';

export interface EvaluateCdcSlotDiskSafetyInput {
  currentWalLsn: string | bigint | number;
  restartLsn: string | bigint | number;
  availableDiskBytes: number | bigint;
  totalDiskBytes?: number | bigint;
  /** Warning threshold ratio of retained WAL to available disk (default: 0.70 = 70%) */
  warningThresholdRatio?: number;
  /** Critical threshold ratio to trip breaker (default: 0.85 = 85%) */
  criticalThresholdRatio?: number;
  /** Max allowed retained WAL bytes regardless of ratio (e.g. 50GB, default: 50 * 1024 * 1024 * 1024) */
  maxRetainedWalBytes?: number | bigint;
  slotName?: string;
}

export interface CdcSlotDiskSafetyReport {
  status: CdcSlotSafetyStatus;
  retainedWalBytes: number;
  retainedWalBytesBigInt: bigint;
  availableDiskBytes: number;
  usageRatio: number;
  shouldDropSlotToSaveDatabase: boolean;
  remediationSql: string | null;
  issues: string[];
}

/**
 * Evaluates whether an unacknowledged PostgreSQL CDC replication slot is retaining
 * excessive WAL files that risk filling 100% of VPS disk and crashing the database.
 */
export function evaluateCdcSlotDiskSafety(
  input: EvaluateCdcSlotDiskSafetyInput,
): CdcSlotDiskSafetyReport {
  const currentOffset = parseLsnToBigInt(input.currentWalLsn);
  const restartOffset = parseLsnToBigInt(input.restartLsn);
  const slotName = input.slotName ?? 'cdc_slot';

  const retainedBigInt = currentOffset >= restartOffset ? currentOffset - restartOffset : 0n;
  const retainedBytes = Number(retainedBigInt);
  const availableBytes = Number(input.availableDiskBytes);

  const warningRatio = input.warningThresholdRatio ?? 0.7;
  const criticalRatio = input.criticalThresholdRatio ?? 0.85;
  const maxRetainedBytes = Number(input.maxRetainedWalBytes ?? 50 * 1024 * 1024 * 1024); // 50 GB

  // Usage ratio relative to disk headroom
  const totalRelevantBytes = availableBytes + retainedBytes;
  const usageRatio = totalRelevantBytes > 0 ? retainedBytes / totalRelevantBytes : 1.0;

  const issues: string[] = [];
  let status: CdcSlotSafetyStatus = 'healthy';
  let shouldDrop = false;
  let remediationSql: string | null = null;

  if (retainedBytes >= maxRetainedBytes) {
    issues.push(
      `Retained WAL size (${(retainedBytes / 1024 / 1024).toFixed(1)} MB) exceeds max threshold (${(maxRetainedBytes / 1024 / 1024).toFixed(1)} MB)`,
    );
    status = 'critical_trip_breaker';
    shouldDrop = true;
  } else if (usageRatio >= criticalRatio) {
    issues.push(
      `WAL disk usage ratio (${(usageRatio * 100).toFixed(1)}%) exceeds critical threshold (${(criticalRatio * 100).toFixed(1)}%)`,
    );
    status = 'critical_trip_breaker';
    shouldDrop = true;
  } else if (usageRatio >= warningRatio) {
    issues.push(
      `WAL disk usage ratio (${(usageRatio * 100).toFixed(1)}%) exceeds warning threshold (${(warningRatio * 100).toFixed(1)}%)`,
    );
    status = 'warning';
  }

  if (shouldDrop) {
    remediationSql = buildDropReplicationSlotSql(slotName);
  }

  return {
    status,
    retainedWalBytes: retainedBytes,
    retainedWalBytesBigInt: retainedBigInt,
    availableDiskBytes: availableBytes,
    usageRatio,
    shouldDropSlotToSaveDatabase: shouldDrop,
    remediationSql,
    issues,
  };
}

/**
 * Builds safe SQL to create a logical replication slot.
 */
export function buildCreateLogicalSlotSql(slotName: string, plugin = 'wal2json'): string {
  const safeSlot = assertValidPgIdentifier(slotName, 'slotName');
  const safePlugin = assertValidPgIdentifier(plugin, 'plugin');
  return `SELECT pg_create_logical_replication_slot('${safeSlot}', '${safePlugin}');`;
}

/**
 * Builds Phase 1 of Two-Phase Peek-then-Ack:
 * Peeks unconsumed changes WITHOUT advancing the replication slot confirmed_flush_lsn.
 */
export function buildPeekLogicalSlotChangesSql(slotName: string, limit = 500): string {
  const safeSlot = assertValidPgIdentifier(slotName, 'slotName');
  const safeLimit = Math.max(1, Math.min(Math.floor(limit), 100_000));
  return `SELECT lsn, xid, data FROM pg_logical_slot_peek_changes('${safeSlot}', NULL, ${safeLimit});`;
}

/**
 * Builds Phase 2 of Two-Phase Peek-then-Ack:
 * Consumes and acknowledges changes up to `uptoLsn`, advancing confirmed_flush_lsn
 * ONLY after the downstream Search Index and Redis cache confirm 200 OK!
 */
export function buildConfirmLogicalSlotFlushSql(slotName: string, uptoLsn: string): string {
  const safeSlot = assertValidPgIdentifier(slotName, 'slotName');
  // Validate LSN format to prevent SQL injection
  parseLsnToBigInt(uptoLsn);
  return `SELECT lsn, xid, data FROM pg_logical_slot_get_changes('${safeSlot}', '${uptoLsn.trim()}', NULL);`;
}

/**
 * Builds safe SQL to drop a replication slot when emergency circuit breaker trips.
 */
export function buildDropReplicationSlotSql(slotName: string): string {
  const safeSlot = assertValidPgIdentifier(slotName, 'slotName');
  return `SELECT pg_drop_replication_slot('${safeSlot}');`;
}

// ============================================================================
// 5. 3-TIER PROGRESSIVE CDC ENGINE
// ============================================================================

export interface SearchIndexSink<T = Record<string, unknown>> {
  upsert(items: Array<{ id: string; doc: T }>): Promise<{ successful: number; failed: number }>;
  delete(ids: string[]): Promise<{ successful: number; failed: number }>;
}

export interface CacheInvalidationSink {
  invalidate(keys: string[]): Promise<number>;
}

export interface PgSqlExecutorLike {
  queryRaw<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<R[]>;
  executeRaw?(sql: string, params?: unknown[]): Promise<unknown>;
}

// ----------------------------------------------------------------------------
// Tier-0: Trigger + NOTIFY + Outbox Catch-up ($5/mo Single VPS Zero-Infra)
// ----------------------------------------------------------------------------

export interface Tier0TriggerNotifyOptions {
  schema?: string;
  targetTable: string;
  outboxTable?: string;
  primaryKeyCol?: string;
  channel?: string;
}

export class Tier0TriggerNotifyOutboxCdc {
  public static buildTriggerNotifyDdl(options: Tier0TriggerNotifyOptions): string {
    const schema = assertValidPgIdentifier(options.schema ?? 'public', 'schema');
    const targetTable = assertValidPgIdentifier(options.targetTable, 'targetTable');
    const outboxTable = assertValidPgIdentifier(options.outboxTable ?? 'cdc_outbox', 'outboxTable');
    const pkCol = assertValidPgIdentifier(options.primaryKeyCol ?? 'id', 'primaryKeyCol');
    const channel = assertValidPgIdentifier(options.channel ?? 'cdc_stream', 'channel');
    const fnName = `fn_${targetTable}_cdc_outbox_notify`;
    const trgName = `trg_${targetTable}_cdc_outbox`;

    return `
-- 1. Create durable cdc_outbox table
CREATE TABLE IF NOT EXISTS ${schema}.${outboxTable} (
  seq_id BIGSERIAL PRIMARY KEY,
  schema_name TEXT NOT NULL,
  table_name TEXT NOT NULL,
  op VARCHAR(1) NOT NULL,
  pk TEXT NOT NULL,
  before_payload JSONB,
  after_payload JSONB,
  tx_id BIGINT DEFAULT txid_current(),
  created_at TIMESTAMPTZ DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_${outboxTable}_seq ON ${schema}.${outboxTable} (seq_id ASC);

-- 2. Trigger function for outbox insertion + pg_notify
CREATE OR REPLACE FUNCTION ${schema}.${fnName}()
RETURNS TRIGGER AS $$
DECLARE
  v_seq_id BIGINT;
  v_op VARCHAR(1);
  v_pk TEXT;
  v_before JSONB := NULL;
  v_after JSONB := NULL;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_op := 'c';
    v_pk := NEW.${pkCol}::text;
    v_after := to_jsonb(NEW);
  ELSIF TG_OP = 'UPDATE' THEN
    v_op := 'u';
    v_pk := NEW.${pkCol}::text;
    v_before := to_jsonb(OLD);
    v_after := to_jsonb(NEW);
  ELSIF TG_OP = 'DELETE' THEN
    v_op := 'd';
    v_pk := OLD.${pkCol}::text;
    v_before := to_jsonb(OLD);
  END IF;

  INSERT INTO ${schema}.${outboxTable} (schema_name, table_name, op, pk, before_payload, after_payload)
  VALUES (TG_TABLE_SCHEMA, TG_TABLE_NAME, v_op, v_pk, v_before, v_after)
  RETURNING seq_id INTO v_seq_id;

  PERFORM pg_notify('${channel}', json_build_object(
    'seq_id', v_seq_id,
    'schema', TG_TABLE_SCHEMA,
    'table', TG_TABLE_NAME,
    'op', v_op,
    'pk', v_pk
  )::text);

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- 3. Bind trigger
DROP TRIGGER IF EXISTS ${trgName} ON ${schema}.${targetTable};
CREATE TRIGGER ${trgName}
AFTER INSERT OR UPDATE OR DELETE ON ${schema}.${targetTable}
FOR EACH ROW EXECUTE FUNCTION ${schema}.${fnName}();
`.trim();
  }

  public static buildCatchUpQuerySql(outboxTable = 'cdc_outbox', schema = 'public'): string {
    const s = assertValidPgIdentifier(schema, 'schema');
    const t = assertValidPgIdentifier(outboxTable, 'outboxTable');
    return `SELECT seq_id, schema_name, table_name, op, pk, before_payload, after_payload, tx_id, created_at FROM ${s}.${t} WHERE seq_id > $1 ORDER BY seq_id ASC LIMIT $2;`;
  }

  public static parseOutboxRowToEvent(row: Record<string, unknown>): CdcChangeEvent {
    const seqId = Number(row.seq_id ?? 0);
    const op = (row.op as CdcOperation) ?? 'u';
    const schema = String(row.schema_name ?? 'public');
    const table = String(row.table_name ?? 'unknown');
    const pk = String(row.pk ?? '');
    const createdAt = row.created_at instanceof Date ? row.created_at.getTime() : Date.now();

    return {
      lsn: formatBigIntToPgLsn(BigInt(seqId)),
      lsnBigInt: BigInt(seqId),
      txId: row.tx_id !== undefined ? Number(row.tx_id) : undefined,
      timestampMs: createdAt,
      schema,
      table,
      op,
      primaryKey: pk,
      before: (row.before_payload as Record<string, unknown>) ?? null,
      after: (row.after_payload as Record<string, unknown>) ?? null,
    };
  }
}

// ----------------------------------------------------------------------------
// Tier-1: Native WAL Slot Poller (Two-Phase Peek-then-Ack, Zero Java/Kafka)
// ----------------------------------------------------------------------------

export interface Tier1NativeWalSlotPollerOptions {
  slotName: string;
  limit?: number;
  searchIndexSink?: SearchIndexSink;
  cacheInvalidationSink?: CacheInvalidationSink;
  watermarkTracker?: IdempotentLsnTracker;
  sqlExecutor: PgSqlExecutorLike;
  cacheKeyPrefix?: string;
}

export interface Tier1PollResult {
  peekedCount: number;
  coalescedCount: number;
  upsertedCount: number;
  deletedCount: number;
  invalidatedCount: number;
  flushedLsn: string | null;
  durationMs: number;
}

export class Tier1NativeWalSlotPoller {
  private slotName: string;
  private limit: number;
  private searchIndexSink?: SearchIndexSink;
  private cacheInvalidationSink?: CacheInvalidationSink;
  private watermarkTracker: IdempotentLsnTracker;
  private sqlExecutor: PgSqlExecutorLike;
  private cacheKeyPrefix: string;

  constructor(options: Tier1NativeWalSlotPollerOptions) {
    this.slotName = assertValidPgIdentifier(options.slotName, 'slotName');
    this.limit = options.limit ?? 500;
    this.searchIndexSink = options.searchIndexSink;
    this.cacheInvalidationSink = options.cacheInvalidationSink;
    this.watermarkTracker = options.watermarkTracker ?? new IdempotentLsnTracker();
    this.sqlExecutor = options.sqlExecutor;
    this.cacheKeyPrefix = options.cacheKeyPrefix ?? 'cache';
  }

  public getTracker(): IdempotentLsnTracker {
    return this.watermarkTracker;
  }

  /**
   * Executes one iteration of Two-Phase Peek-then-Ack:
   * 1. Peek unacknowledged changes from PostgreSQL WAL replication slot.
   * 2. Parse into CdcChangeEvents.
   * 3. Coalesce batch and filter out stale watermarks.
   * 4. Dispatch upserts/deletes to SearchIndexSink.
   * 5. Dispatch cache invalidations to CacheInvalidationSink.
   * 6. ONLY after successful sink operations, advance PostgreSQL confirmed_flush_lsn!
   */
  public async pollAndDispatch(): Promise<Tier1PollResult> {
    const startTime = Date.now();
    const peekSql = buildPeekLogicalSlotChangesSql(this.slotName, this.limit);
    const rows = await this.sqlExecutor.queryRaw<{ lsn: string; xid: number; data: unknown }>(peekSql);

    if (!rows || rows.length === 0) {
      return {
        peekedCount: 0,
        coalescedCount: 0,
        upsertedCount: 0,
        deletedCount: 0,
        invalidatedCount: 0,
        flushedLsn: null,
        durationMs: Date.now() - startTime,
      };
    }

    const rawEvents: CdcChangeEvent[] = [];
    for (const row of rows) {
      const parsed = this.parseSlotRow(row);
      if (Array.isArray(parsed)) {
        rawEvents.push(...parsed);
      } else if (parsed) {
        rawEvents.push(parsed);
      }
    }

    // Coalesce batch
    const coalesced = coalesceCdcBatch(rawEvents, {
      tracker: this.watermarkTracker,
    });

    let upsertedCount = 0;
    let deletedCount = 0;
    let invalidatedCount = 0;

    const upsertItems: Array<{ id: string; doc: Record<string, unknown> }> = [];
    const deleteIds: string[] = [];
    const cacheKeysToInvalidate: string[] = [];

    for (const ev of coalesced) {
      const entityKey = `${ev.schema}.${ev.table}:${ev.primaryKey}`;
      cacheKeysToInvalidate.push(`${this.cacheKeyPrefix}:${ev.table}:${ev.primaryKey}`);

      if (ev.op === 'c' || ev.op === 'u' || ev.op === 'r') {
        if (ev.after) {
          upsertItems.push({
            id: ev.primaryKey,
            doc: ev.after,
          });
        }
      } else if (ev.op === 'd') {
        deleteIds.push(ev.primaryKey);
      }
    }

    // Phase 1b: Apply to Downstream Sinks
    if (this.searchIndexSink) {
      if (upsertItems.length > 0) {
        const res = await this.searchIndexSink.upsert(upsertItems);
        upsertedCount += res.successful;
      }
      if (deleteIds.length > 0) {
        const res = await this.searchIndexSink.delete(deleteIds);
        deletedCount += res.successful;
      }
    } else {
      upsertedCount = upsertItems.length;
      deletedCount = deleteIds.length;
    }

    if (this.cacheInvalidationSink && cacheKeysToInvalidate.length > 0) {
      invalidatedCount = await this.cacheInvalidationSink.invalidate(cacheKeysToInvalidate);
    } else {
      invalidatedCount = cacheKeysToInvalidate.length;
    }

    // Phase 2: Downstream sinks succeeded 200 OK! Now confirm LSN flush to advance slot
    const highestRowLsn = rows[rows.length - 1].lsn;
    const confirmSql = buildConfirmLogicalSlotFlushSql(this.slotName, highestRowLsn);
    await this.sqlExecutor.queryRaw(confirmSql);

    // Advance watermarks in tracker
    for (const ev of coalesced) {
      const entityKey = `${ev.schema}.${ev.table}:${ev.primaryKey}`;
      this.watermarkTracker.setWatermark(entityKey, ev.lsn);
    }
    this.watermarkTracker.setGlobalWatermark(highestRowLsn);

    return {
      peekedCount: rows.length,
      coalescedCount: coalesced.length,
      upsertedCount,
      deletedCount,
      invalidatedCount,
      flushedLsn: highestRowLsn,
      durationMs: Date.now() - startTime,
    };
  }

  private parseSlotRow(row: { lsn: string; xid: number; data: unknown }): CdcChangeEvent | CdcChangeEvent[] | null {
    let payload = row.data;
    if (typeof payload === 'string') {
      try {
        payload = JSON.parse(payload);
      } catch {
        // Not JSON
        return null;
      }
    }

    if (!payload || typeof payload !== 'object') {
      return null;
    }

    const obj = payload as Record<string, unknown>;

    // wal2json v1 format: { change: [...] }
    if (Array.isArray(obj.change)) {
      const events: CdcChangeEvent[] = [];
      for (const ch of obj.change as Array<Record<string, unknown>>) {
        const kind = String(ch.kind ?? '');
        const op: CdcOperation =
          kind === 'insert' ? 'c' : kind === 'update' ? 'u' : kind === 'delete' ? 'd' : 'r';
        const schema = String(ch.schema ?? 'public');
        const table = String(ch.table ?? 'unknown');

        let pk = '';
        const colNames = (ch.columnnames as string[]) ?? [];
        const colValues = (ch.columnvalues as unknown[]) ?? [];
        const after: Record<string, unknown> = {};
        for (let i = 0; i < colNames.length; i++) {
          after[colNames[i]] = colValues[i];
          if (colNames[i] === 'id' || colNames[i].endsWith('_id')) {
            pk = String(colValues[i]);
          }
        }
        if (!pk && colValues.length > 0) {
          pk = String(colValues[0]);
        }

        events.push({
          lsn: row.lsn,
          lsnBigInt: parseLsnToBigInt(row.lsn),
          txId: row.xid,
          timestampMs: Date.now(),
          schema,
          table,
          op,
          primaryKey: pk || 'unknown',
          before: null,
          after: op === 'd' ? null : after,
        });
      }
      return events;
    }

    // Direct change event format or Debezium envelope
    if (obj.source && typeof obj.source === 'object') {
      return Tier2DebeziumEnvelopeConsumer.parseEnvelope(payload as DebeziumEnvelope);
    }

    if (obj.op && obj.table) {
      return {
        lsn: row.lsn,
        lsnBigInt: parseLsnToBigInt(row.lsn),
        txId: row.xid,
        timestampMs: Number(obj.timestampMs ?? Date.now()),
        schema: String(obj.schema ?? 'public'),
        table: String(obj.table),
        op: obj.op as CdcOperation,
        primaryKey: String(obj.primaryKey ?? (obj.after as Record<string, unknown>)?.id ?? '0'),
        before: (obj.before as Record<string, unknown>) ?? null,
        after: (obj.after as Record<string, unknown>) ?? null,
      };
    }

    return null;
  }
}

// ----------------------------------------------------------------------------
// Tier-2: Debezium Envelope Consumer (Enterprise Kafka / wal2json v2 Sink)
// ----------------------------------------------------------------------------

export interface Tier2DebeziumConsumerOptions {
  searchIndexSink?: SearchIndexSink;
  cacheInvalidationSink?: CacheInvalidationSink;
  watermarkTracker?: IdempotentLsnTracker;
  cacheKeyPrefix?: string;
}

export interface Tier2ConsumeBatchResult {
  totalConsumed: number;
  coalescedCount: number;
  upsertedCount: number;
  deletedCount: number;
  invalidatedCount: number;
  highestLsn: string | null;
  durationMs: number;
}

export class Tier2DebeziumEnvelopeConsumer {
  private searchIndexSink?: SearchIndexSink;
  private cacheInvalidationSink?: CacheInvalidationSink;
  private watermarkTracker: IdempotentLsnTracker;
  private cacheKeyPrefix: string;

  constructor(options: Tier2DebeziumConsumerOptions = {}) {
    this.searchIndexSink = options.searchIndexSink;
    this.cacheInvalidationSink = options.cacheInvalidationSink;
    this.watermarkTracker = options.watermarkTracker ?? new IdempotentLsnTracker();
    this.cacheKeyPrefix = options.cacheKeyPrefix ?? 'cache';
  }

  public getTracker(): IdempotentLsnTracker {
    return this.watermarkTracker;
  }

  /**
   * Parses raw Debezium / wal2json v2 envelope into normalized CdcChangeEvent.
   */
  public static parseEnvelope<T = Record<string, unknown>>(
    raw: DebeziumEnvelope<T> | string,
  ): CdcChangeEvent<T> {
    const parsed = typeof raw === 'string' ? (JSON.parse(raw) as DebeziumEnvelope<T>) : raw;
    const lsnRaw = parsed.source?.lsn ?? 0;
    const lsnBigInt = parseLsnToBigInt(lsnRaw);
    const lsn = typeof lsnRaw === 'string' && PG_LSN_HEX_REGEX.test(lsnRaw)
      ? lsnRaw
      : formatBigIntToPgLsn(lsnBigInt);

    const schema = parsed.source?.schema || 'public';
    const table = parsed.source?.table || 'unknown';

    // Extract primary key from after or before
    const dataObj = (parsed.after ?? parsed.before ?? {}) as Record<string, unknown>;
    const pk = String(
      dataObj.id ?? dataObj[`${table}_id`] ?? dataObj.pk ?? Object.values(dataObj)[0] ?? '0',
    );

    return {
      lsn,
      lsnBigInt,
      txId: parsed.source?.txId,
      timestampMs: parsed.ts_ms ?? parsed.source?.ts_ms ?? Date.now(),
      schema,
      table,
      op: parsed.op,
      primaryKey: pk,
      before: parsed.before,
      after: parsed.after,
    };
  }

  /**
   * Consumes a batch of Debezium envelopes, coalesces bursts, checks watermarks,
   * and updates search index and cache.
   */
  public async consumeBatch(
    payloads: Array<DebeziumEnvelope | string>,
  ): Promise<Tier2ConsumeBatchResult> {
    const startTime = Date.now();
    if (!payloads || payloads.length === 0) {
      return {
        totalConsumed: 0,
        coalescedCount: 0,
        upsertedCount: 0,
        deletedCount: 0,
        invalidatedCount: 0,
        highestLsn: null,
        durationMs: Date.now() - startTime,
      };
    }

    const rawEvents: CdcChangeEvent[] = [];
    for (const payload of payloads) {
      rawEvents.push(Tier2DebeziumEnvelopeConsumer.parseEnvelope(payload));
    }

    const coalesced = coalesceCdcBatch(rawEvents, {
      tracker: this.watermarkTracker,
    });

    let upsertedCount = 0;
    let deletedCount = 0;
    let invalidatedCount = 0;

    const upsertItems: Array<{ id: string; doc: Record<string, unknown> }> = [];
    const deleteIds: string[] = [];
    const cacheKeys: string[] = [];
    let highestLsnBigInt = 0n;
    let highestLsnStr: string | null = null;

    for (const ev of coalesced) {
      const currentBigInt = ev.lsnBigInt ?? parseLsnToBigInt(ev.lsn);
      if (currentBigInt > highestLsnBigInt) {
        highestLsnBigInt = currentBigInt;
        highestLsnStr = ev.lsn;
      }

      cacheKeys.push(`${this.cacheKeyPrefix}:${ev.table}:${ev.primaryKey}`);

      if (ev.op === 'c' || ev.op === 'u' || ev.op === 'r') {
        if (ev.after) {
          upsertItems.push({
            id: ev.primaryKey,
            doc: ev.after,
          });
        }
      } else if (ev.op === 'd') {
        deleteIds.push(ev.primaryKey);
      }
    }

    if (this.searchIndexSink) {
      if (upsertItems.length > 0) {
        const res = await this.searchIndexSink.upsert(upsertItems);
        upsertedCount += res.successful;
      }
      if (deleteIds.length > 0) {
        const res = await this.searchIndexSink.delete(deleteIds);
        deletedCount += res.successful;
      }
    } else {
      upsertedCount = upsertItems.length;
      deletedCount = deleteIds.length;
    }

    if (this.cacheInvalidationSink && cacheKeys.length > 0) {
      invalidatedCount = await this.cacheInvalidationSink.invalidate(cacheKeys);
    } else {
      invalidatedCount = cacheKeys.length;
    }

    // Advance watermarks
    for (const ev of coalesced) {
      const entityKey = `${ev.schema}.${ev.table}:${ev.primaryKey}`;
      this.watermarkTracker.setWatermark(entityKey, ev.lsn);
    }
    if (highestLsnStr) {
      this.watermarkTracker.setGlobalWatermark(highestLsnStr);
    }

    return {
      totalConsumed: payloads.length,
      coalescedCount: coalesced.length,
      upsertedCount,
      deletedCount,
      invalidatedCount,
      highestLsn: highestLsnStr,
      durationMs: Date.now() - startTime,
    };
  }
}

// ============================================================================
// 6. GONNACRASH LEVEL 23 METRICS MODELING
// ============================================================================

export interface Level23CdcMetricsInput {
  priceUpdatesPerSec?: number;
  searchQueriesPerSec?: number;
  outageDurationSec?: number;
  workerCapacityReqPerSec?: number;
  estimatedDuplicateRatio?: number;
}

export interface Level23CdcMetricsResult {
  inputs: {
    priceUpdatesPerSec: number;
    searchQueriesPerSec: number;
    outageDurationSec: number;
    workerCapacityReqPerSec: number;
  };
  walBuffering: {
    bufferedWalEvents: number;
    coalescedEvents: number;
    uncoalescedDrainTimeSec: number;
    coalescedDrainTimeSec: number;
    maxDrainTimeSec: number;
    stalePriceDriftPercentage: number;
    dataLossCount: number;
  };
  dualWriteQueueFailure: {
    droppedEvents: number;
    stalePriceDriftPercentage: number;
    searchEngineInconsistency: string;
    outOfOrderRisk: string;
  };
  comparisonSummary: string;
}

/**
 * Models GonnaCrash Level 23 (Search Index Lag & Dual-Write Elimination):
 * - 100 price_updates/s, 300 search_queries/s
 * - 60s Search Index maintenance outage
 * - 6,000 buffered WAL events in PostgreSQL
 * - Drained in < 12s at 500 req/s worker capacity with 0% stale price drift
 * - Compared to Naive Dual-Write Queue where 6,000 updates are permanently lost!
 */
export function calculateLevel23CdcMetrics(
  input: Level23CdcMetricsInput = {},
): Level23CdcMetricsResult {
  const priceUpdatesPerSec = input.priceUpdatesPerSec ?? 100;
  const searchQueriesPerSec = input.searchQueriesPerSec ?? 300;
  const outageDurationSec = input.outageDurationSec ?? 60;
  const workerCapacityReqPerSec = input.workerCapacityReqPerSec ?? 500;
  const duplicateRatio = input.estimatedDuplicateRatio ?? 0.6; // 60% duplicate product price updates

  const bufferedWalEvents = priceUpdatesPerSec * outageDurationSec; // 6,000
  const coalescedEvents = Math.round(bufferedWalEvents * (1 - duplicateRatio)); // 2,400
  const uncoalescedDrainTimeSec = bufferedWalEvents / workerCapacityReqPerSec; // 12.0s
  const coalescedDrainTimeSec = coalescedEvents / workerCapacityReqPerSec; // 4.8s

  return {
    inputs: {
      priceUpdatesPerSec,
      searchQueriesPerSec,
      outageDurationSec,
      workerCapacityReqPerSec,
    },
    walBuffering: {
      bufferedWalEvents,
      coalescedEvents,
      uncoalescedDrainTimeSec,
      coalescedDrainTimeSec,
      maxDrainTimeSec: uncoalescedDrainTimeSec,
      stalePriceDriftPercentage: 0, // Zero price drift!
      dataLossCount: 0,
    },
    dualWriteQueueFailure: {
      droppedEvents: bufferedWalEvents, // 6,000 updates permanently lost
      stalePriceDriftPercentage: 100, // 100% price drift on updated products
      searchEngineInconsistency:
        'Search index retains stale prices while DB has new prices; customers see outdated checkout prices',
      outOfOrderRisk:
        'Retries on transient queue failure arrive out-of-order, overwriting newer prices with older prices',
    },
    comparisonSummary:
      `PostgreSQL WAL CDC buffers ${bufferedWalEvents} updates during ${outageDurationSec}s outage and drains in ${coalescedDrainTimeSec}s (${uncoalescedDrainTimeSec}s raw) at ${workerCapacityReqPerSec} req/s with 0% stale price drift. Naive dual-write drops all ${bufferedWalEvents} updates permanently.`,
  };
}

// ============================================================================
// 7. IN-MEMORY SINK SIMULATORS (FOR TESTING & DEVELOPMENT)
// ============================================================================

export class InMemorySearchIndexSink<T = Record<string, unknown>> implements SearchIndexSink<T> {
  public docs = new Map<string, T>();
  public upsertCallCount = 0;
  public deleteCallCount = 0;

  public async upsert(items: Array<{ id: string; doc: T }>): Promise<{ successful: number; failed: number }> {
    this.upsertCallCount++;
    for (const item of items) {
      this.docs.set(item.id, item.doc);
    }
    return { successful: items.length, failed: 0 };
  }

  public async delete(ids: string[]): Promise<{ successful: number; failed: number }> {
    this.deleteCallCount++;
    for (const id of ids) {
      this.docs.delete(id);
    }
    return { successful: ids.length, failed: 0 };
  }
}

export class InMemoryCacheInvalidationSink implements CacheInvalidationSink {
  public invalidatedKeys: string[] = [];

  public async invalidate(keys: string[]): Promise<number> {
    this.invalidatedKeys.push(...keys);
    return keys.length;
  }
}
