import { z } from 'zod';

/**
 * Crew Specialization Roles for T-RED Media & T-RED Photobooth
 */
export const CrewRoleSchema = z.enum([
  'GLAMBOT_OPERATOR',
  'CINEMATOGRAPHER',
  'PHOTOGRAPHER',
  'LIGHTING_TECH',
  'BOOTH_HOST',
  'TECH_LEAD',
]);
export type CrewRole = z.infer<typeof CrewRoleSchema>;

/**
 * Supported Operational Cities in Vietnam
 */
export const CityLocationSchema = z.enum(['DA_NANG', 'HO_CHI_MINH']);
export type CityLocation = z.infer<typeof CityLocationSchema>;

/**
 * Crew Seniority & Experience Level
 */
export const CrewLevelSchema = z.enum(['JUNIOR', 'SENIOR', 'LEAD']);
export type CrewLevel = z.infer<typeof CrewLevelSchema>;

/**
 * Venue / Event Location Schema
 */
export const VenueSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1, 'Venue name is required'),
  city: CityLocationSchema,
  district: z.string().optional(),
  address: z.string().optional(),
  coordinates: z
    .object({
      lat: z.number(),
      lng: z.number(),
    })
    .optional(),
});
export type Venue = z.infer<typeof VenueSchema>;

/**
 * Crew Member Profile Schema
 */
export const CrewMemberSchema = z.object({
  id: z.string().min(1, 'ID is required'),
  name: z.string().min(1, 'Name is required'),
  phone: z.string().optional(),
  email: z.string().email().optional(),
  city: CityLocationSchema,
  primaryRole: CrewRoleSchema,
  roles: z.array(CrewRoleSchema).min(1, 'At least one role is required'),
  level: CrewLevelSchema,
  hourlyRate: z.number().nonnegative().optional(),
  isActive: z.boolean().default(true),
  rating: z.number().min(0).max(5).optional(),
  pastShowsCount: z.number().nonnegative().default(0),
});
export type CrewMember = z.infer<typeof CrewMemberSchema>;

/**
 * Shift Status
 */
export const ShiftStatusSchema = z.enum([
  'CONFIRMED',
  'TENTATIVE',
  'COMPLETED',
  'CANCELLED',
]);
export type ShiftStatus = z.infer<typeof ShiftStatusSchema>;

/**
 * Shift Assignment Schema
 */
export const ShiftAssignmentSchema = z.object({
  id: z.string().min(1),
  showId: z.string().min(1),
  memberId: z.string().min(1),
  role: CrewRoleSchema,
  startAt: z.union([z.date(), z.string()]),
  endAt: z.union([z.date(), z.string()]),
  venue: VenueSchema,
  status: ShiftStatusSchema.default('CONFIRMED'),
});
export type ShiftAssignment = z.infer<typeof ShiftAssignmentSchema>;

/**
 * Specific Role Requirement with Optional Minimum Level and Count
 */
export const RequiredRoleRequirementSchema = z.object({
  role: CrewRoleSchema,
  minLevel: CrewLevelSchema.optional().default('JUNIOR'),
  count: z.number().int().positive().default(1),
});
export type RequiredRoleRequirement = z.infer<typeof RequiredRoleRequirementSchema>;

/**
 * Event Show Schema
 */
export const EventShowSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  brand: z.enum(['T_RED_MEDIA', 'T_RED_PHOTOBOOTH']).or(z.string()).optional(),
  city: CityLocationSchema,
  venue: VenueSchema,
  startAt: z.union([z.date(), z.string()]),
  endAt: z.union([z.date(), z.string()]),
  requiredRoles: z.array(z.union([CrewRoleSchema, RequiredRoleRequirementSchema])),
  kpi: z
    .object({
      targetPrints: z.number().nonnegative().optional(),
      actualPrints: z.number().nonnegative().optional(),
      targetGuests: z.number().nonnegative().optional(),
      actualGuests: z.number().nonnegative().optional(),
    })
    .optional(),
});
export type EventShow = z.infer<typeof EventShowSchema>;

/**
 * Payout Calculation Breakdown
 */
export const PayoutCalculationSchema = z.object({
  memberId: z.string(),
  showId: z.string(),
  role: CrewRoleSchema,
  level: CrewLevelSchema,
  durationHours: z.number(),
  baseHourlyRate: z.number(),
  baseAmount: z.number(),
  nightHours: z.number(),
  nightBonusRate: z.number(),
  nightBonus: z.number(),
  kpiBonus: z.number(),
  travelAllowance: z.number(),
  totalAmount: z.number(),
  breakdown: z.object({
    regularHours: z.number(),
    regularPay: z.number(),
    nightHours: z.number(),
    nightPayBonus: z.number(),
    kpiBonus: z.number(),
    travelAllowance: z.number(),
    notes: z.array(z.string()).optional(),
  }),
});
export type PayoutCalculation = z.infer<typeof PayoutCalculationSchema>;

/**
 * Shift Conflict Details Result
 */
export interface ShiftConflictResult {
  hasConflict: boolean;
  reason?: string;
  conflictingShift?: ShiftAssignment;
  requiredBufferMinutes?: number;
  actualBufferMinutes?: number;
}
