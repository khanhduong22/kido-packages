import assert from 'node:assert';
import test from 'node:test';
import {
  createNotificationScheduler,
  createValkeyZSetAdapter,
  HybridNotificationScheduler,
  InMemoryZSetStore,
  MAX_TIMEOUT_MS,
  ScheduledNotificationJob,
} from './index';

interface FakeTimerEntry {
  id: number;
  cb: () => void;
  delayMs: number;
  cleared: boolean;
}

function createFakeTimerHarness(initialNowMs = 1_700_000_000_000) {
  let nowMs = initialNowMs;
  let seq = 1;
  const timers = new Map<number, FakeTimerEntry>();

  const setTimeoutFn = (cb: () => void, ms: number) => {
    const id = seq++;
    timers.set(id, { id, cb, delayMs: ms, cleared: false });
    return id as unknown as ReturnType<typeof setTimeout>;
  };

  const clearTimeoutFn = (timerId: ReturnType<typeof setTimeout>) => {
    const numId = timerId as unknown as number;
    const entry = timers.get(numId);
    if (entry) {
      entry.cleared = true;
      timers.delete(numId);
    }
  };

  return {
    nowFn: () => nowMs,
    setNow: (nextNowMs: number) => {
      nowMs = nextNowMs;
    },
    advanceBy: (deltaMs: number) => {
      nowMs += deltaMs;
    },
    setTimeoutFn,
    clearTimeoutFn,
    getActiveTimers: () => Array.from(timers.values()).filter((t) => !t.cleared),
    triggerActiveTimer: () => {
      const active = Array.from(timers.values()).filter((t) => !t.cleared);
      for (const t of active) {
        timers.delete(t.id);
        t.cb();
      }
    },
  };
}

test('HybridNotificationScheduler: O(1) bucket insertion, deduplication, and cancellation', async () => {
  const harness = createFakeTimerHarness(1_000_000);
  const fired: ScheduledNotificationJob<{ title: string }>[] = [];

  const scheduler = createNotificationScheduler<{ title: string }>({
    bucketResolutionMs: 1_000,
    nowFn: harness.nowFn,
    setTimeoutFn: harness.setTimeoutFn,
    clearTimeoutFn: harness.clearTimeoutFn,
    onFire: (job) => {
      fired.push(job);
    },
  });

  assert.ok(scheduler instanceof HybridNotificationScheduler);
  assert.strictEqual(scheduler.getTelemetry().activeTimerArmed, false);
  assert.strictEqual(scheduler.getTelemetry().totalPendingJobs, 0);

  // 1. Insert first job at T + 10_000ms (bucket 1010)
  const res1 = await scheduler.schedule({
    id: 'shift-reminder-1',
    fireAtMs: 1_010_200,
    tenantId: 'store-1',
    userId: 'staff-1',
    payload: { title: 'Ca sáng bắt đầu sau 15 phút' },
  });

  assert.strictEqual(res1.scheduled, true);
  assert.strictEqual(res1.deduplicated, false);
  assert.strictEqual(res1.bucketKey, 1010);
  assert.strictEqual(scheduler.hasJob('shift-reminder-1'), true);
  assert.strictEqual(scheduler.getTelemetry().totalPendingJobs, 1);
  assert.strictEqual(scheduler.getTelemetry().totalBuckets, 1);
  assert.strictEqual(scheduler.getTelemetry().activeTimerArmed, true);
  assert.strictEqual(scheduler.getTelemetry().nextWakeupMs, 1_010_200);
  assert.strictEqual(harness.getActiveTimers().length, 1);

  // 2. Deduplicate/reschedule the SAME job ID to a later bucket T + 25_000ms (bucket 1025)
  const res2 = await scheduler.schedule({
    id: 'shift-reminder-1',
    fireAtMs: 1_025_500,
    tenantId: 'store-1',
    userId: 'staff-1',
    payload: { title: 'Ca sáng dời lịch sau 30 phút' },
  });

  assert.strictEqual(res2.deduplicated, true);
  assert.strictEqual(res2.bucketKey, 1025);
  assert.strictEqual(scheduler.getTelemetry().totalPendingJobs, 1);
  assert.strictEqual(scheduler.getTelemetry().totalBuckets, 1);
  assert.strictEqual(scheduler.getTelemetry().nextWakeupMs, 1_025_500);
  assert.strictEqual(
    scheduler.getJob('shift-reminder-1')?.payload.title,
    'Ca sáng dời lịch sau 30 phút'
  );
  // Still only 1 active setTimeout handle
  assert.strictEqual(harness.getActiveTimers().length, 1);

  // 3. Cancel the job in O(1)
  const cancelled = await scheduler.cancel('shift-reminder-1');
  assert.strictEqual(cancelled, true);
  assert.strictEqual(scheduler.hasJob('shift-reminder-1'), false);
  assert.strictEqual(scheduler.getTelemetry().totalPendingJobs, 0);
  assert.strictEqual(scheduler.getTelemetry().totalBuckets, 0);
  assert.strictEqual(scheduler.getTelemetry().activeTimerArmed, false);
  assert.strictEqual(scheduler.getTelemetry().nextWakeupAt, null);
  assert.strictEqual(scheduler.getTelemetry().cancelledCount, 1);
  assert.strictEqual(harness.getActiveTimers().length, 0);

  // Cancelling non-existent job returns false
  assert.strictEqual(await scheduler.cancel('non-existent'), false);
  assert.strictEqual(fired.length, 0);
});

