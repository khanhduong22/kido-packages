/**
 * Application-Level & Proxy Hash Sharding Router (DDIA Ch.6)
 * Pattern: Shopee / GitHub / Vitess / Citus / Shopify
 *
 * Directs entity queries (e.g. buyer_id, shop_id, customer_phone, tenant_id)
 * to a deterministic shard ID via `murmur3(key) % N`.
 *
 * Invariants:
 * - Single-Shard Routing: Queries with shard key hit exactly 1 physical shard (zero cross-node joins).
 * - Scatter-Gather Routing: Queries without shard key broadcast across all N shards with audit warning.
 */

import { getShardId, murmurhash3_32, toHexHash } from "./murmurhash";

export interface ShardNode<TShardMeta = unknown> {
  id: number;
  name: string;
  meta?: TShardMeta;
}

export interface ShardRouteResult<TShardMeta = unknown> {
  shardId: number;
  shard: ShardNode<TShardMeta>;
  entityKey: string;
  hash: number;
  hexHash: string;
  isScatterGather: false;
}

export interface ScatterGatherRouteResult<TShardMeta = unknown> {
  shards: ShardNode<TShardMeta>[];
  totalShards: number;
  isScatterGather: true;
  warning: string;
}

export interface HashShardRouterOptions<TShardMeta = unknown> {
  /**
   * Number of shards (e.g. 4 -> shard_0..shard_3) or explicit ShardNode array.
   */
  shards: number | ShardNode<TShardMeta>[];
  /**
   * Optional seed for MurmurHash3 (default 0).
   */
  seed?: number;
  /**
   * Prefix for automatically generated shard names (default: "shard").
   */
  namePrefix?: string;
}

export class HashShardRouter<TShardMeta = unknown> {
  private readonly shardList: ShardNode<TShardMeta>[];
  private readonly shardMap: Map<number, ShardNode<TShardMeta>>;
  private readonly seed: number;

  constructor(options: HashShardRouterOptions<TShardMeta>) {
    this.seed = options.seed ?? 0;
    const prefix = options.namePrefix ?? "shard";

    if (typeof options.shards === "number") {
      if (options.shards <= 0 || !Number.isInteger(options.shards)) {
        throw new Error(`Total shards count must be a positive integer, received: ${options.shards}`);
      }
      this.shardList = Array.from({ length: options.shards }, (_, i) => ({
        id: i,
        name: `${prefix}_${i}`,
      }));
    } else if (Array.isArray(options.shards)) {
      if (options.shards.length === 0) {
        throw new Error("Shard array must contain at least 1 shard node.");
      }
      this.shardList = options.shards.map((s, idx) => ({
        id: s.id ?? idx,
        name: s.name || `${prefix}_${idx}`,
        meta: s.meta,
      }));
    } else {
      throw new Error("Invalid shards option: expected positive integer or non-empty array of ShardNodes.");
    }

    this.shardMap = new Map();
    for (const shard of this.shardList) {
      this.shardMap.set(shard.id, shard);
    }
  }

  /**
   * Resolves a deterministic single shard for the given entity key.
   *
   * @param entityKey Partition key (e.g., customerPhone, shopId, buyerId)
   * @returns Route result containing target shard and cryptographic hash metadata
   */
  public resolveShard(entityKey: string): ShardRouteResult<TShardMeta> {
    const rawKey = String(entityKey ?? "");
    const hash = murmurhash3_32(rawKey, this.seed);
    const shardIndex = hash % this.shardList.length;
    const shard = this.shardList[shardIndex];

    return {
      shardId: shard.id,
      shard,
      entityKey: rawKey,
      hash,
      hexHash: toHexHash(hash),
      isScatterGather: false,
    };
  }

  /**
   * Emits scatter-gather routing instructions when a query lacks the partition key.
   * Broadcaster queries all shards in parallel.
   */
  public resolveAllShards(): ScatterGatherRouteResult<TShardMeta> {
    return {
      shards: [...this.shardList],
      totalShards: this.shardList.length,
      isScatterGather: true,
      warning: `Scatter-gather query executed: query lacks shard key, broadcasting across all ${this.shardList.length} shards. Optimize with shard key to avoid cross-shard latency.`,
    };
  }

  /**
   * Retrieves shard by its integer ID.
   */
  public getShard(shardId: number): ShardNode<TShardMeta> | undefined {
    return this.shardMap.get(shardId);
  }

  /**
   * Returns list of all configured shard nodes.
   */
  public getAllShards(): ShardNode<TShardMeta>[] {
    return [...this.shardList];
  }

  /**
   * Returns total count of shards.
   */
  public getShardCount(): number {
    return this.shardList.length;
  }

  /**
   * Returns complete topology overview.
   */
  public getTopology(): { totalShards: number; shards: ShardNode<TShardMeta>[]; seed: number } {
    return {
      totalShards: this.shardList.length,
      shards: [...this.shardList],
      seed: this.seed,
    };
  }
}
