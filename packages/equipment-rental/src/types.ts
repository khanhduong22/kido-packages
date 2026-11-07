import { z } from 'zod';

// ============================================================================
// Enums & Literals
// ============================================================================

export const WarehouseLocationSchema = z.enum(['DA_NANG', 'HO_CHI_MINH']);
export type WarehouseLocation = z.infer<typeof WarehouseLocationSchema>;

export const GearCategorySchema = z.enum([
  'PHOTOBOOTH_GLAMBOT',
  'MAGIC_MIRROR',
  'CAMERA_BODY',
  'LENS',
  'LIGHTING',
  'ACCESSORY',
]);
export type GearCategory = z.infer<typeof GearCategorySchema>;

export const GearStatusSchema = z.enum([
  'AVAILABLE',
  'HOLD_PENDING',
  'ASSIGNED_SHOW',
  'IN_TRANSIT',
  'MAINTENANCE',
  'DAMAGED',
]);
export type GearStatus = z.infer<typeof GearStatusSchema>;

export const BookingStatusSchema = z.enum([
  'DRAFT',
  'CONFIRMED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
]);
export type BookingStatus = z.infer<typeof BookingStatusSchema>;

export const TransferOrderStatusSchema = z.enum([
  'PENDING',
  'IN_TRANSIT',
  'COMPLETED',
  'CANCELLED',
]);
export type TransferOrderStatus = z.infer<typeof TransferOrderStatusSchema>;

export const ConsumableTypeSchema = z.enum([
  'DNP_PAPER_ROLL',
  'INK_RIBBON',
  'CAMERA_BATTERY',
  'OTHER',
]);
export type ConsumableType = z.infer<typeof ConsumableTypeSchema>;

export const GearConditionSchema = z.enum([
  'PRISTINE',
  'GOOD',
  'SCRATCHED',
  'DAMAGED',
  'MISSING',
]);
export type GearCondition = z.infer<typeof GearConditionSchema>;

export const HandoverTypeSchema = z.enum(['CHECK_OUT', 'CHECK_IN']);
export type HandoverType = z.infer<typeof HandoverTypeSchema>;

// ============================================================================
// Entity Schemas
// ============================================================================

export const GearItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  category: GearCategorySchema,
  serialNumber: z.string(),
  warehouseLocation: WarehouseLocationSchema,
  status: GearStatusSchema.default('AVAILABLE'),
  standardAccessories: z.array(z.string()).default([]),
  accessoryCosts: z.record(z.string(), z.number()).default({}),
  replacementValue: z.number().nonnegative().default(0),
  dailyRate: z.number().nonnegative().optional(),
  maintenanceNotes: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type GearItem = z.infer<typeof GearItemSchema>;
export type GearItemInput = z.input<typeof GearItemSchema>;

export const RentalBookingSchema = z.object({
  id: z.string(),
  customerName: z.string(),
  gearIds: z.array(z.string()).min(1),
  startTime: z.coerce.date(),
  endTime: z.coerce.date(),
  status: BookingStatusSchema.default('CONFIRMED'),
  location: WarehouseLocationSchema,
  setupBufferHours: z.number().nonnegative().default(2),
  teardownBufferHours: z.number().nonnegative().default(2),
  eventName: z.string().optional(),
  notes: z.string().optional(),
});
export type RentalBooking = z.infer<typeof RentalBookingSchema>;
export type RentalBookingInput = z.input<typeof RentalBookingSchema>;

export const TransferOrderSchema = z.object({
  id: z.string(),
  gearIds: z.array(z.string()).min(1),
  sourceLocation: WarehouseLocationSchema,
  targetLocation: WarehouseLocationSchema,
  status: TransferOrderStatusSchema.default('PENDING'),
  createdAt: z.coerce.date().default(() => new Date()),
  dispatchedAt: z.coerce.date().optional(),
  receivedAt: z.coerce.date().optional(),
  notes: z.string().optional(),
});
export type TransferOrder = z.infer<typeof TransferOrderSchema>;
export type TransferOrderInput = z.input<typeof TransferOrderSchema>;

export const ConsumableItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: ConsumableTypeSchema,
  totalCapacity: z.number().positive(),
  remainingCapacity: z.number().min(0),
  unit: z.string().default('prints'),
  assignedGearId: z.string().optional(),
  warningThresholdPercent: z.number().min(0).max(100).default(20),
});
export type ConsumableItem = z.infer<typeof ConsumableItemSchema>;
export type ConsumableItemInput = z.input<typeof ConsumableItemSchema>;

export const HandoverItemReportSchema = z.object({
  gearId: z.string(),
  gearName: z.string().optional(),
  condition: GearConditionSchema,
  missingAccessories: z.array(z.string()).default([]),
  damageNote: z.string().optional(),
  accessoryPenaltyFee: z.number().nonnegative().default(0),
  damagePenaltyFee: z.number().nonnegative().default(0),
  totalPenaltyFee: z.number().nonnegative().default(0),
});
export type HandoverItemReport = z.infer<typeof HandoverItemReportSchema>;
export type HandoverItemReportInput = z.input<typeof HandoverItemReportSchema>;

export const HandoverInspectionSchema = z.object({
  id: z.string(),
  bookingId: z.string(),
  type: HandoverTypeSchema,
  timestamp: z.coerce.date().default(() => new Date()),
  inspectorName: z.string(),
  customerRepresentative: z.string(),
  items: z.array(HandoverItemReportSchema),
  totalPenaltyFee: z.number().nonnegative().default(0),
  k80ReceiptText: z.string().optional(),
});
export type HandoverInspection = z.infer<typeof HandoverInspectionSchema>;
export type HandoverInspectionInput = z.input<typeof HandoverInspectionSchema>;

// ============================================================================
// Factory Helpers with Defaults Auto-Filled
// ============================================================================

export function createGearItem(input: GearItemInput): GearItem {
  return GearItemSchema.parse(input);
}

export function createRentalBooking(input: RentalBookingInput): RentalBooking {
  return RentalBookingSchema.parse(input);
}

export function createTransferOrder(input: TransferOrderInput): TransferOrder {
  return TransferOrderSchema.parse(input);
}

export function createConsumableItem(input: ConsumableItemInput): ConsumableItem {
  return ConsumableItemSchema.parse(input);
}

// ============================================================================
// Conflict & Helper Types
// ============================================================================

export interface ConflictCheckResult {
  hasConflict: boolean;
  gearId: string;
  conflictingBookings: RentalBooking[];
  reason?: string;
  effectiveInterval?: {
    start: Date;
    end: Date;
  };
}

export interface ConsumableUsageResult {
  updatedItem: ConsumableItem;
  usedUnits: number;
  remainingPercentage: number;
  isLowWarning: boolean;
  warningMessage?: string;
}

export interface HandoverAuditInput {
  booking: RentalBooking;
  gears: GearItem[];
  inspectorName: string;
  customerRepresentative: string;
  itemAudits?: Array<{
    gearId: string;
    condition: GearCondition;
    missingAccessories?: string[];
    damageNote?: string;
    damageCost?: number;
  }>;
}
