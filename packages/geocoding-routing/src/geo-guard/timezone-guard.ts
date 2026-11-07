/**
 * Timezone Guard & Cloudflare Edge GeoIP Attestation Suite
 *
 * Provides Tier-1 Big-Tech (Duolingo / Strava / Uber pattern) multi-region timezone
 * integrity, anti-cheat physical biological cooldown, and edge attestation to prevent
 * time-travel and timezone-spoofing attacks.
 */

export const DEFAULT_TIMEZONE = 'Asia/Ho_Chi_Minh';
export const DEFAULT_TIMEZONE_LOCK_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000; // 30 days lock
export const DEFAULT_MIN_PHYSICAL_INTERVAL_MS = 20 * 60 * 60 * 1000; // 20 hours physical biological cooldown

export interface FormattedTimezoneParts {
  dateStr: string;
  time12h: string;
  time24h: string;
  minutes: number;
  year: number;
  month: number;
  day: number;
  hours24: number;
  mins: number;
}

export interface TimezoneAttestationOptions {
  targetTimezone: string;
  cfIpCountry?: string | null;
  defaultTimezone?: string;
  homeCountryCode?: string;
}

export interface TimezoneAttestationResult {
  allowed: boolean;
  normalizedTimezone: string;
  reason?: string;
}

export interface TimezoneCooldownOptions {
  lastUpdatedAtMs: number;
  nowMs?: number;
  cooldownMs?: number;
}

export interface TimezoneCooldownResult {
  canChange: boolean;
  remainingMs: number;
  remainingDays: number;
  lockedUntilMs: number;
  reason?: string;
}

export interface PhysicalIntervalOptions {
  lastEventTimestampMs: number;
  currentEventTimestampMs?: number;
  minIntervalMs?: number;
}

export interface PhysicalIntervalResult {
  allowed: boolean;
  elapsedMs: number;
  minIntervalMs: number;
  reason?: string;
}

/**
 * Validates whether the given string is a valid IANA timezone identifier
 */
