/**
 * @file youtube-view-engine.ts
 * @description YouTube Hybrid View Count Engine, Datastore Adaptive Slot Sizer & HyperLogLog
 *
 * Màn 24 (GonnaCrash): counter_at_scale (Viral video, choked counter)
 * 1. Google Cloud Datastore Adaptive Slot Sizer (`calculateOptimalSlotCount` & `evaluateSlotCandidate`):
 *    Solves the exact trade-off between Write Row-Lock Contention (writes/slot <= maxWritesPerRow)
 *    and Read SUM() Amplification (writeRate + N * readRate <= maxDbCapacity).
 *    Mathematically proves why Split 4 (1,100 req/s) succeeds while Split 16 (2,300 req/s) crashes Tier L DB!
 *
 * 2. Self-Contained HyperLogLog Counter (`HyperLogLogCounter`):
 *    Zero-dependency HyperLogLog with p in [4, 14] (default p=10 -> 1,024 registers, 1 KB RAM),
 *    bias-corrected harmonic mean and small-range linear counting correction using murmurhash3_32.
 *
 * 3. YouTube Hybrid View Count Engine (`YouTubeHybridViewEngine`):
 *    Combines InMemorySlottedCounter (100% exact Total Views) with HyperLogLogCounter
 *    (Unique Viewers & Anti-F5 Spam Auditing). Implements YouTube's famous 301-views viral freeze:
 *    below threshold (default 300) or when spamRatio <= 10, views increment public counters.
 *    Rejects synthetic F5 bot inflation and freezes verified views at the cap.
 */

import { murmurhash3_32, getSlotId, InMemorySlottedCounter } from "./slotted-counter";

// ============================================================================
// 1. Google Cloud Datastore Adaptive Slot Sizer
// ============================================================================

export interface AdaptiveSlotSizerInput {
  /** Write operations per second on the counter (e.g., video views) */
  writeRatePerS: number;
  /** Read operations per second on the aggregate counter (e.g., dashboard opens) */
  readRatePerS: number;
  /** Max commits/updates a single database row can sustain per second (default: 200) */
  maxWritesPerRowPerS?: number;
  /** Total operations per second the database tier can sustain (default: 1,500 for Tier L) */
  maxDbCapacityPerS?: number;
  /** Candidate slot counts to evaluate (default: [1, 4, 8, 16, 32, 64]) */
  candidateSlots?: ReadonlyArray<number>;
}

export type SlotCandidateStatus =
  | "optimal"
  | "viable"
  | "row_lock_bottleneck"
  | "read_amplification_overload";

export interface SlotCandidateEvaluation {
  slots: number;
  writesPerSlotPerS: number;
  readOpsPerS: number;
  totalDbOpsPerS: number;
  rowLockSafe: boolean;
  dbCapacitySafe: boolean;
  status: SlotCandidateStatus;
}

export interface AdaptiveSlotSizerResult {
  minSlotsToAvoidRowLock: number;
  maxSlotsWithinDbCapacity: number;
  recommendedSlots: number | null;
  evaluations: SlotCandidateEvaluation[];
}

export interface SlotCandidateInput {
  slots: number;
  writeRatePerS: number;
  readRatePerS: number;
  maxWritesPerRowPerS?: number;
  maxDbCapacityPerS?: number;
  isOptimal?: boolean;
}

/**
 * Evaluates a single slot candidate against row-lock contention and database capacity bounds.
 */
export function evaluateSlotCandidate(
  input: SlotCandidateInput
): SlotCandidateEvaluation;
export function evaluateSlotCandidate(
  slots: number,
  writeRatePerS: number,
  readRatePerS: number,
  maxWritesPerRowPerS?: number,
  maxDbCapacityPerS?: number,
  isOptimal?: boolean
): SlotCandidateEvaluation;
export function evaluateSlotCandidate(
  slotsOrInput: number | SlotCandidateInput,
  writeRatePerS?: number,
  readRatePerS?: number,
  maxWritesPerRowPerS: number = 200,
  maxDbCapacityPerS: number = 1500,
  isOptimal: boolean = false
): SlotCandidateEvaluation {
  let slots: number;
  let writes: number;
  let reads: number;
  let maxWritesPerRow: number;
  let maxDbCap: number;
  let optimal: boolean;

  if (typeof slotsOrInput === "object" && slotsOrInput !== null) {
    slots = slotsOrInput.slots;
    writes = slotsOrInput.writeRatePerS;
    reads = slotsOrInput.readRatePerS;
    maxWritesPerRow = slotsOrInput.maxWritesPerRowPerS ?? 200;
    maxDbCap = slotsOrInput.maxDbCapacityPerS ?? 1500;
    optimal = slotsOrInput.isOptimal ?? false;
  } else {
    slots = slotsOrInput;
    writes = writeRatePerS ?? 0;
    reads = readRatePerS ?? 0;
    maxWritesPerRow = maxWritesPerRowPerS ?? 200;
    maxDbCap = maxDbCapacityPerS ?? 1500;
    optimal = isOptimal ?? false;
  }

  if (slots <= 0) {
    throw new Error(`Slot count must be positive, received: ${slots}`);
  }

  const writesPerSlotPerS = Number((writes / slots).toFixed(2));
  const readOpsPerS = reads * slots;
  const totalDbOpsPerS = writes + readOpsPerS;

  const rowLockSafe = writesPerSlotPerS <= maxWritesPerRow;
  const dbCapacitySafe = totalDbOpsPerS <= maxDbCap;

  let status: SlotCandidateStatus;
  if (!rowLockSafe) {
    status = "row_lock_bottleneck";
  } else if (!dbCapacitySafe) {
    status = "read_amplification_overload";
  } else if (optimal) {
    status = "optimal";
  } else {
    status = "viable";
  }

  return {
    slots,
    writesPerSlotPerS,
    readOpsPerS,
    totalDbOpsPerS,
    rowLockSafe,
    dbCapacitySafe,
    status,
  };
}

