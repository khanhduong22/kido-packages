import { describe, expect, it } from 'bun:test';
import {
  BufferedViewCounter,
  HllAnalytics,
  InMemoryHllStore,
  formatDate,
  getDateRange,
} from './index';

describe('@kido/hll-analytics', () => {
  describe('InMemoryHllStore', () => {
    it('implements PFADD, PFCOUNT and PFMERGE semantics', async () => {
      const store = new InMemoryHllStore();

      // Add elements
      const add1 = await store.pfadd('day1', 'user:A', 'user:B');
      expect(add1).toBe(1);

      // Re-add existing element
      const add2 = await store.pfadd('day1', 'user:A');
      expect(add2).toBe(0);

      // Count
      expect(await store.pfcount('day1')).toBe(2);

      // Add day 2 with overlapping user:B and new user:C
      await store.pfadd('day2', 'user:B', 'user:C');
      expect(await store.pfcount('day2')).toBe(2);

      // Union count of day1 + day2 (user:A, user:B, user:C = 3 unique)
      expect(await store.pfcount('day1', 'day2')).toBe(3);

      // Merge into target key
      await store.pfmerge('week_merged', 'day1', 'day2');
      expect(await store.pfcount('week_merged')).toBe(3);

      // Delete
      await store.del('day1');
      expect(await store.pfcount('day1')).toBe(0);
    });
  });

  describe('Date Helpers', () => {
    it('formats dates consistently', () => {
      expect(formatDate('2026-10-05')).toBe('2026-10-05');
      const d = new Date('2026-10-05T12:00:00.000Z');
      expect(formatDate(d)).toBe('2026-10-05');
    });

    it('generates date ranges', () => {
      const range = getDateRange('2026-10-01', '2026-10-03');
      expect(range).toEqual(['2026-10-01', '2026-10-02', '2026-10-03']);

      const single = getDateRange('2026-10-01', '2026-10-01');
      expect(single).toEqual(['2026-10-01']);

      const invalid = getDateRange('2026-10-05', '2026-10-01');
      expect(invalid).toEqual([]);
    });
  });

  describe('HllAnalytics', () => {
    it('records events and computes DAU / Range Unique', async () => {
      const analytics = new HllAnalytics();

      // Record events for day 1
      const isNewA = await analytics.recordEvent('logins', 'user:1', '2026-10-01');
      const isNewB = await analytics.recordEvent('logins', 'user:2', '2026-10-01');
      const isDupA = await analytics.recordEvent('logins', 'user:1', '2026-10-01');

      expect(isNewA).toBe(true);
      expect(isNewB).toBe(true);
      expect(isDupA).toBe(false);

      expect(await analytics.getDailyUnique('logins', '2026-10-01')).toBe(2);
      expect(await analytics.getDAU('logins', '2026-10-01')).toBe(2);

      // Record batch for day 2
      await analytics.recordBatch(
        'logins',
        ['user:2', 'user:3', 'user:4'],
        '2026-10-02'
      );
      expect(await analytics.getDailyUnique('logins', '2026-10-02')).toBe(3);

      // Range unique over 2 days (users 1, 2, 3, 4 = 4 unique)
      const rangeUnique = await analytics.getRangeUnique(
        'logins',
        '2026-10-01',
        '2026-10-02'
      );
      expect(rangeUnique).toBe(4);
    });

    it('calculates WAU and MAU', async () => {
      const analytics = new HllAnalytics();
      const baseDate = new Date('2026-10-10T00:00:00.000Z');

      // Add user on today (Oct 10)
      await analytics.recordEvent('active', 'user:today', '2026-10-10');
      // Add user 3 days ago (Oct 7 - within 7 days WAU)
      await analytics.recordEvent('active', 'user:week', '2026-10-07');
      // Add user 15 days ago (Sep 25 - outside WAU, inside MAU)
      await analytics.recordEvent('active', 'user:month', '2026-09-25');

      const wau = await analytics.getWAU('active', baseDate);
      expect(wau).toBe(2); // user:today, user:week

      const mau = await analytics.getMAU('active', baseDate);
      expect(mau).toBe(3); // user:today, user:week, user:month
    });
  });

  describe('BufferedViewCounter', () => {
    it('deduplicates visits within the window and batches view counts', async () => {
      const flushedBatches: Map<string, number>[] = [];

      const counter = new BufferedViewCounter({
        dedupWindowMs: 50, // 50ms window for test
        flushIntervalMs: 500, // manual flush or timer
        onFlush: (batch) => {
          flushedBatches.push(new Map(batch));
        },
      });

      // User A views Article 101
      const v1 = counter.recordView('article:101', 'user:A');
      expect(v1).toBe(true);

      // Duplicate view immediately within window -> ignored
      const v2 = counter.recordView('article:101', 'user:A');
      expect(v2).toBe(false);

      // User B views Article 101 -> counted
      const v3 = counter.recordView('article:101', 'user:B');
      expect(v3).toBe(true);

      // User A views Article 202 -> counted
      const v4 = counter.recordView('article:202', 'user:A');
      expect(v4).toBe(true);

      expect(counter.getPendingCount('article:101')).toBe(2);
      expect(counter.getPendingCount('article:202')).toBe(1);
      expect(counter.getPendingTotal()).toBe(3);

      // Flush batch
      const flushRes = await counter.flush();
      expect(flushRes.flushedItems).toBe(2);
      expect(flushRes.totalViews).toBe(3);
      expect(counter.getPendingTotal()).toBe(0);

      expect(flushedBatches.length).toBe(1);
      expect(flushedBatches[0].get('article:101')).toBe(2);
      expect(flushedBatches[0].get('article:202')).toBe(1);

      await counter.stop();
    });

    it('allows view after dedup window expires', async () => {
      const counter = new BufferedViewCounter({
        dedupWindowMs: 25,
        flushIntervalMs: 1000,
        onFlush: () => {},
      });

      expect(counter.recordView('item:1', 'ip:127.0.0.1')).toBe(true);
      expect(counter.recordView('item:1', 'ip:127.0.0.1')).toBe(false);

      // Wait for window to expire
      await new Promise((r) => setTimeout(r, 35));
      expect(counter.recordView('item:1', 'ip:127.0.0.1')).toBe(true);

      await counter.stop();
    });

    it('recovers pending counts if onFlush fails', async () => {
      let shouldFail = true;
      const counter = new BufferedViewCounter({
        dedupWindowMs: 100,
        flushIntervalMs: 1000,
        onFlush: async () => {
          if (shouldFail) {
            throw new Error('Database connection lost');
          }
        },
      });

      counter.recordView('article:1', 'user:1');
      counter.recordView('article:1', 'user:2');

      expect(counter.getPendingCount('article:1')).toBe(2);

      // Flush should throw and restore pending views
      await expect(counter.flush()).rejects.toThrow('Database connection lost');
      expect(counter.getPendingCount('article:1')).toBe(2);

      // Succeed next time
      shouldFail = false;
      const res = await counter.flush();
      expect(res.totalViews).toBe(2);
      expect(counter.getPendingCount('article:1')).toBe(0);

      await counter.stop();
    });
  });
});
