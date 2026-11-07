/**
 * Consistent Hash Ring with Virtual Nodes (DDIA Ch.6)
 * Pattern: Discord / ScyllaDB / Cassandra / DynamoDB / Netflix / Amazon Dynamo
 *
 * Distributes keys across a 2^32 token ring using deterministic MurmurHash3
 * and virtual nodes (vnodes) to achieve uniform load distribution.
 *
 * Key Invariants:
 * - Minimal Rebalancing: When adding/removing 1 node from N nodes, only ~1/N keys move (vs ~(N-1)/N in naive modulo).
 * - Replica Placement: Clockwise traversal guarantees distinct physical nodes for RF=3.
 * - Discord Hot-Spot Protection: Compound (entity_id, time_bucket) keys prevent flash-sale hotspotting.
 */

import { murmurhash3_32 } from "./murmurhash";

export interface VirtualNodeEntry {
  token: number;
  nodeId: string;
  vnodeIndex: number;
}

export interface RingDistributionReport {
  totalKeys: number;
  totalPhysicalNodes: number;
  totalVirtualNodes: number;
  nodeCounts: Record<string, number>;
  nodePercentages: Record<string, number>;
  expectedPercentagePerNode: number;
  stdDevPercent: number;
  minCount: number;
  maxCount: number;
  maxToMinRatio: number;
}

export interface ConsistentHashRingOptions<TNodeMeta = unknown> {
  /**
   * Number of virtual nodes per physical node (default: 150).
   * 150 vnodes achieves stddev < 3% across random keys.
   */
  vnodesPerNode?: number;
  /**
   * Hash seed for MurmurHash3 (default: 0).
   */
  seed?: number;
  /**
   * Initial list of physical node identifiers.
   */
  nodes?: string[];
  /**
   * Optional metadata mapped by nodeId.
   */
  nodeMetadata?: Record<string, TNodeMeta>;
}

export class ConsistentHashRing<TNodeMeta = unknown> {
  private readonly vnodesPerNode: number;
  private readonly seed: number;
  private readonly physicalNodes: Set<string>;
  private readonly metadata: Map<string, TNodeMeta>;
  private ring: VirtualNodeEntry[];

  constructor(options: ConsistentHashRingOptions<TNodeMeta> = {}) {
    this.vnodesPerNode = options.vnodesPerNode ?? 150;
    this.seed = options.seed ?? 0;
    this.physicalNodes = new Set();
    this.metadata = new Map();
    this.ring = [];

    if (this.vnodesPerNode <= 0 || !Number.isInteger(this.vnodesPerNode)) {
      throw new Error(`vnodesPerNode must be a positive integer, received: ${this.vnodesPerNode}`);
    }

    if (options.nodeMetadata) {
      for (const [id, meta] of Object.entries(options.nodeMetadata)) {
        this.metadata.set(id, meta);
      }
    }

    if (options.nodes) {
      for (const node of options.nodes) {
        this.addNode(node, this.metadata.get(node));
      }
    }
  }

  /**
   * Adds a physical node to the hash ring with its corresponding virtual nodes.
   *
   * @param nodeId Unique physical node identifier (e.g. "shard_0", "pg_replica_1")
   * @param meta Optional metadata associated with the node
   */
  public addNode(nodeId: string, meta?: TNodeMeta): this {
    if (!nodeId || typeof nodeId !== "string") {
      throw new Error("nodeId must be a non-empty string");
    }

    if (this.physicalNodes.has(nodeId)) {
      if (meta !== undefined) this.metadata.set(nodeId, meta);
      return this;
    }

    this.physicalNodes.add(nodeId);
    if (meta !== undefined) {
      this.metadata.set(nodeId, meta);
    }

    const newVnodes: VirtualNodeEntry[] = [];
    for (let v = 0; v < this.vnodesPerNode; v++) {
      const vnodeKey = `${nodeId}#vn_${v}`;
      const token = murmurhash3_32(vnodeKey, this.seed);
      newVnodes.push({ token, nodeId, vnodeIndex: v });
    }

    this.ring.push(...newVnodes);
    this.ring.sort((a, b) => a.token - b.token);

    return this;
  }

  /**
   * Removes a physical node and all its virtual nodes from the ring.
   *
   * @param nodeId Physical node identifier
   */
  public removeNode(nodeId: string): this {
    if (!this.physicalNodes.has(nodeId)) {
      return this;
    }

    this.physicalNodes.delete(nodeId);
    this.metadata.delete(nodeId);
    this.ring = this.ring.filter((entry) => entry.nodeId !== nodeId);

    return this;
  }

  /**
   * Checks whether a physical node exists in the ring.
   */
  public hasNode(nodeId: string): boolean {
    return this.physicalNodes.has(nodeId);
  }

  /**
   * Returns all registered physical nodes.
   */
  public getNodes(): string[] {
    return Array.from(this.physicalNodes);
  }

  /**
   * Returns total count of virtual nodes in the ring.
   */
  public getVirtualNodeCount(): number {
    return this.ring.length;
  }

  /**
   * Resolves the primary physical node for a given key using binary search on the token ring.
   * Complexity: O(log V) where V = nodes * vnodesPerNode.
   *
   * @param key Entity key or composite partition key
   * @returns Primary physical node ID
   */
  public getNode(key: string): string {
    if (this.ring.length === 0) {
      throw new Error("ConsistentHashRing is empty. Add at least 1 node before resolving keys.");
    }

    const token = murmurhash3_32(String(key ?? ""), this.seed);
    const index = this.findClosestClockwiseIndex(token);
    return this.ring[index].nodeId;
  }

