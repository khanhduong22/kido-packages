import {
  CityLocation,
  ShiftAssignment,
  ShiftConflictResult,
  Venue,
} from './types';

/**
 * Standard Inter-City Travel Buffer in minutes (flight, transit, airport call-time)
 * E.g., Between Da Nang and Ho Chi Minh: 6 hours = 360 minutes
 */
export const DEFAULT_INTER_CITY_BUFFER_MINUTES = 360;

/**
 * Normalizes input date to a valid JavaScript Date object
 */
export function normalizeDate(date: Date | string | number): Date {
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) {
    throw new Error(`Invalid date provided: ${date}`);
  }
  return d;
}

/**
 * Determines whether two venues represent different physical locations
 */
export function isDifferentVenue(
  venueA?: Venue | { name?: string; city?: CityLocation },
  venueB?: Venue | { name?: string; city?: CityLocation }
): boolean {
  if (!venueA || !venueB) {
    // If either venue is unknown, assume different to be safe
    return true;
  }

  // If cities differ, they are definitely different
  if (venueA.city && venueB.city && venueA.city !== venueB.city) {
    return true;
  }

  // Normalize venue names
  const nameA = (venueA.name || '').trim().toLowerCase();
  const nameB = (venueB.name || '').trim().toLowerCase();

  return nameA !== nameB;
}

/**
 * Determines the required travel buffer in minutes between two venues
 */
export function getRequiredTravelBuffer(
  venueA?: Venue | { name?: string; city?: CityLocation },
  venueB?: Venue | { name?: string; city?: CityLocation },
  intraCityBufferMinutes = 60,
  interCityBufferMinutes = DEFAULT_INTER_CITY_BUFFER_MINUTES
): number {
  if (!venueA || !venueB) {
    return intraCityBufferMinutes;
  }

  // Inter-city check (e.g. DA_NANG vs HO_CHI_MINH)
  if (venueA.city && venueB.city && venueA.city !== venueB.city) {
    return interCityBufferMinutes;
  }

  // Same city, check if exact same venue
  if (!isDifferentVenue(venueA, venueB)) {
    return 0; // Same venue, no travel buffer needed
  }

  return intraCityBufferMinutes;
}

/**
 * Detailed conflict inspection for a crew member's shift against existing assignments.
 * Checks for:
 * 1. Direct shift overlap (Double Shift Guard)
 * 2. Travel buffer violations between consecutive shows
 * 3. Inter-city relocation travel buffer violations
 */