/**
 * Calculates optimal slot count solving the Level 24 trade-off between
 * Write Row-Lock Contention and Read SUM() Amplification.
 */
export function calculateOptimalSlotCount(
  input: AdaptiveSlotSizerInput
): AdaptiveSlotSizerResult {
  const maxWritesPerRowPerS = input.maxWritesPerRowPerS ?? 200;
  const maxDbCapacityPerS = input.maxDbCapacityPerS ?? 1500;
  const candidateSlots = input.candidateSlots ?? [1, 4, 8, 16, 32, 64];

  const minSlotsToAvoidRowLock = Math.ceil(
    input.writeRatePerS / maxWritesPerRowPerS
  );

  const maxSlotsWithinDbCapacity =
    input.readRatePerS > 0
      ? Math.max(
          0,
          Math.floor(
            (maxDbCapacityPerS - input.writeRatePerS) / input.readRatePerS
          )
        )
      : Number.POSITIVE_INFINITY;

  // Initial evaluation pass
  const evaluations: SlotCandidateEvaluation[] = candidateSlots.map((slots) =>
    evaluateSlotCandidate({
      slots,
      writeRatePerS: input.writeRatePerS,
      readRatePerS: input.readRatePerS,
      maxWritesPerRowPerS,
      maxDbCapacityPerS,
    })
  );

  // Find candidate that satisfies both bounds with lowest read overhead (smallest slots)
  const viable = evaluations.filter(
    (e) => e.rowLockSafe && e.dbCapacitySafe
  );
  const best = viable.sort((a, b) => a.slots - b.slots)[0];
  const recommendedSlots = best ? best.slots : null;

  // Mark status for the optimal candidate
  for (const ev of evaluations) {
    if (recommendedSlots !== null && ev.slots === recommendedSlots) {
      ev.status = "optimal";
    }
  }

  return {
    minSlotsToAvoidRowLock,
    maxSlotsWithinDbCapacity,
    recommendedSlots,
    evaluations,
  };
}

// ============================================================================
// 2. Self-Contained HyperLogLog Counter
// ============================================================================

/**
 * Zero-dependency 32-bit HyperLogLog Cardinality Estimator.
 * Uses murmurhash3_32 from ./slotted-counter, with Flajolet bias correction
 * and small-range linear counting correction.
 */
export class HyperLogLogCounter {
  public readonly p: number;
  public readonly m: number;
  private readonly alpha: number;
  public readonly registers: Uint8Array;

  constructor(precision: number = 10) {
    if (precision < 4 || precision > 14) {
      throw new Error(
        `Precision p must be between 4 and 14 inclusive, received: ${precision}`
      );
    }
    this.p = precision;
    this.m = 1 << precision;
    this.registers = new Uint8Array(this.m);

    // Flajolet alpha_m bias correction constants
    if (this.m === 16) {
      this.alpha = 0.673;
    } else if (this.m === 32) {
      this.alpha = 0.697;
    } else if (this.m === 64) {
      this.alpha = 0.709;
    } else {
      this.alpha = 0.7213 / (1 + 1.079 / this.m);
    }
  }

  public get precision(): number {
    return this.p;
  }

  public get numRegisters(): number {
    return this.m;
  }

