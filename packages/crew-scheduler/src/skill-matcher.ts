import {
  CityLocation,
  CrewLevel,
  CrewMember,
  CrewRole,
  EventShow,
  RequiredRoleRequirement,
  ShiftAssignment,
  Venue,
} from './types';
import { hasShiftConflict } from './shift-roster';

/**
 * Seniority Level Numerical Weight for comparisons
 */
export const CREW_LEVEL_WEIGHT: Record<CrewLevel, number> = {
  JUNIOR: 1,
  SENIOR: 2,
  LEAD: 3,
};

/**
 * Checks if a member's level meets or exceeds the required minimum level
 */
export function meetsMinLevel(memberLevel: CrewLevel, minLevel: CrewLevel = 'JUNIOR'): boolean {
  return CREW_LEVEL_WEIGHT[memberLevel] >= CREW_LEVEL_WEIGHT[minLevel];
}

/**
 * Options for filtering qualified crew members
 */
export interface FindQualifiedCrewOptions {
  travelBufferMinutes?: number;
  targetVenue?: Venue;
  minLevel?: CrewLevel;
  includeInactive?: boolean;
}

/**
 * Finds all qualified crew members for specified roles in a city,
 * excluding members with active shift conflicts or insufficient travel buffer.
 *
 * @param crewMembers List of all available crew members in the system
 * @param requiredRoles Array of roles to find candidates for
 * @param city Show operational city (DA_NANG / HO_CHI_MINH)
 * @param showStart Show start timestamp
 * @param showEnd Show end timestamp
 * @param existingAssignments Existing roster shifts across the system
 * @param options Additional options (travelBufferMinutes, targetVenue, minLevel, includeInactive)
 * @returns Map of CrewRole -> sorted array of qualified candidates
 */
export function findQualifiedCrew(
  crewMembers: CrewMember[],
  requiredRoles: CrewRole[],
  city: CityLocation,
  showStart: Date | string,
  showEnd: Date | string,
  existingAssignments: ShiftAssignment[],
  options?: FindQualifiedCrewOptions
): Record<CrewRole, CrewMember[]> {
  const travelBufferMinutes = options?.travelBufferMinutes ?? 60;
  const targetVenue = options?.targetVenue;
  const minLevel = options?.minLevel ?? 'JUNIOR';
  const includeInactive = options?.includeInactive ?? false;

  // Initialize result record
  const result: Record<CrewRole, CrewMember[]> = {} as Record<CrewRole, CrewMember[]>;
  for (const role of requiredRoles) {
    result[role] = [];
  }

  // Filter eligible base pool (active, city match)
  const cityEligibleMembers = crewMembers.filter((m) => {
    if (!includeInactive && !m.isActive) return false;
    return m.city === city;
  });

  for (const role of requiredRoles) {
    const candidates = cityEligibleMembers.filter((m) => {
      // 1. Role capability check (primary role or additional certified roles)
      const hasRole = m.primaryRole === role || (m.roles && m.roles.includes(role));
      if (!hasRole) return false;

      // 2. Minimum seniority check
      if (!meetsMinLevel(m.level, minLevel)) return false;

      // 3. Double-shift & travel buffer conflict check
      const hasConflict = hasShiftConflict(
        m.id,
        showStart,
        showEnd,
        existingAssignments,
        travelBufferMinutes,
        targetVenue
      );
      if (hasConflict) return false;

      return true;
    });

    // Sort candidates:
    // 1. Primary role first
    // 2. Higher seniority level
    // 3. Higher rating
    // 4. Past experience (pastShowsCount)
    candidates.sort((a, b) => {
      const aIsPrimary = a.primaryRole === role ? 1 : 0;
      const bIsPrimary = b.primaryRole === role ? 1 : 0;
      if (aIsPrimary !== bIsPrimary) return bIsPrimary - aIsPrimary;

      const levelDiff = CREW_LEVEL_WEIGHT[b.level] - CREW_LEVEL_WEIGHT[a.level];
      if (levelDiff !== 0) return levelDiff;

      const ratingDiff = (b.rating ?? 4.0) - (a.rating ?? 4.0);
      if (ratingDiff !== 0) return ratingDiff;

      return (b.pastShowsCount ?? 0) - (a.pastShowsCount ?? 0);
    });

    result[role] = candidates;
  }

  return result;
}

/**
 * Internal Normalized Role Requirement Slot
 */
interface RoleSlot {
  slotId: string;
  role: CrewRole;
  minLevel: CrewLevel;
}

/**
 * Result of Optimal Roster Suggestion
 */
export interface OptimalRosterResult {
  isComplete: boolean;
  assignments: ShiftAssignment[];
  matchedCrew: Array<{
    slotId: string;
    role: CrewRole;
    member: CrewMember;
    isPrimary: boolean;
    level: CrewLevel;
  }>;
  unfilledRoles: Array<{
    slotId: string;
    role: CrewRole;
    minLevel: CrewLevel;
  }>;
  candidatePool: Record<CrewRole, CrewMember[]>;
  score: number;
}

/**
 * Calculates a match score for assigning a specific member to a role slot
 */
function calculateMemberRoleScore(member: CrewMember, slot: RoleSlot): number {
  let score = 100;

  // Primary role bonus
  if (member.primaryRole === slot.role) {
    score += 50;
  }

  // Seniority weight
  score += CREW_LEVEL_WEIGHT[member.level] * 15;

  // Rating contribution
  score += (member.rating ?? 4.0) * 10;

  // Experience contribution
  score += Math.min(member.pastShowsCount ?? 0, 20);

  return score;
}

