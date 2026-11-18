/**
 * @kido/async-sync — PostgreSQL CDC Stream & Debezium Sink Test Suite
 *
 * Verifies:
 * 1. Types & Envelopes (CdcOperation, CdcChangeEvent, DebeziumEnvelope)
 * 2. LSN Math & Idempotent Watermark Tracker (parseLsnToBigInt, formatBigIntToPgLsn, IdempotentLsnTracker)
 * 3. LSN Coalescer & Net State Transitions (coalesceCdcBatch: INSERT+UPDATE, INSERT+DELETE, UPDATE+DELETE)
 * 4. PostgreSQL WAL Disk-Full Circuit Breaker & Safe SQL Builders
 * 5. Tier-0 Trigger + pg_notify Outbox CDC Generator
 * 6. Tier-1 Native WAL Slot Poller (Two-Phase Peek-then-Ack loop)
 * 7. Tier-2 Debezium Envelope Consumer
 * 8. GonnaCrash Level 23 CDC Metrics Modeling
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CdcChangeEventSchema,
  CdcOperationSchema,
  DebeziumEnvelopeSchema,
  IdempotentLsnTracker,
  InMemoryCacheInvalidationSink,
  InMemorySearchIndexSink,
  Tier0TriggerNotifyOutboxCdc,
  Tier1NativeWalSlotPoller,
  Tier2DebeziumEnvelopeConsumer,
  buildConfirmLogicalSlotFlushSql,
  buildCreateLogicalSlotSql,
  buildDropReplicationSlotSql,
  buildPeekLogicalSlotChangesSql,
  calculateLevel23CdcMetrics,
  coalesceCdcBatch,
  evaluateCdcSlotDiskSafety,
  formatBigIntToPgLsn,
  parseLsnToBigInt,
  type CdcChangeEvent,
  type DebeziumEnvelope,
} from './index';

describe('@kido/async-sync — pg-cdc-stream (3-Tier PostgreSQL CDC Stream & Debezium Sink)', () => {
  describe('1. Types & Schemas Validation', () => {
    it('validates standard CDC operations (c, u, d, r)', () => {
      assert.equal(CdcOperationSchema.parse('c'), 'c');
      assert.equal(CdcOperationSchema.parse('u'), 'u');
      assert.equal(CdcOperationSchema.parse('d'), 'd');
      assert.equal(CdcOperationSchema.parse('r'), 'r');
      assert.throws(() => CdcOperationSchema.parse('x'));
    });

    it('validates CdcChangeEventSchema and DebeziumEnvelopeSchema', () => {
      const validEvent: CdcChangeEvent = {
        lsn: '0/16B3748',
        timestampMs: 1731300000000,
        schema: 'public',
        table: 'products',
        op: 'u',
        primaryKey: '101',
        before: { id: 101, price: 50 },
        after: { id: 101, price: 65 },
      };
      assert.doesNotThrow(() => CdcChangeEventSchema.parse(validEvent));

      const validDebezium: DebeziumEnvelope = {
        before: { id: 101, price: 50 },
        after: { id: 101, price: 65 },
        op: 'u',
        ts_ms: 1731300000000,
        source: {
          connector: 'postgresql',
          name: 'pg-prod',
          ts_ms: 1731300000000,
          db: 'store_db',
          schema: 'public',
          table: 'products',
          lsn: '0/16B3748',
        },
      };
      assert.doesNotThrow(() => DebeziumEnvelopeSchema.parse(validDebezium));
    });
  });

  describe('2. LSN Math & Idempotent Watermark Tracker', () => {
    it('parseLsnToBigInt & formatBigIntToPgLsn handles hex, bigint, decimal, and numbers', () => {
      assert.equal(parseLsnToBigInt(0n), 0n);
      assert.equal(parseLsnToBigInt('0/0'), 0n);
      assert.equal(parseLsnToBigInt('0/16B3748'), 0x16b3748n);
      assert.equal(parseLsnToBigInt('1/00000000'), 0x100000000n);
      assert.equal(parseLsnToBigInt(23803720), 23803720n);
      assert.equal(parseLsnToBigInt('23803720'), 23803720n);

      assert.equal(formatBigIntToPgLsn(0n), '0/00000000');
      assert.equal(formatBigIntToPgLsn(0x16b3748n), '0/016B3748');
      assert.equal(formatBigIntToPgLsn(0x100000000n), '1/00000000');

      assert.throws(() => parseLsnToBigInt(''));
      assert.throws(() => parseLsnToBigInt('invalid_lsn'));
      assert.throws(() => formatBigIntToPgLsn(-1n));
    });

    it('IdempotentLsnTracker: records watermarks and detects stale replayed WAL events', () => {
      const tracker = new IdempotentLsnTracker();
      const entityKey = 'public.products:101';

      assert.equal(tracker.isStale(entityKey, '0/1000'), false);
      tracker.setWatermark(entityKey, '0/2000');
      assert.equal(tracker.getWatermark(entityKey), parseLsnToBigInt('0/2000'));

      // Older or equal events are stale
      assert.equal(tracker.isStale(entityKey, '0/1000'), true);
      assert.equal(tracker.isStale(entityKey, '0/2000'), true);
      // Newer events are not stale
      assert.equal(tracker.isStale(entityKey, '0/2001'), false);

      // Global watermark test
      tracker.setGlobalWatermark('0/1500');
      assert.equal(tracker.isStale('public.orders:999', '0/1400'), true);
      assert.equal(tracker.isStale('public.orders:999', '0/1600'), false);

      // Snapshot round-trip
      const snap = tracker.toSnapshot();
      assert.ok(snap[entityKey]);
      const restored = new IdempotentLsnTracker(snap);
      assert.equal(restored.isStale(entityKey, '0/2000'), true);
      assert.equal(restored.isStale(entityKey, '0/2001'), false);
    });
  });

  describe('3. LSN Coalescer & Net State Transitions (coalesceCdcBatch)', () => {
    it('coalesces rapid price updates into a single event with the highest LSN', () => {
      const events: CdcChangeEvent[] = [
        {
          lsn: '0/1000',
          timestampMs: 1000,
          schema: 'public',
          table: 'products',
          op: 'u',
          primaryKey: '101',
          before: { price: 50 },
          after: { price: 52 },
        },
        {
          lsn: '0/1050',
          timestampMs: 1050,
          schema: 'public',
          table: 'products',
          op: 'u',
          primaryKey: '101',
          before: { price: 52 },
          after: { price: 55 },
        },
        {
          lsn: '0/1100',
          timestampMs: 1100,
          schema: 'public',
          table: 'products',
          op: 'u',
          primaryKey: '101',
          before: { price: 55 },
          after: { price: 60 },
        },
      ];

      const coalesced = coalesceCdcBatch(events);
      assert.equal(coalesced.length, 1);
      assert.equal(coalesced[0].primaryKey, '101');
      assert.equal(coalesced[0].op, 'u');
      assert.equal(coalesced[0].lsn, '0/1100');
      assert.deepEqual(coalesced[0].before, { price: 50 });
      assert.deepEqual(coalesced[0].after, { price: 60 });
    });

    it('net transition: INSERT followed by UPDATE results in INSERT with latest after payload', () => {
      const events: CdcChangeEvent[] = [
        {
          lsn: '0/2000',
          timestampMs: 2000,
          schema: 'public',
          table: 'products',
          op: 'c',
          primaryKey: '202',
          before: null,
          after: { id: 202, title: 'Item 202', price: 100 },
        },
        {
          lsn: '0/2050',
          timestampMs: 2050,
          schema: 'public',
          table: 'products',
          op: 'u',
          primaryKey: '202',
          before: { id: 202, title: 'Item 202', price: 100 },
          after: { id: 202, title: 'Item 202 Refurbished', price: 90 },
        },
      ];

      const coalesced = coalesceCdcBatch(events);
      assert.equal(coalesced.length, 1);
      assert.equal(coalesced[0].op, 'c'); // Preserved as INSERT!
      assert.equal(coalesced[0].lsn, '0/2050');
      assert.deepEqual(coalesced[0].after, { id: 202, title: 'Item 202 Refurbished', price: 90 });
    });

    it('net transition: INSERT followed by DELETE within same batch is treated as net no-op', () => {
      const events: CdcChangeEvent[] = [
        {
          lsn: '0/3000',
          timestampMs: 3000,
          schema: 'public',
          table: 'products',
          op: 'c',
          primaryKey: '303',
          before: null,
          after: { id: 303, title: 'Temp' },
        },
        {
          lsn: '0/3050',
          timestampMs: 3050,
          schema: 'public',
          table: 'products',
          op: 'd',
          primaryKey: '303',
          before: { id: 303, title: 'Temp' },
          after: null,
        },
      ];

      // Default: dropped as net no-op
      const noOpResult = coalesceCdcBatch(events);
      assert.equal(noOpResult.length, 0);

      // With emitDeletedForNetNoOp = true
      const deleteResult = coalesceCdcBatch(events, { emitDeletedForNetNoOp: true });
      assert.equal(deleteResult.length, 1);
      assert.equal(deleteResult[0].op, 'd');
      assert.equal(deleteResult[0].lsn, '0/3050');
    });

    it('net transition: UPDATE followed by DELETE results in DELETE', () => {
      const events: CdcChangeEvent[] = [
        {
          lsn: '0/4000',
          timestampMs: 4000,
          schema: 'public',
          table: 'products',
          op: 'u',
          primaryKey: '404',
          before: { id: 404, price: 100 },
          after: { id: 404, price: 110 },
        },
        {
          lsn: '0/4050',
          timestampMs: 4050,
          schema: 'public',
          table: 'products',
          op: 'd',
          primaryKey: '404',
          before: { id: 404, price: 110 },
          after: null,
        },
      ];

      const coalesced = coalesceCdcBatch(events);
      assert.equal(coalesced.length, 1);
      assert.equal(coalesced[0].op, 'd');
      assert.equal(coalesced[0].lsn, '0/4050');
      assert.equal(coalesced[0].after, null);
    });

    it('filters out stale events below watermark or lastAppliedLsn', () => {
      const tracker = new IdempotentLsnTracker();
      tracker.setWatermark('public.products:101', '0/5000');

      const events: CdcChangeEvent[] = [
        {
          lsn: '0/4900', // Stale
          timestampMs: 4900,
          schema: 'public',
          table: 'products',
          op: 'u',
          primaryKey: '101',
          after: { price: 40 },
        },
        {
          lsn: '0/5100', // Fresh
          timestampMs: 5100,
          schema: 'public',
          table: 'products',
          op: 'u',
          primaryKey: '101',
          after: { price: 55 },
        },
      ];

      const dropped: CdcChangeEvent[] = [];
      const coalesced = coalesceCdcBatch(events, {
        tracker,
        onDropStaleEvent: (ev) => dropped.push(ev),
      });

      assert.equal(dropped.length, 1);
      assert.equal(dropped[0].lsn, '0/4900');
      assert.equal(coalesced.length, 1);
      assert.equal(coalesced[0].lsn, '0/5100');
      assert.deepEqual(coalesced[0].after, { price: 55 });
    });
  });

  describe('4. PostgreSQL WAL Disk-Full Circuit Breaker & Safe SQL Builders', () => {
    it('evaluateCdcSlotDiskSafety: detects healthy state when retained WAL is low', () => {
      const report = evaluateCdcSlotDiskSafety({
        currentWalLsn: '0/2000000', // ~33 MB
        restartLsn: '0/1000000', // ~16 MB
        availableDiskBytes: 50 * 1024 * 1024 * 1024, // 50 GB free
        slotName: 'search_cdc_slot',
      });

      assert.equal(report.status, 'healthy');
      assert.equal(report.shouldDropSlotToSaveDatabase, false);
      assert.equal(report.remediationSql, null);
      assert.ok(report.retainedWalBytes > 0);
    });

    it('evaluateCdcSlotDiskSafety: warns when usage ratio crosses 70% threshold', () => {
      const report = evaluateCdcSlotDiskSafety({
        currentWalLsn: '0/40000000', // ~1 GB
        restartLsn: '0/0',
        availableDiskBytes: 300 * 1024 * 1024, // 300 MB free (1GB / (1GB + 300MB) = ~77%)
        warningThresholdRatio: 0.7,
        criticalThresholdRatio: 0.85,
        slotName: 'search_cdc_slot',
      });

      assert.equal(report.status, 'warning');
      assert.equal(report.shouldDropSlotToSaveDatabase, false);
      assert.equal(report.remediationSql, null);
      assert.ok(report.issues.length > 0);
    });

    it('evaluateCdcSlotDiskSafety: trips breaker and generates DROP slot SQL on critical threshold', () => {
      const report = evaluateCdcSlotDiskSafety({
        currentWalLsn: '0/80000000', // ~2 GB
        restartLsn: '0/0',
        availableDiskBytes: 100 * 1024 * 1024, // 100 MB free (2GB / 2.1GB = ~95%)
        warningThresholdRatio: 0.7,
        criticalThresholdRatio: 0.85,
        slotName: 'search_cdc_slot',
      });

      assert.equal(report.status, 'critical_trip_breaker');
      assert.equal(report.shouldDropSlotToSaveDatabase, true);
      assert.equal(report.remediationSql, `SELECT pg_drop_replication_slot('search_cdc_slot');`);
      assert.ok(report.issues.some((i) => i.includes('exceeds critical threshold')));
    });

    it('evaluateCdcSlotDiskSafety: trips breaker when maxRetainedWalBytes ceiling is breached', () => {
      const report = evaluateCdcSlotDiskSafety({
        currentWalLsn: '10/00000000', // ~68 GB
        restartLsn: '0/0',
        availableDiskBytes: 500 * 1024 * 1024 * 1024, // Plenty of disk, but WAL is huge
        maxRetainedWalBytes: 50 * 1024 * 1024 * 1024, // 50 GB ceiling
        slotName: 'search_cdc_slot',
      });

      assert.equal(report.status, 'critical_trip_breaker');
      assert.equal(report.shouldDropSlotToSaveDatabase, true);
      assert.equal(report.remediationSql, `SELECT pg_drop_replication_slot('search_cdc_slot');`);
    });

    it('safe SQL builders generate valid SQL and prevent SQL injection', () => {
      assert.equal(
        buildCreateLogicalSlotSql('search_slot', 'wal2json'),
        `SELECT pg_create_logical_replication_slot('search_slot', 'wal2json');`,
      );
      assert.equal(
        buildPeekLogicalSlotChangesSql('search_slot', 250),
        `SELECT lsn, xid, data FROM pg_logical_slot_peek_changes('search_slot', NULL, 250);`,
      );
      assert.equal(
        buildConfirmLogicalSlotFlushSql('search_slot', '0/16B3748'),
        `SELECT lsn, xid, data FROM pg_logical_slot_get_changes('search_slot', '0/16B3748', NULL);`,
      );
      assert.equal(
        buildDropReplicationSlotSql('search_slot'),
        `SELECT pg_drop_replication_slot('search_slot');`,
      );

      // Injection rejection
      assert.throws(() => buildCreateLogicalSlotSql('slot; DROP TABLE users;--'));
      assert.throws(() => buildConfirmLogicalSlotFlushSql('slot', '0/1; DROP TABLE users;--'));
    });
  });

  describe('5. 3-Tier Progressive CDC Engine: Tier-0 Trigger + NOTIFY + Outbox', () => {
    it('Tier0TriggerNotifyOutboxCdc: generates DDL, catch-up query, and parses outbox rows', () => {
      const ddl = Tier0TriggerNotifyOutboxCdc.buildTriggerNotifyDdl({
        targetTable: 'products',
        primaryKeyCol: 'id',
      });

      assert.ok(ddl.includes('CREATE TABLE IF NOT EXISTS public.cdc_outbox'));
      assert.ok(ddl.includes('PERFORM pg_notify'));
      assert.ok(ddl.includes('CREATE TRIGGER trg_products_cdc_outbox'));

      const catchUpSql = Tier0TriggerNotifyOutboxCdc.buildCatchUpQuerySql();
      assert.ok(catchUpSql.includes('WHERE seq_id > $1 ORDER BY seq_id ASC LIMIT $2'));

      const row = {
        seq_id: 1234,
        schema_name: 'public',
        table_name: 'products',
        op: 'u',
        pk: '101',
        tx_id: 9999,
        before_payload: { price: 50 },
        after_payload: { price: 75 },
        created_at: new Date('2026-11-11T00:00:00Z'),
      };
      const parsed = Tier0TriggerNotifyOutboxCdc.parseOutboxRowToEvent(row);
      assert.equal(parsed.op, 'u');
      assert.equal(parsed.primaryKey, '101');
      assert.equal(parsed.txId, 9999);
      assert.deepEqual(parsed.after, { price: 75 });
    });
  });

  describe('6. 3-Tier Progressive CDC Engine: Tier-1 Native WAL Slot Poller (Two-Phase Peek-then-Ack)', () => {
    it('executes Two-Phase Peek-then-Ack loop, coalesces batch, updates sink, and confirms flush LSN', async () => {
      const searchSink = new InMemorySearchIndexSink();
      const cacheSink = new InMemoryCacheInvalidationSink();
      const executedSqls: string[] = [];

      // Mock database executor returning wal2json v1 change array
      const mockSqlExecutor = {
        async queryRaw<R>(sql: string): Promise<R[]> {
          executedSqls.push(sql);
          if (sql.includes('pg_logical_slot_peek_changes')) {
            return [
              {
                lsn: '0/1000',
                xid: 101,
                data: JSON.stringify({
                  change: [
                    {
                      kind: 'update',
                      schema: 'public',
                      table: 'products',
                      columnnames: ['id', 'price'],
                      columnvalues: [101, 55],
                    },
                  ],
                }),
              },
              {
                lsn: '0/1050',
                xid: 102,
                data: JSON.stringify({
                  change: [
                    {
                      kind: 'update',
                      schema: 'public',
                      table: 'products',
                      columnnames: ['id', 'price'],
                      columnvalues: [101, 60],
                    },
                  ],
                }),
              },
              {
                lsn: '0/1100',
                xid: 103,
                data: JSON.stringify({
                  change: [
                    {
                      kind: 'insert',
                      schema: 'public',
                      table: 'products',
                      columnnames: ['id', 'price'],
                      columnvalues: [202, 100],
                    },
                  ],
                }),
              },
            ] as unknown as R[];
          }
          if (sql.includes('pg_logical_slot_get_changes')) {
            return [] as unknown as R[];
          }
          return [] as unknown as R[];
        },
      };

      const poller = new Tier1NativeWalSlotPoller({
        slotName: 'products_cdc_slot',
        sqlExecutor: mockSqlExecutor,
        searchIndexSink: searchSink,
        cacheInvalidationSink: cacheSink,
      });

      const res = await poller.pollAndDispatch();

      assert.equal(res.peekedCount, 3);
      assert.equal(res.coalescedCount, 2); // product 101 coalesced into 1, product 202 is 1
      assert.equal(res.upsertedCount, 2);
      assert.equal(res.flushedLsn, '0/1100');

      // Verify search index received latest coalesced price
      assert.deepEqual(searchSink.docs.get('101'), { id: 101, price: 60 });
      assert.deepEqual(searchSink.docs.get('202'), { id: 202, price: 100 });

      // Verify cache invalidation keys were generated
      assert.ok(cacheSink.invalidatedKeys.includes('cache:products:101'));
      assert.ok(cacheSink.invalidatedKeys.includes('cache:products:202'));

      // Verify Two-Phase Peek-then-Ack SQL sequence: peek first, get_changes (flush) after
      assert.ok(executedSqls[0].includes('pg_logical_slot_peek_changes'));
      assert.ok(executedSqls[1].includes('pg_logical_slot_get_changes'));
      assert.ok(executedSqls[1].includes(`'0/1100'`));

      // Second poll with same LSNs should be recognized as stale by tracker
      const tracker = poller.getTracker();
      assert.equal(tracker.isStale('public.products:101', '0/1050'), true);
      assert.equal(tracker.isStale('public.products:101', '0/1200'), false);
    });
  });

  describe('7. 3-Tier Progressive CDC Engine: Tier-2 Debezium Envelope Consumer', () => {
    it('consumes Debezium batch, coalesces bursts, updates sinks, and sets high-watermarks', async () => {
      const searchSink = new InMemorySearchIndexSink();
      const cacheSink = new InMemoryCacheInvalidationSink();

      const consumer = new Tier2DebeziumEnvelopeConsumer({
        searchIndexSink: searchSink,
        cacheInvalidationSink: cacheSink,
      });

      const debeziumBatch: DebeziumEnvelope[] = [
        {
          before: { id: 501, price: 10 },
          after: { id: 501, price: 12 },
          op: 'u',
          ts_ms: 1000,
          source: {
            connector: 'postgresql',
            name: 'main-db',
            ts_ms: 1000,
            db: 'store',
            schema: 'public',
            table: 'products',
            lsn: '0/2000',
          },
        },
        {
          before: { id: 501, price: 12 },
          after: { id: 501, price: 15 },
          op: 'u',
          ts_ms: 1050,
          source: {
            connector: 'postgresql',
            name: 'main-db',
            ts_ms: 1050,
            db: 'store',
            schema: 'public',
            table: 'products',
            lsn: '0/2050',
          },
        },
        {
          before: { id: 502, price: 99 },
          after: null,
          op: 'd',
          ts_ms: 1100,
          source: {
            connector: 'postgresql',
            name: 'main-db',
            ts_ms: 1100,
            db: 'store',
            schema: 'public',
            table: 'products',
            lsn: '0/2100',
          },
        },
      ];

      const res = await consumer.consumeBatch(debeziumBatch);

      assert.equal(res.totalConsumed, 3);
      assert.equal(res.coalescedCount, 2);
      assert.equal(res.upsertedCount, 1);
      assert.equal(res.deletedCount, 1);
      assert.equal(res.highestLsn, '0/2100');

      assert.deepEqual(searchSink.docs.get('501'), { id: 501, price: 15 });
      assert.equal(searchSink.docs.has('502'), false);

      const tracker = consumer.getTracker();
      assert.equal(tracker.isStale('public.products:501', '0/2050'), true);
      assert.equal(tracker.isStale('public.products:501', '0/2150'), false);
    });
  });

  describe('8. GonnaCrash Level 23 CDC Metrics Modeling', () => {
    it('calculateLevel23CdcMetrics: accurately models 60s Search Index lag and dual-write failure', () => {
      const metrics = calculateLevel23CdcMetrics({
        priceUpdatesPerSec: 100,
        searchQueriesPerSec: 300,
        outageDurationSec: 60,
        workerCapacityReqPerSec: 500,
        estimatedDuplicateRatio: 0.6,
      });

      // 100 updates/s * 60s = 6,000 buffered events
      assert.equal(metrics.walBuffering.bufferedWalEvents, 6_000);
      // Coalesced events (40% unique): 2,400
      assert.equal(metrics.walBuffering.coalescedEvents, 2_400);
      // Uncoalesced drain time: 6,000 / 500 = 12.0s
      assert.equal(metrics.walBuffering.uncoalescedDrainTimeSec, 12.0);
      // Coalesced drain time: 2,400 / 500 = 4.8s (< 12s)
      assert.equal(metrics.walBuffering.coalescedDrainTimeSec, 4.8);
      assert.ok(metrics.walBuffering.coalescedDrainTimeSec < 12.0);

      // 0% stale price drift with CDC WAL
      assert.equal(metrics.walBuffering.stalePriceDriftPercentage, 0);
      assert.equal(metrics.walBuffering.dataLossCount, 0);

      // Contrast with Dual-Write Queue failure:
      assert.equal(metrics.dualWriteQueueFailure.droppedEvents, 6_000);
      assert.equal(metrics.dualWriteQueueFailure.stalePriceDriftPercentage, 100);
      assert.ok(metrics.comparisonSummary.includes('drains in 4.8s'));
      assert.ok(metrics.comparisonSummary.includes('0% stale price drift'));
    });
  });
});