test('HybridNotificationScheduler: Single setTimeout re-arms ONLY when an earlier job arrives', async () => {
  const harness = createFakeTimerHarness(5_000_000);
  const firedIds: string[] = [];

  const scheduler = createNotificationScheduler({
    bucketResolutionMs: 1_000,
    nowFn: harness.nowFn,
    setTimeoutFn: harness.setTimeoutFn,
    clearTimeoutFn: harness.clearTimeoutFn,
    onFire: (job) => {
      firedIds.push(job.id);
    },
  });

  // Schedule job A at +30s
  await scheduler.schedule({
    id: 'job-30s',
    fireAtMs: 5_030_000,
    payload: { msg: '30s' },
  });

  assert.strictEqual(scheduler.getTelemetry().timerReArmCount, 1);
  assert.strictEqual(scheduler.getTelemetry().nextWakeupMs, 5_030_000);
  assert.strictEqual(scheduler.getTelemetry().lastScheduledDelayMs, 30_000);
  assert.strictEqual(harness.getActiveTimers().length, 1);

  // Schedule job B at +60s (LATER than 30s) -> MUST NOT re-arm or create a second timer!
  await scheduler.schedule({
    id: 'job-60s',
    fireAtMs: 5_060_000,
    payload: { msg: '60s' },
  });

  assert.strictEqual(scheduler.getTelemetry().timerReArmCount, 1);
  assert.strictEqual(scheduler.getTelemetry().nextWakeupMs, 5_030_000);
  assert.strictEqual(harness.getActiveTimers().length, 1);

  // Schedule job C at +10s (EARLIER than 30s) -> MUST clear old timer and re-arm for +10s!
  await scheduler.schedule({
    id: 'job-10s',
    fireAtMs: 5_010_000,
    payload: { msg: '10s' },
  });

  assert.strictEqual(scheduler.getTelemetry().timerReArmCount, 2);
  assert.strictEqual(scheduler.getTelemetry().nextWakeupMs, 5_010_000);
  assert.strictEqual(scheduler.getTelemetry().lastScheduledDelayMs, 10_000);
  assert.strictEqual(harness.getActiveTimers().length, 1);

  // Advance clock to +10s and flush due jobs -> fires job-10s and automatically chains timer to job-30s
  harness.setNow(5_010_000);
  const batch1 = await scheduler.flushDueJobs();
  assert.deepStrictEqual(
    batch1.map((j) => j.id),
    ['job-10s']
  );
  assert.deepStrictEqual(firedIds, ['job-10s']);
  assert.strictEqual(scheduler.getTelemetry().nextWakeupMs, 5_030_000);
  assert.strictEqual(scheduler.getTelemetry().lastScheduledDelayMs, 20_000);
  assert.strictEqual(harness.getActiveTimers().length, 1);
});

