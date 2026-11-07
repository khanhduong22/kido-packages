import { z } from 'zod';

/**
 * Coordinate input supporting both latitude/longitude and lat/lng aliases.
 */
export const CoordinatesSchema = z
  .object({
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
  })
  .refine(
    (coords) =>
      (coords.latitude !== undefined || coords.lat !== undefined) &&
      (coords.longitude !== undefined || coords.lng !== undefined),
    {
      message: 'Coordinates must provide either (latitude, longitude) or (lat, lng)',
    }
  )
  .transform((coords) => ({
    latitude: coords.latitude ?? coords.lat!,
    longitude: coords.longitude ?? coords.lng!,
  }));

export type Coordinates = z.infer<typeof CoordinatesSchema>;
export type CoordinatesInput = {
  latitude?: number;
  longitude?: number;
  lat?: number;
  lng?: number;
};

/**
 * Distance Tier definition for tiered pricing models.
 */
export const DistanceTierSchema = z.object({
  upToKm: z.number().positive(),
  ratePerKm: z.number().nonnegative().optional(),
  flatFee: z.number().nonnegative().optional(),
});

export type DistanceTier = z.infer<typeof DistanceTierSchema>;

/**
 * Surcharge configurations for peak hours, bad weather, night time, etc.
 */
export const SurchargesConfigSchema = z.object({
  peakHourMultiplier: z.number().min(1).default(1.2),
  peakHourFlatFee: z.number().nonnegative().default(0),
  rainMultiplier: z.number().min(1).default(1.25),
  rainFlatFee: z.number().nonnegative().default(5000),
  nightMultiplier: z.number().min(1).default(1.3),
  nightFlatFee: z.number().nonnegative().default(10000),
  customFlatFee: z.number().nonnegative().default(0),
});

export type SurchargesConfig = z.infer<typeof SurchargesConfigSchema>;

/**
 * Shipping pricing rule configuration.
 */
export const ShippingRuleSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  baseDistanceKm: z.number().positive().default(2),
  baseFee: z.number().nonnegative().default(15000),
  perKmFee: z.number().nonnegative().default(5000),
  tiers: z.array(DistanceTierSchema).optional(),
  freeShippingThreshold: z.number().nonnegative().optional().default(500000),
  maxDeliveryDistanceKm: z.number().positive().default(40),
  surcharges: SurchargesConfigSchema.default({}),
});

export type ShippingRule = z.infer<typeof ShippingRuleSchema>;

/**
 * Available delivery slot types.
 */
export const DeliverySlotTypeEnum = z.enum([
  'EXPRESS_1H_2H',
  'MORNING',
  'AFTERNOON',
  'EVENING',
]);

export type DeliverySlotType = z.infer<typeof DeliverySlotTypeEnum>;

/**
 * Detailed delivery slot definition.
 */
export const DeliverySlotSchema = z.object({
  id: DeliverySlotTypeEnum,
  label: z.string(),
  description: z.string().optional(),
  startTime: z.string(), // e.g. "08:00"
  endTime: z.string(),   // e.g. "12:00"
  cutoffTime: z.string().optional(), // e.g. "10:30"
  surcharge: z.number().nonnegative().default(0),
});

export type DeliverySlot = z.infer<typeof DeliverySlotSchema>;

/**
 * Input for shipping fee calculation.
 */
export const CalculateShippingInputSchema = z.object({
  origin: CoordinatesSchema,
  destination: CoordinatesSchema,
  orderTotal: z.number().nonnegative().default(0),
  rule: ShippingRuleSchema.partial().optional(),
  slotType: DeliverySlotTypeEnum.optional(),
  deliveryDate: z.union([z.date(), z.string()]).optional(),
  isPeakHour: z.boolean().optional(),
  isRainy: z.boolean().optional(),
  isNight: z.boolean().optional(),
});

export type CalculateShippingInput = z.infer<typeof CalculateShippingInputSchema>;

/**
 * Surcharge breakdown details.
 */
export const SurchargesBreakdownSchema = z.object({
  peakHour: z.number().nonnegative(),
  rain: z.number().nonnegative(),
  night: z.number().nonnegative(),
  slot: z.number().nonnegative(),
  total: z.number().nonnegative(),
});

export type SurchargesBreakdown = z.infer<typeof SurchargesBreakdownSchema>;

/**
 * Shipping price calculation breakdown.
 */
export const ShippingBreakdownSchema = z.object({
  distanceKm: z.number().nonnegative(),
  baseDistanceKm: z.number().nonnegative(),
  baseFee: z.number().nonnegative(),
  extraDistanceKm: z.number().nonnegative(),
  distanceFee: z.number().nonnegative(),
  subtotalBeforeSurcharges: z.number().nonnegative(),
  surcharges: SurchargesBreakdownSchema,
  discount: z.number().nonnegative(),
  finalFee: z.number().nonnegative(),
  isFreeShipping: z.boolean(),
});

export type ShippingBreakdown = z.infer<typeof ShippingBreakdownSchema>;

/**
 * Output of shipping fee calculation.
 */
export const ShippingQuoteSchema = z.object({
  distanceKm: z.number().nonnegative(),
  fee: z.number().nonnegative(),
  currency: z.literal('VND').default('VND'),
  breakdown: ShippingBreakdownSchema,
  estimatedDeliveryMinutes: z
    .object({
      min: z.number().nonnegative(),
      max: z.number().nonnegative(),
    })
    .optional(),
  slotInfo: z
    .object({
      type: DeliverySlotTypeEnum,
      label: z.string(),
      valid: z.boolean(),
      reason: z.string().optional(),
    })
    .optional(),
});

export type ShippingQuote = z.infer<typeof ShippingQuoteSchema>;

/**
 * Third-party Carrier Quote.
 */
export const CarrierQuoteSchema = z.object({
  carrierId: z.string(),
  carrierName: z.string(),
  serviceName: z.string(),
  fee: z.number().nonnegative(),
  currency: z.literal('VND').default('VND'),
  distanceKm: z.number().nonnegative(),
  estimatedMinutes: z.object({
    min: z.number().nonnegative(),
    max: z.number().nonnegative(),
  }),
  breakdown: z
    .object({
      baseFee: z.number().nonnegative(),
      surgeFee: z.number().nonnegative().default(0),
    })
    .optional(),
  notes: z.string().optional(),
});

export type CarrierQuote = z.infer<typeof CarrierQuoteSchema>;

/**
 * Result of delivery slot validation.
 */
export const DeliverySlotValidationResultSchema = z.object({
  isValid: z.boolean(),
  slotType: DeliverySlotTypeEnum,
  slot: DeliverySlotSchema.optional(),
  reason: z.string().optional(),
  estimatedDeliveryWindow: z
    .object({
      startTime: z.date(),
      endTime: z.date(),
    })
    .optional(),
});

export type DeliverySlotValidationResult = z.infer<typeof DeliverySlotValidationResultSchema>;
