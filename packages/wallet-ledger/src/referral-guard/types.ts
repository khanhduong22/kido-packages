export type FraudAction = 'ALLOW' | 'FLAG_FOR_REVIEW' | 'BLOCK';

export type FraudReason =
  | 'EXACT_IP_MATCH_WITH_REFERRER'
  | 'SUBNET_MATCH_WITH_REFERRER'
  | 'DEVICE_FINGERPRINT_MATCH'
  | 'DISPOSABLE_EMAIL_DOMAIN'
  | 'GMAIL_ALIAS_ABUSE'
  | 'VELOCITY_LIMIT_EXCEEDED_HOURLY'
  | 'VELOCITY_LIMIT_EXCEEDED_DAILY'
  | 'CUSTOM_RULE_TRIGGERED';

export interface ReferralRegistration {
  referralCode: string;
  referrerId: string;
  refereeId: string;
  refereeEmail: string;
  ipAddress: string;
  userAgent?: string;
  deviceFingerprint?: string;
  timestamp?: number;
}

export interface ReferrerLoginHistory {
  referrerId: string;
  loginIps: Array<{ ip: string; timestamp: number }>;
  knownFingerprints?: string[];
  knownUserAgents?: string[];
}

export interface FraudEvaluationResult {
  isAllowed: boolean;
  riskScore: number; // 0 to 100
  reasons: FraudReason[];
  action: FraudAction;
  details: {
    matchedIp?: string;
    matchedSubnet?: string;
    normalizedEmail: string;
    hourlyCount: number;
    dailyCount: number;
  };
}

export interface FraudGuardConfig {
  maxRegistrationsPerHour?: number; // default: 5
  maxRegistrationsPerDay?: number; // default: 20
  lookbackDays?: number; // default: 30 days
  blockScoreThreshold?: number; // default: 70
  reviewScoreThreshold?: number; // default: 40
  customBlockedDomains?: string[];
}

export interface RevenueBreakdown {
  grossAmount: number;
  gatewayFee: number;
  discountAmount: number;
  taxAmount: number;
  netRevenue: number;
}

export interface CommissionTier {
  tierId: string;
  name: string;
  percentage: number; // e.g. 10 for 10%
  minNetRevenue?: number;
}

export interface CommissionCalculation {
  orderId: string;
  referrerId: string;
  grossAmount: number;
  breakdown: RevenueBreakdown;
  commissionRate: number;
  commissionAmount: number;
  tierName?: string;
  currency: string;
}

export type RewardStatus =
  | 'PENDING_HOLD'
  | 'CLEARED'
  | 'CANCELLED_CLAWBACK'
  | 'RECOVERED_CLAWBACK';

export interface CommissionRewardRecord {
  rewardId: string;
  orderId: string;
  referrerId: string;
  amount: number;
  currency: string;
  status: RewardStatus;
  holdDays: number;
  createdAt: number;
  holdUntil: number;
  clearedAt?: number;
  clawedBackAt?: number;
  clawbackReason?: string;
  metadata?: Record<string, unknown>;
}

export type ClawbackAction =
  | 'CANCELLED_PENDING'
  | 'DEBITED_EARN_WALLET'
  | 'NOT_ELIGIBLE';

export interface ClawbackResult {
  success: boolean;
  rewardId: string;
  orderId: string;
  action: ClawbackAction;
  amount: number;
  notes: string;
}
