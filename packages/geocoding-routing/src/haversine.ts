import { Coordinates } from './schemas';

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

export const EARTH_RADIUS_KM = 6371;
export const DEFAULT_ROAD_CURVATURE_FACTOR = 1.3; // Hệ số uốn lượn đường bộ Việt Nam (1.25 - 1.35)

/**
 * Standardize various coordinate property representations to { lat, lon }
 */
export function normalizeCoordinates(coords: CoordinatesInput): Coordinates {
  const lat = coords.lat ?? coords.latitude;
  const lon = coords.lon ?? coords.lng ?? coords.longitude;

  if (lat === undefined || lon === undefined) {
    throw new Error('Coordinates must contain valid latitude (lat) and longitude (lon/lng)');
  }

  return { lat, lon };
}

/**
 * Calculates great-circle straight-line distance between two coordinates in kilometers using Haversine formula
 */
export function haversineDistance(from: CoordinatesInput, to: CoordinatesInput): number {
  const c1 = normalizeCoordinates(from);
  const c2 = normalizeCoordinates(to);

  const dLat = ((c2.lat - c1.lat) * Math.PI) / 180;
  const dLon = ((c2.lon - c1.lon) * Math.PI) / 180;

  const lat1Rad = (c1.lat * Math.PI) / 180;
  const lat2Rad = (c2.lat * Math.PI) / 180;

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1Rad) * Math.cos(lat2Rad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distance = EARTH_RADIUS_KM * c;

  return Math.round(distance * 100) / 100;
}

/**
 * Calculates great-circle straight-line distance in meters
 */
export function haversineDistanceMeters(from: CoordinatesInput, to: CoordinatesInput): number {
  return Math.round(haversineDistance(from, to) * 1000);
}

/**
 * Estimates actual road travel distance (km) applying the road curvature factor (1.25 - 1.35x)
 */
export function estimateRoadDistance(
  from: CoordinatesInput,
  to: CoordinatesInput,
  options?: { curvatureFactor?: number }
): number {
  const directDistance = haversineDistance(from, to);
  const factor = options?.curvatureFactor ?? DEFAULT_ROAD_CURVATURE_FACTOR;

  // Clamped between 1.15 and 1.50 for safety
  const safeFactor = Math.max(1.15, Math.min(1.5, factor));
  const roadDistance = directDistance * safeFactor;

  return Math.round(roadDistance * 10) / 10;
}

/**
 * Estimates driving travel duration in minutes based on distance and traffic context
 * - Urban short trips (< 15km): ~28 km/h
 * - Medium mixed trips (15 - 40km): ~40 km/h
 * - Long-distance / highway trips (> 40km): ~55 km/h
 */
export function estimateTravelTimeMinutes(
  distanceKm: number,
  options?: { isUrban?: boolean; averageSpeedKmh?: number }
): number {
  if (distanceKm <= 0) return 0;

  let speedKmh = options?.averageSpeedKmh;

  if (!speedKmh) {
    if (options?.isUrban || distanceKm < 15) {
      speedKmh = 28;
    } else if (distanceKm < 40) {
      speedKmh = 40;
    } else {
      speedKmh = 55;
    }
  }

  const hours = distanceKm / speedKmh;
  const minutes = Math.ceil(hours * 60);

  // Add min base buffer of 5 minutes for traffic lights / boarding
  return Math.max(5, minutes);
}
