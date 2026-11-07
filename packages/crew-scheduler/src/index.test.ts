import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CrewMember,
  CrewRole,
  CityLocation,
  EventShow,
  ShiftAssignment,
  Venue,
  CrewRoleSchema,
  CityLocationSchema,
  CrewMemberSchema,
  EventShowSchema,
  hasShiftConflict,
  findShiftConflict,
  validateRoster,
  findQualifiedCrew,
  suggestOptimalRoster,
  calculateNightHours,
  calculatePayout,
  calculateShowRosterPayout,
  DEFAULT_HOURLY_RATES,
  resolveWorkforceCategory,
  calculateCategoryTotals,
  groupWorkforcePayroll,
  WORKFORCE_CATEGORIES,
  WorkforceMemberPayroll,
} from './index';

// =============================================================================
// Mock Fixtures
// =============================================================================

const venueIntercontinentalDanang: Venue = {
  name: 'InterContinental Danang Sun Peninsula',
  city: 'DA_NANG',
  district: 'Son Tra',
  address: 'Bai Bac, Son Tra Peninsula, Da Nang',
};

const venueFuramaDanang: Venue = {
  name: 'Furama Resort Danang',
  city: 'DA_NANG',
  district: 'Ngu Hanh Son',
  address: '105 Vo Nguyen Giap, Da Nang',
};

const venueGemCenterSaigon: Venue = {
  name: 'GEM Center Saigon',
  city: 'HO_CHI_MINH',
  district: 'District 1',
  address: '8 Nguyen Binh Khiem, Da Kao, District 1, HCMC',
};

const venueWhitePalaceSaigon: Venue = {
  name: 'White Palace Pham Van Dong',
  city: 'HO_CHI_MINH',
  district: 'Thu Duc',
  address: '108 Pham Van Dong, Hiep Binh Chanh, Thu Duc, HCMC',
};

const mockCrewPool: CrewMember[] = [
  {
    id: 'crew-001',
    name: 'Nguyen Van An',
    city: 'DA_NANG',
    primaryRole: 'GLAMBOT_OPERATOR',
    roles: ['GLAMBOT_OPERATOR', 'TECH_LEAD'],
    level: 'LEAD',
    rating: 4.9,
    pastShowsCount: 45,
    isActive: true,
  },
  {
    id: 'crew-002',
    name: 'Tran Thi Binh',
    city: 'DA_NANG',
    primaryRole: 'CINEMATOGRAPHER',
    roles: ['CINEMATOGRAPHER', 'PHOTOGRAPHER'],
    level: 'SENIOR',
    rating: 4.8,
    pastShowsCount: 30,
    isActive: true,
  },
  {
    id: 'crew-003',
    name: 'Le Hoang Cuong',
    city: 'DA_NANG',
    primaryRole: 'LIGHTING_TECH',
    roles: ['LIGHTING_TECH'],
    level: 'JUNIOR',
    rating: 4.5,
    pastShowsCount: 12,
    isActive: true,
  },
  {
    id: 'crew-004',
    name: 'Pham Minh Dung',
    city: 'DA_NANG',
    primaryRole: 'BOOTH_HOST',
    roles: ['BOOTH_HOST', 'PHOTOGRAPHER'],
    level: 'JUNIOR',
    rating: 4.6,
    pastShowsCount: 18,
    isActive: true,
  },
  {
    id: 'crew-005',
    name: 'Dang Quoc Em',
    city: 'DA_NANG',
    primaryRole: 'TECH_LEAD',
    roles: ['TECH_LEAD', 'GLAMBOT_OPERATOR', 'CINEMATOGRAPHER'],
    level: 'LEAD',
    rating: 5.0,
    pastShowsCount: 60,
    isActive: true,
  },
  {
    id: 'crew-006',
    name: 'Hoang Van Giang',
    city: 'HO_CHI_MINH',
    primaryRole: 'GLAMBOT_OPERATOR',
    roles: ['GLAMBOT_OPERATOR', 'CINEMATOGRAPHER'],
    level: 'SENIOR',
    rating: 4.7,
    pastShowsCount: 25,
    isActive: true,
  },
  {
    id: 'crew-007',
    name: 'Vu Thi Huong',
    city: 'HO_CHI_MINH',
    primaryRole: 'BOOTH_HOST',
    roles: ['BOOTH_HOST'],
    level: 'JUNIOR',
    rating: 4.4,
    pastShowsCount: 10,
    isActive: true,
  },
  {
    id: 'crew-008',
    name: 'Doan Van Inactive',
    city: 'DA_NANG',
    primaryRole: 'PHOTOGRAPHER',
    roles: ['PHOTOGRAPHER'],
    level: 'SENIOR',
    rating: 4.0,
    pastShowsCount: 20,
    isActive: false, // Inactive
  },
];

