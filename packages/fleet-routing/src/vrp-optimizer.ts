import { z } from 'zod';

export const LocationCoordinateSchema = z.object({
  id: z.string(),
  name: z.string(),
  address: z.string(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  contactPhone: z.string().optional(),
  contactPerson: z.string().optional(),
  cargoWeightKg: z.number().nonnegative().optional(),
  cargoVolumeM3: z.number().nonnegative().optional(),
  timeWindowStart: z.string().optional(), // '08:30'
  timeWindowEnd: z.string().optional(),   // '11:00'
  serviceMinutes: z.number().int().positive().default(12),
  notes: z.string().optional(),
});
export type LocationCoordinate = z.input<typeof LocationCoordinateSchema>;

export interface VrpOptimizerOptions {
  averageSpeedKmH?: number;        // Default 28 km/h in VN inner city
  urbanTortuosityFactor?: number;   // 1.32x for actual street network vs straight-line
  returnToDepot?: boolean;          // Default true (round trip)
  departureTime?: string;          // ISO string or '08:00'
}

export interface RouteLeg {
  legIndex: number;
  fromId: string;
  fromName: string;
  toId: string;
  toName: string;
  toAddress: string;
  toContactPhone?: string;
  distanceKm: number;
  durationMinutes: number;
  cumulativeDistanceKm: number;
  arrivalEstimatedTime: string;
  departureEstimatedTime: string;
  serviceMinutes: number;
  cargoWeightKg?: number;
  cargoVolumeM3?: number;
  googleMapsNavigationUrl: string;
}

export interface VrpOptimizationResult {
  depot: LocationCoordinate;
  originalSequence: LocationCoordinate[];
  optimizedSequence: LocationCoordinate[];
  originalDistanceKm: number;
  optimizedDistanceKm: number;
  distanceSavedKm: number;
  savingsPercentage: number;
  totalDurationMinutes: number;
  totalTransitMinutes: number;
  totalServiceMinutes: number;
  legs: RouteLeg[];
  fullGoogleMapsUrl: string;
  summary: string;
}

/**
 * Calculate Haversine distance in kilometers between two geo-coordinates
 */
export function calculateHaversineDistanceKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
  tortuosityFactor = 1.32
): number {
  if (lat1 === lat2 && lon1 === lon2) return 0;

  const R = 6371; // Earth radius in km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const straightKm = R * c;

  // Multiply by road tortuosity factor to estimate actual road street network
  return Math.round(straightKm * tortuosityFactor * 100) / 100;
}

/**
 * Build symmetric distance matrix between all points
 */
function buildDistanceMatrix(
  points: LocationCoordinate[],
  tortuosityFactor: number
): number[][] {
  const n = points.length;
  const matrix: number[][] = Array.from({ length: n }, () => Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) {
        matrix[i][j] = 0;
      } else {
        matrix[i][j] = calculateHaversineDistanceKm(
          points[i].latitude,
          points[i].longitude,
          points[j].latitude,
          points[j].longitude,
          tortuosityFactor
        );
      }
    }
  }
  return matrix;
}

/**
 * Calculate total tour distance for an array of stop indices starting from 0 (depot)
 */
function calculateTourDistance(
  tour: number[],
  distMatrix: number[][],
  returnToDepot: boolean
): number {
  let dist = 0;
  for (let i = 0; i < tour.length - 1; i++) {
    dist += distMatrix[tour[i]][tour[i + 1]];
  }
  if (returnToDepot && tour.length > 1) {
    dist += distMatrix[tour[tour.length - 1]][tour[0]];
  }
  return dist;
}

/**
 * 2-Opt local search improvement for TSP/VRP tour
 */
function apply2Opt(
  initialTour: number[],
  distMatrix: number[][],
  returnToDepot: boolean
): number[] {
  let tour = [...initialTour];
  let improved = true;
  let iterations = 0;
  const maxIterations = 500;

  while (improved && iterations < maxIterations) {
    improved = false;
    iterations++;

    // tour[0] is depot (fixed start)
    for (let i = 1; i < tour.length - 1; i++) {
      for (let k = i + 1; k < tour.length; k++) {
        // Calculate current cost vs reversed cost
        const currentDist = calculateTourDistance(tour, distMatrix, returnToDepot);

        // Reverse sub-segment [i...k]
        const newTour = [
          ...tour.slice(0, i),
          ...tour.slice(i, k + 1).reverse(),
          ...tour.slice(k + 1),
        ];

        const newDist = calculateTourDistance(newTour, distMatrix, returnToDepot);

        if (newDist < currentDist - 0.001) {
          tour = newTour;
          improved = true;
          break;
        }
      }
      if (improved) break;
    }
  }

  return tour;
}

