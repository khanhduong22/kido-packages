// Schemas & Types
export * from './schemas';

// Haversine & Road Distance Estimation
export * from './haversine';

// OSRM Driving Route Client with Fallback
export * from './osrm-client';

// Vietnam Airport Hubs & Fixed Routes
export * from './airports';

// Tiered Fare Calculator & Surge Pricing Engine
export * from './fare-calculator';

// Geo-Guard: Geofencing (Vincenty & Haversine), 4-Layer Anti-Mock GPS, EXIF Verifier & B2B Tier Pricing
export {
  GeofenceTargetSchema,
  type GeofenceTarget,
  GeofenceFormulaSchema,
  type GeofenceFormula,
  GeofenceOptionsSchema,
  type GeofenceOptions,
  GeofenceResultSchema,
  type GeofenceResult,
  KinematicSampleSchema,
  type KinematicSample,
  MockDetectorOptionsSchema,
  type MockDetectorOptions,
  MockDetectionInputSchema,
  type MockDetectionInput,
  FraudRiskLevelSchema,
  type FraudRiskLevel,
  MockDetectionLayersSchema,
  type MockDetectionLayers,
  MockDetectionResultSchema,
  type MockDetectionResult,
  ExifGpsMetadataSchema,
  type ExifGpsMetadata,
  PhotoMetadataSchema,
  type PhotoMetadata,
  ExifVerifyContextSchema,
  type ExifVerifyContext,
  ExifVerifyOptionsSchema,
  type ExifVerifyOptions,
  PhotoVerificationResultSchema,
  type PhotoVerificationResult,
  DealerTierSchema,
  type DealerTier,
  VolumeDiscountBracketSchema,
  type VolumeDiscountBracket,
  DealerProfileSchema,
  type DealerProfile,
  OrderItemSchema,
  type OrderItem,
  OrderPricingRequestSchema,
  type OrderPricingRequest,
  ItemPricingBreakdownSchema,
  type ItemPricingBreakdown,
  OrderPricingResultSchema,
  type OrderPricingResult,
} from './geo-guard/schemas';

export {
  WGS84_SEMI_MAJOR_AXIS,
  WGS84_FLATTENING,
  WGS84_SEMI_MINOR_AXIS,
  SPHERICAL_EARTH_RADIUS_METERS,
  vincentyDistance,
  isInsideGeofence,
  isInsideGeofence as checkGeofence,
  haversineDistance as geoGuardHaversineDistance,
  normalizeCoordinates as normalizeGeoGuardCoordinates,
} from './geo-guard/geofence';

export * from './geo-guard/mock-detector';
export * from './geo-guard/exif-verifier';
export * from './geo-guard/b2b-tier-pricing';
export * from './geo-guard/timezone-guard';
