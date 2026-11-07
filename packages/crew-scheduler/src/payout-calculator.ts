import {
  CrewLevel,
  CrewMember,
  CrewRole,
  EventShow,
  PayoutCalculation,
  ShiftAssignment,
} from './types';
import { normalizeDate } from './shift-roster';

/**
 * Standard Freelance Base Hourly Rates in Vietnam (VND / hour)
 */
export const DEFAULT_HOURLY_RATES: Record<CrewLevel, number> = {
  JUNIOR: 150_000, // 150,000 VND / hour
  SENIOR: 250_000, // 250,000 VND / hour
  LEAD: 350_000,   // 350,000 VND / hour
};

/**
 * Standard Night Shift Bonus Rate (+30% after 23:00)
 */
export const DEFAULT_NIGHT_BONUS_RATE = 0.3; // +30%

/**
 * KPI Bonus defaults for Photobooth & Event activations
 */
export const DEFAULT_KPI_CONFIG = {
  bonusPerExtraPrint: 1_000, // 1,000 VND per print exceeding target
  bonusPerExtraGuest: 500,   // 500 VND per attendee/guest exceeding target
};

/**
 * Accurately calculates the number of working hours falling into the night window.
 * Default night window: 23:00 (11:00 PM) to 06:00 (6:00 AM).
 *
 * @param startAt Start timestamp
 * @param endAt End timestamp
 * @param nightStartHour Hour when night starts (default 23)
 * @param nightEndHour Hour when night ends (default 6)
 * @returns Number of night hours (decimal)
 */
export function calculateNightHours(
  startAt: Date | string,
  endAt: Date | string,
  nightStartHour = 23,
  nightEndHour = 6
): number {
  const start = normalizeDate(startAt);
  const end = normalizeDate(endAt);

  if (start.getTime() >= end.getTime()) {
    return 0;
  }

  // Iterate minute by minute or 5-minute intervals for absolute precision across days
  // 1-minute steps for exact fractional calculations
  let nightMinutes = 0;
  const current = new Date(start.getTime());

  // Round start to next minute boundary if needed or step minute by minute
  while (current.getTime() < end.getTime()) {
    const nextMinute = new Date(current.getTime() + 60 * 1000);
    const stepEnd = nextMinute.getTime() > end.getTime() ? end : nextMinute;
    const fractionOfMinute = (stepEnd.getTime() - current.getTime()) / (60 * 1000);

    // Evaluate hour in Vietnam Standard Time (UTC+7) for deterministic CI/local parity
    const hour = (current.getUTCHours() + 7) % 24;
    // Night window condition: >= 23 (23:00 to 23:59) OR < 6 (00:00 to 05:59)
    const isNight = hour >= nightStartHour || hour < nightEndHour;

    if (isNight) {
      nightMinutes += fractionOfMinute;
    }

    current.setTime(stepEnd.getTime());
  }

  return Number((nightMinutes / 60).toFixed(4));
}

/**
 * Options for calculating crew payout
 */
export interface PayoutOptions {
  customHourlyRates?: Partial<Record<CrewLevel, number>>;
  nightBonusRate?: number;
  bonusPerExtraPrint?: number;
  bonusPerExtraGuest?: number;
  travelAllowance?: number;
  minBillableHours?: number;
}

/**
 * Calculates show payout for a single crew member
 *
 * @param params Details of the member, show, and optional custom parameters
 * @returns Detailed PayoutCalculation
 */
export function calculatePayout(params: {
  member: CrewMember;
  show: EventShow;
  role?: CrewRole;
  kpiBonus?: number;
  travelAllowance?: number;
  options?: PayoutOptions;
}): PayoutCalculation {
  const { member, show } = params;
  const role = params.role || member.primaryRole;
  const options = params.options;

  const start = normalizeDate(show.startAt);
  const end = normalizeDate(show.endAt);

  const rawDurationHours = (end.getTime() - start.getTime()) / (1000 * 60 * 60);
  const minHours = options?.minBillableHours ?? 0;
  const durationHours = Number(Math.max(rawDurationHours, minHours).toFixed(2));

  // Determine base hourly rate: member custom rate > options custom rate > default level rate
  const baseHourlyRate =
    member.hourlyRate ??
    options?.customHourlyRates?.[member.level] ??
    DEFAULT_HOURLY_RATES[member.level];

  // Base pay for show
  const baseAmount = Math.round(durationHours * baseHourlyRate);

  // Night shift calculation (+30% between 23:00 and 06:00)
  const nightHours = calculateNightHours(start, end);
  const nightBonusRate = options?.nightBonusRate ?? DEFAULT_NIGHT_BONUS_RATE;
  const nightBonus = Math.round(nightHours * baseHourlyRate * nightBonusRate);

  // KPI Bonus calculation if not explicitly provided
  let kpiBonus = params.kpiBonus ?? 0;
  if (kpiBonus === 0 && show.kpi) {
    const bonusPerPrint = options?.bonusPerExtraPrint ?? DEFAULT_KPI_CONFIG.bonusPerExtraPrint;
    const bonusPerGuest = options?.bonusPerExtraGuest ?? DEFAULT_KPI_CONFIG.bonusPerExtraGuest;

    let totalShowKpiBonus = 0;
    if (show.kpi.actualPrints && show.kpi.targetPrints && show.kpi.actualPrints > show.kpi.targetPrints) {
      totalShowKpiBonus += (show.kpi.actualPrints - show.kpi.targetPrints) * bonusPerPrint;
    }
    if (show.kpi.actualGuests && show.kpi.targetGuests && show.kpi.actualGuests > show.kpi.targetGuests) {
      totalShowKpiBonus += (show.kpi.actualGuests - show.kpi.targetGuests) * bonusPerGuest;
    }

    // Default per-member KPI bonus is the total or split by crew size
    const crewCount = Math.max(1, show.requiredRoles.length);
    kpiBonus = Math.round(totalShowKpiBonus / crewCount);
  }

  const travelAllowance = params.travelAllowance ?? options?.travelAllowance ?? 0;
  const totalAmount = baseAmount + nightBonus + kpiBonus + travelAllowance;

  const regularHours = Number(Math.max(0, durationHours - nightHours).toFixed(2));
  const regularPay = Math.round(regularHours * baseHourlyRate);

  const notes: string[] = [];
  if (nightHours > 0) {
    notes.push(
      `Ca đêm sau 23:00: ${nightHours}h x ${baseHourlyRate.toLocaleString('vi-VN')} VND x +${Math.round(nightBonusRate * 100)}% = +${nightBonus.toLocaleString('vi-VN')} VND`
    );
  }
  if (kpiBonus > 0) {
    notes.push(`Thưởng KPI vượt số lượng: +${kpiBonus.toLocaleString('vi-VN')} VND`);
  }
  if (travelAllowance > 0) {
    notes.push(`Phụ cấp di chuyển: +${travelAllowance.toLocaleString('vi-VN')} VND`);
  }

  return {
    memberId: member.id,
    showId: show.id,
    role,
    level: member.level,
    durationHours,
    baseHourlyRate,
    baseAmount,
    nightHours,
    nightBonusRate,
    nightBonus,
    kpiBonus,
    travelAllowance,
    totalAmount,
    breakdown: {
      regularHours,
      regularPay,
      nightHours,
      nightPayBonus: nightBonus,
      kpiBonus,
      travelAllowance,
      notes,
    },
  };
}

