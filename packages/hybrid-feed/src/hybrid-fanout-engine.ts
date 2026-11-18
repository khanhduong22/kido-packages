/**
 * @file hybrid-fanout-engine.ts
 * @description Tier-1 Hybrid Fanout Engine (Push on Write for Normal Users, Pull on Read for Celebrities & Broadcasts)
 *
 * Architecture Invariants:
 * 1. Asymmetric Fanout: Normal users (< celebrityThreshold) execute fanout-on-write to followers.
 *    Celebrities and global broadcasts bypass inbox write amplification and write ONLY 1 row to outbox (1x write amp).
 * 2. Keyset K-Way Merge: Timeline reads merge 1 personal inbox + N followed celebrity outbox streams via Binary Max-Heap.
 * 3. Parameterized SQL with Strict Identifier Quoting: No SQL injection vulnerability in table/column names.
 * 4. Deterministic Level 22 Math: Mathematically proves 15,007 req/s (on-read) and 20,600 req/s (on-write) compress to 1,201 req/s (hybrid).
 */

import {
  FeedItem,
  kWayMergeFeeds,
  KWayMergeResult,
} from "./k-way-cursor-merger";

export type SqlDialect = "postgres" | "sqlite";

export interface HybridFanoutEngineOptions {
  celebrityThreshold?: number; // default: 500 (or 20,000 for GonnaCrash Level 22)
  inboxMaxBatchSize?: number; // default: 500
  dialect?: SqlDialect; // default: "postgres"
  inboxTableName?: string; // default: "user_inbox"
  celebrityOutboxTableName?: string; // default: "celebrity_outbox"
  broadcastOutboxTableName?: string; // default: "broadcast_outbox"
  dbExecutor?: (
    sql: string,
    params: (string | number | boolean | null)[]
  ) => Promise<void> | void;
}

export interface PublishPostInput<T = Record<string, unknown>> {
  id: string;
  authorId: string;
  createdAtMs?: number;
  payload?: T;
  isBroadcast?: boolean;
  followerIds?: ReadonlyArray<string>;
  followerCount?: number;
}

export interface PublishPostResult<T> {
  strategy: "pull_bypass" | "push_fanout";
  rowsWritten: number;
  batchesCount: number;
  item: FeedItem<T>;
  generatedSqlBatches: Array<{
    sql: string;
    params: (string | number | boolean | null)[];
  }>;
}

export interface ReadTimelineInput {
  userId: string;
  followedCelebrityIds?: ReadonlyArray<string>;
  includeBroadcasts?: boolean;
  limit?: number;
  cursor?: string | null;
  mutedAuthorIds?: ReadonlySet<string>;
  deletedItemIds?: ReadonlySet<string>;
}

export interface ReadTimelineResult<T> {
  items: FeedItem<T>[];
  nextCursor: string | null;
  metrics: {
    dbReads: number;
    inboxCount: number;
    celebrityOutboxCount: number;
    broadcastCount: number;
  };
  mergeStats: KWayMergeResult<T>["stats"];
}

export interface Level22LoadParams {
  normalPostRatePerS: number;
  normalFollowers: number;
  celebPostRatePerS: number;
  celebFollowers: number;
  timelineReadRatePerS: number;
  followedCelebsPerUser: number;
  mode: "on_read" | "on_write" | "hybrid";
}

export interface Level22LoadResult {
  mode: "on_read" | "on_write" | "hybrid";
  normalPostWritesPerS: number;
  celebPostWritesPerS: number;
  totalWritesPerS: number;
  inboxReadsPerS: number;
  celebReadsPerS: number;
  totalReadsPerS: number;
  totalSqlReqPerS: number;
  loadReductionVsOnReadPct: number;
  loadReductionVsOnWritePct: number;
}

/**
 * Validates that an SQL identifier matches strict safe characters.
 * Prevents SQL injection via dynamic table or column names.
 */
