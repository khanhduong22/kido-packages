export type DemoPersona = 'ADMIN' | 'STAFF' | 'GUEST';

export type DemoRole = 'ADMIN' | 'PARTNER' | 'STAFF' | 'USER' | 'GUEST';

export type EmploymentType = 'FULL_TIME' | 'PART_TIME';

export interface DemoPersonaProfile {
  id: string;
  name: string;
  email: string;
  persona: DemoPersona;
  role: DemoRole;
  image: string;
  label: string;
  employmentType: EmploymentType;
  hourlyRate: number;
  monthlySalary: number;
}

export interface SanitizeStaffOptions {
  /**
   * When true (default), picks names and salary bands deterministically based on index
   * so repeated runs produce stable demo snapshots. Set to false for randomized selection.
   */
  deterministic?: boolean;
  /**
   * Email domain for generated demo accounts (default: "demomart.vn").
   */
  domain?: string;
  /**
   * Prefix for regular staff emails (default: "staff", producing "staff01@demomart.vn").
   */
  emailPrefix?: string;
  /**
   * Custom pool of Vietnamese sample names.
   */
  namePool?: readonly string[];
  /**
   * Custom hourly rate bands for PART_TIME staff (VND).
   */
  partTimeRates?: readonly number[];
  /**
   * Custom monthly salary bands for FULL_TIME staff (VND).
   */
  fullTimeSalaries?: readonly number[];
  /**
   * Optional mutable map to record `originalName -> sanitizedDemoName` mappings
   * for downstream free-text and JSONB scrubbing.
   */
  nameMap?: Map<string, string>;
}

export interface StaffProfileInput {
  id?: string;
  name?: string | null;
  email?: string | null;
  image?: string | null;
  role?: string | null;
  employmentType?: EmploymentType | string | null;
  hourlyRate?: number | null;
  monthlySalary?: number | null;
  isActive?: boolean | null;
  birthday?: Date | string | null;
  startDate?: Date | string | null;
  [key: string]: unknown;
}

export interface SanitizedStaffProfile {
  id: string;
  name: string;
  email: string;
  image: string;
  role: 'ADMIN' | 'PARTNER' | 'USER';
  persona: DemoPersona;
  isActive: boolean;
  employmentType: EmploymentType;
  hourlyRate: number;
  monthlySalary: number;
  birthday: Date;
  startDate: Date;
}

export interface PayslipDailyDetail {
  date: string;
  checkIn?: string | null;
  checkOut?: string | null;
  hours: number;
  salary: number;
  isLate?: boolean;
  multiplier?: number;
  isValid?: boolean;
  shift?: string;
  isSenior?: boolean;
  seniorBonus?: number;
}

export interface PayslipAdjustment {
  id: string;
  userId?: string;
  amount: number;
  reason: string;
  date?: string;
}

export interface PayslipJsonPayload {
  userId?: string;
  staffName?: string;
  name?: string;
  userName?: string;
  email?: string;
  userEmail?: string;
  employmentType?: EmploymentType;
  hourlyRate: number;
  dynamicHourlyRate: number;
  monthlySalary: number;
  standardDays: number;
  dailySalary: number;
  leaveCount: number;
  deduction: number;
  totalHours: number;
  totalOvertimeHours: number;
  leaderboardOvertimeHours: number;
  daysWorked: number;
  checkinCount: number;
  baseSalary: number;
  totalAdjustments: number;
  lateCount: number;
  latePenaltyHours: number;
  latePenaltyAmount: number;
  totalSeniorBonus: number;
  bonusPercent: number;
  bonusAmount: number;
  totalSalary: number;
  totalPay: number;
  projectedSalary: number;
  netSalary: number;
  finalNet: number;
  isThuKpiSalary: boolean;
  adjustments: PayslipAdjustment[];
  dailyDetails: PayslipDailyDetail[];
  [key: string]: unknown;
}

export interface RecomputePayslipOptions {
  userId?: string;
  staffName?: string;
  email?: string;
  employmentType?: EmploymentType;
  nameMap?: Map<string, string>;
  brandMap?: Record<string, string>;
}

export type ModuleKey =
  | 'attendance'
  | 'piecework'
  | 'operations'
  | 'payroll'
  | 'gamification'
  | 'ai_sop';

export interface DemoModulesConfig {
  attendance: boolean;
  piecework: boolean;
  operations: boolean;
  payroll: boolean;
  gamification: boolean;
  ai_sop: boolean;
  [key: string]: boolean;
}

export interface ModuleDefinition {
  key: ModuleKey | string;
  label: string;
  description: string;
  isCore?: boolean;
}

export type ModulePresetKey =
  | 'FULL_SUITE'
  | 'RETAIL_CORE'
  | 'FNB_SHIFT'
  | 'MINIMAL_ATTENDANCE';

export interface KeyValueStoreAdapter {
  get(key: string): Promise<string | null> | string | null;
  set(key: string, value: string, ttlSeconds?: number): Promise<unknown> | unknown;
  del?(key: string): Promise<unknown> | unknown;
}

export interface BlockedEndpointRule {
  /**
   * HTTP method(s) to match (e.g. "POST", "DELETE", ["POST", "PUT", "DELETE"], or "*" for all).
   */
  method?: string | readonly string[];
  /**
   * Route path substring or regular expression to match against pathname.
   */
  pattern: string | RegExp;
  /**
   * Human-readable reason returned when blocked in public demo sandbox.
   */
  reason?: string;
  /**
   * Set to true to explicitly whitelist a route that would otherwise match a broader block rule.
   */
  allowInSandbox?: boolean;
}

export interface DemoSandboxBlockResult {
  blocked: boolean;
  status: number;
  code?: string;
  reason?: string;
  matchedRule?: string;
}

export interface DemoSandboxConfig {
  enabled: boolean;
  defaultPersona?: DemoPersona;
  redisKey?: string;
  safeDatabaseSubstrings?: readonly string[];
  blockedRules?: readonly BlockedEndpointRule[];
  brandMap?: Record<string, string>;
  safeEvidenceBaseUrl?: string;
}
