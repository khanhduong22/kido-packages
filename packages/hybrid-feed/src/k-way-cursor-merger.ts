/**
 * @file k-way-cursor-merger.ts
 * @description Deterministic K-Way Binary Max-Heap Merger with Keyset Cursor Pagination & Deduplication
 *
 * Architecture Invariants:
 * 1. O(N log K) Binary Max-Heap ordering by `createdAtMs DESC, id DESC`.
 * 2. Strict Keyset Cursor Pagination: `(createdAtMs < cursor.createdAtMs) || (createdAtMs === cursor.createdAtMs && id < cursor.id)`.
 * 3. Idempotent Deduplication: Deduplicates by `item.id` to seamlessly absorb mid-flight celebrity
 *    promotion/demotion without ghost duplicates.
 * 4. Zero External Dependencies: Pure TypeScript with Buffer Base64URL encoding.
 */

export interface FeedItem<T = Record<string, unknown>> {
  id: string;
  authorId: string;
  createdAtMs: number;
  payload?: T;
  isCelebrity?: boolean;
  isBroadcast?: boolean;
}

export interface TimelineCursor {
  createdAtMs: number;
  id: string;
}

export interface KWayMergeOptions {
  limit?: number;
  cursor?: string | TimelineCursor | null;
  mutedAuthorIds?: ReadonlySet<string>;
  deletedItemIds?: ReadonlySet<string>;
  minTimestampMs?: number;
}

export interface KWayMergeStats {
  streamsScanned: number;
  candidatesEvaluated: number;
  duplicatesDropped: number;
}

export interface KWayMergeResult<T> {
  items: FeedItem<T>[];
  nextCursor: string | null;
  stats: KWayMergeStats;
}

// Ambient type declaration for environments where @types/node is not loaded
declare const Buffer:
  | {
      from(
        str: string,
        encoding?: string
      ): {
        toString(encoding?: string): string;
      };
    }
  | undefined;

/**
 * Universal Base64URL encoding (Node, Bun, and browser compatible)
 */
function toBase64Url(str: string): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(str, "utf8").toString("base64url");
  }
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Universal Base64URL decoding (Node, Bun, and browser compatible)
 */
function fromBase64Url(token: string): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(token, "base64url").toString("utf8");
  }
  let base64 = token.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4 !== 0) {
    base64 += "=";
  }
  return atob(base64);
}

/**
 * Encodes a TimelineCursor into a URL-safe Base64URL token.
 */
export function encodeTimelineCursor(cursor: TimelineCursor): string {
  if (
    !cursor ||
    typeof cursor.createdAtMs !== "number" ||
    Number.isNaN(cursor.createdAtMs) ||
    typeof cursor.id !== "string" ||
    cursor.id.length === 0
  ) {
    throw new Error(
      "Invalid TimelineCursor: createdAtMs must be a valid number and id must be a non-empty string"
    );
  }

  const payload = JSON.stringify({ t: cursor.createdAtMs, id: cursor.id });
  return toBase64Url(payload);
}

/**
 * Decodes a Base64URL cursor token into a TimelineCursor or returns null on malformed input.
 */
