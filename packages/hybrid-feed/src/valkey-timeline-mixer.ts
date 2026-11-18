/**
 * @file valkey-timeline-mixer.ts
 * @description Tier-2 Valkey/Redis Capped ZSET Timeline Mixer with Atomic Lua Capping and L1 Celebrity Cache
 *
 * Architecture Invariants:
 * 1. Atomic Lua ZSET Capping: Caps follower inboxes to maxInboxSize (800 items, Twitter/X production standard)
 *    and applies TTL expiration via single atomic Lua script (LUA_ZADD_CAPPED_TIMELINE).
 * 2. L1 In-Memory Celebrity Cache: Caches celebrity outboxes in RAM with TTL (default 5000ms),
 *    compressing GonnaCrash Level 22's 600 celebrity reads/s down to < 1 read/s (> 99.8% hit rate).
 * 3. K-Way Heap Timeline Fusion: Merges Valkey-cached user inbox with L1-cached celebrity outboxes in O(N log K).
 */

import {
  FeedItem,
  kWayMergeFeeds,
  KWayMergeResult,
  TimelineCursor,
} from "./k-way-cursor-merger";

/**
 * Atomic Lua script to insert a feed item, cap the ZSET size to maxInboxSize, and refresh TTL.
 *
 * KEYS[1] = Timeline ZSET key (e.g. "feed:inbox:user_123")
 * ARGV[1] = score (createdAtMs)
 * ARGV[2] = member (serialized FeedItem JSON)
 * ARGV[3] = maxInboxSize (e.g. 800)
 * ARGV[4] = ttlSeconds (e.g. 604800)
 */
export const LUA_ZADD_CAPPED_TIMELINE = `
redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])
local count = redis.call('ZCARD', KEYS[1])
local maxCap = tonumber(ARGV[3])
if maxCap and maxCap > 0 and count > maxCap then
  -- Oldest elements have the lowest scores (ranks 0 .. count - maxCap - 1)
  redis.call('ZREMRANGEBYRANK', KEYS[1], 0, count - maxCap - 1)
  count = maxCap
end
if ARGV[4] and tonumber(ARGV[4]) > 0 then
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[4]))
end
return count
`.trim();

export interface ValkeyTimelineMixerOptions {
  valkeyStore?: InMemoryValkeyTimelineStore;
  maxInboxSize?: number; // default: 800
  inboxTtlSeconds?: number; // default: 604800 (7 days)
  celebrityCacheTtlMs?: number; // default: 5000 (5s)
  keyPrefix?: string; // default: "kido:feed"
}

export interface ValkeyTimelineMixerStats {
  celebrityL1CacheHits: number;
  celebrityL1CacheMisses: number;
  celebrityValkeyReads: number;
  inboxValkeyReads: number;
  inboxPushesExecuted: number;
  celebrityPostsRecorded: number;
}

export interface HybridTimelineParams {
  userId: string;
  followedCelebrityIds?: ReadonlyArray<string>;
  limit?: number;
  cursor?: string | TimelineCursor | null;
  mutedAuthorIds?: ReadonlySet<string>;
  deletedItemIds?: ReadonlySet<string>;
}

export interface HybridTimelineOutput<T> {
  items: FeedItem<T>[];
  nextCursor: string | null;
  stats: KWayMergeResult<T>["stats"];
  mixerStats: {
    l1CacheHits: number;
    l1CacheMisses: number;
    valkeyReads: number;
    l1HitRatioPct: number;
  };
}

/**
 * Pure TypeScript In-Memory Valkey/Redis Simulator
 * Accurately models ZSET score ordering, ranking, and atomic Lua script execution.
 */
export class InMemoryValkeyTimelineStore {
  private readonly zsets = new Map<string, Map<string, number>>();
  private readonly ttls = new Map<string, number>();

  public zadd(key: string, score: number, member: string): number {
    let set = this.zsets.get(key);
    if (!set) {
      set = new Map<string, number>();
      this.zsets.set(key, set);
    }
    const isNew = !set.has(member);
    set.set(member, score);
    return isNew ? 1 : 0;
  }

  public zcard(key: string): number {
    return this.zsets.get(key)?.size ?? 0;
  }