test('HybridNotificationScheduler: Batch firing of multiple jobs in the same time bucket', async () => {
  const harness = createFakeTimerHarness(10_000_000);
  const individualFired: string[] = [];
  const batchHistory: string[][] = [];

  const scheduler = createNotificationScheduler<{ index: number }>({
    bucketResolutionMs: 1_000, // 1-second buckets
    nowFn: harness.nowFn,
    setTimeoutFn: harness.setTimeoutFn,
    clearTimeoutFn: harness.clearTimeoutFn,
    onFire: (job) => {
      individualFired.push(job.id);
    },
    onBatchFire: (jobs) => {
      batchHistory.push(jobs.map((j) => j.id));
    },
  });

  // Schedule 4 jobs falling inside the same 1-second bucket [10_005_000, 10_005_999]
  // and 1 job in a later bucket [10_008_000]
  await scheduler.scheduleBatch([
    { id: 'staff-c', fireAtMs: 10_005_800, payload: { index: 3 } },
    { id: 'staff-a', fireAtMs: 10_005_100, payload: { index: 1 } },
    { id: 'staff-b', fireAtMs: 10_005_400, payload: { index: 2 } },
    { id: 'staff-d', fireAtMs: 10_005_950, payload: { index: 4 } },
    { id: 'staff-later', fireAtMs: 10_008_000, payload: { index: 5 } },
  ]);

  // Verify 4 jobs are grouped into bucket 10005, and 1 job in bucket 10008 (total 2 buckets)
  const telemetryBefore = scheduler.getTelemetry();
  assert.strictEqual(telemetryBefore.totalPendingJobs, 5);
  assert.strictEqual(telemetryBefore.totalBuckets, 2);
  assert.strictEqual(telemetryBefore.nextWakeupMs, 10_005_100);
  assert.strictEqual(harness.getActiveTimers().length, 1);

  // Advance clock to end of bucket 10005 (10_005_999) and flush
  harness.setNow(10_005_999);
  const firedBatch = await scheduler.flushDueJobs();

  assert.strictEqual(firedBatch.length, 4);
  assert.deepStrictEqual(individualFired, ['staff-a', 'staff-b', 'staff-c', 'staff-d']);
  assert.deepStrictEqual(batchHistory, [['staff-a', 'staff-b', 'staff-c', 'staff-d']]);

  // Only 'staff-later' remains, and the single timer is re-armed for 10_008_000
  const telemetryAfter = scheduler.getTelemetry();
  assert.strictEqual(telemetryAfter.totalPendingJobs, 1);
  assert.strictEqual(telemetryAfter.totalBuckets, 1);
  assert.strictEqual(telemetryAfter.firedCount, 4);
  assert.strictEqual(telemetryAfter.nextWakeupMs, 10_008_000);
});

test('HybridNotificationScheduler: Valkey/Redis ZSET atomic zrem claim prevents duplicate execution across 2 concurrent workers', async () => {
  const harness = createFakeTimerHarness(20_000_000);
  const sharedValkeyZSet = new InMemoryZSetStore();
  const zsetAdapter = createValkeyZSetAdapter(sharedValkeyZSet);

  const workerAFired: string[] = [];
  const workerBFired: string[] = [];

  const workerA = createNotificationScheduler<{ shiftId: string }>({
    bucketResolutionMs: 1_000,
    zsetStore: zsetAdapter,
    nowFn: harness.nowFn,
    setTimeoutFn: harness.setTimeoutFn,
    clearTimeoutFn: harness.clearTimeoutFn,
    onFire: async (job) => {
      workerAFired.push(job.id);
    },
  });

  const workerB = createNotificationScheduler<{ shiftId: string }>({
    bucketResolutionMs: 1_000,
    zsetStore: zsetAdapter,
    nowFn: harness.nowFn,
    setTimeoutFn: harness.setTimeoutFn,
    clearTimeoutFn: harness.clearTimeoutFn,
    onFire: async (job) => {
      workerBFired.push(job.id);
    },
  });

  // Schedule 3 notifications on Worker A (persisted into shared Valkey ZSET)
  await workerA.scheduleBatch([
    { id: 'checkin-remind-1', fireAtMs: 20_005_000, payload: { shiftId: 'S1' } },
    { id: 'checkin-remind-2', fireAtMs: 20_005_200, payload: { shiftId: 'S2' } },
    { id: 'checkin-remind-3', fireAtMs: 20_005_500, payload: { shiftId: 'S3' } },
  ]);

  assert.strictEqual(sharedValkeyZSet.size(), 3);

  // Worker B hydrates from shared Valkey ZSET (simulating multi-replica startup)
  const hydratedCount = await workerB.hydrateFromZSet();
  assert.strictEqual(hydratedCount, 3);
  assert.strictEqual(workerB.getTelemetry().totalPendingJobs, 3);

  // Advance clock to 20_006_000 and trigger BOTH Worker A and Worker B concurrently!
  harness.setNow(20_006_000);
  await Promise.all([workerA.flushDueJobs(), workerB.flushDueJobs()]);

  // Total notifications fired across BOTH workers combined MUST equal 3 (zero duplicates!)
  const combinedFired = [...workerAFired, ...workerBFired].sort();
  assert.deepStrictEqual(combinedFired, [
    'checkin-remind-1',
    'checkin-remind-2',
    'checkin-remind-3',
  ]);
  assert.strictEqual(workerAFired.length + workerBFired.length, 3);

  // Verify telemetry reflects claimed vs skippedByClaim counts across the 2 workers
  const telA = workerA.getTelemetry();
  const telB = workerB.getTelemetry();
  assert.strictEqual(telA.claimedCount + telB.claimedCount, 3);
  assert.strictEqual(telA.skippedByClaimCount + telB.skippedByClaimCount, 3);
  assert.strictEqual(sharedValkeyZSet.size(), 0);
});