/**
 * Normalized extraction of required role slots from an EventShow
 */
export function extractRoleSlots(show: EventShow): RoleSlot[] {
  const slots: RoleSlot[] = [];
  let index = 1;

  for (const item of show.requiredRoles) {
    if (typeof item === 'string') {
      slots.push({
        slotId: `slot-${index++}-${item}`,
        role: item as CrewRole,
        minLevel: 'JUNIOR',
      });
    } else {
      const count = item.count ?? 1;
      const minLevel = item.minLevel ?? 'JUNIOR';
      for (let c = 0; c < count; c++) {
        slots.push({
          slotId: `slot-${index++}-${item.role}`,
          role: item.role,
          minLevel,
        });
      }
    }
  }

  return slots;
}

/**
 * Suggests the optimal crew roster for an event show.
 * Guarantees no crew member is double-assigned to multiple roles within the same show,
 * respects double-shift guard and travel buffers, and maximizes overall crew competency.
 *
 * @param show Target EventShow
 * @param crewMembers Available crew pool
 * @param existingAssignments Existing assignments across the system
 * @param options Travel buffer & selection preferences
 */
export function suggestOptimalRoster(
  show: EventShow,
  crewMembers: CrewMember[],
  existingAssignments: ShiftAssignment[],
  options?: {
    travelBufferMinutes?: number;
    preferSeniority?: boolean;
  }
): OptimalRosterResult {
  const travelBufferMinutes = options?.travelBufferMinutes ?? 60;
  const slots = extractRoleSlots(show);

  // Extract unique roles needed
  const uniqueRoles = Array.from(new Set(slots.map((s) => s.role)));

  // Find candidate pool for each unique role
  const candidatePool = findQualifiedCrew(
    crewMembers,
    uniqueRoles,
    show.city,
    show.startAt,
    show.endAt,
    existingAssignments,
    {
      travelBufferMinutes,
      targetVenue: show.venue,
    }
  );

  // Match candidates for each slot based on slot minLevel
  const slotCandidates: Map<string, CrewMember[]> = new Map();
  for (const slot of slots) {
    const rawCandidates = candidatePool[slot.role] || [];
    const eligible = rawCandidates.filter((m) => meetsMinLevel(m.level, slot.minLevel));
    slotCandidates.set(slot.slotId, eligible);
  }

  // Sort slots by fewest candidates first (Most Constrained Variable) to prune early
  const sortedSlots = [...slots].sort((a, b) => {
    const aCount = slotCandidates.get(a.slotId)?.length ?? 0;
    const bCount = slotCandidates.get(b.slotId)?.length ?? 0;
    return aCount - bCount;
  });

  // Backtracking solver to find optimal unique assignment
  let bestScore = -1;
  let bestAssignment: Map<string, CrewMember> = new Map();

  function backtrack(
    slotIndex: number,
    currentAssignment: Map<string, CrewMember>,
    assignedMemberIds: Set<string>,
    currentScore: number
  ) {
    if (slotIndex >= sortedSlots.length) {
      if (currentScore > bestScore) {
        bestScore = currentScore;
        bestAssignment = new Map(currentAssignment);
      }
      return;
    }

    const currentSlot = sortedSlots[slotIndex];
    const candidates = slotCandidates.get(currentSlot.slotId) || [];

    let branchExplored = false;
    for (const candidate of candidates) {
      if (assignedMemberIds.has(candidate.id)) {
        continue; // Cannot assign same member to two roles in the same show
      }

      branchExplored = true;
      const scoreGain = calculateMemberRoleScore(candidate, currentSlot);

      currentAssignment.set(currentSlot.slotId, candidate);
      assignedMemberIds.add(candidate.id);

      backtrack(slotIndex + 1, currentAssignment, assignedMemberIds, currentScore + scoreGain);

      // Backtrack
      currentAssignment.delete(currentSlot.slotId);
      assignedMemberIds.delete(candidate.id);
    }

    // Also explore branch where this slot is left unfilled (if no candidates or all conflicts)
    if (!branchExplored || currentAssignment.size < sortedSlots.length) {
      backtrack(slotIndex + 1, currentAssignment, assignedMemberIds, currentScore);
    }
  }

  backtrack(0, new Map(), new Set(), 0);

  // Build final assignments and details
  const matchedCrew: OptimalRosterResult['matchedCrew'] = [];
  const assignments: ShiftAssignment[] = [];
  const unfilledRoles: OptimalRosterResult['unfilledRoles'] = [];

  for (const slot of slots) {
    const assignedMember = bestAssignment.get(slot.slotId);
    if (assignedMember) {
      matchedCrew.push({
        slotId: slot.slotId,
        role: slot.role,
        member: assignedMember,
        isPrimary: assignedMember.primaryRole === slot.role,
        level: assignedMember.level,
      });

      assignments.push({
        id: `assign-${show.id}-${assignedMember.id}-${slot.role}`,
        showId: show.id,
        memberId: assignedMember.id,
        role: slot.role,
        startAt: show.startAt,
        endAt: show.endAt,
        venue: show.venue,
        status: 'CONFIRMED',
      });
    } else {
      unfilledRoles.push({
        slotId: slot.slotId,
        role: slot.role,
        minLevel: slot.minLevel,
      });
    }
  }

  const isComplete = unfilledRoles.length === 0;

  return {
    isComplete,
    assignments,
    matchedCrew,
    unfilledRoles,
    candidatePool,
    score: Math.max(0, bestScore),
  };
}
