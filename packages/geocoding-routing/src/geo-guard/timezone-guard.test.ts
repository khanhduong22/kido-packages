import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_TIMEZONE,
  DEFAULT_TIMEZONE_LOCK_COOLDOWN_MS,
  DEFAULT_MIN_PHYSICAL_INTERVAL_MS,
  isValidIanaTimezone,
  normalizeIanaTimezone,
  formatTimestampInTimezone,
  getTimezoneMomentMs,
  verifyCloudflareGeoIpTimezone,
  evaluateTimezoneLockCooldown,
  evaluatePhysicalBiologicalInterval,
} from './timezone-guard';

describe('Timezone Guard & Cloudflare Edge GeoIP Attestation Suite', () => {
  describe('1. IANA Timezone Validation & Normalization', () => {
    it('should validate valid IANA timezones', () => {
      assert.strictEqual(isValidIanaTimezone('Asia/Ho_Chi_Minh'), true);
      assert.strictEqual(isValidIanaTimezone('America/Toronto'), true);
      assert.strictEqual(isValidIanaTimezone('UTC'), true);
      assert.strictEqual(isValidIanaTimezone('Europe/London'), true);
      assert.strictEqual(isValidIanaTimezone('Asia/Tokyo'), true);
    });

    it('should reject invalid or malformed timezones', () => {
      assert.strictEqual(isValidIanaTimezone('Mars/Olympus_Mons'), false);
      assert.strictEqual(isValidIanaTimezone('Fake/Zone'), false);
      assert.strictEqual(isValidIanaTimezone(''), false);
      assert.strictEqual(isValidIanaTimezone(null), false);
      assert.strictEqual(isValidIanaTimezone(undefined), false);
    });

    it('should normalize invalid timezones to fallback', () => {
      assert.strictEqual(
        normalizeIanaTimezone('America/New_York'),
        'America/New_York',
      );
      assert.strictEqual(
        normalizeIanaTimezone('Invalid/Zone'),
        DEFAULT_TIMEZONE,
      );
      assert.strictEqual(
        normalizeIanaTimezone(null, 'UTC'),
        'UTC',
      );
    });
  });

  describe('2. Wall-Clock Formatting & Epoch Calculation', () => {
    it('should accurately format millisecond timestamp into wall-clock parts', () => {
      // 2026-10-20 05:30:00 UTC = 2026-10-20 12:30:00 Asia/Ho_Chi_Minh (UTC+7)
      const epochMs = Date.UTC(2026, 9, 20, 5, 30, 0, 0);
      const parts = formatTimestampInTimezone(epochMs, 'Asia/Ho_Chi_Minh');

      assert.ok(parts !== null);
      assert.strictEqual(parts.dateStr, '2026-10-20');
      assert.strictEqual(parts.hours24, 12);
      assert.strictEqual(parts.mins, 30);
      assert.strictEqual(parts.time24h, '12:30');
      assert.strictEqual(parts.time12h, '12:30 PM');
      assert.strictEqual(parts.minutes, 12 * 60 + 30);
    });

    it('should format correctly across different global timezones (Toronto UTC-4)', () => {
      // 2026-10-20 05:30:00 UTC = 2026-10-20 01:30:00 America/Toronto (EDT, UTC-4)
      const epochMs = Date.UTC(2026, 9, 20, 5, 30, 0, 0);
      const parts = formatTimestampInTimezone(epochMs, 'America/Toronto');

      assert.ok(parts !== null);
      assert.strictEqual(parts.dateStr, '2026-10-20');
      assert.strictEqual(parts.hours24, 1);
      assert.strictEqual(parts.mins, 30);
      assert.strictEqual(parts.time12h, '01:30 AM');
    });

    it('should return null for invalid or non-positive timestamps', () => {
      assert.strictEqual(formatTimestampInTimezone(0), null);
      assert.strictEqual(formatTimestampInTimezone(-1000), null);
      assert.strictEqual(formatTimestampInTimezone(NaN), null);
    });

    it('should calculate roundtrip epoch moment with getTimezoneMomentMs', () => {
      const dateStr = '2026-10-20';
      const hours = 5;
      const mins = 15;
      const tz = 'America/Toronto';

      const momentMs = getTimezoneMomentMs(dateStr, hours, mins, tz);
      const roundtripParts = formatTimestampInTimezone(momentMs, tz);

      assert.ok(roundtripParts !== null);
      assert.strictEqual(roundtripParts.dateStr, dateStr);
      assert.strictEqual(roundtripParts.hours24, hours);
      assert.strictEqual(roundtripParts.mins, mins);
    });
  });

  describe('3. Cloudflare Edge GeoIP Attestation Guard', () => {
    it('should allow user switching to default home timezone regardless of GeoIP', () => {
      const res = verifyCloudflareGeoIpTimezone({
        targetTimezone: 'Asia/Ho_Chi_Minh',
        cfIpCountry: 'CA',
      });
      assert.strictEqual(res.allowed, true);
      assert.strictEqual(res.normalizedTimezone, 'Asia/Ho_Chi_Minh');
    });

    it('should reject user in Vietnam (VN) attempting to spoof overseas timezone', () => {
      const res = verifyCloudflareGeoIpTimezone({
        targetTimezone: 'America/Toronto',
        cfIpCountry: 'VN',
      });
      assert.strictEqual(res.allowed, false);
      assert.ok(res.reason?.includes('Cloudflare GeoIP detected IP located in VN'));
    });

    it('should allow athlete physically in Canada (CA) to switch to Toronto timezone', () => {
      const res = verifyCloudflareGeoIpTimezone({
        targetTimezone: 'America/Toronto',
        cfIpCountry: 'CA',
      });
      assert.strictEqual(res.allowed, true);
      assert.strictEqual(res.normalizedTimezone, 'America/Toronto');
    });

    it('should allow switching when cfIpCountry header is absent (e.g. dev/staging bypass)', () => {
      const res = verifyCloudflareGeoIpTimezone({
        targetTimezone: 'Europe/Paris',
        cfIpCountry: null,
      });
      assert.strictEqual(res.allowed, true);
      assert.strictEqual(res.normalizedTimezone, 'Europe/Paris');
    });
  });

  describe('4. Timezone Lock Cooldown Guard (30-day Commitment)', () => {
    it('should lock user who changed timezone 10 days ago', () => {
      const tenDaysMs = 10 * 24 * 60 * 60 * 1000;
      const lastUpdated = Date.now() - tenDaysMs;

      const res = evaluateTimezoneLockCooldown({
        lastUpdatedAtMs: lastUpdated,
      });

      assert.strictEqual(res.canChange, false);
      assert.strictEqual(res.remainingDays, 20);
      assert.ok(res.reason?.includes('wait 20 more day(s)'));
    });

    it('should allow user who changed timezone 31 days ago to update', () => {
      const thirtyOneDaysMs = 31 * 24 * 60 * 60 * 1000;
      const lastUpdated = Date.now() - thirtyOneDaysMs;

      const res = evaluateTimezoneLockCooldown({
        lastUpdatedAtMs: lastUpdated,
      });

      assert.strictEqual(res.canChange, true);
      assert.strictEqual(res.remainingMs, 0);
      assert.strictEqual(res.remainingDays, 0);
    });
  });

  describe('5. Biological Physical Interval Guard (Anti-Time-Travel)', () => {
    it('should reject check-in if less than 20 hours have elapsed', () => {
      const lastWakeup = 10000000;
      const currentWakeup = lastWakeup + 12 * 3600 * 1000; // 12 hours later

      const res = evaluatePhysicalBiologicalInterval({
        lastEventTimestampMs: lastWakeup,
        currentEventTimestampMs: currentWakeup,
      });

      assert.strictEqual(res.allowed, false);
      assert.ok(res.reason?.includes('remaining: 8.0h'));
    });

    it('should allow check-in if 21 hours have elapsed', () => {
      const lastWakeup = 10000000;
      const currentWakeup = lastWakeup + 21 * 3600 * 1000; // 21 hours later

      const res = evaluatePhysicalBiologicalInterval({
        lastEventTimestampMs: lastWakeup,
        currentEventTimestampMs: currentWakeup,
      });

      assert.strictEqual(res.allowed, true);
      assert.strictEqual(res.elapsedMs, 21 * 3600 * 1000);
    });
  });
});