test('HybridNotificationScheduler: 32-bit MAX_TIMEOUT_MS overflow protection (> 24.8 days)', async () => {
  const initialNow = 100_000_000;
  const harness = createFakeTimerHarness(initialNow);
  const fired: string[] = [];

  const scheduler = createNotificationScheduler({
    bucketResolutionMs: 60_000, // 1-minute buckets
    nowFn: harness.nowFn,
    setTimeoutFn: harness.setTimeoutFn,
    clearTimeoutFn: harness.clearTimeoutFn,
    onFire: (job) => {
      fired.push(job.id);
    },
  });

  // Schedule a notification 30 days in the future (> 24.85 days MAX_TIMEOUT_MS)
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1_000; // 2,592,000,000 ms (> 2,147,483,647 ms)
  const targetFireAtMs = initialNow + thirtyDaysMs;

  await scheduler.schedule({
    id: 'monthly-payroll-reminder',
    fireAtMs: targetFireAtMs,
    payload: { type: 'PAYROLL_CLOSE' },
  });

  const telemetry1 = scheduler.getTelemetry();
  assert.strictEqual(telemetry1.activeTimerArmed, true);
  assert.strictEqual(telemetry1.nextWakeupMs, targetFireAtMs);
  // Delay MUST be clamped to MAX_TIMEOUT_MS (2_147_483_647) to prevent 32-bit signed int overflow
  assert.strictEqual(telemetry1.lastScheduledDelayMs, MAX_TIMEOUT_MS);

  const activeTimers1 = harness.getActiveTimers();
  assert.strictEqual(activeTimers1.length, 1);
  assert.strictEqual(activeTimers1[0].delayMs, MAX_TIMEOUT_MS);

  // Simulate the first MAX_TIMEOUT_MS wakeup (~24.85 days later): job is NOT due yet!
  harness.setNow(initialNow + MAX_TIMEOUT_MS);
  const dueAtOverflowCheckpoint = await scheduler.flushDueJobs();
  assert.strictEqual(dueAtOverflowCheckpoint.length, 0);
  assert.strictEqual(fired.length, 0);

  // Scheduler automatically re-arms the single timer for the remaining ~5.15 days (444,516,353 ms)
  const remainingDelayMs = thirtyDaysMs - MAX_TIMEOUT_MS;
  const telemetry2 = scheduler.getTelemetry();
  assert.strictEqual(telemetry2.activeTimerArmed, true);
  assert.strictEqual(telemetry2.lastScheduledDelayMs, remainingDelayMs);

  // Advance the remaining 5.15 days -> job fires!
  harness.setNow(targetFireAtMs);
  const dueAtTarget = await scheduler.flushDueJobs();
  assert.strictEqual(dueAtTarget.length, 1);
  assert.deepStrictEqual(fired, ['monthly-payroll-reminder']);
  assert.strictEqual(scheduler.getTelemetry().activeTimerArmed, false);
});
