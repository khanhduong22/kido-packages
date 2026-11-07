import { z } from 'zod';

// ==========================================
// 1. Geographic & Location Schemas
// ==========================================

export const CoordinatesSchema = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  accuracy: z.number().nonnegative().optional(),
  altitude: z.number().optional(),
  speed: z.number().nonnegative().optional(),
  heading: z.number().min(0).max(360).optional(),
  timestamp: z.union([z.number(), z.string(), z.date()]).optional(),
  isMockProvider: z.boolean().optional(),
  isFromMockProvider: z.boolean().optional(),
});

export type Coordinates = z.infer<typeof CoordinatesSchema>;

export interface CoordinatesInput {
  lat?: number;
  latitude?: number;
  lon?: number;
  lng?: number;
  longitude?: number;
  accuracy?: number;
  altitude?: number;
  speed?: number;
  heading?: number;
  timestamp?: number | string | Date;
  isMockProvider?: boolean;
  isFromMockProvider?: boolean;
}

export const GeofenceTargetSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  code: z.string().optional(),
  coordinates: CoordinatesSchema,
  radiusMeters: z.number().positive().default(50),
});

export type GeofenceTarget = z.infer<typeof GeofenceTargetSchema>;

export const GeofenceFormulaSchema = z.enum(['haversine', 'vincenty', 'auto']);
export type GeofenceFormula = z.infer<typeof GeofenceFormulaSchema>;

export const GeofenceOptionsSchema = z.object({
  radiusMeters: z.number().positive().default(50),
  formula: GeofenceFormulaSchema.default('vincenty'),
  toleranceMeters: z.number().nonnegative().default(0),
});

export type GeofenceOptions = z.infer<typeof GeofenceOptionsSchema>;

export const GeofenceResultSchema = z.object({
  isInside: z.boolean(),
  distanceMeters: z.number().nonnegative(),
  allowedRadiusMeters: z.number().positive(),
  deltaMeters: z.number(), // Negative if inside margin, positive if outside excess
  formulaUsed: z.enum(['haversine', 'vincenty']),
});

export type GeofenceResult = z.infer<typeof GeofenceResultSchema>;

// ==========================================
// 2. Mock GPS Detector Schemas
// ==========================================

export const KinematicSampleSchema = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number(),
  timestamp: z.number().optional(),
});

export type KinematicSample = z.infer<typeof KinematicSampleSchema>;

export const MockDetectorOptionsSchema = z.object({
  maxSpeedKmh: z.number().positive().default(150),
  minAcceptableAccuracy: z.number().nonnegative().default(0.01),
  minKinematicVariance: z.number().positive().default(0.001),
  minKinematicSamples: z.number().int().min(2).default(3),
});

export type MockDetectorOptions = z.infer<typeof MockDetectorOptionsSchema>;

export const MockDetectionInputSchema = z.object({
  currentLocation: CoordinatesSchema,
  previousLocation: CoordinatesSchema.optional(),
  accelerometerSamples: z.array(KinematicSampleSchema).optional(),
  options: MockDetectorOptionsSchema.optional(),
});

export type MockDetectionInput = z.infer<typeof MockDetectionInputSchema>;

export const FraudRiskLevelSchema = z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
export type FraudRiskLevel = z.infer<typeof FraudRiskLevelSchema>;

export const MockDetectionLayersSchema = z.object({
  mockProvider: z.object({
    flagged: z.boolean(),
    details: z.string(),
  }),
  accuracyAnalysis: z.object({
    flagged: z.boolean(),
    details: z.string(),
    accuracy: z.number().optional(),
  }),
  teleportation: z.object({
    flagged: z.boolean(),
    details: z.string(),
    calculatedSpeedKmh: z.number().optional(),
    distanceMeters: z.number().optional(),
    timeDeltaSeconds: z.number().optional(),
  }),
  kinematicCheck: z.object({
    flagged: z.boolean(),
    details: z.string(),
    sampleCount: z.number(),
    magnitudeVariance: z.number().optional(),
    isEmulatorLikely: z.boolean(),
  }),
});

export type MockDetectionLayers = z.infer<typeof MockDetectionLayersSchema>;

export const MockDetectionResultSchema = z.object({
  isMock: z.boolean(),
  threatScore: z.number().min(0).max(100),
  riskLevel: FraudRiskLevelSchema,
  reasons: z.array(z.string()),
  layers: MockDetectionLayersSchema,
  evaluatedAt: z.string(),
});

export type MockDetectionResult = z.infer<typeof MockDetectionResultSchema>;

