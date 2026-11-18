import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  calculateOptimalSlotCount,
  evaluateSlotCandidate,
  HyperLogLogCounter,
  YouTubeHybridViewEngine,
} from "../src/index";

describe("Màn 24: @kido/hot-counter YouTube View Engine & Cloud Datastore Adaptive Slot Sizer", () => {
  describe("1. Cloud Datastore Adaptive Slot Sizer (calculateOptimalSlotCount & evaluateSlotCandidate)", () => {
    it("mathematically proves Level 24 exact trade-off: Split 4 wins, Split 1 fails row lock, Split 16 crashes DB", () => {
      // Level 24 Parameters:
      // - 700 writes/sec (viral video views)
      // - 100 reads/sec (creator dashboard opens)
      // - 200 writes/row/sec max row commit limit
      // - 1,500 total ops/sec max capacity for Relational DB Tier L
      const result = calculateOptimalSlotCount({
        writeRatePerS: 700,
        readRatePerS: 100,
        maxWritesPerRowPerS: 200,
        maxDbCapacityPerS: 1500,
        candidateSlots: [1, 4, 16],
      });

      // Bounds
      // minSlots = ceil(700 / 200) = 4
      assert.strictEqual(result.minSlotsToAvoidRowLock, 4);
      // maxSlots = floor((1500 - 700) / 100) = 8
      assert.strictEqual(result.maxSlotsWithinDbCapacity, 8);
      // recommended candidate from [1, 4, 16] is 4
      assert.strictEqual(result.recommendedSlots, 4);

      // Verify evaluations array
      assert.strictEqual(result.evaluations.length, 3);

      // Candidate 1 (Split 1 - Naive single row):
      // writes/slot = 700 > 200 (FAILS row lock!)
      // total DB ops = 700 + 100 = 800 <= 1500
      const split1 = result.evaluations.find((e) => e.slots === 1)!;
      assert.strictEqual(split1.writesPerSlotPerS, 700);
      assert.strictEqual(split1.readOpsPerS, 100);
      assert.strictEqual(split1.totalDbOpsPerS, 800);
      assert.strictEqual(split1.rowLockSafe, false);
      assert.strictEqual(split1.dbCapacitySafe, true);
      assert.strictEqual(split1.status, "row_lock_bottleneck");

      // Candidate 4 (Split 4 - Recommended):
      // writes/slot = 175 <= 200 (SAFE!)
      // total DB ops = 700 + 400 = 1,100 <= 1,500 (SAFE!)
      const split4 = result.evaluations.find((e) => e.slots === 4)!;
      assert.strictEqual(split4.writesPerSlotPerS, 175);
      assert.strictEqual(split4.readOpsPerS, 400);
      assert.strictEqual(split4.totalDbOpsPerS, 1100);
      assert.strictEqual(split4.rowLockSafe, true);
      assert.strictEqual(split4.dbCapacitySafe, true);
      assert.strictEqual(split4.status, "optimal");

      // Candidate 16 (Split 16 - Over-sharded trap):
      // writes/slot = 43.75 <= 200 (SAFE)
      // total DB ops = 700 + 1,600 = 2,300 > 1,500 (FAILS DB capacity due to 16x SUM amplification!)
      const split16 = result.evaluations.find((e) => e.slots === 16)!;
      assert.strictEqual(split16.writesPerSlotPerS, 43.75);
      assert.strictEqual(split16.readOpsPerS, 1600);
      assert.strictEqual(split16.totalDbOpsPerS, 2300);
      assert.strictEqual(split16.rowLockSafe, true);
      assert.strictEqual(split16.dbCapacitySafe, false);
      assert.strictEqual(split16.status, "read_amplification_overload");
    });

    it("evaluates a single slot candidate via evaluateSlotCandidate", () => {
      const evalPositional = evaluateSlotCandidate(4, 700, 100, 200, 1500, true);
      assert.strictEqual(evalPositional.slots, 4);
      assert.strictEqual(evalPositional.writesPerSlotPerS, 175);
      assert.strictEqual(evalPositional.readOpsPerS, 400);
      assert.strictEqual(evalPositional.totalDbOpsPerS, 1100);
      assert.strictEqual(evalPositional.status, "optimal");

      const evalObject = evaluateSlotCandidate({
        slots: 16,
        writeRatePerS: 700,
        readRatePerS: 100,
      });
      assert.strictEqual(evalObject.slots, 16);
      assert.strictEqual(evalObject.status, "read_amplification_overload");
    });

    it("handles low traffic where split_1 is viable and optimal", () => {
      const result = calculateOptimalSlotCount({
        writeRatePerS: 50,
        readRatePerS: 10,
        maxWritesPerRowPerS: 200,
        maxDbCapacityPerS: 1500,
        candidateSlots: [1, 4, 8, 16],
      });

      assert.strictEqual(result.minSlotsToAvoidRowLock, 1);
      assert.strictEqual(result.recommendedSlots, 1);
      const split1 = result.evaluations.find((e) => e.slots === 1)!;
      assert.strictEqual(split1.status, "optimal");
    });

    it("returns null recommendedSlots when write rate alone exceeds DB capacity", () => {
      const result = calculateOptimalSlotCount({
        writeRatePerS: 2000,
        readRatePerS: 100,
        maxWritesPerRowPerS: 200,
        maxDbCapacityPerS: 1500,
        candidateSlots: [1, 4, 8, 16],
      });

      assert.strictEqual(result.maxSlotsWithinDbCapacity, 0);
      assert.strictEqual(result.recommendedSlots, null);
    });
  });

  describe("2. Self-Contained HyperLogLogCounter", () => {
    it("enforces precision bounds in [4, 14]", () => {
      assert.throws(() => new HyperLogLogCounter(3));
      assert.throws(() => new HyperLogLogCounter(15));
      const hll = new HyperLogLogCounter(10);
      assert.strictEqual(hll.precision, 10);
      assert.strictEqual(hll.numRegisters, 1024);
      assert.strictEqual(hll.registers.length, 1024);
    });

    it("returns 0 for empty counter", () => {
      const hll = new HyperLogLogCounter(10);
      assert.strictEqual(hll.count(), 0);
    });

    it("is 100% idempotent when the same viewer refreshes 1,000 times", () => {
      const hll = new HyperLogLogCounter(10);
      for (let i = 0; i < 1000; i++) {
        hll.add("super_fan_user_99");
      }
      assert.strictEqual(hll.count(), 1);
    });

    it("estimates small cardinalities accurately using Linear Counting correction", () => {
      for (const expected of [1, 2, 5, 10, 50, 100]) {
        const hll = new HyperLogLogCounter(10);
        for (let i = 0; i < expected; i++) {
          hll.add(`user_small_${i}`);
        }
        const est = hll.count();
        // For small numbers (<= 100), Linear Counting should be within 2% or exact
        const err = Math.abs(est - expected) / expected;
        assert.ok(
          err <= 0.05,
          `Expected ${expected}, got ${est} (err: ${(err * 100).toFixed(2)}%)`
        );
      }
    });

    it("achieves < 3% cardinality accuracy across 5,000 unique viewers", () => {
      const hll = new HyperLogLogCounter(10);
      const totalUnique = 5000;
      for (let i = 0; i < totalUnique; i++) {
        hll.add(`viewer_unique_${i}`);
      }
      const estimated = hll.count();
      const relativeError = Math.abs(estimated - totalUnique) / totalUnique;

      // Must be strictly less than 3% (0.03) error
      assert.ok(
        relativeError < 0.03,
        `Relative error ${(relativeError * 100).toFixed(2)}% must be < 3%, estimated: ${estimated}`
      );
    });

    it("merges two independent HyperLogLog counters seamlessly", () => {
      const hllA = new HyperLogLogCounter(10);
      const hllB = new HyperLogLogCounter(10);

      for (let i = 0; i < 1000; i++) {
        hllA.add(`user_cluster_a_${i}`);
      }
      for (let i = 0; i < 1000; i++) {
        hllB.add(`user_cluster_b_${i}`);
      }

      hllA.merge(hllB);
      const mergedEst = hllA.count();
      const expectedTotal = 2000;
      const relativeError = Math.abs(mergedEst - expectedTotal) / expectedTotal;

      assert.ok(
        relativeError < 0.05,
        `Merged estimation ${mergedEst} relative error ${(relativeError * 100).toFixed(2)}% must be < 5%`
      );
    });

    it("serializes and deserializes correctly", () => {
      const original = new HyperLogLogCounter(10);
      for (let i = 0; i < 500; i++) {
        original.add(`user_ser_${i}`);
      }
      const bytes = original.serialize();
      assert.strictEqual(bytes.length, 1024);

      const deserialized = HyperLogLogCounter.deserialize(bytes);
      assert.strictEqual(deserialized.precision, 10);
      assert.strictEqual(deserialized.count(), original.count());
    });
  });

  describe("3. YouTubeHybridViewEngine (Total Views + Anti-F5 Spam Audit)", () => {
    let engine: YouTubeHybridViewEngine;

    beforeEach(() => {
      engine = new YouTubeHybridViewEngine({
        viralFreezeThreshold: 300,
        maxViewsPerUniqueViewerRatio: 10,
        numSlots: 4,
        hllPrecision: 10,
      });
    });

    it("records organic viral traffic without freezing verified public views", () => {
      const videoId = "mv_organic_hit_2026";
      const totalUnique = 1000;

      // 1000 unique viewers, 20% rewatch once -> 1,200 raw views
      for (let i = 0; i < totalUnique; i++) {
        const viewerId = `organic_viewer_${i}`;
        engine.recordView(videoId, viewerId);
        if (i % 5 === 0) {
          engine.recordView(videoId, viewerId);
        }
      }

      const metrics = engine.getVideoMetrics(videoId);
      assert.strictEqual(metrics.rawTotalViews, 1200);
      // All 1,200 views accepted because spamRatio is ~1.15 <= 10
      assert.strictEqual(metrics.verifiedPublicViews, 1200);
      assert.strictEqual(metrics.isSuspectedBotAttack, false);
      assert.strictEqual(metrics.activeSlots, 4);

      // Verify slot distribution adds up to raw total views
      const sumSlots = metrics.slotDistribution.reduce((a, b) => a + b, 0);
      assert.strictEqual(sumSlots, 1200);
      assert.strictEqual(metrics.slotDistribution.length, 4);

      // Slot distribution should be well-balanced (175 - 350 per slot)
      for (const slotCount of metrics.slotDistribution) {
        assert.ok(slotCount > 200 && slotCount < 400);
      }
    });

    it("detects F5 bot attack and freezes public views at viralFreezeThreshold (300 views)", () => {
      const videoId = "mv_botted_track_99";
      const botViewerId = "bot_spammer_f5_loop";

      // Single bot viewer spams 500 times
      for (let i = 0; i < 500; i++) {
        const res = engine.recordView(videoId, botViewerId);
        if (i < 300) {
          assert.strictEqual(res.acceptedAsVerified, true);
        } else {
          // Beyond 300, rejected as synthetic inflation!
          assert.strictEqual(res.acceptedAsVerified, false);
        }
      }

      const metrics = engine.getVideoMetrics(videoId);
      // Raw slotted counter registers all 500 views
      assert.strictEqual(metrics.rawTotalViews, 500);
      // Verified public views FROZEN at exactly 300!
      assert.strictEqual(metrics.verifiedPublicViews, 300);
      // Only 1 unique viewer detected by HyperLogLog!
      assert.strictEqual(metrics.estimatedUniqueViewers, 1);
      // Spam ratio is 500 / 1 = 500 (>> 10 max ratio)
      assert.strictEqual(metrics.spamRatio, 500);
      assert.strictEqual(metrics.isSuspectedBotAttack, true);

      // All 500 writes hit the same slot (because callerKey/viewerId is identical)
      const nonZeroSlots = metrics.slotDistribution.filter((c) => c > 0);
      assert.strictEqual(nonZeroSlots.length, 1);
      assert.strictEqual(nonZeroSlots[0], 500);
    });

    it("supports reset of individual videos and all videos", () => {
      engine.recordView("v1", "u1");
      engine.recordView("v2", "u2");

      assert.strictEqual(engine.getVideoMetrics("v1").rawTotalViews, 1);
      assert.strictEqual(engine.getVideoMetrics("v2").rawTotalViews, 1);

      engine.reset("v1");
      assert.strictEqual(engine.getVideoMetrics("v1").rawTotalViews, 0);
      assert.strictEqual(engine.getVideoMetrics("v2").rawTotalViews, 1);

      engine.reset();
      assert.strictEqual(engine.getVideoMetrics("v2").rawTotalViews, 0);
    });
  });
});