  public zremrangebyrank(key: string, start: number, stop: number): number {
    const set = this.zsets.get(key);
    if (!set || set.size === 0) return 0;

    // Sort ascending by score, member tie-breaker
    const entries = Array.from(set.entries()).sort((a, b) => {
      if (a[1] !== b[1]) return a[1] - b[1];
      return a[0].localeCompare(b[0]);
    });

    const len = entries.length;
    const actualStart = start < 0 ? Math.max(0, len + start) : start;
    const actualStop = stop < 0 ? Math.max(0, len + stop) : Math.min(len - 1, stop);

    if (actualStart > actualStop || actualStart >= len) {
      return 0;
    }

    let removed = 0;
    for (let i = actualStart; i <= actualStop; i++) {
      if (set.delete(entries[i][0])) {
        removed++;
      }
    }
    return removed;
  }

  public zrevrange(key: string, start: number, stop: number): string[] {
    const set = this.zsets.get(key);
    if (!set || set.size === 0) return [];

    // Sort descending by score, member tie-breaker
    const entries = Array.from(set.entries()).sort((a, b) => {
      if (a[1] !== b[1]) return b[1] - a[1];
      return b[0].localeCompare(a[0]);
    });

    const len = entries.length;
    const actualStart = start < 0 ? Math.max(0, len + start) : start;
    const actualStop = stop < 0 ? Math.max(0, len + stop) : Math.min(len - 1, stop);

    if (actualStart > actualStop || actualStart >= len) {
      return [];
    }

    return entries.slice(actualStart, actualStop + 1).map((e) => e[0]);
  }

  public expire(key: string, seconds: number): number {
    this.ttls.set(key, Date.now() + seconds * 1000);
    return 1;
  }

  public eval(
    script: string,
    _numkeys: number,
    keys: string[],
    args: (string | number)[]
  ): number {
    if (script === LUA_ZADD_CAPPED_TIMELINE || script.includes("ZREMRANGEBYRANK")) {
      const key = keys[0];
      const score = Number(args[0]);
      const member = String(args[1]);
      const maxCap = Number(args[2]);
      const ttlSec = args[3] !== undefined ? Number(args[3]) : 0;

      this.zadd(key, score, member);
      const count = this.zcard(key);
      if (maxCap > 0 && count > maxCap) {
        this.zremrangebyrank(key, 0, count - maxCap - 1);
      }
      if (ttlSec > 0) {
        this.expire(key, ttlSec);
      }
      return this.zcard(key);
    }
    throw new Error("Unsupported Lua script in InMemoryValkeyTimelineStore");
  }

  public clear(): void {
    this.zsets.clear();
    this.ttls.clear();
  }
}

/**
 * Valkey Timeline Mixer with L1 RAM Cache for Celebrities
 */
export class ValkeyTimelineMixer<T = Record<string, unknown>> {
  public readonly valkey: InMemoryValkeyTimelineStore;
  public readonly maxInboxSize: number;
  public readonly inboxTtlSeconds: number;
  public readonly celebrityCacheTtlMs: number;
  public readonly keyPrefix: string;

  private readonly celebrityL1Cache = new Map<
    string,
    { items: FeedItem<T>[]; timestamp: number }
  >();

  private readonly stats: ValkeyTimelineMixerStats = {
    celebrityL1CacheHits: 0,
    celebrityL1CacheMisses: 0,
    celebrityValkeyReads: 0,
    inboxValkeyReads: 0,
    inboxPushesExecuted: 0,
    celebrityPostsRecorded: 0,
  };

  constructor(options?: ValkeyTimelineMixerOptions) {
    this.valkey = options?.valkeyStore ?? new InMemoryValkeyTimelineStore();
    this.maxInboxSize = options?.maxInboxSize ?? 800;
    this.inboxTtlSeconds = options?.inboxTtlSeconds ?? 604800; // 7 days
    this.celebrityCacheTtlMs = options?.celebrityCacheTtlMs ?? 5000; // 5 seconds
    this.keyPrefix = options?.keyPrefix ?? "kido:feed";
  }

  /**
   * Pushes a normal post to each follower's capped Valkey inbox ZSET.
   * Atomic Lua script caps ZSET to maxInboxSize (800 items).
   */
  public async pushToFollowerInboxes(
    item: FeedItem<T>,
    followerIds: ReadonlyArray<string>
  ): Promise<{ pushedCount: number }> {
    const serialized = JSON.stringify(item);

    for (const followerId of followerIds) {
      const inboxKey = `${this.keyPrefix}:inbox:${followerId}`;
      this.valkey.eval(
        LUA_ZADD_CAPPED_TIMELINE,
        1,
        [inboxKey],
        [item.createdAtMs, serialized, this.maxInboxSize, this.inboxTtlSeconds]
      );
      this.stats.inboxPushesExecuted++;
    }

    return { pushedCount: followerIds.length };
  }