  /**
   * Adds a viewer ID or item to the HyperLogLog register set.
   * Returns true if any register value was increased.
   */
  public add(viewerId: string): boolean {
    const x = murmurhash3_32(viewerId);
    // Upper p bits select the register index j in [0, m - 1]
    const j = x >>> (32 - this.p);
    // Lower 32 - p bits aligned to MSB to count leading zeros in O(1)
    const w = (x << this.p) >>> 0;
    // rho is position of first 1-bit (1-indexed), max is 32 - p + 1
    const rho = w === 0 ? 32 - this.p + 1 : Math.clz32(w) + 1;

    if (rho > this.registers[j]) {
      this.registers[j] = rho;
      return true;
    }
    return false;
  }

  /**
   * Computes the estimated distinct cardinality.
   * Applies Flajolet harmonic mean with small-range linear counting correction.
   */
  public count(): number {
    let sum = 0;
    let zeros = 0;

    for (let i = 0; i < this.m; i++) {
      const val = this.registers[i];
      sum += Math.pow(2, -val);
      if (val === 0) {
        zeros++;
      }
    }

    let estimate = (this.alpha * this.m * this.m) / sum;

    // Small range correction: Linear Counting
    if (estimate <= 2.5 * this.m) {
      if (zeros > 0) {
        estimate = this.m * Math.log(this.m / zeros);
      }
    } else if (estimate > (1 / 30) * 4294967296) {
      // Large range correction for 32-bit hash space
      estimate = -4294967296 * Math.log(1 - estimate / 4294967296);
    }

    return Math.round(estimate);
  }

  /**
   * Merges another HyperLogLogCounter with the exact same precision into this counter.
   */
  public merge(other: HyperLogLogCounter): void {
    if (this.p !== other.p) {
      throw new Error(
        `Cannot merge HyperLogLog with different precisions: ${this.p} vs ${other.p}`
      );
    }
    for (let i = 0; i < this.m; i++) {
      if (other.registers[i] > this.registers[i]) {
        this.registers[i] = other.registers[i];
      }
    }
  }

  /**
   * Serializes the register array into a compact Uint8Array.
   */
  public serialize(): Uint8Array {
    return new Uint8Array(this.registers);
  }

  /**
   * Deserializes a Uint8Array into a HyperLogLogCounter.
   */
  public static deserialize(
    bytes: Uint8Array,
    precision?: number
  ): HyperLogLogCounter {
    const p = precision ?? Math.round(Math.log2(bytes.length));
    if (p < 4 || p > 14 || (1 << p) !== bytes.length) {
      throw new Error(
        `Invalid HyperLogLog byte array length: ${bytes.length} (expected 2^p with p in [4, 14])`
      );
    }
    const hll = new HyperLogLogCounter(p);
    hll.registers.set(bytes);
    return hll;
  }
}

// ============================================================================
// 3. YouTube Hybrid View Count Engine
// ============================================================================

export interface YouTubeHybridViewEngineOptions {
  /**
   * View count threshold where YouTube's anti-fraud auditing freezes public count
   * to verify organic integrity (default: 300, modeling the 301-view phenomenon).
   */
  viralFreezeThreshold?: number;
  /**
   * Maximum acceptable ratio of (rawTotalViews / estimatedUniqueViewers) before
   * flagging synthetic F5 spam (default: 10).
   */
  maxViewsPerUniqueViewerRatio?: number;
  /**
   * Number of sharded physical slots for InMemorySlottedCounter (default: 4, matching Level 24).
   */
  numSlots?: number;
  /**
   * Precision p for HyperLogLogCounter (default: 10 -> 1024 registers).
   */
  hllPrecision?: number;
}

export interface VideoMetrics {
  videoId?: string;
  rawTotalViews: number;
  verifiedPublicViews: number;
  estimatedUniqueViewers: number;
  spamRatio: number;
  isSuspectedBotAttack: boolean;
  activeSlots: number;
  slotDistribution: number[];
}

export interface ViewRecordResult {
  videoId: string;
  viewerId: string;
  slotId: number;
  rawTotalViews: number;
  verifiedPublicViews: number;
  estimatedUniqueViewers: number;
  spamRatio: number;
  isSuspectedBotAttack: boolean;
  acceptedAsVerified: boolean;
}

/**
 * YouTube Hybrid View Count Engine.
 * Combines InMemorySlottedCounter (for exact 100% total raw views) with
 * HyperLogLogCounter (for distinct viewers & anti-F5 bot audit).
 */
export class YouTubeHybridViewEngine {
  private readonly rawCounter: InMemorySlottedCounter;
  private readonly verifiedCounter: InMemorySlottedCounter;
  private readonly hllMap = new Map<string, HyperLogLogCounter>();

  public readonly viralFreezeThreshold: number;
  public readonly maxViewsPerUniqueViewerRatio: number;
  public readonly numSlots: number;
  public readonly hllPrecision: number;