export function findShiftConflict(
  memberId: string,
  startAt: Date | string,
  endAt: Date | string,
  existingShifts: ShiftAssignment[],
  travelBufferMinutes = 60,
  targetVenue?: Venue | { name?: string; city?: CityLocation }
): ShiftConflictResult | null {
  const targetStart = normalizeDate(startAt).getTime();
  const targetEnd = normalizeDate(endAt).getTime();

  if (targetStart >= targetEnd) {
    return {
      hasConflict: true,
      reason: `Invalid shift duration: start time must be before end time (${new Date(targetStart).toISOString()} >= ${new Date(targetEnd).toISOString()})`,
    };
  }

  // Filter shifts belonging to this member, ignoring cancelled shifts
  const memberShifts = existingShifts.filter(
    (s) => s.memberId === memberId && s.status !== 'CANCELLED'
  );

  for (const shift of memberShifts) {
    const shiftStart = normalizeDate(shift.startAt).getTime();
    const shiftEnd = normalizeDate(shift.endAt).getTime();

    // 1. Direct Overlap Check: max(start1, start2) < min(end1, end2)
    const isDirectOverlap = Math.max(targetStart, shiftStart) < Math.min(targetEnd, shiftEnd);
    if (isDirectOverlap) {
      return {
        hasConflict: true,
        reason: `Direct shift overlap: Member ${memberId} is already scheduled from ${new Date(shiftStart).toISOString()} to ${new Date(shiftEnd).toISOString()} at ${shift.venue.name}`,
        conflictingShift: shift,
        requiredBufferMinutes: 0,
        actualBufferMinutes: 0,
      };
    }

    // 2. Travel Buffer Check for consecutive shifts
    const requiredBuffer = getRequiredTravelBuffer(
      targetVenue,
      shift.venue,
      travelBufferMinutes,
      DEFAULT_INTER_CITY_BUFFER_MINUTES
    );

    const requiredBufferMs = requiredBuffer * 60 * 1000;

    // Target shift is AFTER existing shift
    if (targetStart >= shiftEnd) {
      const gapMs = targetStart - shiftEnd;
      if (gapMs < requiredBufferMs) {
        const actualBufferMinutes = Math.round(gapMs / (60 * 1000));
        return {
          hasConflict: true,
          reason: `Insufficient travel buffer after shift at ${shift.venue.name}: ${actualBufferMinutes}m available, but ${requiredBuffer}m required`,
          conflictingShift: shift,
          requiredBufferMinutes: requiredBuffer,
          actualBufferMinutes,
        };
      }
    }

    // Target shift is BEFORE existing shift
    if (targetEnd <= shiftStart) {
      const gapMs = shiftStart - targetEnd;
      if (gapMs < requiredBufferMs) {
        const actualBufferMinutes = Math.round(gapMs / (60 * 1000));
        return {
          hasConflict: true,
          reason: `Insufficient travel buffer before shift at ${shift.venue.name}: ${actualBufferMinutes}m available, but ${requiredBuffer}m required`,
          conflictingShift: shift,
          requiredBufferMinutes: requiredBuffer,
          actualBufferMinutes,
        };
      }
    }
  }

  return null;
}

/**
 * Double Shift & Travel Buffer Guard
 * Returns true if the member has a conflict or insufficient travel buffer, false if available.
 *
 * @param memberId Crew member ID to check
 * @param startAt Proposed shift start timestamp
 * @param endAt Proposed shift end timestamp
 * @param existingShifts All existing shift assignments
 * @param travelBufferMinutes Required buffer in minutes between different venues (default 60 mins)
 * @param targetVenue Optional venue details of the proposed shift
 */
export function hasShiftConflict(
  memberId: string,
  startAt: Date | string,
  endAt: Date | string,
  existingShifts: ShiftAssignment[],
  travelBufferMinutes = 60,
  targetVenue?: Venue | { name?: string; city?: CityLocation }
): boolean {
  const result = findShiftConflict(
    memberId,
    startAt,
    endAt,
    existingShifts,
    travelBufferMinutes,
    targetVenue
  );
  return result !== null && result.hasConflict;
}

/**
 * Validates a batch of assignments to ensure no member is double-booked
 * or scheduled with insufficient travel buffers across the whole roster.
 */
export function validateRoster(
  assignments: ShiftAssignment[],
  travelBufferMinutes = 60
): {
  isValid: boolean;
  conflicts: Array<{
    shiftA: ShiftAssignment;
    shiftB: ShiftAssignment;
    reason: string;
  }>;
} {
  const conflicts: Array<{
    shiftA: ShiftAssignment;
    shiftB: ShiftAssignment;
    reason: string;
  }> = [];

  for (let i = 0; i < assignments.length; i++) {
    for (let j = i + 1; j < assignments.length; j++) {
      const a = assignments[i];
      const b = assignments[j];

      if (a.memberId !== b.memberId) continue;
      if (a.status === 'CANCELLED' || b.status === 'CANCELLED') continue;

      const conflict = findShiftConflict(
        a.memberId,
        a.startAt,
        a.endAt,
        [b],
        travelBufferMinutes,
        a.venue
      );

      if (conflict && conflict.hasConflict) {
        conflicts.push({
          shiftA: a,
          shiftB: b,
          reason: conflict.reason || 'Shift conflict detected',
        });
      }
    }
  }

  return {
    isValid: conflicts.length === 0,
    conflicts,
  };
}
