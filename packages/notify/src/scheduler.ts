/**
 * @kido/notify — Hybrid Timing Wheel + Valkey/Redis ZSET + Single Next-Wakeup setTimeout Worker
 *
 * Big-Tech 3-Layer Notification Scheduler Architecture:
 * - Level 3 (Memory Index): O(1) Hierarchical Timing Wheel Buckets (`Map<bucketSlot, Map<jobId, Job>>`)
 *   + O(1) secondary index (`jobIdToBucket`) for instant deduplication, rescheduling, and cancellation.
 * - Level 2 (Persistence & Distributed Lock-Free Claim): Optional Valkey/Redis `ZSET` adapter (`ZADD`,
 *   `ZRANGEBYSCORE`, atomic `ZREM` claim) ensuring crash durability and 100% zero duplicate sends across
 *   multiple container replicas.
 * - Level 1 (Zero-Idle-CPU Execution Engine): Maintains EXACTLY ONE `setTimeout` handle (`activeTimer`)
 *   across the entire process. Never ticks on empty slots ("Zero Empty Tick" jump) and clamps delays to
 *   `MAX_TIMEOUT_MS` (2,147,483,647 ms ≈ 24.85 days) to prevent 32-bit signed integer overflow.
 */

/**
 * Maximum safe 32-bit signed integer delay for Node.js / Bun / Browser `setTimeout` (2^31 - 1 ms ≈ 24.85 days).
 * Passing any value larger than this to native `setTimeout` causes immediate 1ms overflow execution.
 */
export const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * Default Timing Wheel bucket resolution (1,000 ms = 1 second).
 */
export const DEFAULT_BUCKET_RESOLUTION_MS = 1_000;

/**
 * Default Valkey / Redis Sorted Set key for persisted scheduled notifications.
 */
export const DEFAULT_ZSET_KEY = 'kt:notify:scheduled:zset';

/**
 * Represents a scheduled notification task in the Hybrid Timing Wheel.
 */
export interface ScheduledNotificationJob<TPayload = unknown> {
  /** Unique deterministic job identifier (e.g. `shift-reminder:shift_123:user_456`) */
  id: string;
  /** Unix epoch timestamp in milliseconds when the notification must fire */
  fireAtMs: number;
  /** Optional tenant / store identifier for multi-tenant isolation */
  tenantId?: string;
  /** Optional target user / staff identifier */
  userId?: string;
  /** Notification channel payload (WebPush, Telegram, SMS, Webhook, etc.) */
  payload: TPayload;
  /** Optional arbitrary metadata for audit / tracing */
  metadata?: Record<string, unknown>;
}

/**
 * Minimal Valkey / Redis Sorted Set (`ZSET`) adapter interface.
 * Compatible with `ioredis`, `valkey`, `node-redis` wrappers, or `InMemoryZSetStore`.
 */
export interface ZSetStoreAdapter {
  zadd(key: string, score: number, member: string): Promise<unknown>;
  zrangebyscore(key: string, min: number | string, max: number | string): Promise<string[]>;
  zrem(key: string, ...members: string[]): Promise<number>;
  zrangeWithScores?(
    key: string,
    start: number,
    stop: number
  ): Promise<Array<{ member: string; score: number }>>;
}

/**
 * Real-time observability telemetry snapshot for the Hybrid Notification Scheduler.
 */
export interface NotificationSchedulerTelemetry {
  activeTimerArmed: boolean;
  nextWakeupAt: string | null;
  nextWakeupMs: number | null;
  lastScheduledDelayMs: number | null;
  timerReArmCount: number;
  totalPendingJobs: number;
  totalBuckets: number;
  firedCount: number;
  claimedCount: number;
  skippedByClaimCount: number;
  cancelledCount: number;
  mode: 'HYBRID_TIMING_WHEEL_ZSET_SINGLE_TIMER';
}

/**
 * Result returned when scheduling a single notification job.
 */
export interface ScheduleJobResult {
  scheduled: boolean;
  deduplicated: boolean;
  bucketKey: number;
  nextWakeupMs: number | null;
}

/**
 * Configuration options for `HybridNotificationScheduler`.
 */