export function assertValidIdentifier(name: string): string {
  if (!name || typeof name !== "string") {
    throw new Error("SQL identifier must be a non-empty string");
  }
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(
      `Invalid SQL identifier: "${name}". Identifiers must match /^[a-zA-Z_][a-zA-Z0-9_]*$/ to prevent SQL injection.`
    );
  }
  return name;
}

/**
 * Quotes an SQL identifier according to the target SQL dialect.
 */
export function quoteIdentifier(name: string, _dialect: SqlDialect = "postgres"): string {
  return `"${assertValidIdentifier(name)}"`;
}

/**
 * Deterministic Capacity Calculator for GonnaCrash Level 22 Social Media Feed
 */
export function calculateLevel22SqlLoad(params: Level22LoadParams): Level22LoadResult {
  const {
    normalPostRatePerS,
    normalFollowers,
    celebPostRatePerS,
    celebFollowers,
    timelineReadRatePerS,
    followedCelebsPerUser,
    mode,
  } = params;

  let normalPostWritesPerS = 0;
  let celebPostWritesPerS = 0;
  let inboxReadsPerS = 0;
  let celebReadsPerS = 0;

  if (mode === "on_read") {
    // Pure Pull / Fanout-on-Read:
    // Write: 1 row per post
    normalPostWritesPerS = normalPostRatePerS * 1;
    celebPostWritesPerS = celebPostRatePerS * 1;

    // Read: Every timeline fetch queries all followed accounts (normalFollowers = 50)
    inboxReadsPerS = 0;
    celebReadsPerS = timelineReadRatePerS * normalFollowers;
  } else if (mode === "on_write") {
    // Pure Push / Fanout-on-Write:
    // Write: fanout to all followers
    normalPostWritesPerS = normalPostRatePerS * normalFollowers;
    celebPostWritesPerS = celebPostRatePerS * celebFollowers;

    // Read: single personal inbox query
    inboxReadsPerS = timelineReadRatePerS * 1;
    celebReadsPerS = 0;
  } else {
    // Hybrid Mode:
    // Normal writes fanout; celebrity writes bypass fanout (1 write)
    normalPostWritesPerS = normalPostRatePerS * normalFollowers;
    celebPostWritesPerS = celebPostRatePerS * 1;

    // Read: 1 personal inbox + followedCelebsPerUser outbox queries
    inboxReadsPerS = timelineReadRatePerS * 1;
    celebReadsPerS = timelineReadRatePerS * followedCelebsPerUser;
  }

  const totalWritesPerS = normalPostWritesPerS + celebPostWritesPerS;
  const totalReadsPerS = inboxReadsPerS + celebReadsPerS;
  const totalSqlReqPerS = totalWritesPerS + totalReadsPerS;

  // Baseline comparisons against pure on_read (15,007) and on_write (20,600)
  const onReadBaseline =
    normalPostRatePerS * 1 +
    celebPostRatePerS * 1 +
    timelineReadRatePerS * normalFollowers;
  const onWriteBaseline =
    normalPostRatePerS * normalFollowers +
    celebPostRatePerS * celebFollowers +
    timelineReadRatePerS * 1;

  const loadReductionVsOnReadPct =
    onReadBaseline > 0
      ? Number((((onReadBaseline - totalSqlReqPerS) / onReadBaseline) * 100).toFixed(2))
      : 0;

  const loadReductionVsOnWritePct =
    onWriteBaseline > 0
      ? Number((((onWriteBaseline - totalSqlReqPerS) / onWriteBaseline) * 100).toFixed(2))
      : 0;

  return {
    mode,
    normalPostWritesPerS,
    celebPostWritesPerS,
    totalWritesPerS,
    inboxReadsPerS,
    celebReadsPerS,
    totalReadsPerS,
    totalSqlReqPerS,
    loadReductionVsOnReadPct,
    loadReductionVsOnWritePct,
  };
}

/**
 * Hybrid Fanout Feed Engine
 */