  /**
   * Returns replicationFactor distinct physical replica nodes for a key by walking clockwise.
   * Simulates ScyllaDB / Cassandra replica set placement.
   *
   * @param key Entity key
   * @param replicationFactor Number of distinct physical nodes to replicate to
   * @returns Array of unique physical node IDs (ordered by ring proximity)
   */
  public getReplicaNodes(key: string, replicationFactor: number): string[] {
    if (this.ring.length === 0) {
      throw new Error("ConsistentHashRing is empty. Add at least 1 node before resolving replicas.");
    }
    if (replicationFactor <= 0) {
      throw new Error(`replicationFactor must be > 0, received: ${replicationFactor}`);
    }

    const targetCount = Math.min(replicationFactor, this.physicalNodes.size);
    const token = murmurhash3_32(String(key ?? ""), this.seed);
    const startIndex = this.findClosestClockwiseIndex(token);

    const replicas: string[] = [];
    const seen = new Set<string>();

    for (let i = 0; i < this.ring.length && replicas.length < targetCount; i++) {
      const idx = (startIndex + i) % this.ring.length;
      const nodeId = this.ring[idx].nodeId;
      if (!seen.has(nodeId)) {
        seen.add(nodeId);
        replicas.push(nodeId);
      }
    }

    return replicas;
  }

  /**
   * Discord Hot-Spot Protection: Compound Bucketed Key Builder.
   *
   * Discord Pattern: When 1 channel or shop receives millions of events (e.g. Flash Sale on Shop #264725277),
   * partitioning strictly by `entityId` creates a burning hot shard that overloads single disk/CPU.
   * By combining `entityId` with a coarse time bucket, writes spread across time buckets while
   * recent queries scan only the current bucket!
   *
   * @param entityId Entity partition key (e.g., "shop_264725277", "channel_102938")
   * @param timestamp Date, unix timestamp ms, or ISO string
   * @param bucketWindowMs Bucket window duration in milliseconds (default: 864,000,000 ms = 10 days)
   * @returns Bucketed key formatted as `${entityId}:bucket_${bucketIndex}`
   */
  public static buildDiscordBucketKey(
    entityId: string,
    timestamp: Date | number | string = new Date(),
    bucketWindowMs: number = 864_000_000
  ): string {
    let timeMs: number;
    if (timestamp instanceof Date) {
      timeMs = timestamp.getTime();
    } else if (typeof timestamp === "number") {
      timeMs = timestamp;
    } else {
      timeMs = new Date(timestamp).getTime();
    }

    if (isNaN(timeMs)) {
      timeMs = Date.now();
    }

    const bucketIndex = Math.floor(timeMs / bucketWindowMs);
    return `${entityId}:bucket_${bucketIndex}`;
  }

  /**
   * Instance helper for buildDiscordBucketKey.
   */
  public buildDiscordBucketKey(
    entityId: string,
    timestamp: Date | number | string = new Date(),
    bucketWindowMs: number = 864_000_000
  ): string {
    return ConsistentHashRing.buildDiscordBucketKey(entityId, timestamp, bucketWindowMs);
  }

  /**
   * Analyzes statistical balance of keys across the physical nodes in the ring.
   * Returns standard deviation and min/max load distribution.
   *
   * @param sampleKeys Array of representative keys to route through the ring
   */
  public analyzeRingDistribution(sampleKeys: string[]): RingDistributionReport {
    if (this.physicalNodes.size === 0) {
      throw new Error("Cannot analyze ring distribution on an empty ring.");
    }

    const nodeCounts: Record<string, number> = {};
    for (const node of this.physicalNodes) {
      nodeCounts[node] = 0;
    }

    for (const key of sampleKeys) {
      const node = this.getNode(key);
      nodeCounts[node] = (nodeCounts[node] || 0) + 1;
    }

    const totalKeys = sampleKeys.length;
    const nodePercentages: Record<string, number> = {};
    const counts = Object.values(nodeCounts);
    const expectedPercentage = totalKeys > 0 ? 100 / this.physicalNodes.size : 0;

    let varianceSum = 0;
    for (const [node, count] of Object.entries(nodeCounts)) {
      const pct = totalKeys > 0 ? (count / totalKeys) * 100 : 0;
      nodePercentages[node] = Number(pct.toFixed(2));
      const diff = pct - expectedPercentage;
      varianceSum += diff * diff;
    }

    const variance = this.physicalNodes.size > 0 ? varianceSum / this.physicalNodes.size : 0;
    const stdDevPercent = Number(Math.sqrt(variance).toFixed(2));
    const minCount = counts.length > 0 ? Math.min(...counts) : 0;
    const maxCount = counts.length > 0 ? Math.max(...counts) : 0;
    const maxToMinRatio = minCount > 0 ? Number((maxCount / minCount).toFixed(2)) : Infinity;

    return {
      totalKeys,
      totalPhysicalNodes: this.physicalNodes.size,
      totalVirtualNodes: this.ring.length,
      nodeCounts,
      nodePercentages,
      expectedPercentagePerNode: Number(expectedPercentage.toFixed(2)),
      stdDevPercent,
      minCount,
      maxCount,
      maxToMinRatio,
    };
  }

  /**
   * Binary search for the first virtual node whose token >= searchToken.
   * Wraps around clockwise to 0 if searchToken exceeds the highest ring token.
   */
  private findClosestClockwiseIndex(searchToken: number): number {
    let low = 0;
    let high = this.ring.length - 1;

    // Past the end of ring: wrap around to index 0
    if (searchToken > this.ring[high].token) {
      return 0;
    }

    let result = 0;
    while (low <= high) {
      const mid = (low + high) >>> 1;
      if (this.ring[mid].token >= searchToken) {
        result = mid;
        high = mid - 1; // explore earlier matching positions
      } else {
        low = mid + 1;
      }
    }

    return result;
  }
}