export interface HybridNotificationSchedulerOptions<TPayload = unknown> {
  /**
   * Time-bucket slot resolution in milliseconds (default: `1000` ms = 1s).
   * Jobs falling within the same `[bucketKey * resolution, (bucketKey + 1) * resolution)` window
   * are grouped into the same O(1) bucket slot for batch wakeup processing.
   */
  bucketResolutionMs?: number;
  /**
   * Optional Valkey / Redis ZSET store for crash persistence and multi-replica atomic `ZREM` claiming.
   */
  zsetStore?: ZSetStoreAdapter;
  /**
   * Valkey / Redis key used to store scheduled jobs in ZSET (default: `'kt:notify:scheduled:zset'`).
   */
  zsetKey?: string;
  /**
   * Handler invoked for each claimed due job when its bucket fires.
   */
  onFire: (job: ScheduledNotificationJob<TPayload>) => Promise<void> | void;
  /**
   * Optional batch handler invoked with all claimed jobs that fired in the same wakeup tick.
   */
  onBatchFire?: (jobs: ScheduledNotificationJob<TPayload>[]) => Promise<void> | void;
  /**
   * Optional error callback invoked if `onFire`, `onBatchFire`, or `zsetStore` throws.
   */
  onError?: (error: unknown, job?: ScheduledNotificationJob<TPayload>) => void;
  /**
   * Custom clock function returning current epoch milliseconds (default: `() => Date.now()`).
   */
  nowFn?: () => number;
  /**
   * Custom `setTimeout` implementation for deterministic testing.
   */
  setTimeoutFn?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  /**
   * Custom `clearTimeout` implementation for deterministic testing.
   */
  clearTimeoutFn?: (timerId: ReturnType<typeof setTimeout>) => void;
  /**
   * Whether to call `.unref()` on the underlying Node/Bun timer handle so an idle process can exit cleanly (default: `true`).
   */
  autoUnref?: boolean;
}

/**
 * Deterministically serializes a `ScheduledNotificationJob` into canonical JSON
 * so two replicas scheduling the identical logical job produce the exact same ZSET member string.
 */
export function serializeScheduledJob<TPayload>(job: ScheduledNotificationJob<TPayload>): string {
  return JSON.stringify({
    id: job.id,
    fireAtMs: job.fireAtMs,
    tenantId: job.tenantId ?? undefined,
    userId: job.userId ?? undefined,
    payload: job.payload,
    metadata: job.metadata ?? undefined,
  });
}

/**
 * Safely parses a serialized `ScheduledNotificationJob` from a ZSET member string.
 */
