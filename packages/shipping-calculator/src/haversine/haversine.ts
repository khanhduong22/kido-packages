import { CoordinatesInput, CoordinatesSchema } from '../schemas/shipping.schema';

export const EARTH_RADIUS_KM = 6371;

export interface HaversineOptions {
  /**
   * Number of decimal places to round the result to.
   * Pass null or undefined for full float precision.
   * Default: 2
   */
  roundDecimals?: number | null;
}

/**
 * Calculates the great-circle distance between two geographic points using the Haversine formula.
 *
 * @param origin Source location coordinates ({ latitude, longitude } or { lat, lng })
 * @param destination Target location coordinates ({ latitude, longitude } or { lat, lng })
 * @param options Calculation options including decimal precision
 * @returns Distance in kilometers (km)
 */
export function calculateHaversineDistance(
  origin: CoordinatesInput,
  destination: CoordinatesInput,
  options: HaversineOptions = { roundDecimals: 2 }
): number {
  const parsedOrigin = CoordinatesSchema.parse(origin);
  const parsedDest = CoordinatesSchema.parse(destination);

  const lat1 = parsedOrigin.latitude;
  const lon1 = parsedOrigin.longitude;
  const lat2 = parsedDest.latitude;
  const lon2 = parsedDest.longitude;

  // Handle exact identical coordinates quickly
  if (lat1 === lat2 && lon1 === lon2) {
    return 0;
  }

  const toRad = (degree: number) => (degree * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const radLat1 = toRad(lat1);
  const radLat2 = toRad(lat2);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(radLat1) * Math.cos(radLat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);

  // Math.min/Math.max clamp to protect against floating point inaccuracies near 1
  const clampedA = Math.max(0, Math.min(1, a));
  const c = 2 * Math.atan2(Math.sqrt(clampedA), Math.sqrt(1 - clampedA));
  const distance = EARTH_RADIUS_KM * c;

  if (options?.roundDecimals !== undefined && options?.roundDecimals !== null) {
    const factor = Math.pow(10, options.roundDecimals);
    return Math.round(distance * factor) / factor;
  }

  return distance;
}

/**
 * Checks whether the destination is within a given radius (km) from the origin.
 */
export function isWithinRadius(
  origin: CoordinatesInput,
  destination: CoordinatesInput,
  maxDistanceKm: number
): boolean {
  const distance = calculateHaversineDistance(origin, destination, { roundDecimals: null });
  return distance <= maxDistanceKm;
}
