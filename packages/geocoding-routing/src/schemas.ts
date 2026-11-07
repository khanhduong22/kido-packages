import { z } from 'zod';

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

export const VehicleTypeSchema = z.enum(['SEDAN_4', 'SUV_7', 'VIP_CARNIVAL']);
export type VehicleType = z.infer<typeof VehicleTypeSchema>;

export interface VehicleOption {
  type: VehicleType;
  name: string;
  shortName: string;
  seats: number;
  luggage: number;
  multiplier: number;
  popularModels: string;
  badge?: string;
}

export const VEHICLE_OPTIONS: Record<VehicleType, VehicleOption> = {
  SEDAN_4: {
    type: 'SEDAN_4',
    name: 'Tiêu chuẩn 4 chỗ',
    shortName: 'Sedan 4c',
    seats: 4,
    luggage: 2,
    multiplier: 1.0,
    popularModels: 'Toyota Vios, Hyundai Accent, Honda City',
    badge: 'Tiết kiệm',
  },
  SUV_7: {
    type: 'SUV_7',
    name: 'Gia đình 7 chỗ',
    shortName: 'SUV/MPV 7c',
    seats: 7,
    luggage: 4,
    multiplier: 1.25,
    popularModels: 'Mitsubishi Xpander, Toyota Veloz, Innova',
    badge: 'Phổ biến',
  },
  VIP_CARNIVAL: {
    type: 'VIP_CARNIVAL',
    name: 'Chuyên cơ VIP Limousine',
    shortName: 'VIP Carnival',
    seats: 7,
    luggage: 6,
    multiplier: 1.9,
    popularModels: 'Kia Carnival, Hyundai Custin, DCar Limousine',
    badge: 'Sang trọng',
  },
};

export const AirportHubSchema = z.object({
  code: z.string(),
  name: z.string(),
  shortName: z.string(),
  city: z.string(),
  province: z.string(),
  coordinates: CoordinatesSchema,
  isMajor: z.boolean().default(true),
});

export type AirportHub = z.infer<typeof AirportHubSchema>;

export const AirportFixedRouteSchema = z.object({
  id: z.string(),
  airportCode: z.string(),
  name: z.string(),
  destinationName: z.string(),
  destinationCoordinates: CoordinatesSchema,
  distanceKm: z.number().positive(),
  estimatedMinutes: z.number().positive(),
  fares: z.record(VehicleTypeSchema, z.number().positive()),
  description: z.string().optional(),
});

export type AirportFixedRoute = z.infer<typeof AirportFixedRouteSchema>;

export const TieredKmChargeSchema = z.object({
  tier: z.string(),
  km: z.number(),
  ratePerKm: z.number(),
  subtotal: z.number(),
});

export type TieredKmCharge = z.infer<typeof TieredKmChargeSchema>;

export const FareBreakdownSchema = z.object({
  baseFare: z.number(),
  distanceFare: z.number(),
  tieredCharges: z.array(TieredKmChargeSchema),
  vehicleMultiplier: z.number(),
  vehicleSurcharge: z.number(),
  nightSurcharge: z.number(),
  peakSurcharge: z.number(),
  roundTripDiscount: z.number(),
  subtotalBeforeDiscount: z.number(),
  totalFare: z.number(),
  depositAmount: z.number(),
  isFixedAirportRoute: z.boolean(),
  fixedRouteName: z.string().optional(),
});

export type FareBreakdown = z.infer<typeof FareBreakdownSchema>;

export const RouteQuoteSchema = z.object({
  pickupAddress: z.string(),
  dropoffAddress: z.string(),
  pickupCoordinates: CoordinatesSchema.optional(),
  dropoffCoordinates: CoordinatesSchema.optional(),
  distanceKm: z.number(),
  durationMinutes: z.number(),
  vehicleType: VehicleTypeSchema,
  vehicleInfo: z.custom<VehicleOption>(),
  isRoundTrip: z.boolean(),
  fareBreakdown: FareBreakdownSchema,
  totalFare: z.number(),
  depositAmount: z.number(),
  routingSource: z.enum(['osrm', 'haversine_fallback', 'fixed_airport_table']),
  calculatedAt: z.string(),
});

export type RouteQuote = z.infer<typeof RouteQuoteSchema>;

export const RideBookingInputSchema = z.object({
  customerName: z.string().min(2, 'Tên khách hàng tối thiểu 2 ký tự'),
  customerPhone: z.string().regex(/^(0|\+84)[3|5|7|8|9][0-9]{8}$/, 'Số điện thoại Việt Nam không hợp lệ'),
  customerEmail: z.string().email('Email không hợp lệ').optional().or(z.literal('')),
  pickupAddress: z.string().min(3, 'Điểm đón không được để trống'),
  dropoffAddress: z.string().min(3, 'Điểm đến không được để trống'),
  pickupCoordinates: CoordinatesSchema.optional(),
  dropoffCoordinates: CoordinatesSchema.optional(),
  airportRouteId: z.string().optional(),
  vehicleType: VehicleTypeSchema.default('SEDAN_4'),
  pickupTime: z.string().min(5, 'Thời gian đón không hợp lệ'), // e.g. "2026-10-01T14:30" or "14:30"
  pickupDate: z.string().optional(),
  isRoundTrip: z.boolean().default(false),
  flightNumber: z.string().optional(),
  notes: z.string().optional(),
});

export type RideBookingInput = z.infer<typeof RideBookingInputSchema>;