export function decodeTimelineCursor(token?: string | null): TimelineCursor | null {
  if (!token || typeof token !== "string" || token.trim().length === 0) {
    return null;
  }

  try {
    const raw = fromBase64Url(token);
    const parsed = JSON.parse(raw);
    const createdAtMs = typeof parsed?.t === "number" ? parsed.t : parsed?.createdAtMs;
    const id = parsed?.id;

    if (
      typeof createdAtMs === "number" &&
      !Number.isNaN(createdAtMs) &&
      typeof id === "string" &&
      id.length > 0
    ) {
      return { createdAtMs, id };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Internal Binary Max-Heap Node
 */
interface HeapNode<T> {
  item: FeedItem<T>;
  streamIndex: number;
  indexInStream: number;
}

/**
 * Compares two FeedItems according to `createdAtMs DESC, id DESC`.
 * Returns > 0 if a has higher priority than b (newer or higher id tie-breaker).
 */
function compareFeedItems<T>(a: FeedItem<T>, b: FeedItem<T>): number {
  if (a.createdAtMs !== b.createdAtMs) {
    return a.createdAtMs - b.createdAtMs; // positive if a > b
  }
  return a.id.localeCompare(b.id); // positive if a.id > b.id
}

/**
 * Deterministic Binary Max-Heap
 */
export class BinaryMaxHeap<T> {
  private readonly data: HeapNode<T>[] = [];

  get size(): number {
    return this.data.length;
  }

  peek(): HeapNode<T> | undefined {
    return this.data[0];
  }

  push(node: HeapNode<T>): void {
    this.data.push(node);
    this.bubbleUp(this.data.length - 1);
  }

  pop(): HeapNode<T> | undefined {
    if (this.data.length === 0) return undefined;
    const root = this.data[0];
    const last = this.data.pop()!;
    if (this.data.length > 0) {
      this.data[0] = last;
      this.trickleDown(0);
    }
    return root;
  }

  private bubbleUp(index: number): void {
    while (index > 0) {
      const parentIndex = (index - 1) >> 1;
      if (compareFeedItems(this.data[index].item, this.data[parentIndex].item) > 0) {
        const tmp = this.data[index];
        this.data[index] = this.data[parentIndex];
        this.data[parentIndex] = tmp;
        index = parentIndex;
      } else {
        break;
      }
    }
  }

  private trickleDown(index: number): void {
    const length = this.data.length;
    while (true) {
      const leftChild = (index << 1) + 1;
      const rightChild = leftChild + 1;
      let largest = index;

      if (
        leftChild < length &&
        compareFeedItems(this.data[leftChild].item, this.data[largest].item) > 0
      ) {
        largest = leftChild;
      }

      if (
        rightChild < length &&
        compareFeedItems(this.data[rightChild].item, this.data[largest].item) > 0
      ) {
        largest = rightChild;
      }

      if (largest !== index) {
        const tmp = this.data[index];
        this.data[index] = this.data[largest];
        this.data[largest] = tmp;
        index = largest;
      } else {
        break;
      }
    }
  }
}

/**
 * Checks whether an item strictly falls AFTER the pagination cursor
 * under `createdAtMs DESC, id DESC` ordering.
 */
function isStrictlyAfterCursor<T>(item: FeedItem<T>, cursor: TimelineCursor): boolean {
  if (item.createdAtMs < cursor.createdAtMs) {
    return true;
  }
  if (item.createdAtMs === cursor.createdAtMs) {
    return item.id < cursor.id;
  }
  return false;
}

/**
 * Merges K independent sorted streams of FeedItems into a single unified timeline
 * using an O(N log K) Binary Max-Heap.
 *
 * Supports keyset cursor pagination, dynamic deduplication, author muting, item deletion,
 * and minimum timestamp bounds.
 */
export function kWayMergeFeeds<T = Record<string, unknown>>(
  streams: ReadonlyArray<ReadonlyArray<FeedItem<T>>>,
  options?: KWayMergeOptions
): KWayMergeResult<T> {
  const limit = options?.limit ?? 20;
  const decodedCursor: TimelineCursor | null =
    typeof options?.cursor === "string"
      ? decodeTimelineCursor(options.cursor)
      : (options?.cursor ?? null);

  const mutedAuthorIds = options?.mutedAuthorIds;
  const deletedItemIds = options?.deletedItemIds;
  const minTimestampMs = options?.minTimestampMs;

  const stats: KWayMergeStats = {
    streamsScanned: streams.length,
    candidatesEvaluated: 0,
    duplicatesDropped: 0,
  };

  if (limit <= 0 || streams.length === 0) {
    return {
      items: [],
      nextCursor: null,
      stats,
    };
  }

  const heap = new BinaryMaxHeap<T>();

  // Advance each stream to the first item that is strictly after the cursor (if cursor provided)
  const advanceToNextEligible = (
    streamIndex: number,
    startIndex: number
  ): number => {
    const stream = streams[streamIndex];
    let idx = startIndex;
    if (decodedCursor) {
      while (idx < stream.length && !isStrictlyAfterCursor(stream[idx], decodedCursor)) {
        idx++;
      }
    }
    return idx;
  };

  // Initialize heap with head of each stream
  for (let s = 0; s < streams.length; s++) {
    const eligibleIndex = advanceToNextEligible(s, 0);
    if (eligibleIndex < streams[s].length) {
      heap.push({
        item: streams[s][eligibleIndex],
        streamIndex: s,
        indexInStream: eligibleIndex,
      });
    }
  }

  const items: FeedItem<T>[] = [];
  const seenIds = new Set<string>();

  // Helper to advance the popped stream and re-enqueue into heap
  const advanceStreamNode = (node: HeapNode<T>): void => {
    const nextEligible = advanceToNextEligible(
      node.streamIndex,
      node.indexInStream + 1
    );
    if (nextEligible < streams[node.streamIndex].length) {
      heap.push({
        item: streams[node.streamIndex][nextEligible],
        streamIndex: node.streamIndex,
        indexInStream: nextEligible,
      });
    }
  };

  while (heap.size > 0 && items.length < limit) {
    const node = heap.pop()!;
    stats.candidatesEvaluated++;

    advanceStreamNode(node);

    const candidate = node.item;

    // 1. Deduplication guard (e.g. author promoted to celebrity mid-flight)
    if (seenIds.has(candidate.id)) {
      stats.duplicatesDropped++;
      continue;
    }

    // 2. Muted author guard
    if (mutedAuthorIds && mutedAuthorIds.has(candidate.authorId)) {
      continue;
    }

    // 3. Deleted item guard
    if (deletedItemIds && deletedItemIds.has(candidate.id)) {
      continue;
    }

    // 4. Minimum timestamp guard
    if (minTimestampMs !== undefined && candidate.createdAtMs < minTimestampMs) {
      continue;
    }

    seenIds.add(candidate.id);
    items.push(candidate);
  }

  // Determine if more valid items remain to emit a meaningful nextCursor
  let nextCursor: string | null = null;
  if (items.length === limit) {
    let hasMore = false;
    while (heap.size > 0) {
      const peeked = heap.pop()!;
      stats.candidatesEvaluated++;
      advanceStreamNode(peeked);

      const candidate = peeked.item;
      if (seenIds.has(candidate.id)) {
        stats.duplicatesDropped++;
        continue;
      }
      if (mutedAuthorIds && mutedAuthorIds.has(candidate.authorId)) continue;
      if (deletedItemIds && deletedItemIds.has(candidate.id)) continue;
      if (minTimestampMs !== undefined && candidate.createdAtMs < minTimestampMs) continue;

      hasMore = true;
      break;
    }

    if (hasMore) {
      const lastItem = items[items.length - 1];
      nextCursor = encodeTimelineCursor({
        createdAtMs: lastItem.createdAtMs,
        id: lastItem.id,
      });
    }
  }

  return {
    items,
    nextCursor,
    stats,
  };
}