export function isValidIanaTimezone(tz?: string | null): boolean {
  if (!tz || typeof tz !== 'string') return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns tz if it is a valid IANA timezone, else returns fallback (or DEFAULT_TIMEZONE)
 */
export function normalizeIanaTimezone(
  tz?: string | null,
  fallback = DEFAULT_TIMEZONE,
): string {
  if (tz && isValidIanaTimezone(tz)) {
    return tz;
  }
  return fallback;
}

/**
 * Formats a Unix millisecond timestamp into wall-clock parts for the specified timezone
 */
export function formatTimestampInTimezone(
  timestampMs: number,
  timeZone = DEFAULT_TIMEZONE,
): FormattedTimezoneParts | null {
  if (!timestampMs || !Number.isFinite(timestampMs) || timestampMs <= 0) {
    return null;
  }

  const validTz = normalizeIanaTimezone(timeZone);

  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: validTz,
      hour12: false,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });

    const parts = formatter.formatToParts(new Date(timestampMs));
    const map: Record<string, string> = {};
    for (const p of parts) {
      map[p.type] = p.value;
    }

    const year = Number(map.year);
    const month = Number(map.month);
    const day = Number(map.day);
    let hours24 = Number(map.hour);
    if (hours24 === 24) hours24 = 0;
    const mins = Number(map.minute);

    const yearStr = String(year);
    const monthStr = String(month).padStart(2, '0');
    const dayStr = String(day).padStart(2, '0');
    const dateStr = `${yearStr}-${monthStr}-${dayStr}`;

    const hours12 = hours24 % 12 || 12;
    const ampm = hours24 >= 12 ? 'PM' : 'AM';
    const time12h = `${String(hours12).padStart(2, '0')}:${String(mins).padStart(2, '0')} ${ampm}`;
    const time24h = `${String(hours24).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
    const minutes = hours24 * 60 + mins;

    return {
      dateStr,
      time12h,
      time24h,
      minutes,
      year,
      month,
      day,
      hours24,
      mins,
    };
  } catch {
    return null;
  }
}

/**
 * Accurately computes the Unix epoch millisecond timestamp for a given dateStr (YYYY-MM-DD),
 * hours (0-23), mins (0-59) in the specified IANA timezone (handling DST like America/Toronto).
 */
export function getTimezoneMomentMs(
  dateStr: string,
  hours: number,
  mins: number,
  timeZone = DEFAULT_TIMEZONE,
): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  const utcGuess = Date.UTC(y, m - 1, d, hours, mins, 0, 0);
  const tzParts = formatTimestampInTimezone(utcGuess, timeZone);
  if (!tzParts) return utcGuess - 7 * 3600 * 1000;
  const tzAsUtc = Date.UTC(
    tzParts.year,
    tzParts.month - 1,
    tzParts.day,
    tzParts.hours24,
    tzParts.mins,
    0,
    0,
  );
  const offsetMs = tzAsUtc - utcGuess;
  return utcGuess - offsetMs;
}

/**
 * Cloudflare Edge GeoIP Attestation check for timezone switching.
 * Prevents users within the home country (e.g., Vietnam) from spoofing overseas timezones
 * to gain unfair early check-in or streak rescue windows.
 */
export function verifyCloudflareGeoIpTimezone(
  options: TimezoneAttestationOptions,
): TimezoneAttestationResult {
  const defaultTz = options.defaultTimezone || DEFAULT_TIMEZONE;
  const homeCountry = (options.homeCountryCode || 'VN').toUpperCase();
  const normalized = normalizeIanaTimezone(options.targetTimezone, defaultTz);

  // If user is selecting the default home timezone, always allow
  if (normalized === defaultTz) {
    return { allowed: true, normalizedTimezone: normalized };
  }

  // If Cloudflare Edge GeoIP country header is present and matches the home country,
  // reject switching to foreign timezone
  if (options.cfIpCountry) {
    const detectedCountry = options.cfIpCountry.trim().toUpperCase();
    if (detectedCountry === homeCountry && normalized !== defaultTz) {
      return {
        allowed: false,
        normalizedTimezone: normalized,
        reason: `Cloudflare GeoIP detected IP located in ${homeCountry}. Switching to overseas timezone (${normalized}) is restricted to athletes/users physically abroad to prevent timezone spoofing.`,
      };
    }
  }

  return { allowed: true, normalizedTimezone: normalized };
}

/**
 * Evaluates whether a user can change their timezone based on cooldown window (e.g. 30 days).
 * Prevents rapid switching between timezones to game daily streak cycles.
 */
export function evaluateTimezoneLockCooldown(
  options: TimezoneCooldownOptions,
): TimezoneCooldownResult {
  const nowMs = options.nowMs ?? Date.now();
  const cooldownMs = options.cooldownMs ?? DEFAULT_TIMEZONE_LOCK_COOLDOWN_MS;
  const lockedUntilMs = options.lastUpdatedAtMs + cooldownMs;
  const remainingMs = Math.max(0, lockedUntilMs - nowMs);
  const remainingDays = Math.ceil(remainingMs / (24 * 60 * 60 * 1000));

  if (remainingMs > 0) {
    return {
      canChange: false,
      remainingMs,
      remainingDays,
      lockedUntilMs,
      reason: `Timezone is locked for 30 days following an update. Please wait ${remainingDays} more day(s) before changing timezone again.`,
    };
  }

  return {
    canChange: true,
    remainingMs: 0,
    remainingDays: 0,
    lockedUntilMs,
  };
}

/**
 * Biological Physical Interval Guard (Physical Law).
 * Enforces a biological minimum physical interval (e.g. 20 hours) between consecutive
 * daily events (such as wake-up check-ins), neutralizing time-travel attacks via timezone hopping.
 */
export function evaluatePhysicalBiologicalInterval(
  options: PhysicalIntervalOptions,
): PhysicalIntervalResult {
  const nowMs = options.currentEventTimestampMs ?? Date.now();
  const minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_PHYSICAL_INTERVAL_MS;
  const elapsedMs = nowMs - options.lastEventTimestampMs;

  if (elapsedMs < minIntervalMs) {
    const waitHours = ((minIntervalMs - elapsedMs) / (60 * 60 * 1000)).toFixed(1);
    return {
      allowed: false,
      elapsedMs,
      minIntervalMs,
      reason: `Physical biological cooldown active: minimum ${minIntervalMs / (3600 * 1000)}h required between daily events (remaining: ${waitHours}h).`,
    };
  }

  return {
    allowed: true,
    elapsedMs,
    minIntervalMs,
  };
}