describe('@kido/crew-scheduler Test Suite', () => {
  // ===========================================================================
  // 1. Zod Validation & Schema Type Integrity
  // ===========================================================================
  describe('1. Zod Schema & Domain Types', () => {
    it('1.1 should validate valid CrewMember schema successfully', () => {
      const validMember = mockCrewPool[0];
      const parsed = CrewMemberSchema.parse(validMember);
      assert.equal(parsed.id, 'crew-001');
      assert.equal(parsed.city, 'DA_NANG');
      assert.equal(parsed.level, 'LEAD');
    });

    it('1.2 should reject invalid CrewRole and invalid City', () => {
      assert.throws(() => {
        CrewRoleSchema.parse('DJ_MUSICIAN');
      }, /Invalid enum value/);

      assert.throws(() => {
        CityLocationSchema.parse('HA_NOI');
      }, /Invalid enum value/);
    });

    it('1.3 should validate EventShow schema with nested venue and roles', () => {
      const validShow: EventShow = {
        id: 'show-101',
        name: 'Wedding Gala InterCon Da Nang',
        brand: 'T_RED_MEDIA',
        city: 'DA_NANG',
        venue: venueIntercontinentalDanang,
        startAt: new Date('2026-11-20T17:00:00+07:00'),
        endAt: new Date('2026-11-20T22:00:00+07:00'),
        requiredRoles: ['GLAMBOT_OPERATOR', 'CINEMATOGRAPHER'],
      };
      const parsed = EventShowSchema.parse(validShow);
      assert.equal(parsed.name, 'Wedding Gala InterCon Da Nang');
    });
  });

  // ===========================================================================
  // 2. Skill Matcher: Role Qualification & City Filter
  // ===========================================================================
  describe('2. Skill Matcher (findQualifiedCrew)', () => {
    it('2.1 should filter crew members strictly by show operational city', () => {
      const danangCandidates = findQualifiedCrew(
        mockCrewPool,
        ['GLAMBOT_OPERATOR'],
        'DA_NANG',
        new Date('2026-11-20T17:00:00+07:00'),
        new Date('2026-11-20T21:00:00+07:00'),
        []
      );

      // Should only include Da Nang members (crew-001, crew-005), NOT Saigon member (crew-006)
      const memberIds = danangCandidates.GLAMBOT_OPERATOR.map((c) => c.id);
      assert.ok(memberIds.includes('crew-001'), 'Should contain crew-001');
      assert.ok(memberIds.includes('crew-005'), 'Should contain crew-005');
      assert.equal(memberIds.includes('crew-006'), false, 'Should not contain HCMC crew-006');
    });

    it('2.2 should exclude inactive crew members by default', () => {
      const candidates = findQualifiedCrew(
        mockCrewPool,
        ['PHOTOGRAPHER'],
        'DA_NANG',
        new Date('2026-11-20T17:00:00+07:00'),
        new Date('2026-11-20T21:00:00+07:00'),
        []
      );

      const memberIds = candidates.PHOTOGRAPHER.map((c) => c.id);
      assert.equal(memberIds.includes('crew-008'), false, 'Should exclude inactive crew-008');
    });

    it('2.3 should sort candidates with primary role first, then level, then rating', () => {
      const candidates = findQualifiedCrew(
        mockCrewPool,
        ['GLAMBOT_OPERATOR'],
        'DA_NANG',
        new Date('2026-11-20T17:00:00+07:00'),
        new Date('2026-11-20T21:00:00+07:00'),
        []
      );

      // crew-001 has primaryRole GLAMBOT_OPERATOR
      // crew-005 has primaryRole TECH_LEAD (GLAMBOT_OPERATOR is secondary)
      // Therefore, crew-001 should rank ahead of crew-005
      assert.equal(candidates.GLAMBOT_OPERATOR[0].id, 'crew-001');
      assert.equal(candidates.GLAMBOT_OPERATOR[1].id, 'crew-005');
    });
  });

  // ===========================================================================
  // 3. Double Shift Guard: Schedule Overlap Detection
  // ===========================================================================
  describe('3. Double Shift Guard (Shift Overlap)', () => {
    const existingShift: ShiftAssignment = {
      id: 'shift-01',
      showId: 'show-01',
      memberId: 'crew-001',
      role: 'GLAMBOT_OPERATOR',
      startAt: new Date('2026-11-20T14:00:00+07:00'),
      endAt: new Date('2026-11-20T18:00:00+07:00'),
      venue: venueIntercontinentalDanang,
      status: 'CONFIRMED',
    };

    it('3.1 should detect direct collision when proposed shift overlaps existing shift', () => {
      // Overlapping shift: 16:00 to 20:00 (overlaps with 14:00 - 18:00)
      const conflict = hasShiftConflict(
        'crew-001',
        new Date('2026-11-20T16:00:00+07:00'),
        new Date('2026-11-20T20:00:00+07:00'),
        [existingShift]
      );
      assert.equal(conflict, true, 'Must detect direct overlap');

      const details = findShiftConflict(
        'crew-001',
        new Date('2026-11-20T16:00:00+07:00'),
        new Date('2026-11-20T20:00:00+07:00'),
        [existingShift]
      );
      assert.ok(details?.reason?.includes('Direct shift overlap'));
    });

    it('3.2 should allow different members to be scheduled simultaneously without conflict', () => {
      // Another member (crew-002) at the same time: NO conflict
      const conflict = hasShiftConflict(
        'crew-002',
        new Date('2026-11-20T14:00:00+07:00'),
        new Date('2026-11-20T18:00:00+07:00'),
        [existingShift]
      );
      assert.equal(conflict, false, 'Different member should have no conflict');
    });

    it('3.3 should ignore CANCELLED shifts when checking conflicts', () => {
      const cancelledShift: ShiftAssignment = {
        ...existingShift,
        id: 'shift-cancelled',
        status: 'CANCELLED',
      };

      const conflict = hasShiftConflict(
        'crew-001',
        new Date('2026-11-20T14:00:00+07:00'),
        new Date('2026-11-20T18:00:00+07:00'),
        [cancelledShift]
      );
      assert.equal(conflict, false, 'Cancelled shift must not trigger conflict');
    });
  });

  // ===========================================================================
  // 4. Travel Buffer: Intra-City Between Different Venues
  // ===========================================================================
  describe('4. Travel Buffer Between Different Venues', () => {
    // Existing show at InterContinental Da Nang (ends at 18:00)
    const existingShift: ShiftAssignment = {
      id: 'shift-ic',
      showId: 'show-ic',
      memberId: 'crew-001',
      role: 'GLAMBOT_OPERATOR',
      startAt: new Date('2026-11-20T14:00:00+07:00'),
      endAt: new Date('2026-11-20T18:00:00+07:00'),
      venue: venueIntercontinentalDanang,
      status: 'CONFIRMED',
    };

    it('4.1 should catch conflict when gap is 30 mins (< 60 min required buffer)', () => {
      // Next show at Furama Resort (starts at 18:30 -> gap is only 30 mins)
      const conflict = hasShiftConflict(
        'crew-001',
        new Date('2026-11-20T18:30:00+07:00'),
        new Date('2026-11-20T22:30:00+07:00'),
        [existingShift],
        60, // 60 min travel buffer
        venueFuramaDanang
      );
      assert.equal(conflict, true, 'Should detect insufficient 30 min buffer');

      const details = findShiftConflict(
        'crew-001',
        new Date('2026-11-20T18:30:00+07:00'),
        new Date('2026-11-20T22:30:00+07:00'),
        [existingShift],
        60,
        venueFuramaDanang
      );
      assert.ok(details?.reason?.includes('Insufficient travel buffer'));
      assert.equal(details?.actualBufferMinutes, 30);
      assert.equal(details?.requiredBufferMinutes, 60);
    });

    it('4.2 should allow assignment when travel buffer is 75 mins (>= 60 min required buffer)', () => {
      // Next show starts at 19:15 -> gap is 75 mins >= 60 mins
      const conflict = hasShiftConflict(
        'crew-001',
        new Date('2026-11-20T19:15:00+07:00'),
        new Date('2026-11-20T23:15:00+07:00'),
        [existingShift],
        60,
        venueFuramaDanang
      );
      assert.equal(conflict, false, '75 mins gap satisfies 60 min travel buffer');
    });

    it('4.3 should allow consecutive back-to-back shifts at the exact same venue without buffer', () => {
      // Same venue (InterContinental Danang): Starts immediately at 18:00 (gap = 0)
      const conflict = hasShiftConflict(
        'crew-001',
        new Date('2026-11-20T18:00:00+07:00'),
        new Date('2026-11-20T22:00:00+07:00'),
        [existingShift],
        60,
        venueIntercontinentalDanang // Exact same venue!
      );
      assert.equal(conflict, false, 'Same venue requires zero transit buffer');
    });

    it('4.4 should respect customizable travel buffer (e.g. 90 minutes)', () => {
      // Gap is 75 mins. Under 60m buffer it passes, but under 90m buffer it must fail
      const conflict90 = hasShiftConflict(
        'crew-001',
        new Date('2026-11-20T19:15:00+07:00'),
        new Date('2026-11-20T23:15:00+07:00'),
        [existingShift],
        90, // Custom 90 min buffer
        venueFuramaDanang
      );
      assert.equal(conflict90, true, '75m gap fails 90m buffer requirement');
    });
  });

  // ===========================================================================
  // 5. Inter-City Flight/Relocation Guard
  // ===========================================================================
  describe('5. Inter-City Relocation Guard', () => {
    const danangShift: ShiftAssignment = {
      id: 'shift-dn',
      showId: 'show-dn',
      memberId: 'crew-001',
      role: 'GLAMBOT_OPERATOR',
      startAt: new Date('2026-11-20T08:00:00+07:00'),
      endAt: new Date('2026-11-20T12:00:00+07:00'),
      venue: venueIntercontinentalDanang, // DA_NANG
      status: 'CONFIRMED',
    };

    it('5.1 should prevent scheduling a show in Saigon 3 hours after a show in Da Nang', () => {
      // Ends in Da Nang at 12:00. Starts in Saigon at 15:00 (gap = 3 hours = 180m < 360m inter-city buffer)
      const conflict = hasShiftConflict(
        'crew-001',
        new Date('2026-11-20T15:00:00+07:00'),
        new Date('2026-11-20T19:00:00+07:00'),
        [danangShift],
        60,
        venueGemCenterSaigon // HO_CHI_MINH
      );
      assert.equal(conflict, true, 'Must flag inter-city relocation violation');
    });
  });

  // ===========================================================================
  // 6. Optimal Roster Dispatcher & Conflict Avoidance
  // ===========================================================================
  describe('6. Optimal Roster Dispatcher (suggestOptimalRoster)', () => {
    it('6.1 should successfully suggest a complete 4-man crew for a Glambot show', () => {
      const show: EventShow = {
        id: 'show-glambot-01',
        name: 'Gala Dinner T-RED Media Show',
        brand: 'T_RED_MEDIA',
        city: 'DA_NANG',
        venue: venueIntercontinentalDanang,
        startAt: new Date('2026-11-25T18:00:00+07:00'),
        endAt: new Date('2026-11-25T22:00:00+07:00'),
        requiredRoles: [
          'GLAMBOT_OPERATOR',
          'CINEMATOGRAPHER',
          'LIGHTING_TECH',
          'TECH_LEAD',
        ],
      };

      const result = suggestOptimalRoster(show, mockCrewPool, []);
      assert.equal(result.isComplete, true, 'Should completely staff all 4 roles');
      assert.equal(result.assignments.length, 4);

      // Verify that no two roles are assigned to the exact same member
      const assignedMemberIds = result.assignments.map((a) => a.memberId);
      const uniqueMemberIds = new Set(assignedMemberIds);
      assert.equal(uniqueMemberIds.size, 4, 'All assigned crew must be distinct individuals');
    });

    it('6.2 should flag unfilled roles when suitable qualified crew is unavailable', () => {
      // Requesting 3 Glambot Operators in Da Nang, but only 2 exist (crew-001, crew-005)
      const show: EventShow = {
        id: 'show-heavy',
        name: 'Massive Multi-Glambot Summit',
        city: 'DA_NANG',
        venue: venueFuramaDanang,
        startAt: new Date('2026-11-25T18:00:00+07:00'),
        endAt: new Date('2026-11-25T22:00:00+07:00'),
        requiredRoles: [
          { role: 'GLAMBOT_OPERATOR', count: 3, minLevel: 'SENIOR' },
        ],
      };

      const result = suggestOptimalRoster(show, mockCrewPool, []);
      assert.equal(result.isComplete, false, 'Cannot fill 3 when only 2 exist');
      assert.equal(result.unfilledRoles.length, 1);
      assert.equal(result.assignments.length, 2);
    });
  });

  // ===========================================================================
  // 7. Payout Calculator: Base Rates by Seniority Level
  // ===========================================================================
  describe('7. Payout Calculator (Base Hourly Rates)', () => {
    const show4h: EventShow = {
      id: 'show-day-01',
      name: 'Afternoon Product Launch',
      city: 'DA_NANG',
      venue: venueFuramaDanang,
      startAt: new Date('2026-11-20T13:00:00+07:00'),
      endAt: new Date('2026-11-20T17:00:00+07:00'), // Exactly 4.0 hours
      requiredRoles: ['GLAMBOT_OPERATOR'],
    };

    it('7.1 should calculate Junior payout at 150,000 VND / hour', () => {
      const juniorMember = mockCrewPool.find((m) => m.level === 'JUNIOR')!;
      const payout = calculatePayout({ member: juniorMember, show: show4h });

      assert.equal(payout.durationHours, 4.0);
      assert.equal(payout.baseHourlyRate, DEFAULT_HOURLY_RATES.JUNIOR); // 150k
      assert.equal(payout.baseAmount, 4 * 150_000); // 600,000 VND
      assert.equal(payout.nightHours, 0);
      assert.equal(payout.nightBonus, 0);
      assert.equal(payout.totalAmount, 600_000);
    });

    it('7.2 should calculate Senior payout at 250,000 VND / hour', () => {
      const seniorMember = mockCrewPool.find((m) => m.level === 'SENIOR')!;
      const payout = calculatePayout({ member: seniorMember, show: show4h });

      assert.equal(payout.baseHourlyRate, 250_000);
      assert.equal(payout.baseAmount, 4 * 250_000); // 1,000,000 VND
      assert.equal(payout.totalAmount, 1_000_000);
    });

    it('7.3 should calculate Lead payout at 350,000 VND / hour', () => {
      const leadMember = mockCrewPool.find((m) => m.level === 'LEAD')!;
      const payout = calculatePayout({ member: leadMember, show: show4h });

      assert.equal(payout.baseHourlyRate, 350_000);
      assert.equal(payout.baseAmount, 4 * 350_000); // 1,400,000 VND
      assert.equal(payout.totalAmount, 1_400_000);
    });

    it('7.4 should honor custom hourlyRate defined on member profile', () => {
      const customMember: CrewMember = {
        ...mockCrewPool[0],
        id: 'crew-custom',
        hourlyRate: 500_000, // Custom 500k/h
      };

      const payout = calculatePayout({ member: customMember, show: show4h });
      assert.equal(payout.baseHourlyRate, 500_000);
      assert.equal(payout.totalAmount, 2_000_000); // 4 * 500k
    });
  });

  // ===========================================================================
  // 8. Payout Calculator: Night Shift Allowance (+30% after 23:00)
  // ===========================================================================
  describe('8. Payout Calculator (Night Shift Allowance +30%)', () => {
    it('8.1 calculateNightHours should correctly identify hours between 23:00 and 06:00', () => {
      // 20:00 to 01:00 = 5.0 total hours, with 2.0 night hours (23:00 to 01:00)
      const nightHours1 = calculateNightHours(
        '2026-11-20T20:00:00+07:00',
        '2026-11-21T01:00:00+07:00'
      );
      assert.equal(nightHours1, 2.0);

      // Daytime 10:00 to 18:00 = 0.0 night hours
      const nightHours2 = calculateNightHours(
        '2026-11-20T10:00:00+07:00',
        '2026-11-20T18:00:00+07:00'
      );
      assert.equal(nightHours2, 0);

      // All night 23:30 to 03:30 = 4.0 night hours
      const nightHours3 = calculateNightHours(
        '2026-11-20T23:30:00+07:00',
        '2026-11-21T03:30:00+07:00'
      );
      assert.equal(nightHours3, 4.0);
    });

    it('8.2 should apply +30% night bonus on Senior member working until 01:00 AM', () => {
      // Show from 20:00 to 01:00 (5 hours total: 3h regular, 2h night)
      // Senior rate = 250,000 VND / h
      // Base pay = 5h * 250,000 = 1,250,000 VND
      // Night bonus (+30%) on 2 hours = 2h * 250,000 * 0.3 = 150,000 VND
      // Total amount = 1,400,000 VND
      const nightShow: EventShow = {
        id: 'show-night-01',
        name: 'Late Night Wedding Afterparty',
        city: 'DA_NANG',
        venue: venueIntercontinentalDanang,
        startAt: new Date('2026-11-20T20:00:00+07:00'),
        endAt: new Date('2026-11-21T01:00:00+07:00'),
        requiredRoles: ['CINEMATOGRAPHER'],
      };

      const seniorMember = mockCrewPool.find((m) => m.id === 'crew-002')!; // Senior
      const payout = calculatePayout({ member: seniorMember, show: nightShow });

      assert.equal(payout.durationHours, 5.0);
      assert.equal(payout.nightHours, 2.0);
      assert.equal(payout.baseAmount, 1_250_000);
      assert.equal(payout.nightBonus, 150_000);
      assert.equal(payout.totalAmount, 1_400_000);
      assert.ok(payout.breakdown.notes?.some((n) => n.includes('Ca đêm')));
    });
  });

  // ===========================================================================
  // 9. Payout Calculator: Over-KPI Photobooth Bonus
  // ===========================================================================
  describe('9. Payout Calculator (KPI Over-Achievement Bonus)', () => {
    it('9.1 should award KPI bonuses for exceeding print and guest targets', () => {
      // 4 hours show, target: 500 prints / 300 guests; actual: 700 prints / 400 guests
      // Excess prints: 200 * 1,000 VND = 200,000 VND
      // Excess guests: 100 * 500 VND = 50,000 VND
      // Total KPI Pool = 250,000 VND
      const photoboothShow: EventShow = {
        id: 'show-photo-01',
        name: 'T-RED Photobooth Corporate Summit',
        brand: 'T_RED_PHOTOBOOTH',
        city: 'HO_CHI_MINH',
        venue: venueGemCenterSaigon,
        startAt: new Date('2026-11-22T17:00:00+07:00'),
        endAt: new Date('2026-11-22T21:00:00+07:00'), // 4 hours
        requiredRoles: ['BOOTH_HOST'], // 1 crew member
        kpi: {
          targetPrints: 500,
          actualPrints: 700,
          targetGuests: 300,
          actualGuests: 400,
        },
      };

      const boothHost = mockCrewPool.find((m) => m.id === 'crew-007')!; // Junior, 150k/h
      const payout = calculatePayout({ member: boothHost, show: photoboothShow });

      assert.equal(payout.baseAmount, 4 * 150_000); // 600,000 VND
      assert.equal(payout.kpiBonus, 250_000); // 200k prints + 50k guests
      assert.equal(payout.totalAmount, 600_000 + 250_000); // 850,000 VND
    });
  });

  // ===========================================================================
  // 10. Entire Show Roster Budget Calculation
  // ===========================================================================
  describe('10. Full Show Roster Budget & Validation', () => {
    it('10.1 should aggregate budget and calculate individual payouts for all crew', () => {
      const show: EventShow = {
        id: 'show-gala-full',
        name: 'Grand Luxury Wedding Gala',
        city: 'DA_NANG',
        venue: venueIntercontinentalDanang,
        startAt: new Date('2026-11-25T19:00:00+07:00'),
        endAt: new Date('2026-11-26T00:00:00+07:00'), // 5 hours (1h night: 23:00 to 00:00)
        requiredRoles: ['GLAMBOT_OPERATOR', 'CINEMATOGRAPHER'],
      };

      const assignments: ShiftAssignment[] = [
        {
          id: 'assign-1',
          showId: show.id,
          memberId: 'crew-001', // LEAD (350k/h)
          role: 'GLAMBOT_OPERATOR',
          startAt: show.startAt,
          endAt: show.endAt,
          venue: show.venue,
          status: 'CONFIRMED',
        },
        {
          id: 'assign-2',
          showId: show.id,
          memberId: 'crew-002', // SENIOR (250k/h)
          role: 'CINEMATOGRAPHER',
          startAt: show.startAt,
          endAt: show.endAt,
          venue: show.venue,
          status: 'CONFIRMED',
        },
      ];

      const summary = calculateShowRosterPayout(show, assignments, mockCrewPool);

      assert.equal(summary.totalCrewCount, 2);
      assert.equal(summary.totalDurationHours, 5.0);

      // Crew 1 (Lead): Base = 5 * 350k = 1,750,000; Night (1h) = 1 * 350k * 0.3 = 105,000 -> Total = 1,855,000
      // Crew 2 (Senior): Base = 5 * 250k = 1,250,000; Night (1h) = 1 * 250k * 0.3 = 75,000 -> Total = 1,325,000
      assert.equal(summary.totalBaseAmount, 1_750_000 + 1_250_000); // 3,000,000
      assert.equal(summary.totalNightBonus, 105_000 + 75_000); // 180,000
      assert.equal(summary.grandTotalAmount, 3_180_000);
    });

    it('10.2 validateRoster should detect conflicts when a roster has colliding assignments', () => {
      const collidingAssignments: ShiftAssignment[] = [
        {
          id: 'a1',
          showId: 's1',
          memberId: 'crew-001',
          role: 'GLAMBOT_OPERATOR',
          startAt: new Date('2026-11-20T14:00:00+07:00'),
          endAt: new Date('2026-11-20T18:00:00+07:00'),
          venue: venueIntercontinentalDanang,
          status: 'CONFIRMED',
        },
        {
          id: 'a2',
          showId: 's2',
          memberId: 'crew-001', // Same member!
          role: 'GLAMBOT_OPERATOR',
          startAt: new Date('2026-11-20T17:00:00+07:00'), // Overlaps!
          endAt: new Date('2026-11-20T21:00:00+07:00'),
          venue: venueFuramaDanang,
          status: 'CONFIRMED',
        },
      ];

      const validation = validateRoster(collidingAssignments);
      assert.equal(validation.isValid, false);
      assert.equal(validation.conflicts.length, 1);
    });
  });

  // ===========================================================================
  // 11. Categorized Workforce Payroll Aggregator (5-Tier Grouping)
  // ===========================================================================
  describe('11. Categorized Workforce Payroll Aggregator (5-Tier Grouping)', () => {
    it('11.1 should correctly resolve category for ADMIN, PARTNER, FULL_TIME, PART_TIME, and RESIGNED', () => {
      assert.equal(resolveWorkforceCategory({ role: 'ADMIN', isActive: true }), 'ADMIN');
      assert.equal(resolveWorkforceCategory({ role: 'GENERAL_MANAGER', isActive: true }), 'ADMIN');
      assert.equal(resolveWorkforceCategory({ role: 'CO_DONG', isActive: true }), 'PARTNER');
      assert.equal(resolveWorkforceCategory({ employmentType: 'PARTNER', isActive: true }), 'PARTNER');
      assert.equal(resolveWorkforceCategory({ role: 'SENIOR_STAFF', isActive: true }), 'FULL_TIME');
      assert.equal(resolveWorkforceCategory({ role: 'STAFF', employmentType: 'FULL_TIME', isActive: true }), 'FULL_TIME');
      assert.equal(resolveWorkforceCategory({ role: 'HOURLY_CREW', employmentType: 'PART_TIME', isActive: true }), 'PART_TIME');
      assert.equal(resolveWorkforceCategory({ role: 'FREELANCE', isActive: true }), 'PART_TIME');
      assert.equal(resolveWorkforceCategory({ role: 'STAFF', isActive: false }), 'RESIGNED');
      assert.equal(resolveWorkforceCategory({ role: 'ADMIN', employmentType: 'RESIGNED', isActive: true }), 'RESIGNED');
    });

    it('11.2 should calculate category totals with baseSalary, allowances, bonus, deductions, and netPayout', () => {
      const members: WorkforceMemberPayroll[] = [
        {
          id: 'u1',
          name: 'Nguyễn Văn A',
          baseSalary: 12_000_000,
          baseHours: 160,
          overtimeHours: 10,
          allowances: 1_000_000,
          bonus: 500_000,
          deductions: 200_000,
          isActive: true,
        },
        {
          id: 'u2',
          name: 'Trần Thị B',
          baseSalary: 15_000_000,
          baseHours: 160,
          overtimeHours: 0,
          allowances: 1_200_000,
          bonus: 1_000_000,
          deductions: 300_000,
          isActive: true,
        },
      ];

      const totals = calculateCategoryTotals(members);
      assert.equal(totals.headcount, 2);
      assert.equal(totals.totalBaseHours, 320);
      assert.equal(totals.totalOvertimeHours, 10);
      assert.equal(totals.totalBaseSalary, 27_000_000);
      assert.equal(totals.totalAllowances, 2_200_000);
      assert.equal(totals.totalBonus, 1_500_000);
      assert.equal(totals.totalDeductions, 500_000);
      // Net u1: 12m + 1m + 0.5m - 0.2m = 13.3m
      // Net u2: 15m + 1.2m + 1m - 0.3m = 16.9m
      // Total net: 30.2m
      assert.equal(totals.totalNetPayout, 30_200_000);
    });

    it('11.3 should group workforce into 5 tiers with correct headcount, sorting, and grand totals', () => {
      const staffList: WorkforceMemberPayroll[] = [
        { id: 'adm-1', name: 'Giám đốc Điều hành', role: 'ADMIN', baseSalary: 30_000_000, isActive: true },
        { id: 'part-1', name: 'Cổ đông Thiên thần', role: 'PARTNER', baseSalary: 20_000_000, isActive: true },
        { id: 'ft-1', name: 'Nguyễn Văn B (Fulltime)', role: 'STAFF', employmentType: 'FULL_TIME', baseSalary: 10_000_000, allowances: 500_000, isActive: true },
        { id: 'ft-2', name: 'An Đình C (Fulltime)', role: 'STAFF', employmentType: 'FULL_TIME', baseSalary: 12_000_000, bonus: 1_000_000, isActive: true },
        { id: 'pt-1', name: 'Lê Thị D (Part-time)', role: 'CREW', employmentType: 'PART_TIME', baseSalary: 4_000_000, isActive: true },
        { id: 'old-1', name: 'Phạm Văn E (Đã nghỉ)', role: 'STAFF', baseSalary: 8_000_000, isActive: false },
      ];

      const result = groupWorkforcePayroll(staffList, { sortBy: 'name', sortOrder: 'asc' });

      assert.equal(result.activeHeadcount, 5);
      assert.equal(result.groups.ADMIN.members.length, 1);
      assert.equal(result.groups.PARTNER.members.length, 1);
      assert.equal(result.groups.FULL_TIME.members.length, 2);
      assert.equal(result.groups.PART_TIME.members.length, 1);
      assert.equal(result.groups.RESIGNED.members.length, 1);

      // Verify Vietnamese name sorting in FULL_TIME: "An Đình C" before "Nguyễn Văn B"
      assert.equal(result.groups.FULL_TIME.members[0].name, 'An Đình C (Fulltime)');
      assert.equal(result.groups.FULL_TIME.members[1].name, 'Nguyễn Văn B (Fulltime)');

      // Verify Grand Totals exclude resigned by default:
      // Active baseSalary: 30m + 20m + 10m + 12m + 4m = 76,000,000
      assert.equal(result.grandTotals.headcount, 5);
      assert.equal(result.grandTotals.totalBaseSalary, 76_000_000);
      // Net: 30m + 20m + 10.5m + 13m + 4m = 77,500,000
      assert.equal(result.grandTotals.totalNetPayout, 77_500_000);

      // Verify metadata config
      assert.equal(result.groups.ADMIN.config.badgeColor, 'amber');
      assert.equal(result.groups.RESIGNED.config.isCollapsible, true);
    });

    it('11.4 should include resigned in grand totals when includeResignedInGrandTotals is true', () => {
      const staffList: WorkforceMemberPayroll[] = [
        { id: 'ft-1', name: 'Nhân viên A', role: 'STAFF', baseSalary: 10_000_000, isActive: true },
        { id: 'res-1', name: 'Nhân viên Cũ', role: 'STAFF', baseSalary: 5_000_000, isActive: false },
      ];

      const withResigned = groupWorkforcePayroll(staffList, { includeResignedInGrandTotals: true });
      assert.equal(withResigned.grandTotals.headcount, 2);
      assert.equal(withResigned.grandTotals.totalBaseSalary, 15_000_000);
      assert.equal(withResigned.activeHeadcount, 1);
    });
  });
});
