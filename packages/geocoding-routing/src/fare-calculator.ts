import { AIRPORT_FIXED_ROUTES, getFixedRouteById } from './airports';
import {
  FareBreakdown,
  RouteQuote,
  TieredKmCharge,
  VEHICLE_OPTIONS,
  VehicleType,
} from './schemas';

export interface FareCalculationInput {
  distanceKm: number;
  durationMinutes?: number;
  vehicleType?: VehicleType;
  pickupTime?: string | Date;
  isRoundTrip?: boolean;
  airportRouteId?: string;
  customCurvatureFactor?: number;
}

export const FARE_CONFIG = {
  // Base rates for Sedan 4 seats
  tier1: { maxKm: 5, ratePerKm: 14000, name: '1-5km (Mở cửa / Chặng ngắn)' },
  tier2: { maxKm: 30, ratePerKm: 12000, name: '6-30km (Cự ly tiêu chuẩn)' },
  tier3: { ratePerKm: 10200, name: '>30km Đường dài (Giảm 15% cước km)' }, // 12000 * 0.85
  nightSurcharge: 50000, // 22:00 - 05:00
  peakSurcharge: 30000, // 07:00 - 09:00 & 16:30 - 19:00
  roundTripDiscountRate: 0.2, // Giảm 20% tổng cước chuyến khứ hồi
};

/**
 * Checks if a given time string (e.g. "2026-10-01T22:30" or "23:15") or Date falls in night hours (22:00 - 05:00)
 */
export function isNightTime(timeInput?: string | Date): boolean {
  if (!timeInput) return false;

  let hour = 12;

  if (timeInput instanceof Date) {
    hour = timeInput.getHours();
  } else if (typeof timeInput === 'string') {
    // Check if ISO or full datetime
    if (timeInput.includes('T') || timeInput.includes(' ')) {
      const parsed = new Date(timeInput);
      if (!isNaN(parsed.getTime())) {
        hour = parsed.getHours();
      }
    } else if (timeInput.includes(':')) {
      // Just "HH:mm"
      const [h] = timeInput.split(':').map((v) => parseInt(v, 10));
      if (!isNaN(h)) {
        hour = h;
      }
    }
  }

  return hour >= 22 || hour < 5;
}

/**
 * Checks if given time falls into traffic peak hours (07:00 - 09:00 or 16:30 - 19:00)
 */
export function isPeakHour(timeInput?: string | Date): boolean {
  if (!timeInput) return false;

  let hour = 12;
  let minute = 0;

  if (timeInput instanceof Date) {
    hour = timeInput.getHours();
    minute = timeInput.getMinutes();
  } else if (typeof timeInput === 'string') {
    if (timeInput.includes('T') || timeInput.includes(' ')) {
      const parsed = new Date(timeInput);
      if (!isNaN(parsed.getTime())) {
        hour = parsed.getHours();
        minute = parsed.getMinutes();
      }
    } else if (timeInput.includes(':')) {
      const parts = timeInput.split(':').map((v) => parseInt(v, 10));
      if (!isNaN(parts[0])) {
        hour = parts[0];
        minute = parts[1] || 0;
      }
    }
  }

  // Morning rush: 07:00 - 08:59
  if (hour >= 7 && hour < 9) return true;

  // Evening rush: 16:30 - 18:59
  if (hour === 16 && minute >= 30) return true;
  if (hour === 17 || hour === 18) return true;

  return false;
}

/**
 * Calculates deposit required to confirm ride (100k - 200k or 30% for high value)
 */
export function calculateDepositAmount(totalFare: number): number {
  if (totalFare <= 0) return 0;
  if (totalFare < 300000) return 100000;
  if (totalFare <= 1000000) return 200000;
  return Math.round((totalFare * 0.3) / 10000) * 10000;
}

/**
 * Core Fare Calculation Engine
 */