export class HybridFanoutEngine<T = Record<string, unknown>> {
  public readonly celebrityThreshold: number;
  public readonly inboxMaxBatchSize: number;
  public readonly dialect: SqlDialect;
  public readonly inboxTableName: string;
  public readonly celebrityOutboxTableName: string;
  public readonly broadcastOutboxTableName: string;
  private readonly dbExecutor?: (
    sql: string,
    params: (string | number | boolean | null)[]
  ) => Promise<void> | void;

  // In-memory backing stores for standalone simulation, unit tests & Tier-0 SME mode
  private readonly userInboxes = new Map<string, FeedItem<T>[]>();
  private readonly celebrityOutboxes = new Map<string, FeedItem<T>[]>();
  private readonly broadcastOutbox: FeedItem<T>[] = [];

  constructor(options?: HybridFanoutEngineOptions) {
    this.celebrityThreshold = options?.celebrityThreshold ?? 500;
    this.inboxMaxBatchSize = options?.inboxMaxBatchSize ?? 500;
    this.dialect = options?.dialect ?? "postgres";
    this.inboxTableName = assertValidIdentifier(
      options?.inboxTableName ?? "user_inbox"
    );
    this.celebrityOutboxTableName = assertValidIdentifier(
      options?.celebrityOutboxTableName ?? "celebrity_outbox"
    );
    this.broadcastOutboxTableName = assertValidIdentifier(
      options?.broadcastOutboxTableName ?? "broadcast_outbox"
    );
    this.dbExecutor = options?.dbExecutor;
  }

  /**
   * Generates a parameterized SQL statement for bulk inserting feed items into user inboxes.
   */
  public buildBulkInboxInsertSql(
    items: Array<{
      userId: string;
      postId: string;
      authorId: string;
      createdAtMs: number;
      isCelebrity?: boolean;
    }>
  ): { sql: string; params: (string | number | boolean)[] } {
    if (items.length === 0) {
      return { sql: "", params: [] };
    }

    const table = quoteIdentifier(this.inboxTableName, this.dialect);
    const colUser = quoteIdentifier("user_id", this.dialect);
    const colPost = quoteIdentifier("post_id", this.dialect);
    const colAuthor = quoteIdentifier("author_id", this.dialect);
    const colCreated = quoteIdentifier("created_at_ms", this.dialect);
    const colIsCeleb = quoteIdentifier("is_celebrity", this.dialect);

    const params: (string | number | boolean)[] = [];
    const valuesClauses: string[] = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (this.dialect === "postgres") {
        const offset = i * 5;
        valuesClauses.push(
          `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5})`
        );
      } else {
        valuesClauses.push("(?, ?, ?, ?, ?)");
      }
      params.push(
        item.userId,
        item.postId,
        item.authorId,
        item.createdAtMs,
        Boolean(item.isCelebrity)
      );
    }

    let sql = "";
    if (this.dialect === "postgres") {
      sql = `INSERT INTO ${table} (${colUser}, ${colPost}, ${colAuthor}, ${colCreated}, ${colIsCeleb}) VALUES ${valuesClauses.join(
        ", "
      )} ON CONFLICT (${colUser}, ${colPost}) DO NOTHING;`;
    } else {
      sql = `INSERT OR IGNORE INTO ${table} (${colUser}, ${colPost}, ${colAuthor}, ${colCreated}, ${colIsCeleb}) VALUES ${valuesClauses.join(
        ", "
      )};`;
    }

