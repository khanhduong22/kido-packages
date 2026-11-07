import {
  FraudAction,
  FraudEvaluationResult,
  FraudGuardConfig,
  FraudReason,
  ReferralRegistration,
  ReferrerLoginHistory,
} from './types';

export const DEFAULT_DISPOSABLE_DOMAINS = new Set([
  'mailinator.com',
  '10minutemail.com',
  'tempmail.com',
  'temp-mail.org',
  'guerrillamail.com',
  'sharklasers.com',
  'throwawaymail.com',
  'yopmail.com',
  'dispostable.com',
  'getairmail.com',
  'mohmal.com',
  'trashmail.com',
  'crazymailing.com',
  'maildrop.cc',
  'burnermail.io',
  'inboxkitten.com',
]);

export class ReferralFraudGuard {
  private config: Required<FraudGuardConfig>;
  private blockedDomains: Set<string>;

  // referrerId -> list of timestamps
  private hourlyRegistrations: Map<string, number[]> = new Map();
  private dailyRegistrations: Map<string, number[]> = new Map();

  constructor(config?: FraudGuardConfig) {
    this.config = {
      maxRegistrationsPerHour: config?.maxRegistrationsPerHour ?? 5,
      maxRegistrationsPerDay: config?.maxRegistrationsPerDay ?? 20,
      lookbackDays: config?.lookbackDays ?? 30,
      blockScoreThreshold: config?.blockScoreThreshold ?? 70,
      reviewScoreThreshold: config?.reviewScoreThreshold ?? 40,
      customBlockedDomains: config?.customBlockedDomains ?? [],
    };

    this.blockedDomains = new Set(DEFAULT_DISPOSABLE_DOMAINS);
    for (const d of this.config.customBlockedDomains) {
      this.blockedDomains.add(d.toLowerCase().trim());
    }
  }

  /**
   * Check if an email uses a known disposable temporary email domain
   */
  public isDisposableEmail(email: string): boolean {
    const atIdx = email.lastIndexOf('@');
    if (atIdx === -1) return true;
    const domain = email.substring(atIdx + 1).toLowerCase().trim();
    return this.blockedDomains.has(domain);
  }

  /**
   * Normalize email address:
   * For Gmail/Googlemail: removes dots and drops "+tag" suffixes
   */
  public normalizeEmail(email: string): { normalized: string; isAliased: boolean } {
    const atIdx = email.lastIndexOf('@');
    if (atIdx === -1) {
      return { normalized: email.toLowerCase().trim(), isAliased: false };
    }

    let local = email.substring(0, atIdx).toLowerCase().trim();
    const domain = email.substring(atIdx + 1).toLowerCase().trim();
    let isAliased = false;

    if (domain === 'gmail.com' || domain === 'googlemail.com') {
      // Remove all dots in local part
      local = local.replace(/\./g, '');
      // Strip + extension
      const plusIdx = local.indexOf('+');
      if (plusIdx !== -1) {
        local = local.substring(0, plusIdx);
        isAliased = true;
      }
    } else {
      const plusIdx = local.indexOf('+');
      if (plusIdx !== -1) {
        local = local.substring(0, plusIdx);
        isAliased = true;
      }
    }

    return {
      normalized: `${local}@${domain}`,
      isAliased,
    };
  }

  /**
   * Check if two IPv4 addresses belong to the same /24 subnet (e.g. 192.168.1.x)
   */
  public isSubnetMatch(ip1: string, ip2: string): boolean {
    const clean1 = ip1.trim();
    const clean2 = ip2.trim();

    if (clean1 === clean2) return true;

    const parts1 = clean1.split('.');
    const parts2 = clean2.split('.');

    // Check IPv4 standard 4 octets
    if (parts1.length === 4 && parts2.length === 4) {
      return parts1[0] === parts2[0] && parts1[1] === parts2[1] && parts1[2] === parts2[2];
    }

    // Basic IPv6 /64 check
    if (clean1.includes(':') && clean2.includes(':')) {
      const p6_1 = clean1.split(':').slice(0, 4).join(':');
      const p6_2 = clean2.split(':').slice(0, 4).join(':');
      return p6_1 === p6_2;
    }

    return false;
  }