/**
 * Nearest Neighbor Heuristic
 */
function nearestNeighborTour(
  n: number,
  distMatrix: number[][]
): number[] {
  const visited = new Set<number>();
  visited.add(0); // 0 is depot
  const tour = [0];

  let current = 0;
  while (visited.size < n) {
    let nearestDist = Infinity;
    let nearestNode = -1;

    for (let candidate = 1; candidate < n; candidate++) {
      if (!visited.has(candidate)) {
        const d = distMatrix[current][candidate];
        if (d < nearestDist) {
          nearestDist = d;
          nearestNode = candidate;
        }
      }
    }

    if (nearestNode !== -1) {
      visited.add(nearestNode);
      tour.push(nearestNode);
      current = nearestNode;
    } else {
      break;
    }
  }

  return tour;
}

/**
 * Format minutes offset into HH:MM string
 */
function formatTimeFromMinutes(baseMinutes: number): string {
  const normalized = ((baseMinutes % 1440) + 1440) % 1440;
  const h = Math.floor(normalized / 60);
  const m = Math.floor(normalized % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Optimize Multi-Stop Delivery Route for Logistics Fleets
 */
export function optimizeDeliveryRoute(
  depot: LocationCoordinate,
  deliveryStops: LocationCoordinate[],
  options: VrpOptimizerOptions = {}
): VrpOptimizationResult {
  const averageSpeedKmH = options.averageSpeedKmH ?? 28;
  const urbanTortuosityFactor = options.urbanTortuosityFactor ?? 1.32;
  const returnToDepot = options.returnToDepot ?? true;

  if (deliveryStops.length === 0) {
    return {
      depot,
      originalSequence: [],
      optimizedSequence: [],
      originalDistanceKm: 0,
      optimizedDistanceKm: 0,
      distanceSavedKm: 0,
      savingsPercentage: 0,
      totalDurationMinutes: 0,
      totalTransitMinutes: 0,
      totalServiceMinutes: 0,
      legs: [],
      fullGoogleMapsUrl: '',
      summary: 'Không có điểm giao hàng nào cần tối ưu.',
    };
  }

  // All points: Index 0 is Depot, 1..N are delivery stops
  const allPoints: LocationCoordinate[] = [depot, ...deliveryStops];
  const distMatrix = buildDistanceMatrix(allPoints, urbanTortuosityFactor);

  // 1. Original (naive input order) tour: 0 -> 1 -> 2 -> ... -> N
  const naiveTour = Array.from({ length: allPoints.length }, (_, i) => i);
  const originalDistance = calculateTourDistance(naiveTour, distMatrix, returnToDepot);

  // 2. Initial Nearest Neighbor tour
  const nnTour = nearestNeighborTour(allPoints.length, distMatrix);

  // 3. Improve using 2-Opt local search
  const optimizedTourIndices = apply2Opt(nnTour, distMatrix, returnToDepot);
  const optimizedDistance = calculateTourDistance(optimizedTourIndices, distMatrix, returnToDepot);

  const roundedOriginalKm = Math.round(originalDistance * 10) / 10;
  const roundedOptimizedKm = Math.round(optimizedDistance * 10) / 10;
  const distanceSavedKm = Math.max(0, Math.round((roundedOriginalKm - roundedOptimizedKm) * 10) / 10);
  const savingsPercentage =
    roundedOriginalKm > 0
      ? Math.round((distanceSavedKm / roundedOriginalKm) * 1000) / 10
      : 0;

  // Extract ordered stops (excluding depot index 0)
  const optimizedSequence: LocationCoordinate[] = [];
  for (let i = 1; i < optimizedTourIndices.length; i++) {
    optimizedSequence.push(allPoints[optimizedTourIndices[i]]);
  }

  // Build legs and timeline
  const legs: RouteLeg[] = [];
  let cumulativeDist = 0;
  let totalTransitMins = 0;
  let totalServiceMins = 0;

  // Base departure: 08:00 AM = 480 minutes
  let currentMinutes = 8 * 60;
  if (options.departureTime) {
    const parts = options.departureTime.split(':').map((p) => parseInt(p, 10));
    if (parts.length >= 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
      currentMinutes = parts[0] * 60 + parts[1];
    }
  }

  const tourPointsWithDepot = [...optimizedTourIndices];
  if (returnToDepot) {
    tourPointsWithDepot.push(0); // return to depot
  }

  for (let i = 0; i < tourPointsWithDepot.length - 1; i++) {
    const fromIdx = tourPointsWithDepot[i];
    const toIdx = tourPointsWithDepot[i + 1];
    const fromPt = allPoints[fromIdx];
    const toPt = allPoints[toIdx];

    const legDist = Math.round(distMatrix[fromIdx][toIdx] * 10) / 10;
    cumulativeDist = Math.round((cumulativeDist + legDist) * 10) / 10;

    // Driving time = (distance / speed) * 60
    const drivingMins = Math.max(2, Math.round((legDist / averageSpeedKmH) * 60));
    totalTransitMins += drivingMins;

    const arrivalMins = currentMinutes + drivingMins;
    const arrivalTime = formatTimeFromMinutes(arrivalMins);

    const serviceMins = toIdx === 0 ? 15 : (toPt.serviceMinutes ?? 12);
    totalServiceMins += serviceMins;

    const departureMins = arrivalMins + serviceMins;
    const departureTime = formatTimeFromMinutes(departureMins);
    currentMinutes = departureMins;

    // Google Maps Navigation Deep Link
    const gmapsNavUrl = `https://www.google.com/maps/dir/?api=1&origin=${fromPt.latitude},${fromPt.longitude}&destination=${toPt.latitude},${toPt.longitude}&travelmode=driving`;

    legs.push({
      legIndex: i + 1,
      fromId: fromPt.id,
      fromName: fromPt.name,
      toId: toPt.id,
      toName: toPt.name,
      toAddress: toPt.address,
      toContactPhone: toPt.contactPhone,
      distanceKm: legDist,
      durationMinutes: drivingMins,
      cumulativeDistanceKm: cumulativeDist,
      arrivalEstimatedTime: arrivalTime,
      departureEstimatedTime: departureTime,
      serviceMinutes: serviceMins,
      cargoWeightKg: toPt.cargoWeightKg,
      cargoVolumeM3: toPt.cargoVolumeM3,
      googleMapsNavigationUrl: gmapsNavUrl,
    });
  }

  const totalDurationMinutes = totalTransitMins + totalServiceMins;

  // Build full multi-stop Google Maps URL
  // https://www.google.com/maps/dir/lat1,lng1/lat2,lng2/...
  const fullWaypoints = [
    `${depot.latitude},${depot.longitude}`,
    ...optimizedSequence.map((s) => `${s.latitude},${s.longitude}`),
  ];
  if (returnToDepot) {
    fullWaypoints.push(`${depot.latitude},${depot.longitude}`);
  }
  const fullGoogleMapsUrl = `https://www.google.com/maps/dir/${fullWaypoints.join('/')}`;

  const summary = `Tối ưu lộ trình ${deliveryStops.length} điểm: Giảm từ ${roundedOriginalKm} km xuống ${roundedOptimizedKm} km, tiết kiệm ${distanceSavedKm} km (${savingsPercentage}%). Tổng thời gian di chuyển & giao hàng dự kiến ${Math.floor(
    totalDurationMinutes / 60
  )}h ${totalDurationMinutes % 60}m.`;

  return {
    depot,
    originalSequence: deliveryStops,
    optimizedSequence,
    originalDistanceKm: roundedOriginalKm,
    optimizedDistanceKm: roundedOptimizedKm,
    distanceSavedKm,
    savingsPercentage,
    totalDurationMinutes,
    totalTransitMinutes: totalTransitMins,
    totalServiceMinutes: totalServiceMins,
    legs,
    fullGoogleMapsUrl,
    summary,
  };
}