  /**
   * Records a celebrity post into Valkey celebrity outbox and updates the L1 cache.
   */
  public async recordCelebrityPost(item: FeedItem<T>): Promise<void> {
    const celebKey = `${this.keyPrefix}:celeb:${item.authorId}`;
    const serialized = JSON.stringify(item);

    this.valkey.zadd(celebKey, item.createdAtMs, serialized);
    this.stats.celebrityPostsRecorded++;

    // Invalidate L1 cache for this celebrity so subsequent reads pick up the latest post
    this.celebrityL1Cache.delete(item.authorId);
  }

  /**
   * Fetches a celebrity outbox with L1 TTL in-memory caching.
   * Compresses 600 req/s down to < 1 req/s at GonnaCrash Level 22 scale.
   */
  public async getCelebrityOutbox(authorId: string): Promise<FeedItem<T>[]> {
    const now = Date.now();
    const cached = this.celebrityL1Cache.get(authorId);

    if (cached && now - cached.timestamp < this.celebrityCacheTtlMs) {
      this.stats.celebrityL1CacheHits++;
      return cached.items;
    }

    this.stats.celebrityL1CacheMisses++;
    this.stats.celebrityValkeyReads++;

    const celebKey = `${this.keyPrefix}:celeb:${authorId}`;
    const rawMembers = this.valkey.zrevrange(celebKey, 0, 100);
    const items = rawMembers.map((m) => JSON.parse(m) as FeedItem<T>);

    this.celebrityL1Cache.set(authorId, { items, timestamp: now });
    return items;
  }

  /**
   * Fetches a user's hybrid timeline:
   * 1. Reads personal capped inbox ZSET from Valkey.
   * 2. Reads followed celebrity outboxes through L1 RAM cache.
   * 3. Merges all streams in O(N log K) via Binary Max-Heap.
   */
  public async getHybridTimeline(
    params: HybridTimelineParams
  ): Promise<HybridTimelineOutput<T>> {
    const limit = params.limit ?? 20;

    // 1. Fetch personal inbox from Valkey
    const inboxKey = `${this.keyPrefix}:inbox:${params.userId}`;
    this.stats.inboxValkeyReads++;
    const rawInbox = this.valkey.zrevrange(inboxKey, 0, limit * 3);
    const personalInbox = rawInbox.map((m) => JSON.parse(m) as FeedItem<T>);

    const streams: Array<ReadonlyArray<FeedItem<T>>> = [personalInbox];

    // 2. Fetch followed celebrities through L1 Cache
    const followedCelebs = params.followedCelebrityIds ?? [];
    for (const celebId of followedCelebs) {
      const celebStream = await this.getCelebrityOutbox(celebId);
      streams.push(celebStream);
    }

    // 3. Merge K streams via Binary Max-Heap
    const mergeResult = kWayMergeFeeds(streams, {
      limit,
      cursor: params.cursor,
      mutedAuthorIds: params.mutedAuthorIds,
      deletedItemIds: params.deletedItemIds,
    });

    const totalL1Lookups =
      this.stats.celebrityL1CacheHits + this.stats.celebrityL1CacheMisses;
    const l1HitRatioPct =
      totalL1Lookups > 0
        ? Number(
            ((this.stats.celebrityL1CacheHits / totalL1Lookups) * 100).toFixed(2)
          )
        : 100;

    return {
      items: mergeResult.items,
      nextCursor: mergeResult.nextCursor,
      stats: mergeResult.stats,
      mixerStats: {
        l1CacheHits: this.stats.celebrityL1CacheHits,
        l1CacheMisses: this.stats.celebrityL1CacheMisses,
        valkeyReads:
          this.stats.inboxValkeyReads + this.stats.celebrityValkeyReads,
        l1HitRatioPct,
      },
    };
  }

  public getStats(): ValkeyTimelineMixerStats {
    return { ...this.stats };
  }

  public clear(): void {
    this.valkey.clear();
    this.celebrityL1Cache.clear();
    this.stats.celebrityL1CacheHits = 0;
    this.stats.celebrityL1CacheMisses = 0;
    this.stats.celebrityValkeyReads = 0;
    this.stats.inboxValkeyReads = 0;
    this.stats.inboxPushesExecuted = 0;
    this.stats.celebrityPostsRecorded = 0;
  }
}
