import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  Tier0SmeHybridFeed,
  Tier1GrowthHybridFeed,
  Tier2BigTechTimelineMixer,
  NaiveOnReadFeed,
  NaiveOnWriteFeed,
  recommendFeedTier,
  runHybridFeedBenchmark,
} from "../src/index";

describe("3-Tier Progressive Hybrid Feed Architecture", () => {
  describe("Naive Baselines Comparison", () => {
    it("simulates Naive On-Read read amplification bottleneck", () => {
      const feed = new NaiveOnReadFeed();
      // User follows 50 creators
      for (let i = 0; i < 50; i++) {
        feed.follow("user_1", `creator_${i}`);
        feed.publishPost({ id: `p_${i}`, authorId: `creator_${i}` });
      }

      // Single timeline read queries 50 followed authors
      const timeline = feed.readTimeline("user_1", 20);
      assert.strictEqual(timeline.length, 20);
      assert.strictEqual(feed.totalWrites, 50);
      // 50 queries executed for 1 timeline read!
      assert.strictEqual(feed.totalReadQueries, 50);
    });

    it("simulates Naive On-Write explosive write amplification bottleneck", () => {
      const feed = new NaiveOnWriteFeed();
      const celebFollowers = Array.from({ length: 5000 }, (_, i) => `user_${i}`);

      // 1 celebrity post triggers 5,000 inbox writes!
      const result = feed.publishPost({
        id: "viral_post",
        authorId: "celeb_1",
        followerIds: celebFollowers,
      });

      assert.strictEqual(result.rowsWritten, 5000);
      assert.strictEqual(feed.totalWrites, 5000);
      assert.strictEqual(feed.readTimeline("user_0", 10).length, 1);
      assert.strictEqual(feed.totalReadQueries, 1);
    });
  });

  describe("Tier-0 SME Zero-Infra Feed (Tier0SmeHybridFeed)", () => {
    it("manages hybrid timeline on single VPS with $0 Redis cost", async () => {
      const feed = new Tier0SmeHybridFeed({ celebrityThreshold: 100, dialect: "sqlite" });

      // Normal post: pushes to followers
      const normResult = await feed.publish({
        id: "post_norm",
        authorId: "bob",
        followerIds: ["alice"],
      });
      assert.strictEqual(normResult.strategy, "push_fanout");
      assert.strictEqual(normResult.rowsWritten, 1);

      // Celebrity post: pull bypass
      const celebResult = await feed.publish({
        id: "post_celeb",
        authorId: "elon",
        followerCount: 2000,
      });
      assert.strictEqual(celebResult.strategy, "pull_bypass");
      assert.strictEqual(celebResult.rowsWritten, 1);

      // Read Alice's timeline
      const timeline = feed.read({
        userId: "alice",
        followedCelebrityIds: ["elon"],
        limit: 10,
      });

      assert.strictEqual(timeline.items.length, 2);
      assert.strictEqual(timeline.metrics.dbReads, 2); // 1 inbox + 1 celeb outbox
    });
  });

  describe("Tier-1 Growth Hybrid Feed (Tier1GrowthHybridFeed)", () => {
    it("partitions user inbox and handles batching & cursor pagination", async () => {
      const feed = new Tier1GrowthHybridFeed({
        celebrityThreshold: 500,
        inboxMaxBatchSize: 100,
        dialect: "postgres",
      });

      // Publish normal post to 250 followers
      const followers = Array.from({ length: 250 }, (_, i) => `follower_${i}`);
      const pubResult = await feed.publish({
        id: "post_growth_1",
        authorId: "creator_mid",
        followerIds: followers,
      });

      assert.strictEqual(pubResult.strategy, "push_fanout");
      assert.strictEqual(pubResult.rowsWritten, 250);
      // 250 followers / 100 maxBatchSize = 3 batches
      assert.strictEqual(pubResult.batchesCount, 3);

      // Read follower timeline
      const timeline = feed.read({
        userId: "follower_0",
        limit: 10,
      });
      assert.strictEqual(timeline.items.length, 1);
      assert.strictEqual(timeline.items[0].id, "post_growth_1");
    });
  });

  describe("Tier-2 Big-Tech Timeline Mixer (Tier2BigTechTimelineMixer)", () => {
    it("assembles timeline with Valkey capped ZSETs and L1 RAM cache", async () => {
      const feed = new Tier2BigTechTimelineMixer({
        maxInboxSize: 100,
        celebrityCacheTtlMs: 3000,
      });

      // Normal post
      await feed.publishNormalPost(
        { id: "post_norm_1", authorId: "author_1", createdAtMs: 1000 },
        ["user_vip"]
      );

      // Celebrity post
      await feed.publishCelebrityPost({
        id: "post_celeb_1",
        authorId: "celeb_megastar",
        createdAtMs: 2000,
      });

      // Read timeline
      const output = await feed.readTimeline({
        userId: "user_vip",
        followedCelebrityIds: ["celeb_megastar"],
        limit: 10,
      });

      assert.strictEqual(output.items.length, 2);
      assert.strictEqual(output.items[0].id, "post_celeb_1"); // Newer
      assert.strictEqual(output.items[1].id, "post_norm_1");
    });
  });

  describe("Architecture Recommendation Advisor", () => {
    it("recommends naive-on-read for hobby/negligible traffic with zero budget", () => {
      const recommendation = recommendFeedTier({
        dailyActiveUsers: 500,
        timelineReadsPerSecond: 1,
        maxFollowersPerUser: 50,
        monthlyBudgetUsd: 0,
      });
      assert.strictEqual(recommendation.recommendedTier, "naive-on-read");
    });

    it("recommends tier0-sme for single-VPS SME workloads (<10k DAU, low budget)", () => {
      const recommendation = recommendFeedTier({
        dailyActiveUsers: 5000,
        timelineReadsPerSecond: 10,
        maxFollowersPerUser: 500,
        monthlyBudgetUsd: 10,
      });
      assert.strictEqual(recommendation.recommendedTier, "tier0-sme");
    });

    it("recommends tier1-growth for mid-market scale (<500k DAU)", () => {
      const recommendation = recommendFeedTier({
        dailyActiveUsers: 200000,
        timelineReadsPerSecond: 200,
        maxFollowersPerUser: 10000,
        monthlyBudgetUsd: 200,
      });
      assert.strictEqual(recommendation.recommendedTier, "tier1-growth");
    });

    it("recommends tier2-bigtech for enterprise / high-fanout workloads", () => {
      const recommendation = recommendFeedTier({
        dailyActiveUsers: 2000000,
        timelineReadsPerSecond: 2500,
        maxFollowersPerUser: 100000,
        monthlyBudgetUsd: 1000,
      });
      assert.strictEqual(recommendation.recommendedTier, "tier2-bigtech");
    });
  });

  describe("Progressive Benchmark Suite", () => {
    it("runs runHybridFeedBenchmark across all 5 tiers successfully", async () => {
      const bench = await runHybridFeedBenchmark({
        normalPostCount: 50,
        followersPerNormalUser: 10,
        celebrityPostCount: 2,
        followersPerCelebrity: 100,
        timelineReadCount: 20,
      });

      assert.ok(bench.results["naive-on-read"].executionTimeMs >= 0);
      assert.ok(bench.results["naive-on-write"].executionTimeMs >= 0);
      assert.ok(bench.results["tier0-sme"].executionTimeMs >= 0);
      assert.ok(bench.results["tier1-growth"].executionTimeMs >= 0);
      assert.ok(bench.results["tier2-bigtech"].executionTimeMs >= 0);

      // Verify write amplification in naive on-write is massively higher than tier-2 or on-read
      assert.ok(
        bench.results["naive-on-write"].totalWrites >
          bench.results["tier2-bigtech"].totalWrites
      );
    });
  });
});