/**
 * Summary of total payout for an entire show roster
 */
export interface ShowRosterPayoutSummary {
  showId: string;
  showName: string;
  totalDurationHours: number;
  totalCrewCount: number;
  totalBaseAmount: number;
  totalNightBonus: number;
  totalKpiBonus: number;
  totalTravelAllowance: number;
  grandTotalAmount: number;
  crewPayouts: PayoutCalculation[];
}

/**
 * Calculates show payout for an entire roster of assigned crew members
 *
 * @param show The EventShow instance
 * @param assignments Confirmed shift assignments for this show
 * @param crewMembers Pool of crew members
 * @param options Additional payout options
 */
export function calculateShowRosterPayout(
  show: EventShow,
  assignments: ShiftAssignment[],
  crewMembers: CrewMember[],
  options?: PayoutOptions
): ShowRosterPayoutSummary {
  const memberMap = new Map(crewMembers.map((m) => [m.id, m]));
  const showAssignments = assignments.filter(
    (a) => a.showId === show.id && a.status !== 'CANCELLED'
  );

  // Compute show-level KPI total bonus pool if KPI data exists
  let totalKpiPool = 0;
  if (show.kpi) {
    const bonusPerPrint = options?.bonusPerExtraPrint ?? DEFAULT_KPI_CONFIG.bonusPerExtraPrint;
    const bonusPerGuest = options?.bonusPerExtraGuest ?? DEFAULT_KPI_CONFIG.bonusPerExtraGuest;

    if (show.kpi.actualPrints && show.kpi.targetPrints && show.kpi.actualPrints > show.kpi.targetPrints) {
      totalKpiPool += (show.kpi.actualPrints - show.kpi.targetPrints) * bonusPerPrint;
    }
    if (show.kpi.actualGuests && show.kpi.targetGuests && show.kpi.actualGuests > show.kpi.targetGuests) {
      totalKpiPool += (show.kpi.actualGuests - show.kpi.targetGuests) * bonusPerGuest;
    }
  }

  const crewCount = showAssignments.length;
  const kpiBonusPerMember = crewCount > 0 ? Math.round(totalKpiPool / crewCount) : 0;

  const crewPayouts: PayoutCalculation[] = [];
  let totalBaseAmount = 0;
  let totalNightBonus = 0;
  let totalKpiBonus = 0;
  let totalTravelAllowance = 0;
  let grandTotalAmount = 0;

  for (const assignment of showAssignments) {
    const member = memberMap.get(assignment.memberId);
    if (!member) {
      throw new Error(`Crew member ${assignment.memberId} not found in provided crew members pool`);
    }

    const payout = calculatePayout({
      member,
      show,
      role: assignment.role,
      kpiBonus: kpiBonusPerMember,
      options,
    });

    crewPayouts.push(payout);
    totalBaseAmount += payout.baseAmount;
    totalNightBonus += payout.nightBonus;
    totalKpiBonus += payout.kpiBonus;
    totalTravelAllowance += payout.travelAllowance;
    grandTotalAmount += payout.totalAmount;
  }

  const start = normalizeDate(show.startAt);
  const end = normalizeDate(show.endAt);
  const totalDurationHours = Number(((end.getTime() - start.getTime()) / (1000 * 60 * 60)).toFixed(2));

  return {
    showId: show.id,
    showName: show.name,
    totalDurationHours,
    totalCrewCount: crewCount,
    totalBaseAmount,
    totalNightBonus,
    totalKpiBonus,
    totalTravelAllowance,
    grandTotalAmount,
    crewPayouts,
  };
}