    return { sql, params };
  }

  /**
   * Generates a parameterized SQL statement for inserting a celebrity or broadcast post into outbox.
   */
  public buildCelebrityOutboxInsertSql(
    item: {
      postId: string;
      authorId: string;
      createdAtMs: number;
      isBroadcast?: boolean;
      payloadJson?: string;
    },
    targetTable: string = this.celebrityOutboxTableName
  ): { sql: string; params: (string | number | boolean | null)[] } {
    const table = quoteIdentifier(targetTable, this.dialect);
    const colPost = quoteIdentifier("post_id", this.dialect);
    const colAuthor = quoteIdentifier("author_id", this.dialect);
    const colCreated = quoteIdentifier("created_at_ms", this.dialect);
    const colIsBroadcast = quoteIdentifier("is_broadcast", this.dialect);
    const colPayload = quoteIdentifier("payload", this.dialect);

    const params: (string | number | boolean | null)[] = [
      item.postId,
      item.authorId,
      item.createdAtMs,
      Boolean(item.isBroadcast),
      item.payloadJson ?? null,
    ];

    let sql = "";
    if (this.dialect === "postgres") {
      sql = `INSERT INTO ${table} (${colPost}, ${colAuthor}, ${colCreated}, ${colIsBroadcast}, ${colPayload}) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (${colPost}) DO NOTHING;`;
    } else {
      sql = `INSERT OR IGNORE INTO ${table} (${colPost}, ${colAuthor}, ${colCreated}, ${colIsBroadcast}, ${colPayload}) VALUES (?, ?, ?, ?, ?);`;
    }

    return { sql, params };
  }

  /**
   * Publishes a post using the hybrid fanout policy:
   * - If isBroadcast is true OR followerCount >= celebrityThreshold:
   *   writes ONLY 1 row to the outbox (pull bypass).
   * - Otherwise:
   *   fans out to followerIds in chunks of inboxMaxBatchSize (push).
   */
  public async publishPost(input: PublishPostInput<T>): Promise<PublishPostResult<T>> {
    const createdAtMs = input.createdAtMs ?? Date.now();
    const effectiveFollowerCount =
      input.followerCount ?? input.followerIds?.length ?? 0;
    const isCelebrity =
      Boolean(input.isBroadcast) ||
      effectiveFollowerCount >= this.celebrityThreshold;

    const feedItem: FeedItem<T> = {
      id: input.id,
      authorId: input.authorId,
      createdAtMs,
      payload: input.payload,
      isCelebrity,
      isBroadcast: Boolean(input.isBroadcast),
    };

    const generatedSqlBatches: Array<{
      sql: string;
      params: (string | number | boolean | null)[];
    }> = [];

    if (input.isBroadcast) {
      // 1. Broadcast Post: Bypass all user inboxes, write 1 row to broadcast outbox
      this.broadcastOutbox.unshift(feedItem);
      const sqlObj = this.buildCelebrityOutboxInsertSql(
        {
          postId: feedItem.id,
          authorId: feedItem.authorId,
          createdAtMs: feedItem.createdAtMs,
          isBroadcast: true,
          payloadJson: feedItem.payload ? JSON.stringify(feedItem.payload) : undefined,
        },
        this.broadcastOutboxTableName
      );
      generatedSqlBatches.push(sqlObj);

      if (this.dbExecutor) {
        await this.dbExecutor(sqlObj.sql, sqlObj.params);
      }

      return {
        strategy: "pull_bypass",
        rowsWritten: 1,
        batchesCount: 1,
        item: feedItem,
        generatedSqlBatches,
      };
    }

    if (isCelebrity) {
      // 2. Celebrity Post: Bypass user inboxes, write 1 row to celebrity outbox
      let celebStream = this.celebrityOutboxes.get(input.authorId);
      if (!celebStream) {
        celebStream = [];
        this.celebrityOutboxes.set(input.authorId, celebStream);
      }
      celebStream.unshift(feedItem);

      const sqlObj = this.buildCelebrityOutboxInsertSql({
        postId: feedItem.id,
        authorId: feedItem.authorId,
        createdAtMs: feedItem.createdAtMs,
        isBroadcast: false,
        payloadJson: feedItem.payload ? JSON.stringify(feedItem.payload) : undefined,
      });
      generatedSqlBatches.push(sqlObj);

      if (this.dbExecutor) {
        await this.dbExecutor(sqlObj.sql, sqlObj.params);
      }

      return {
        strategy: "pull_bypass",
        rowsWritten: 1,
        batchesCount: 1,
        item: feedItem,
        generatedSqlBatches,
      };
    }

    // 3. Normal Post: Push fanout into follower inboxes in batches of inboxMaxBatchSize
    const followerIds = input.followerIds ?? [];
    let rowsWritten = 0;
    let batchesCount = 0;

    for (let i = 0; i < followerIds.length; i += this.inboxMaxBatchSize) {
      const chunk = followerIds.slice(i, i + this.inboxMaxBatchSize);
      batchesCount++;

      const batchItems = chunk.map((followerId) => {
        // In-memory store update
        let inbox = this.userInboxes.get(followerId);
        if (!inbox) {
          inbox = [];
          this.userInboxes.set(followerId, inbox);
        }
        inbox.unshift(feedItem);

        return {
          userId: followerId,
          postId: feedItem.id,
          authorId: feedItem.authorId,
          createdAtMs: feedItem.createdAtMs,
          isCelebrity: false,
        };
      });

      const sqlObj = this.buildBulkInboxInsertSql(batchItems);
      generatedSqlBatches.push(sqlObj);

      if (this.dbExecutor) {
        await this.dbExecutor(sqlObj.sql, sqlObj.params);
      }

      rowsWritten += chunk.length;
    }

    return {
      strategy: "push_fanout",
      rowsWritten,
      batchesCount,
      item: feedItem,
      generatedSqlBatches,
    };
  }

  /**
   * Reads a user's unified timeline by fetching:
   * - 1 personal inbox stream (`user_inbox`)
   * - N celebrity outbox streams (`celebrity_outbox`) for followed celebrities
   * - 1 broadcast outbox stream (if includeBroadcasts is true)
   * And merges them using the K-Way Max-Heap Merger.
   */
  public readTimeline(input: ReadTimelineInput): ReadTimelineResult<T> {
    const streams: Array<ReadonlyArray<FeedItem<T>>> = [];
    let dbReads = 0;

    // 1. Personal Inbox Stream (1 DB read)
    const personalInbox = this.userInboxes.get(input.userId) ?? [];
    streams.push(personalInbox);
    dbReads++;

    // 2. Followed Celebrity Streams (N DB reads)
    let celebrityOutboxCount = 0;
    const followedCelebs = input.followedCelebrityIds ?? [];
    for (const celebId of followedCelebs) {
      const celebStream = this.celebrityOutboxes.get(celebId) ?? [];
      celebrityOutboxCount += celebStream.length;
      streams.push(celebStream);
      dbReads++;
    }

    // 3. System Broadcasts (1 DB read if enabled)
    let broadcastCount = 0;
    if (input.includeBroadcasts) {
      broadcastCount = this.broadcastOutbox.length;
      streams.push(this.broadcastOutbox);
      dbReads++;
    }

    const mergeResult = kWayMergeFeeds(streams, {
      limit: input.limit ?? 20,
      cursor: input.cursor,
      mutedAuthorIds: input.mutedAuthorIds,
      deletedItemIds: input.deletedItemIds,
    });

    return {
      items: mergeResult.items,
      nextCursor: mergeResult.nextCursor,
      metrics: {
        dbReads,
        inboxCount: personalInbox.length,
        celebrityOutboxCount,
        broadcastCount,
      },
      mergeStats: mergeResult.stats,
    };
  }

  // Internal test helpers to inspect state
  public getUserInbox(userId: string): FeedItem<T>[] {
    return this.userInboxes.get(userId) ?? [];
  }

  public getCelebrityOutbox(authorId: string): FeedItem<T>[] {
    return this.celebrityOutboxes.get(authorId) ?? [];
  }

  public getBroadcastOutbox(): FeedItem<T>[] {
    return this.broadcastOutbox;
  }

  public clear(): void {
    this.userInboxes.clear();
    this.celebrityOutboxes.clear();
    this.broadcastOutbox.length = 0;
  }
}