export function calculateFare(input: FareCalculationInput): FareBreakdown {
  const vehicleType = input.vehicleType || 'SEDAN_4';
  const vehicleOption = VEHICLE_OPTIONS[vehicleType] || VEHICLE_OPTIONS.SEDAN_4;
  const isRoundTrip = !!input.isRoundTrip;

  // Check 1: Airport Fixed Route
  if (input.airportRouteId) {
    const fixedRoute = getFixedRouteById(input.airportRouteId);
    if (fixedRoute) {
      const rawFare = fixedRoute.fares[vehicleType] ?? fixedRoute.fares.SEDAN_4 ?? 220000;
      let baseFixedFare: number = rawFare;

      if (isRoundTrip) {
        // Round trip on airport route: 2x distance with 20% discount on return leg (1.8x)
        baseFixedFare = Math.round(rawFare * 1.8);
      }

      const nightSurcharge = isNightTime(input.pickupTime) ? FARE_CONFIG.nightSurcharge : 0;
      const peakSurcharge = isPeakHour(input.pickupTime) ? FARE_CONFIG.peakSurcharge : 0;
      const totalFare = Math.round((baseFixedFare + nightSurcharge + peakSurcharge) / 1000) * 1000;
      const depositAmount = calculateDepositAmount(totalFare);

      return {
        baseFare: baseFixedFare,
        distanceFare: baseFixedFare,
        tieredCharges: [
          {
            tier: `Tuyến cố định: ${fixedRoute.name}`,
            km: fixedRoute.distanceKm * (isRoundTrip ? 2 : 1),
            ratePerKm: Math.round(baseFixedFare / (fixedRoute.distanceKm * (isRoundTrip ? 2 : 1))),
            subtotal: baseFixedFare,
          },
        ],
        vehicleMultiplier: vehicleOption.multiplier,
        vehicleSurcharge: 0,
        nightSurcharge,
        peakSurcharge,
        roundTripDiscount: isRoundTrip ? Math.round(rawFare * 0.2) : 0,
        subtotalBeforeDiscount: baseFixedFare,
        totalFare,
        depositAmount,
        isFixedAirportRoute: true,
        fixedRouteName: fixedRoute.name,
      };
    }
  }

  // Check 2: Tiered km distance calculation
  let distanceKm = Math.max(0.5, input.distanceKm);
  if (isRoundTrip) {
    distanceKm = distanceKm * 2;
  }

  const tieredCharges: TieredKmCharge[] = [];
  let remainingKm = distanceKm;
  let rawDistanceFare = 0;

  // Tier 1: 1 - 5 km
  if (remainingKm > 0) {
    const kmInTier1 = Math.min(remainingKm, FARE_CONFIG.tier1.maxKm);
    const subtotal = kmInTier1 * FARE_CONFIG.tier1.ratePerKm;
    tieredCharges.push({
      tier: FARE_CONFIG.tier1.name,
      km: Math.round(kmInTier1 * 10) / 10,
      ratePerKm: FARE_CONFIG.tier1.ratePerKm,
      subtotal,
    });
    rawDistanceFare += subtotal;
    remainingKm -= kmInTier1;
  }

  // Tier 2: 6 - 30 km (25 km max in this bucket)
  if (remainingKm > 0) {
    const kmInTier2 = Math.min(remainingKm, FARE_CONFIG.tier2.maxKm - FARE_CONFIG.tier1.maxKm);
    const subtotal = kmInTier2 * FARE_CONFIG.tier2.ratePerKm;
    tieredCharges.push({
      tier: FARE_CONFIG.tier2.name,
      km: Math.round(kmInTier2 * 10) / 10,
      ratePerKm: FARE_CONFIG.tier2.ratePerKm,
      subtotal,
    });
    rawDistanceFare += subtotal;
    remainingKm -= kmInTier2;
  }

  // Tier 3: > 30 km
  if (remainingKm > 0) {
    const subtotal = remainingKm * FARE_CONFIG.tier3.ratePerKm;
    tieredCharges.push({
      tier: FARE_CONFIG.tier3.name,
      km: Math.round(remainingKm * 10) / 10,
      ratePerKm: FARE_CONFIG.tier3.ratePerKm,
      subtotal,
    });
    rawDistanceFare += subtotal;
    remainingKm = 0;
  }

  // Apply Vehicle Multiplier
  const vehicleMultiplier = vehicleOption.multiplier;
  const vehicleSurcharge = Math.round(rawDistanceFare * (vehicleMultiplier - 1));
  const subtotalWithVehicle = rawDistanceFare + vehicleSurcharge;

  // Surcharges
  const nightSurcharge = isNightTime(input.pickupTime) ? FARE_CONFIG.nightSurcharge : 0;
  const peakSurcharge = isPeakHour(input.pickupTime) ? FARE_CONFIG.peakSurcharge : 0;

  const subtotalBeforeDiscount = subtotalWithVehicle + nightSurcharge + peakSurcharge;

  // Round trip discount (20% on the round trip portion)
  let roundTripDiscount = 0;
  if (isRoundTrip) {
    roundTripDiscount = Math.round(subtotalWithVehicle * FARE_CONFIG.roundTripDiscountRate);
  }

  const totalFare = Math.max(
    50000,
    Math.round((subtotalBeforeDiscount - roundTripDiscount) / 1000) * 1000
  );
  const depositAmount = calculateDepositAmount(totalFare);

  return {
    baseFare: FARE_CONFIG.tier1.ratePerKm * Math.min(distanceKm, 5),
    distanceFare: rawDistanceFare,
    tieredCharges,
    vehicleMultiplier,
    vehicleSurcharge,
    nightSurcharge,
    peakSurcharge,
    roundTripDiscount,
    subtotalBeforeDiscount,
    totalFare,
    depositAmount,
    isFixedAirportRoute: false,
  };
}

/**
 * Creates high-level validated RouteQuote object
 */
export function createRouteQuote(params: {
  pickupAddress: string;
  dropoffAddress: string;
  distanceKm: number;
  durationMinutes: number;
  vehicleType?: VehicleType;
  pickupTime?: string | Date;
  isRoundTrip?: boolean;
  airportRouteId?: string;
  routingSource?: 'osrm' | 'haversine_fallback' | 'fixed_airport_table';
}): RouteQuote {
  const vehicleType = params.vehicleType || 'SEDAN_4';
  const vehicleInfo = VEHICLE_OPTIONS[vehicleType];

  const fareBreakdown = calculateFare({
    distanceKm: params.distanceKm,
    durationMinutes: params.durationMinutes,
    vehicleType,
    pickupTime: params.pickupTime,
    isRoundTrip: params.isRoundTrip,
    airportRouteId: params.airportRouteId,
  });

  return {
    pickupAddress: params.pickupAddress,
    dropoffAddress: params.dropoffAddress,
    distanceKm: params.distanceKm,
    durationMinutes: params.durationMinutes,
    vehicleType,
    vehicleInfo,
    isRoundTrip: !!params.isRoundTrip,
    fareBreakdown,
    totalFare: fareBreakdown.totalFare,
    depositAmount: fareBreakdown.depositAmount,
    routingSource: params.routingSource || (params.airportRouteId ? 'fixed_airport_table' : 'osrm'),
    calculatedAt: new Date().toISOString(),
  };
}
