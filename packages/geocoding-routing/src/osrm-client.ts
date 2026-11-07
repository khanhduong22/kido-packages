import { CoordinatesInput, estimateRoadDistance, estimateTravelTimeMinutes, normalizeCoordinates } from './haversine';

export interface OsrmRouteOptions {
  baseUrl?: string;
  timeoutMs?: number;
  fallbackToHaversine?: boolean;
  curvatureFactor?: number;
  fetchFn?: typeof fetch;
}

export interface RouteResult {
  distanceKm: number;
  distanceMeters: number;
  durationMinutes: number;
  durationSeconds: number;
  isFallback: boolean;
  source: 'osrm' | 'haversine_fallback';
  rawResponse?: any;
}

export const DEFAULT_OSRM_BASE_URL = 'https://router.project-osrm.org';
export const DEFAULT_OSRM_TIMEOUT_MS = 3000;

/**
 * Queries OpenStreetMap OSRM Driving Route API with automatic Haversine road curvature fallback
 */
export async function getOsrmRoute(
  from: CoordinatesInput,
  to: CoordinatesInput,
  options?: OsrmRouteOptions
): Promise<RouteResult> {
  const c1 = normalizeCoordinates(from);
  const c2 = normalizeCoordinates(to);

  const baseUrl = (options?.baseUrl || DEFAULT_OSRM_BASE_URL).replace(/\/$/, '');
  const timeoutMs = options?.timeoutMs ?? DEFAULT_OSRM_TIMEOUT_MS;
  const fallbackEnabled = options?.fallbackToHaversine ?? true;
  const fetcher = options?.fetchFn ?? fetch;

  // OSRM expects coordinates in {lon},{lat};{lon},{lat} format
  const url = `${baseUrl}/route/v1/driving/${c1.lon},${c1.lat};${c2.lon},${c2.lat}?overview=false&steps=false`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetcher(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'KT-VietRide-Express/1.0',
      },
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!res.ok) {
      throw new Error(`OSRM HTTP error status ${res.status}`);
    }

    const data = (await res.json()) as any;

    if (data.code !== 'Ok' || !data.routes || data.routes.length === 0) {
      throw new Error(`OSRM routing failed: ${data.code || 'No route found'}`);
    }

    const primaryRoute = data.routes[0];
    const distanceMeters = Math.round(primaryRoute.distance);
    const durationSeconds = Math.round(primaryRoute.duration);
    const distanceKm = Math.round((distanceMeters / 1000) * 10) / 10;
    const durationMinutes = Math.max(5, Math.ceil(durationSeconds / 60));

    return {
      distanceKm,
      distanceMeters,
      durationMinutes,
      durationSeconds,
      isFallback: false,
      source: 'osrm',
      rawResponse: data,
    };
  } catch (err: any) {
    if (!fallbackEnabled) {
      throw err;
    }

    // Graceful fallback to Haversine curvature road estimation
    const distanceKm = estimateRoadDistance(c1, c2, { curvatureFactor: options?.curvatureFactor });
    const distanceMeters = Math.round(distanceKm * 1000);
    const durationMinutes = estimateTravelTimeMinutes(distanceKm);
    const durationSeconds = durationMinutes * 60;

    return {
      distanceKm,
      distanceMeters,
      durationMinutes,
      durationSeconds,
      isFallback: true,
      source: 'haversine_fallback',
    };
  }
}