export function deserializeScheduledJob<TPayload = unknown>(
  member: string
): ScheduledNotificationJob<TPayload> | null {
  try {
    const parsed = JSON.parse(member) as ScheduledNotificationJob<TPayload>;
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.id === 'string' &&
      typeof parsed.fireAtMs === 'number'
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * In-memory implementation of `ZSetStoreAdapter` for local fallback and multi-worker atomic `zrem` simulation.
 */
export class InMemoryZSetStore implements ZSetStoreAdapter {
  private readonly store = new Map<string, Map<string, number>>();

  async zadd(key: string, score: number, member: string): Promise<number> {
    let zset = this.store.get(key);
    if (!zset) {
      zset = new Map<string, number>();
      this.store.set(key, zset);
    }
    const isNew = !zset.has(member) ? 1 : 0;
    zset.set(member, score);
    return isNew;
  }

  async zrangebyscore(
    key: string,
    min: number | string,
    max: number | string
  ): Promise<string[]> {
    const zset = this.store.get(key);
    if (!zset || zset.size === 0) return [];

    const minVal =
      min === '-inf' ? Number.NEGATIVE_INFINITY : Number(String(min).replace(/^\(/, ''));
    const maxVal =
      max === '+inf' || max === 'inf'
        ? Number.POSITIVE_INFINITY
        : Number(String(max).replace(/^\(/, ''));

    const matched: Array<{ member: string; score: number }> = [];
    for (const [member, score] of zset.entries()) {
      if (score >= minVal && score <= maxVal) {
        matched.push({ member, score });
      }
    }

    matched.sort((a, b) => a.score - b.score || a.member.localeCompare(b.member));
    return matched.map((item) => item.member);
  }

  async zrem(key: string, ...members: string[]): Promise<number> {
    const zset = this.store.get(key);
    if (!zset || zset.size === 0) return 0;

    let removed = 0;
    for (const member of members) {
      if (zset.delete(member)) {
        removed += 1;
      }
    }
    if (zset.size === 0) {
      this.store.delete(key);
    }
    return removed;
  }

  async zrangeWithScores(
    key: string,
    start: number,
    stop: number
  ): Promise<Array<{ member: string; score: number }>> {
    const zset = this.store.get(key);
    if (!zset || zset.size === 0) return [];

    const entries = Array.from(zset.entries()).map(([member, score]) => ({ member, score }));
    entries.sort((a, b) => a.score - b.score || a.member.localeCompare(b.member));

    const len = entries.length;
    const normStart = start < 0 ? Math.max(0, len + start) : start;
    const normStop = stop < 0 ? len + stop : stop;
    return entries.slice(normStart, normStop + 1);
  }

  /**
   * Returns current member count for a key (for diagnostics/testing).
   */
  size(key: string = DEFAULT_ZSET_KEY): number {
    return this.store.get(key)?.size ?? 0;
  }
}

/**
 * Helper to wrap an `ioredis` / `valkey` client instance into a `ZSetStoreAdapter`.
 */
export function createValkeyZSetAdapter(redisClient: {
  zadd(key: string, score: number | string, member: string): Promise<unknown>;
  zrangebyscore(key: string, min: number | string, max: number | string): Promise<string[]>;
  zrem(key: string, ...members: string[]): Promise<number>;
}): ZSetStoreAdapter {
  return {
    zadd: (key, score, member) => redisClient.zadd(key, score, member),
    zrangebyscore: (key, min, max) => redisClient.zrangebyscore(key, min, max),
    zrem: (key, ...members) => redisClient.zrem(key, ...members),
  };
}

/**
 * Production-grade **Hybrid Timing Wheel + Valkey ZSET + Single Next-Wakeup `setTimeout`** Notification Worker.
 */
export class HybridNotificationScheduler<TPayload = unknown> {
  private readonly bucketResolutionMs: number;
  private readonly zsetStore?: ZSetStoreAdapter;
  private readonly zsetKey: string;
  private readonly onFire: (job: ScheduledNotificationJob<TPayload>) => Promise<void> | void;
  private readonly onBatchFire?: (
    jobs: ScheduledNotificationJob<TPayload>[]
  ) => Promise<void> | void;
  private readonly onError?: (error: unknown, job?: ScheduledNotificationJob<TPayload>) => void;
  private readonly nowFn: () => number;
  private readonly setTimeoutFn: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimeoutFn: (timerId: ReturnType<typeof setTimeout>) => void;
  private readonly autoUnref: boolean;

  /**
   * Level 3: Hierarchical Timing Wheel Buckets
   * Maps `bucketKey = Math.floor(fireAtMs / bucketResolutionMs)` -> `Map<jobId, ScheduledNotificationJob>`
   */
  private readonly buckets = new Map<number, Map<string, ScheduledNotificationJob<TPayload>>>();

  /**
   * O(1) secondary index mapping `jobId` -> `bucketKey` for instant cancellation and deduplication.
   */
  private readonly jobIdToBucket = new Map<string, number>();

  /**
   * O(1) secondary index mapping `jobId` -> serialized ZSET member string.
   */
  private readonly jobIdToMember = new Map<string, string>();

  /**
   * Level 1: Single Next-Wakeup `setTimeout` handle (`activeTimer`).
   * At most ONE timer exists across the entire process at any point in time.
   */
  private activeTimer: ReturnType<typeof setTimeout> | null = null;
  private currentNextWakeupMs: number | null = null;
  private lastScheduledDelayMs: number | null = null;
  private stopped = false;

  // Telemetry counters
  private timerReArmCount = 0;
  private firedCount = 0;
  private claimedCount = 0;
  private skippedByClaimCount = 0;
  private cancelledCount = 0;

  constructor(options: HybridNotificationSchedulerOptions<TPayload>) {
    this.bucketResolutionMs = Math.max(1, options.bucketResolutionMs ?? DEFAULT_BUCKET_RESOLUTION_MS);
    this.zsetStore = options.zsetStore;
    this.zsetKey = options.zsetKey ?? DEFAULT_ZSET_KEY;
    this.onFire = options.onFire;
    this.onBatchFire = options.onBatchFire;
    this.onError = options.onError;
    this.nowFn = options.nowFn ?? (() => Date.now());
    this.setTimeoutFn = options.setTimeoutFn ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimeoutFn = options.clearTimeoutFn ?? ((id) => clearTimeout(id));
    this.autoUnref = options.autoUnref ?? true;
  }

  /**
   * Computes the O(1) Timing Wheel bucket slot key for a given epoch timestamp in milliseconds.
   */
  public getBucketKey(fireAtMs: number): number {
    return Math.floor(fireAtMs / this.bucketResolutionMs);
  }

  /**
   * Schedules or updates (deduplicates) a notification job in O(1) time.
   * - Inserts into the Timing Wheel bucket slot in O(1).
   * - Persists to Valkey/Redis `ZSET` if `zsetStore` is configured.
   * - Only re-arms the single `setTimeout` if this job's `fireAtMs` is earlier than `currentNextWakeupMs`
   *   (or if the previous earliest job was rescheduled).
   */
  public async schedule(job: ScheduledNotificationJob<TPayload>): Promise<ScheduleJobResult> {
    if (!job || !job.id || typeof job.fireAtMs !== 'number' || Number.isNaN(job.fireAtMs)) {
      throw new Error('Invalid ScheduledNotificationJob: id and valid numeric fireAtMs are required');
    }

    this.stopped = false;

    const existingBucketKey = this.jobIdToBucket.get(job.id);
    const existingMember = this.jobIdToMember.get(job.id);
    let deduplicated = false;
    let wasEarliestModified = false;

    if (existingBucketKey !== undefined) {
      deduplicated = true;
      const oldBucket = this.buckets.get(existingBucketKey);
      const oldJob = oldBucket?.get(job.id);
      if (oldJob && this.currentNextWakeupMs !== null && oldJob.fireAtMs <= this.currentNextWakeupMs) {
        wasEarliestModified = true;
      }
      if (oldBucket) {
        oldBucket.delete(job.id);
        if (oldBucket.size === 0) {
          this.buckets.delete(existingBucketKey);
        }
      }
      this.jobIdToBucket.delete(job.id);
      this.jobIdToMember.delete(job.id);
    }

    const bucketKey = this.getBucketKey(job.fireAtMs);
    let bucket = this.buckets.get(bucketKey);
    if (!bucket) {
      bucket = new Map<string, ScheduledNotificationJob<TPayload>>();
      this.buckets.set(bucketKey, bucket);
    }

    const serializedMember = serializeScheduledJob(job);
    bucket.set(job.id, job);
    this.jobIdToBucket.set(job.id, bucketKey);
    this.jobIdToMember.set(job.id, serializedMember);

    if (this.zsetStore) {
      try {
        if (existingMember && existingMember !== serializedMember) {
          await this.zsetStore.zrem(this.zsetKey, existingMember);
        }
        await this.zsetStore.zadd(this.zsetKey, job.fireAtMs, serializedMember);
      } catch (err) {
        this.onError?.(err, job);
      }
    }

    // Level 1: Single Next-Wakeup Timer Management
    if (wasEarliestModified) {
      this.recomputeAndArmNextTimer();
    } else if (this.currentNextWakeupMs === null || job.fireAtMs < this.currentNextWakeupMs) {
      this.armSingleTimer(job.fireAtMs);
    }

    return {
      scheduled: true,
      deduplicated,
      bucketKey,
      nextWakeupMs: this.currentNextWakeupMs,
    };
  }

  /**
   * Schedules a batch of jobs and arms the single `setTimeout` only once for the earliest job.
   */
  public async scheduleBatch(
    jobs: ScheduledNotificationJob<TPayload>[]
  ): Promise<{ scheduledCount: number; deduplicatedCount: number; nextWakeupMs: number | null }> {
    this.stopped = false;
    let scheduledCount = 0;
    let deduplicatedCount = 0;

    for (const job of jobs) {
      if (!job || !job.id || typeof job.fireAtMs !== 'number' || Number.isNaN(job.fireAtMs)) {
        continue;
      }

      const existingBucketKey = this.jobIdToBucket.get(job.id);
      const existingMember = this.jobIdToMember.get(job.id);

      if (existingBucketKey !== undefined) {
        deduplicatedCount += 1;
        const oldBucket = this.buckets.get(existingBucketKey);
        if (oldBucket) {
          oldBucket.delete(job.id);
          if (oldBucket.size === 0) {
            this.buckets.delete(existingBucketKey);
          }
        }
      }

      const bucketKey = this.getBucketKey(job.fireAtMs);
      let bucket = this.buckets.get(bucketKey);
      if (!bucket) {
        bucket = new Map<string, ScheduledNotificationJob<TPayload>>();
        this.buckets.set(bucketKey, bucket);
      }

      const serializedMember = serializeScheduledJob(job);
      bucket.set(job.id, job);
      this.jobIdToBucket.set(job.id, bucketKey);
      this.jobIdToMember.set(job.id, serializedMember);
      scheduledCount += 1;

      if (this.zsetStore) {
        try {
          if (existingMember && existingMember !== serializedMember) {
            await this.zsetStore.zrem(this.zsetKey, existingMember);
          }
          await this.zsetStore.zadd(this.zsetKey, job.fireAtMs, serializedMember);
        } catch (err) {
          this.onError?.(err, job);
        }
      }
    }

    this.recomputeAndArmNextTimer();

    return {
      scheduledCount,
      deduplicatedCount,
      nextWakeupMs: this.currentNextWakeupMs,
    };
  }

  /**
   * Cancels a scheduled job by ID in O(1) time via `jobIdToBucket` secondary index.
   * Also removes the job from Valkey/Redis `ZSET` if configured.
   */
  public async cancel(jobId: string): Promise<boolean> {
    const bucketKey = this.jobIdToBucket.get(jobId);
    const member = this.jobIdToMember.get(jobId);

    if (bucketKey === undefined) {
      if (this.zsetStore && member) {
        await this.zsetStore.zrem(this.zsetKey, member);
      }
      return false;
    }

    const bucket = this.buckets.get(bucketKey);
    const removedJob = bucket?.get(jobId);
    if (bucket) {
      bucket.delete(jobId);
      if (bucket.size === 0) {
        this.buckets.delete(bucketKey);
      }
    }

    this.jobIdToBucket.delete(jobId);
    this.jobIdToMember.delete(jobId);
    this.cancelledCount += 1;

    if (this.zsetStore && member) {
      try {
        await this.zsetStore.zrem(this.zsetKey, member);
      } catch (err) {
        this.onError?.(err, removedJob);
      }
    }

    // If the cancelled job was the earliest wakeup target (or no jobs remain), recompute the single timer
    if (
      this.jobIdToBucket.size === 0 ||
      (removedJob &&
        this.currentNextWakeupMs !== null &&
        removedJob.fireAtMs <= this.currentNextWakeupMs)
    ) {
      this.recomputeAndArmNextTimer();
    }

    return true;
  }

  /**
   * O(1) lookup of a pending job by ID.
   */
  public getJob(jobId: string): ScheduledNotificationJob<TPayload> | undefined {
    const bucketKey = this.jobIdToBucket.get(jobId);
    if (bucketKey === undefined) return undefined;
    return this.buckets.get(bucketKey)?.get(jobId);
  }

  /**
   * O(1) check whether a job ID is currently pending in the Timing Wheel.
   */
  public hasJob(jobId: string): boolean {
    return this.jobIdToBucket.has(jobId);
  }

  /**
   * Hydrates pending jobs from Valkey/Redis `ZSET` into the local Timing Wheel (e.g., on container startup)
   * and arms the single next-wakeup `setTimeout`.
   */
  public async hydrateFromZSet(): Promise<number> {
    if (!this.zsetStore) return 0;

    const members = await this.zsetStore.zrangebyscore(this.zsetKey, '-inf', '+inf');
    let hydratedCount = 0;

    for (const member of members) {
      const job = deserializeScheduledJob<TPayload>(member);
      if (!job) continue;

      const existingBucketKey = this.jobIdToBucket.get(job.id);
      if (existingBucketKey !== undefined) {
        const oldBucket = this.buckets.get(existingBucketKey);
        oldBucket?.delete(job.id);
        if (oldBucket && oldBucket.size === 0) {
          this.buckets.delete(existingBucketKey);
        }
      }

      const bucketKey = this.getBucketKey(job.fireAtMs);
      let bucket = this.buckets.get(bucketKey);
      if (!bucket) {
        bucket = new Map<string, ScheduledNotificationJob<TPayload>>();
        this.buckets.set(bucketKey, bucket);
      }

      bucket.set(job.id, job);
      this.jobIdToBucket.set(job.id, bucketKey);
      this.jobIdToMember.set(job.id, member);
      hydratedCount += 1;
    }

    this.recomputeAndArmNextTimer();
    return hydratedCount;
  }

  /**
   * Flushes and fires all due jobs with `fireAtMs <= nowMs`.
   *
   * Multi-Replica Atomic Claim Guarantee:
   * When `zsetStore` is configured, each due job is claimed via `zsetStore.zrem(zsetKey, member)`.
   * Because Valkey/Redis `ZREM` is atomic, if N container replicas wake up at the exact same millisecond,
   * ONLY the replica receiving `zrem > 0` dispatches `onFire(job)`. All other replicas receive `0` and
   * skip firing (`skippedByClaimCount++`), guaranteeing 100% zero duplicate notifications.
   */
  public async flushDueJobs(
    nowOverrideMs?: number
  ): Promise<ScheduledNotificationJob<TPayload>[]> {
    const nowMs = nowOverrideMs ?? this.nowFn();
    const maxDueBucketKey = this.getBucketKey(nowMs);

    // Collect candidate due jobs from local Timing Wheel buckets
    const candidateMap = new Map<
      string,
      { job: ScheduledNotificationJob<TPayload>; member: string }
    >();

    for (const [bucketKey, bucket] of this.buckets.entries()) {
      if (bucketKey <= maxDueBucketKey) {
        for (const [jobId, job] of bucket.entries()) {
          if (job.fireAtMs <= nowMs) {
            const member = this.jobIdToMember.get(jobId) ?? serializeScheduledJob(job);
            candidateMap.set(jobId, { job, member });
          }
        }
      }
    }

    // Also pull any due jobs directly from Valkey/Redis ZSET (supports cross-replica job discovery)
    if (this.zsetStore) {
      try {
        const remoteDueMembers = await this.zsetStore.zrangebyscore(this.zsetKey, '-inf', nowMs);
        for (const member of remoteDueMembers) {
          const parsedJob = deserializeScheduledJob<TPayload>(member);
          if (parsedJob && parsedJob.fireAtMs <= nowMs && !candidateMap.has(parsedJob.id)) {
            candidateMap.set(parsedJob.id, { job: parsedJob, member });
          }
        }
      } catch (err) {
        this.onError?.(err);
      }
    }

    // Sort due candidates deterministically by fireAtMs, then id
    const dueEntries = Array.from(candidateMap.values()).sort(
      (a, b) => a.job.fireAtMs - b.job.fireAtMs || a.job.id.localeCompare(b.job.id)
    );

    const firedJobs: ScheduledNotificationJob<TPayload>[] = [];

    for (const { job, member } of dueEntries) {
      // Remove from local Timing Wheel bucket & secondary indexes
      const bKey = this.jobIdToBucket.get(job.id) ?? this.getBucketKey(job.fireAtMs);
      const bucket = this.buckets.get(bKey);
      if (bucket) {
        bucket.delete(job.id);
        if (bucket.size === 0) {
          this.buckets.delete(bKey);
        }
      }
      this.jobIdToBucket.delete(job.id);
      this.jobIdToMember.delete(job.id);

      // Level 2: Distributed Atomic ZREM Claim
      if (this.zsetStore) {
        let claimed = 0;
        try {
          claimed = await this.zsetStore.zrem(this.zsetKey, member);
        } catch (err) {
          this.onError?.(err, job);
          continue;
        }

        if (claimed <= 0) {
          // Another replica already claimed and fired this job
          this.skippedByClaimCount += 1;
          continue;
        }
        this.claimedCount += 1;
      } else {
        this.claimedCount += 1;
      }

      // Dispatch notification
      try {
        await this.onFire(job);
        this.firedCount += 1;
        firedJobs.push(job);
      } catch (err) {
        this.onError?.(err, job);
      }
    }

    if (firedJobs.length > 0 && this.onBatchFire) {
      try {
        await this.onBatchFire(firedJobs);
      } catch (err) {
        this.onError?.(err);
      }
    }

    // Re-arm the single next-wakeup timer for remaining jobs in the Timing Wheel
    if (!this.stopped) {
      this.recomputeAndArmNextTimer(nowMs);
    }

    return firedJobs;
  }

  /**
   * Returns a live telemetry snapshot of the Hybrid Notification Scheduler.
   */
  public getTelemetry(): NotificationSchedulerTelemetry {
    return {
      activeTimerArmed: this.activeTimer !== null,
      nextWakeupAt:
        this.currentNextWakeupMs !== null ? new Date(this.currentNextWakeupMs).toISOString() : null,
      nextWakeupMs: this.currentNextWakeupMs,
      lastScheduledDelayMs: this.lastScheduledDelayMs,
      timerReArmCount: this.timerReArmCount,
      totalPendingJobs: this.jobIdToBucket.size,
      totalBuckets: this.buckets.size,
      firedCount: this.firedCount,
      claimedCount: this.claimedCount,
      skippedByClaimCount: this.skippedByClaimCount,
      cancelledCount: this.cancelledCount,
      mode: 'HYBRID_TIMING_WHEEL_ZSET_SINGLE_TIMER',
    };
  }

  /**
   * Stops the active `setTimeout` handle without discarding in-memory jobs.
   */
  public stop(): void {
    this.stopped = true;
    this.clearActiveTimer();
  }

  /**
   * Clears all in-memory buckets, indexes, and disarms the single timer.
   */
  public async clear(): Promise<void> {
    this.stop();
    this.buckets.clear();
    this.jobIdToBucket.clear();
    this.jobIdToMember.clear();
    this.lastScheduledDelayMs = null;
  }

  /**
   * Finds the earliest `fireAtMs` across all non-empty Timing Wheel buckets and arms the single timer.
   */
  private recomputeAndArmNextTimer(referenceNowMs?: number): void {
    this.clearActiveTimer();

    if (this.buckets.size === 0 || this.jobIdToBucket.size === 0) {
      this.lastScheduledDelayMs = null;
      return;
    }

    // Find the minimum bucketKey first, then find the minimum fireAtMs inside that earliest bucket!
    let minBucketKey = Number.POSITIVE_INFINITY;
    for (const [bucketKey, bucket] of this.buckets.entries()) {
      if (bucket.size === 0) {
        this.buckets.delete(bucketKey);
        continue;
      }
      if (bucketKey < minBucketKey) {
        minBucketKey = bucketKey;
      }
    }

    if (!Number.isFinite(minBucketKey)) {
      this.lastScheduledDelayMs = null;
      return;
    }

    const earliestBucket = this.buckets.get(minBucketKey);
    if (!earliestBucket || earliestBucket.size === 0) {
      this.lastScheduledDelayMs = null;
      return;
    }

    let earliestFireAtMs = Number.POSITIVE_INFINITY;
    for (const job of earliestBucket.values()) {
      if (job.fireAtMs < earliestFireAtMs) {
        earliestFireAtMs = job.fireAtMs;
      }
    }

    if (Number.isFinite(earliestFireAtMs)) {
      this.armSingleTimer(earliestFireAtMs, referenceNowMs);
    }
  }

  /**
   * Arms the SINGLE `setTimeout` for `targetWakeupMs`, clamping delay to `[0, MAX_TIMEOUT_MS]`.
   */
  private armSingleTimer(targetWakeupMs: number, referenceNowMs?: number): void {
    if (this.stopped) return;

    this.clearActiveTimer();

    const nowMs = referenceNowMs ?? this.nowFn();
    const rawDelayMs = targetWakeupMs - nowMs;
    const clampedDelayMs = Math.min(MAX_TIMEOUT_MS, Math.max(0, rawDelayMs));

    this.currentNextWakeupMs = targetWakeupMs;
    this.lastScheduledDelayMs = clampedDelayMs;
    this.timerReArmCount += 1;

    const timer = this.setTimeoutFn(() => {
      this.activeTimer = null;
      this.currentNextWakeupMs = null;
      void this.flushDueJobs();
    }, clampedDelayMs);

    if (this.autoUnref && timer && typeof (timer as NodeJS.Timeout).unref === 'function') {
      (timer as NodeJS.Timeout).unref();
    }

    this.activeTimer = timer;
  }

  private clearActiveTimer(): void {
    if (this.activeTimer !== null) {
      this.clearTimeoutFn(this.activeTimer);
      this.activeTimer = null;
    }
    this.currentNextWakeupMs = null;
  }
}

/**
 * Factory function to instantiate a `HybridNotificationScheduler`.
 */
export function createNotificationScheduler<TPayload = unknown>(
  options: HybridNotificationSchedulerOptions<TPayload>
): HybridNotificationScheduler<TPayload> {
  return new HybridNotificationScheduler<TPayload>(options);
}
