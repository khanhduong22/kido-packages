import {
  Coordinates,
  CoordinatesInput,
  GeofenceOptions,
  GeofenceResult,
  GeofenceTarget,
} from './schemas';

// WGS-84 ellipsoid constants
export const WGS84_SEMI_MAJOR_AXIS = 6378137.0; // a in meters
export const WGS84_FLATTENING = 1 / 298.257223563; // f
export const WGS84_SEMI_MINOR_AXIS = 6356752.314245; // b = a * (1 - f) in meters
export const SPHERICAL_EARTH_RADIUS_METERS = 6371000; // Spherical mean radius

/**
 * Standardize varied coordinate representations into standard { lat, lon }
 */
export function normalizeCoordinates(coords: CoordinatesInput): Coordinates {
  const lat = coords.lat ?? coords.latitude;
  const lon = coords.lon ?? coords.lng ?? coords.longitude;

  if (lat === undefined || lon === undefined) {
    throw new Error('Coordinates must contain valid latitude (lat/latitude) and longitude (lon/lng/longitude)');
  }

  if (lat < -90 || lat > 90) {
    throw new RangeError(`Latitude ${lat} is out of bounds [-90, 90]`);
  }

  if (lon < -180 || lon > 180) {
    throw new RangeError(`Longitude ${lon} is out of bounds [-180, 180]`);
  }

  return {
    lat,
    lon,
    accuracy: coords.accuracy,
    altitude: coords.altitude,
    speed: coords.speed,
    heading: coords.heading,
    timestamp: coords.timestamp,
    isMockProvider: coords.isMockProvider,
    isFromMockProvider: coords.isFromMockProvider,
  };
}

/**
 * Calculates great-circle distance between two points in meters using Haversine formula
 * Assumes a spherical Earth with radius R = 6,371,000m
 */
export function haversineDistance(from: CoordinatesInput, to: CoordinatesInput): number {
  const c1 = normalizeCoordinates(from);
  const c2 = normalizeCoordinates(to);

  // If points are identical
  if (c1.lat === c2.lat && c1.lon === c2.lon) {
    return 0;
  }

  const rad = Math.PI / 180;
  const dLat = (c2.lat - c1.lat) * rad;
  const dLon = (c2.lon - c1.lon) * rad;

  const lat1Rad = c1.lat * rad;
  const lat2Rad = c2.lat * rad;

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1Rad) * Math.cos(lat2Rad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
  const distance = SPHERICAL_EARTH_RADIUS_METERS * c;

  return Math.round(distance * 100) / 100;
}

/**
 * Calculates precise geodesic distance in meters using Vincenty's inverse formula
 * on the WGS-84 reference ellipsoid (accurate to within 0.5mm on Earth).
 *
 * If points are nearly antipodal and the formula does not converge, it automatically
 * falls back to Haversine distance with high reliability.
 */
export function vincentyDistance(from: CoordinatesInput, to: CoordinatesInput): number {
  const c1 = normalizeCoordinates(from);
  const c2 = normalizeCoordinates(to);

  if (c1.lat === c2.lat && c1.lon === c2.lon) {
    return 0;
  }

  const a = WGS84_SEMI_MAJOR_AXIS;
  const b = WGS84_SEMI_MINOR_AXIS;
  const f = WGS84_FLATTENING;

  const rad = Math.PI / 180;
  const L = (c2.lon - c1.lon) * rad;

  const U1 = Math.atan((1 - f) * Math.tan(c1.lat * rad));
  const U2 = Math.atan((1 - f) * Math.tan(c2.lat * rad));

  const sinU1 = Math.sin(U1);
  const cosU1 = Math.cos(U1);
  const sinU2 = Math.sin(U2);
  const cosU2 = Math.cos(U2);

  let lambda = L;
  let lambdaPrev = 0;
  let iterLimit = 200;

  let cosSqAlpha = 0;
  let sinSigma = 0;
  let cos2SigmaM = 0;
  let cosSigma = 0;
  let sigma = 0;

  do {
    const sinLambda = Math.sin(lambda);
    const cosLambda = Math.cos(lambda);

    sinSigma = Math.sqrt(
      cosU2 * sinLambda * (cosU2 * sinLambda) +
      (cosU1 * sinU2 - sinU1 * cosU2 * cosLambda) * (cosU1 * sinU2 - sinU1 * cosU2 * cosLambda)
    );

    if (sinSigma === 0) {
      return 0; // Co-incident points
    }

    cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosLambda;
    sigma = Math.atan2(sinSigma, cosSigma);

    const sinAlpha = (cosU1 * cosU2 * sinLambda) / sinSigma;
    cosSqAlpha = 1 - sinAlpha * sinAlpha;

    cos2SigmaM = cosSqAlpha !== 0 ? cosSigma - (2 * sinU1 * sinU2) / cosSqAlpha : 0;

    const C = (f / 16) * cosSqAlpha * (4 + f * (4 - 3 * cosSqAlpha));
    lambdaPrev = lambda;
    lambda =
      L +
      (1 - C) *
        f *
        sinAlpha *
        (sigma +
          C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)));
  } while (Math.abs(lambda - lambdaPrev) > 1e-12 && --iterLimit > 0);

  // If formula failed to converge (antipodal points), fall back gracefully to Haversine
  if (iterLimit === 0) {
    return haversineDistance(from, to);
  }

  const uSq = (cosSqAlpha * (a * a - b * b)) / (b * b);
  const A = 1 + (uSq / 16384) * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
  const B = (uSq / 1024) * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));

  const deltaSigma =
    B *
    sinSigma *
    (cos2SigmaM +
      (B / 4) *
        (cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM) -
          (B / 6) *
            cos2SigmaM *
            (-3 + 4 * sinSigma * sinSigma) *
            (-3 + 4 * cos2SigmaM * cos2SigmaM)));

  const s = b * A * (sigma - deltaSigma);
  return Math.round(s * 100) / 100;
}

/**
 * Checks if user location is inside the specified geofence boundary of a retail store / dealer
 *
 * @param userLoc - Current user device coordinates
 * @param target - Retail store / target location coordinates or GeofenceTarget
 * @param radiusMeters - Geofence radius in meters (default: 50m)
 * @param options - Additional options (formula: 'vincenty' | 'haversine', toleranceMeters)
 */
export function isInsideGeofence(
  userLoc: CoordinatesInput,
  target: CoordinatesInput | GeofenceTarget,
  radiusMeters: number = 50,
  options?: Partial<GeofenceOptions>
): GeofenceResult {
  const targetCoords = 'coordinates' in target ? target.coordinates : target;
  const configuredRadius =
    'radiusMeters' in target && typeof target.radiusMeters === 'number'
      ? target.radiusMeters
      : radiusMeters;

  const formula = options?.formula ?? 'vincenty';
  const tolerance = options?.toleranceMeters ?? 0;
  const effectiveAllowedRadius = configuredRadius + tolerance;

  let distanceMeters = 0;
  let formulaUsed: 'haversine' | 'vincenty' = 'vincenty';

  if (formula === 'haversine') {
    distanceMeters = haversineDistance(userLoc, targetCoords);
    formulaUsed = 'haversine';
  } else {
    distanceMeters = vincentyDistance(userLoc, targetCoords);
    formulaUsed = 'vincenty';
  }

  const isInside = distanceMeters <= effectiveAllowedRadius;
  const deltaMeters = Math.round((distanceMeters - configuredRadius) * 100) / 100;

  return {
    isInside,
    distanceMeters,
    allowedRadiusMeters: configuredRadius,
    deltaMeters,
    formulaUsed,
  };
}