// ==========================================
// 3. EXIF Shelf Photo Verifier Schemas
// ==========================================

export const ExifGpsMetadataSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  altitude: z.number().optional(),
});

export type ExifGpsMetadata = z.infer<typeof ExifGpsMetadataSchema>;

export const PhotoMetadataSchema = z.object({
  hasExif: z.boolean(),
  gps: ExifGpsMetadataSchema.optional(),
  capturedAt: z.date().optional(),
  cameraMake: z.string().optional(),
  cameraModel: z.string().optional(),
  software: z.string().optional(),
});

export type PhotoMetadata = z.infer<typeof PhotoMetadataSchema>;

export const ExifVerifyContextSchema = z.object({
  deviceCoordinates: CoordinatesSchema,
  submissionTimestamp: z.union([z.number(), z.string(), z.date()]),
  storeCoordinates: CoordinatesSchema.optional(),
});

export type ExifVerifyContext = z.infer<typeof ExifVerifyContextSchema>;

export const ExifVerifyOptionsSchema = z.object({
  maxDistanceMeters: z.number().positive().default(100),
  maxTimeDeltaSeconds: z.number().positive().default(600), // 10 minutes
  requireGps: z.boolean().default(true),
  requireTimestamp: z.boolean().default(true),
});

export type ExifVerifyOptions = z.infer<typeof ExifVerifyOptionsSchema>;

export const PhotoVerificationResultSchema = z.object({
  isValid: z.boolean(),
  flags: z.array(z.string()),
  reasons: z.array(z.string()),
  distanceMeters: z.number().optional(),
  timeDeltaSeconds: z.number().optional(),
  extractedMetadata: PhotoMetadataSchema,
  verifiedAt: z.string(),
});

export type PhotoVerificationResult = z.infer<typeof PhotoVerificationResultSchema>;

// ==========================================
// 4. FMCG B2B Tier Pricing & Credit Limit Schemas
// ==========================================

export const DealerTierSchema = z.enum(['TIER_1', 'TIER_2', 'GOLD']);
export type DealerTier = z.infer<typeof DealerTierSchema>;

export const VolumeDiscountBracketSchema = z.object({
  minQuantity: z.number().int().positive(),
  additionalDiscountPercent: z.number().min(0).max(100),
});

export type VolumeDiscountBracket = z.infer<typeof VolumeDiscountBracketSchema>;

export const DealerProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  tier: DealerTierSchema,
  creditLimit: z.number().nonnegative(), // Hạn mức công nợ (VND)
  currentDebt: z.number().nonnegative(), // Công nợ hiện tại (VND)
  customDiscountPercent: z.number().min(0).max(100).optional(),
});

export type DealerProfile = z.infer<typeof DealerProfileSchema>;

export const OrderItemSchema = z.object({
  productId: z.string(),
  productName: z.string(),
  unitPrice: z.number().positive(), // Giá niêm yết (VND)
  quantity: z.number().int().positive(),
});

export type OrderItem = z.infer<typeof OrderItemSchema>;

export const OrderPricingRequestSchema = z.object({
  dealer: DealerProfileSchema,
  items: z.array(OrderItemSchema).min(1),
  customVolumeBrackets: z.array(VolumeDiscountBracketSchema).optional(),
  notes: z.string().optional(),
});

export type OrderPricingRequest = z.infer<typeof OrderPricingRequestSchema>;

export const ItemPricingBreakdownSchema = z.object({
  productId: z.string(),
  productName: z.string(),
  unitPrice: z.number(),
  quantity: z.number(),
  grossSubtotal: z.number(),
  baseTierDiscountPercent: z.number(),
  volumeDiscountPercent: z.number(),
  totalDiscountPercent: z.number(),
  discountAmount: z.number(),
  netSubtotal: z.number(),
});

export type ItemPricingBreakdown = z.infer<typeof ItemPricingBreakdownSchema>;

export const OrderPricingResultSchema = z.object({
  dealerId: z.string(),
  dealerName: z.string(),
  dealerTier: DealerTierSchema,
  items: z.array(ItemPricingBreakdownSchema),
  grossTotal: z.number(),
  totalDiscount: z.number(),
  netTotal: z.number(),
  creditLimit: z.number(),
  currentDebt: z.number(),
  projectedDebt: z.number(),
  availableCreditBeforeOrder: z.number(),
  remainingCreditAfterOrder: z.number(),
  isLocked: z.boolean(),
  lockReason: z.string().optional(),
  excessDebtAmount: z.number(),
  calculatedAt: z.string(),
});

export type OrderPricingResult = z.infer<typeof OrderPricingResultSchema>;