  /**
   * Evaluate a registration request against fraud prevention heuristics
   */
  public evaluateRegistration(
    reg: ReferralRegistration,
    referrerHistory: ReferrerLoginHistory
  ): FraudEvaluationResult {
    const now = reg.timestamp || Date.now();
    const reasons: FraudReason[] = [];
    let riskScore = 0;

    const { normalized, isAliased } = this.normalizeEmail(reg.refereeEmail);

    // 1. Disposable Email Domain Check
    if (this.isDisposableEmail(reg.refereeEmail)) {
      reasons.push('DISPOSABLE_EMAIL_DOMAIN');
      riskScore += 80;
    }

    // 2. Gmail / Email +alias check
    if (isAliased) {
      reasons.push('GMAIL_ALIAS_ABUSE');
      riskScore += 25;
    }

    // 3. Self-referral via IP Check (against 30-day login history)
    const lookbackMs = this.config.lookbackDays * 24 * 60 * 60 * 1000;
    const minTimestamp = now - lookbackMs;

    const recentIps = referrerHistory.loginIps.filter((item) => item.timestamp >= minTimestamp);

    let matchedExactIp: string | undefined;
    let matchedSubnetIp: string | undefined;

    for (const login of recentIps) {
      if (login.ip === reg.ipAddress) {
        matchedExactIp = login.ip;
        break;
      }
      if (!matchedSubnetIp && this.isSubnetMatch(login.ip, reg.ipAddress)) {
        matchedSubnetIp = login.ip;
      }
    }

    if (matchedExactIp) {
      reasons.push('EXACT_IP_MATCH_WITH_REFERRER');
      riskScore += 75; // Instant high risk for identical IP
    } else if (matchedSubnetIp) {
      reasons.push('SUBNET_MATCH_WITH_REFERRER');
      riskScore += 35; // Suspicious subnet match
    }

    // 4. Device Fingerprint Check
    if (
      reg.deviceFingerprint &&
      referrerHistory.knownFingerprints &&
      referrerHistory.knownFingerprints.includes(reg.deviceFingerprint)
    ) {
      reasons.push('DEVICE_FINGERPRINT_MATCH');
      riskScore += 65;
    }

    // 5. Velocity Check
    const hourlyTimes = this.cleanupAndGetTimes(
      this.hourlyRegistrations,
      reg.referrerId,
      now,
      60 * 60 * 1000
    );
    const dailyTimes = this.cleanupAndGetTimes(
      this.dailyRegistrations,
      reg.referrerId,
      now,
      24 * 60 * 60 * 1000
    );

    const hourlyCount = hourlyTimes.length;
    const dailyCount = dailyTimes.length;

    if (hourlyCount >= this.config.maxRegistrationsPerHour) {
      reasons.push('VELOCITY_LIMIT_EXCEEDED_HOURLY');
      riskScore += 40;
    }

    if (dailyCount >= this.config.maxRegistrationsPerDay) {
      reasons.push('VELOCITY_LIMIT_EXCEEDED_DAILY');
      riskScore += 40;
    }

    // Cap risk score at 100
    const finalScore = Math.min(100, riskScore);

    let action: FraudAction = 'ALLOW';
    let isAllowed = true;

    if (finalScore >= this.config.blockScoreThreshold) {
      action = 'BLOCK';
      isAllowed = false;
    } else if (finalScore >= this.config.reviewScoreThreshold) {
      action = 'FLAG_FOR_REVIEW';
      isAllowed = true;
    }

    return {
      isAllowed,
      riskScore: finalScore,
      reasons,
      action,
      details: {
        matchedIp: matchedExactIp,
        matchedSubnet: matchedSubnetIp,
        normalizedEmail: normalized,
        hourlyCount,
        dailyCount,
      },
    };
  }

  /**
   * Record a verified registration to update rolling velocity windows
   */
  public recordSuccessfulRegistration(reg: ReferralRegistration): void {
    const now = reg.timestamp || Date.now();
    const hourly = this.hourlyRegistrations.get(reg.referrerId) || [];
    hourly.push(now);
    this.hourlyRegistrations.set(reg.referrerId, hourly);

    const daily = this.dailyRegistrations.get(reg.referrerId) || [];
    daily.push(now);
    this.dailyRegistrations.set(reg.referrerId, daily);
  }

  private cleanupAndGetTimes(
    map: Map<string, number[]>,
    key: string,
    now: number,
    windowMs: number
  ): number[] {
    const list = map.get(key) || [];
    const valid = list.filter((t) => now - t <= windowMs);
    map.set(key, valid);
    return valid;
  }

  /**
   * Reset velocity tracking counters
   */
  public resetVelocity(referrerId?: string): void {
    if (referrerId) {
      this.hourlyRegistrations.delete(referrerId);
      this.dailyRegistrations.delete(referrerId);
    } else {
      this.hourlyRegistrations.clear();
      this.dailyRegistrations.clear();
    }
  }
}
