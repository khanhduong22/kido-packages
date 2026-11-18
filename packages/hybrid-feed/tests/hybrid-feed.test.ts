import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  FeedItem,
  TimelineCursor,
  encodeTimelineCursor,
  decodeTimelineCursor,
  kWayMergeFeeds,
  BinaryMaxHeap,
  HybridFanoutEngine,
  calculateLevel22SqlLoad,
  assertValidIdentifier,
  quoteIdentifier,
  ValkeyTimelineMixer,
  InMemoryValkeyTimelineStore,
  LUA_ZADD_CAPPED_TIMELINE,
} from "../src/index";

describe("Màn 22: @kido/hybrid-feed Core Package", () => {
  describe("Module 1: K-Way Binary Max-Heap Merger & Keyset Cursor Pagination", () => {
    it("orders merged items by createdAtMs DESC with id DESC tie-breaker", () => {
      const streamA: FeedItem[] = [
        { id: "post_100", authorId: "user_a", createdAtMs: 1000 },
        { id: "post_080", authorId: "user_a", createdAtMs: 800 },
        { id: "post_050_b", authorId: "user_a", createdAtMs: 500 },
      ];
      const streamB: FeedItem[] = [
        { id: "post_090", authorId: "user_b", createdAtMs: 900 },
        { id: "post_050_z", authorId: "user_b", createdAtMs: 500 }, // same timestamp as post_050_b, but 'z' > 'b'
        { id: "post_010", authorId: "user_b", createdAtMs: 100 },
      ];

      const result = kWayMergeFeeds([streamA, streamB], { limit: 10 });

      assert.strictEqual(result.items.length, 6);
      assert.strictEqual(result.items[0].id, "post_100");
      assert.strictEqual(result.items[1].id, "post_090");
      assert.strictEqual(result.items[2].id, "post_080");
      // Tie breaker: post_050_z ('z') should come before post_050_b ('b')
      assert.strictEqual(result.items[3].id, "post_050_z");
      assert.strictEqual(result.items[4].id, "post_050_b");
      assert.strictEqual(result.items[5].id, "post_010");
      assert.strictEqual(result.nextCursor, null);
    });

    it("deduplicates identical post IDs (handles author mid-flight celebrity transition)", () => {
      // User was normal, so post_042 was pushed to follower's inbox
      const followerInbox: FeedItem[] = [
        { id: "post_050", authorId: "author_normal", createdAtMs: 5000 },
        { id: "post_042", authorId: "author_promoted", createdAtMs: 4200 },
      ];
      // Author got promoted to celebrity, so post_042 is ALSO in celebrity outbox
      const celebrityOutbox: FeedItem[] = [
        { id: "post_060", authorId: "author_promoted", createdAtMs: 6000 },
        { id: "post_042", authorId: "author_promoted", createdAtMs: 4200 }, // Duplicate!
      ];

      const result = kWayMergeFeeds([followerInbox, celebrityOutbox], { limit: 10 });

      const itemIds = result.items.map((i) => i.id);
      assert.deepStrictEqual(itemIds, ["post_060", "post_050", "post_042"]);
      assert.strictEqual(result.stats.duplicatesDropped, 1);
    });

    it("paginates seamlessly across pages using keyset cursor without skips or duplicates", () => {
      const stream: FeedItem[] = Array.from({ length: 25 }, (_, i) => ({
        id: `post_${String(100 - i).padStart(3, "0")}`,
        authorId: "author_1",
        createdAtMs: 10000 - i * 100,
      }));

      // Page 1: limit 10
      const page1 = kWayMergeFeeds([stream], { limit: 10 });
      assert.strictEqual(page1.items.length, 10);
      assert.ok(page1.nextCursor !== null);
      assert.strictEqual(page1.items[0].id, "post_100");
      assert.strictEqual(page1.items[9].id, "post_091");

      // Page 2: limit 10 using cursor from page 1
      const page2 = kWayMergeFeeds([stream], {
        limit: 10,
        cursor: page1.nextCursor,
      });
      assert.strictEqual(page2.items.length, 10);
      assert.ok(page2.nextCursor !== null);
      assert.strictEqual(page2.items[0].id, "post_090");
      assert.strictEqual(page2.items[9].id, "post_081");

      // Page 3: limit 10 using cursor from page 2 (remaining 5 items)
      const page3 = kWayMergeFeeds([stream], {
        limit: 10,
        cursor: page2.nextCursor,
      });
      assert.strictEqual(page3.items.length, 5);
      assert.strictEqual(page3.items[0].id, "post_080");
      assert.strictEqual(page3.items[4].id, "post_076");
      // End of feed: nextCursor must be null!
      assert.strictEqual(page3.nextCursor, null);

      // Verify no duplicates across all 3 pages
      const allIds = [
        ...page1.items.map((i) => i.id),
        ...page2.items.map((i) => i.id),
        ...page3.items.map((i) => i.id),
      ];
      assert.strictEqual(allIds.length, 25);
      const uniqueIds = new Set(allIds);
      assert.strictEqual(uniqueIds.size, 25);
    });

    it("encodes and decodes TimelineCursor cleanly and safely handles malformed input", () => {
      const cursor: TimelineCursor = { createdAtMs: 1711920000000, id: "post_xyz_123" };
      const token = encodeTimelineCursor(cursor);
      assert.ok(typeof token === "string" && token.length > 0);

      const decoded = decodeTimelineCursor(token);
      assert.deepStrictEqual(decoded, cursor);

      // Malformed inputs return null
      assert.strictEqual(decodeTimelineCursor(null), null);
      assert.strictEqual(decodeTimelineCursor(""), null);
      assert.strictEqual(decodeTimelineCursor("not-valid-base64!"), null);
      assert.strictEqual(decodeTimelineCursor(Buffer.from("not-json").toString("base64url")), null);
      assert.strictEqual(decodeTimelineCursor(Buffer.from(JSON.stringify({ t: "not-number", id: "x" })).toString("base64url")), null);

      // Invalid cursor object throws in encodeTimelineCursor
      assert.throws(() => {
        encodeTimelineCursor({ createdAtMs: NaN, id: "abc" });
      });
      assert.throws(() => {
        encodeTimelineCursor({ createdAtMs: 123, id: "" });
      });
    });

    it("filters muted authors and deleted items", () => {
      const stream: FeedItem[] = [
        { id: "post_1", authorId: "spammer", createdAtMs: 1000 },
        { id: "post_2", authorId: "friend", createdAtMs: 900 },
        { id: "post_3", authorId: "friend", createdAtMs: 800 },
      ];

      const result = kWayMergeFeeds([stream], {
        limit: 10,
        mutedAuthorIds: new Set(["spammer"]),
        deletedItemIds: new Set(["post_3"]),
      });

      assert.strictEqual(result.items.length, 1);
      assert.strictEqual(result.items[0].id, "post_2");
    });
  });

  describe("Module 2: HybridFanoutEngine & GonnaCrash Level 22 Load Math", () => {
    let engine: HybridFanoutEngine;

    beforeEach(() => {
      engine = new HybridFanoutEngine({
        celebrityThreshold: 500,
        inboxMaxBatchSize: 200,
        dialect: "postgres",
      });
    });

    it("executes fanout-on-write push for normal authors (< 500 followers)", async () => {
      const followers = Array.from({ length: 150 }, (_, i) => `user_${i}`);
      const result = await engine.publishPost({
        id: "post_norm_1",
        authorId: "normal_user",
        followerIds: followers,
      });

      assert.strictEqual(result.strategy, "push_fanout");
      assert.strictEqual(result.rowsWritten, 150);
      assert.strictEqual(result.batchesCount, 1);
      assert.strictEqual(engine.getUserInbox("user_0").length, 1);
      assert.strictEqual(engine.getUserInbox("user_149").length, 1);
      assert.strictEqual(engine.getCelebrityOutbox("normal_user").length, 0);
    });

    it("executes pull bypass (fanout-on-read) for celebrity authors (>= 500 followers)", async () => {
      const followers = Array.from({ length: 20000 }, (_, i) => `user_${i}`);
      const result = await engine.publishPost({
        id: "post_celeb_1",
        authorId: "celebrity_star",
        followerIds: followers,
      });

      assert.strictEqual(result.strategy, "pull_bypass");
      assert.strictEqual(result.rowsWritten, 1);
      assert.strictEqual(result.batchesCount, 1);
      // Followers should NOT have received writes in their inboxes (0 inbox writes!)
      assert.strictEqual(engine.getUserInbox("user_0").length, 0);
      // Only 1 row written into celebrity outbox
      assert.strictEqual(engine.getCelebrityOutbox("celebrity_star").length, 1);
      assert.strictEqual(engine.getCelebrityOutbox("celebrity_star")[0].id, "post_celeb_1");
    });

    it("executes pull bypass for broadcast announcements regardless of follower count", async () => {
      const result = await engine.publishPost({
        id: "post_system_broadcast",
        authorId: "system_admin",
        isBroadcast: true,
      });

      assert.strictEqual(result.strategy, "pull_bypass");
      assert.strictEqual(result.rowsWritten, 1);
      assert.strictEqual(engine.getBroadcastOutbox().length, 1);
    });

    it("chunks large follower lists into batches of inboxMaxBatchSize", async () => {
      const followers = Array.from({ length: 450 }, (_, i) => `user_${i}`);
      const result = await engine.publishPost({
        id: "post_batch_1",
        authorId: "small_creator",
        followerCount: 450, // below 500 threshold
        followerIds: followers,
      });

      assert.strictEqual(result.strategy, "push_fanout");
      assert.strictEqual(result.rowsWritten, 450);
      // 450 items / 200 maxBatchSize = 3 batches (200 + 200 + 50)
      assert.strictEqual(result.batchesCount, 3);
      assert.strictEqual(result.generatedSqlBatches.length, 3);
    });

    it("builds parameterized SQL with strict identifier quoting and rejects injection attacks", () => {
      // Valid identifiers
      assert.strictEqual(assertValidIdentifier("user_inbox"), "user_inbox");
      assert.strictEqual(quoteIdentifier("user_inbox", "postgres"), '"user_inbox"');

      // Invalid identifiers throw
      assert.throws(() => assertValidIdentifier("user_inbox; DROP TABLE users;--"));
      assert.throws(() => assertValidIdentifier("table-name"));
      assert.throws(() => assertValidIdentifier("123table"));

      // PostgreSQL syntax check
      const pgSql = engine.buildBulkInboxInsertSql([
        { userId: "u1", postId: "p1", authorId: "a1", createdAtMs: 1000 },
      ]);
      assert.ok(pgSql.sql.includes('INSERT INTO "user_inbox"'));
      assert.ok(pgSql.sql.includes("VALUES ($1, $2, $3, $4, $5)"));
      assert.ok(pgSql.sql.includes("ON CONFLICT"));

      // SQLite syntax check
      const sqliteEngine = new HybridFanoutEngine({ dialect: "sqlite" });
      const sqliteSql = sqliteEngine.buildBulkInboxInsertSql([
        { userId: "u1", postId: "p1", authorId: "a1", createdAtMs: 1000 },
      ]);
      assert.ok(sqliteSql.sql.includes('INSERT OR IGNORE INTO "user_inbox"'));
      assert.ok(sqliteSql.sql.includes("VALUES (?, ?, ?, ?, ?)"));
    });

    it("reads timeline combining personal inbox + followed celebrity outboxes + broadcasts", async () => {
      // 1. Followed normal friend posts (inbox)
      await engine.publishPost({
        id: "friend_post_1",
        authorId: "friend_bob",
        followerIds: ["current_user"],
        createdAtMs: 2000,
      });

      // 2. Followed celebrity post (outbox)
      await engine.publishPost({
        id: "celeb_post_1",
        authorId: "celeb_alice",
        followerCount: 50000,
        createdAtMs: 3000,
      });

      // 3. System broadcast (broadcast outbox)
      await engine.publishPost({
        id: "broadcast_1",
        authorId: "system",
        isBroadcast: true,
        createdAtMs: 4000,
      });

      const timeline = engine.readTimeline({
        userId: "current_user",
        followedCelebrityIds: ["celeb_alice"],
        includeBroadcasts: true,
        limit: 10,
      });

      assert.strictEqual(timeline.items.length, 3);
      // Ordering: broadcast (4000) > celeb (3000) > friend (2000)
      assert.strictEqual(timeline.items[0].id, "broadcast_1");
      assert.strictEqual(timeline.items[1].id, "celeb_post_1");
      assert.strictEqual(timeline.items[2].id, "friend_post_1");

      // Metrics: 1 inbox read + 1 celebrity read + 1 broadcast read = 3 DB reads
      assert.strictEqual(timeline.metrics.dbReads, 3);
      assert.strictEqual(timeline.metrics.inboxCount, 1);
      assert.strictEqual(timeline.metrics.celebrityOutboxCount, 1);
      assert.strictEqual(timeline.metrics.broadcastCount, 1);
    });

    it("proves GonnaCrash Level 22 exact SQL load math (15,007 on-read, 20,600 on-write, 1,201 hybrid)", () => {
      const baseParams = {
        normalPostRatePerS: 6,
        normalFollowers: 50,
        celebPostRatePerS: 1,
        celebFollowers: 20000,
        timelineReadRatePerS: 300,
        followedCelebsPerUser: 2,
      };

      // 1. Mode: on_read
      const onRead = calculateLevel22SqlLoad({ ...baseParams, mode: "on_read" });
      // 6 normal writes + 1 celeb write = 7 writes/s
      // 300 reads * 50 followed = 15,000 reads/s
      // Total = 15,007 SQL req/s
      assert.strictEqual(onRead.totalWritesPerS, 7);
      assert.strictEqual(onRead.totalReadsPerS, 15000);
      assert.strictEqual(onRead.totalSqlReqPerS, 15007);

      // 2. Mode: on_write
      const onWrite = calculateLevel22SqlLoad({ ...baseParams, mode: "on_write" });
      // 6 * 50 = 300 normal writes + 1 * 20,000 = 20,000 celeb writes = 20,300 writes/s
      // 300 * 1 = 300 inbox reads/s
      // Total = 20,600 SQL req/s
      assert.strictEqual(onWrite.totalWritesPerS, 20300);
      assert.strictEqual(onWrite.totalReadsPerS, 300);
      assert.strictEqual(onWrite.totalSqlReqPerS, 20600);

      // 3. Mode: hybrid
      const hybrid = calculateLevel22SqlLoad({ ...baseParams, mode: "hybrid" });
      // 6 * 50 = 300 normal writes + 1 celeb write = 301 writes/s
      // 300 reads * (1 inbox + 2 celeb outboxes) = 900 reads/s
      // Total = 1,201 SQL req/s!
      assert.strictEqual(hybrid.totalWritesPerS, 301);
      assert.strictEqual(hybrid.totalReadsPerS, 900);
      assert.strictEqual(hybrid.totalSqlReqPerS, 1201);

      // Verify >90% load compression
      assert.ok(hybrid.loadReductionVsOnReadPct > 91);
      assert.ok(hybrid.loadReductionVsOnWritePct > 94);
    });
  });

  describe("Module 3: ValkeyTimelineMixer & L1 Cache Optimization", () => {
    let mixer: ValkeyTimelineMixer;

    beforeEach(() => {
      mixer = new ValkeyTimelineMixer({
        maxInboxSize: 5, // small cap for testing
        celebrityCacheTtlMs: 2000,
      });
    });

    it("caps follower inbox ZSET to maxInboxSize using atomic Lua script", async () => {
      // Push 10 posts to user_123's inbox (maxInboxSize = 5)
      for (let i = 1; i <= 10; i++) {
        await mixer.pushToFollowerInboxes(
          {
            id: `post_${i}`,
            authorId: "author_test",
            createdAtMs: 1000 + i * 10,
          },
          ["user_123"]
        );
      }

      // Query inbox
      const timeline = await mixer.getHybridTimeline({
        userId: "user_123",
        limit: 10,
      });

      // Must be capped at exactly 5 items
      assert.strictEqual(timeline.items.length, 5);
      // Must retain the 5 newest items (post_10 down to post_6)
      const ids = timeline.items.map((i) => i.id);
      assert.deepStrictEqual(ids, [
        "post_10",
        "post_9",
        "post_8",
        "post_7",
        "post_6",
      ]);
    });

    it("compresses celebrity read load via L1 RAM cache (slashes 600 req/s to < 1 req/s)", async () => {
      await mixer.recordCelebrityPost({
        id: "celeb_post_viral",
        authorId: "celeb_taylor",
        createdAtMs: 5000,
      });

      // 50 concurrent timeline reads from different users following celeb_taylor
      for (let u = 0; u < 50; u++) {
        await mixer.getHybridTimeline({
          userId: `user_${u}`,
          followedCelebrityIds: ["celeb_taylor"],
          limit: 10,
        });
      }

      const stats = mixer.getStats();
      // First read should miss and hit Valkey
      assert.strictEqual(stats.celebrityL1CacheMisses, 1);
      assert.strictEqual(stats.celebrityValkeyReads, 1);
      // The remaining 49 reads must hit L1 RAM cache (0 Valkey reads)!
      assert.strictEqual(stats.celebrityL1CacheHits, 49);
    });
  });
});