  constructor(options: YouTubeHybridViewEngineOptions = {}) {
    this.viralFreezeThreshold = options.viralFreezeThreshold ?? 300;
    this.maxViewsPerUniqueViewerRatio =
      options.maxViewsPerUniqueViewerRatio ?? 10;
    this.numSlots = options.numSlots ?? 4;
    this.hllPrecision = options.hllPrecision ?? 10;

    this.rawCounter = new InMemorySlottedCounter(this.numSlots);
    this.verifiedCounter = new InMemorySlottedCounter(this.numSlots);
  }

  private getOrCreateHll(videoId: string): HyperLogLogCounter {
    let hll = this.hllMap.get(videoId);
    if (!hll) {
      hll = new HyperLogLogCounter(this.hllPrecision);
      this.hllMap.set(videoId, hll);
    }
    return hll;
  }

  /**
   * Records a view event for a given video from a viewer.
   *
   * 1. Always increments the raw slotted counter (slot = getSlotId(viewerId, numSlots)).
   * 2. Registers the viewer in the video's HyperLogLog estimator.
   * 3. Calculates spamRatio = rawTotalViews / estimatedUniqueViewers.
   * 4. If below viralFreezeThreshold OR spamRatio <= maxViewsPerUniqueViewerRatio,
   *    increments verifiedPublicViews.
   *    Otherwise, rejects synthetic inflation and holds verifiedPublicViews at the cap!
   */
  public recordView(videoId: string, viewerId: string): ViewRecordResult {
    const rawRes = this.rawCounter.increment(
      "video:raw",
      videoId,
      1,
      viewerId
    );
    const rawTotalViews = rawRes.total;

    const hll = this.getOrCreateHll(videoId);
    hll.add(viewerId);
    const estimatedUniqueViewers = hll.count();

    const spamRatio =
      rawTotalViews / Math.max(1, estimatedUniqueViewers);

    const isSuspectedBotAttack =
      rawTotalViews >= this.viralFreezeThreshold &&
      spamRatio > this.maxViewsPerUniqueViewerRatio;

    const acceptedAsVerified =
      rawTotalViews <= this.viralFreezeThreshold ||
      spamRatio <= this.maxViewsPerUniqueViewerRatio;

    let verifiedTotal = this.verifiedCounter.getTotal(
      "video:verified",
      videoId
    );

    if (acceptedAsVerified) {
      const vRes = this.verifiedCounter.increment(
        "video:verified",
        videoId,
        1,
        viewerId
      );
      verifiedTotal = vRes.total;
    }

    return {
      videoId,
      viewerId,
      slotId: rawRes.slotId,
      rawTotalViews,
      verifiedPublicViews: verifiedTotal,
      estimatedUniqueViewers,
      spamRatio,
      isSuspectedBotAttack,
      acceptedAsVerified,
    };
  }

  /**
   * Retrieves comprehensive view and audit metrics for a video.
   */
  public getVideoMetrics(videoId: string): VideoMetrics {
    const rawTotalViews = this.rawCounter.getTotal("video:raw", videoId);
    const verifiedPublicViews = this.verifiedCounter.getTotal(
      "video:verified",
      videoId
    );
    const hll = this.hllMap.get(videoId);
    const estimatedUniqueViewers = hll ? hll.count() : 0;
    const spamRatio =
      rawTotalViews === 0
        ? 0
        : rawTotalViews / Math.max(1, estimatedUniqueViewers);

    const isSuspectedBotAttack =
      rawTotalViews >= this.viralFreezeThreshold &&
      spamRatio > this.maxViewsPerUniqueViewerRatio;

    const slotDistribution = this.rawCounter.getSlotBreakdown(
      "video:raw",
      videoId
    );

    return {
      videoId,
      rawTotalViews,
      verifiedPublicViews,
      estimatedUniqueViewers,
      spamRatio,
      isSuspectedBotAttack,
      activeSlots: this.numSlots,
      slotDistribution,
    };
  }

  /**
   * Gets the underlying HyperLogLogCounter for inspection or serialization.
   */
  public getHyperLogLog(videoId: string): HyperLogLogCounter | undefined {
    return this.hllMap.get(videoId);
  }

  /**
   * Resets counts for a specific video or all videos.
   */
  public reset(videoId?: string): void {
    if (videoId) {
      this.hllMap.delete(videoId);
      // Re-initialize counters for this video to 0
      this.rawCounter.initializeStock("video:raw", videoId, 0);
      this.verifiedCounter.initializeStock("video:verified", videoId, 0);
    } else {
      this.hllMap.clear();
      // create new counter instances
      const raw = new InMemorySlottedCounter(this.numSlots);
      const verified = new InMemorySlottedCounter(this.numSlots);
      (this as any).rawCounter = raw;
      (this as any).verifiedCounter = verified;
    }
  }
}
