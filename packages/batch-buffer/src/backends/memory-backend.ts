import { BufferBackend } from '../types';

/**
 * High-performance, zero-dependency In-Memory FIFO Queue Driver.
 * Uses an amortized O(1) head-pointer approach to prevent expensive array reallocation
 * during continuous micro-batch popping at high throughput.
 */
export class MemoryBackend<T> implements BufferBackend<T> {
  private items: T[] = [];
  private head: number = 0;
  private readonly compactionThreshold: number;

  constructor(options?: { compactionThreshold?: number }) {
    this.compactionThreshold = options?.compactionThreshold ?? 1024;
  }

  /**
   * Append one or multiple items to the tail of the buffer.
   */
  public push(item: T | T[]): number {
    if (Array.isArray(item)) {
      if (item.length === 0) return this.size();
      for (let i = 0; i < item.length; i++) {
        this.items.push(item[i]);
      }
    } else {
      this.items.push(item);
    }
    return this.size();
  }

  /**
   * Extract up to `maxCount` items from the head of the buffer in strict FIFO order.
   */
  public popBatch(maxCount: number): T[] {
    const currentSize = this.size();
    if (currentSize === 0 || maxCount <= 0) {
      return [];
    }

    const countToPop = Math.min(maxCount, currentSize);
    const batch: T[] = new Array(countToPop);
    for (let i = 0; i < countToPop; i++) {
      batch[i] = this.items[this.head + i];
    }

    this.head += countToPop;
    this.compactIfNeeded();
    return batch;
  }

  /**
   * Peek at up to `maxCount` items from the head without removing them.
   */
  public peek(maxCount?: number): T[] {
    const currentSize = this.size();
    if (currentSize === 0) {
      return [];
    }

    const limit = maxCount !== undefined && maxCount > 0
      ? Math.min(maxCount, currentSize)
      : currentSize;

    const result: T[] = new Array(limit);
    for (let i = 0; i < limit; i++) {
      result[i] = this.items[this.head + i];
    }
    return result;
  }

  /**
   * Return the current number of queued items.
   */
  public size(): number {
    return this.items.length - this.head;
  }

  /**
   * Evict the oldest `count` items from the head of the buffer.
   */
  public dropOldest(count: number): number {
    if (count <= 0) return 0;
    const currentSize = this.size();
    const toDrop = Math.min(count, currentSize);
    this.head += toDrop;
    this.compactIfNeeded();
    return toDrop;
  }

  /**
   * Evict the newest `count` items from the tail of the buffer.
   */
  public dropNewest(count: number): number {
    if (count <= 0) return 0;
    const currentSize = this.size();
    const toDrop = Math.min(count, currentSize);
    this.items.length -= toDrop;
    return toDrop;
  }

  /**
   * Reset and clear the entire buffer.
   */
  public clear(): void {
    this.items = [];
    this.head = 0;
  }

  /**
   * Amortized compaction to reclaim memory when the head pointer moves forward significantly.
   */
  private compactIfNeeded(): void {
    if (this.head >= this.compactionThreshold && this.head >= this.items.length / 2) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
  }
}
