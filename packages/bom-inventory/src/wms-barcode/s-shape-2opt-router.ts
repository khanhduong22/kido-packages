import { z } from 'zod';

/**
 * 3D Warehouse Coordinate & Location Specification
 * Represents bin coordinates in warehouse space for distance estimation and routing.
 */
export interface WarehouseLocation3D {
  binCode: string;
  aisle: string;
  aisleIndex: number;
  rack: number;
  level: number;
  bin: number;
  x: number;
  y: number;
  z: number;
}

export interface PickOrderItem {
  orderId: string;
  orderNumber: string;
  sku: string;
  productTitle?: string;
  variantTitle?: string;
  image?: string;
  binCode: string;
  quantity: number;
}

export interface OrderAllocation {
  orderId: string;
  orderNumber: string;
  boxNumber: number;
  quantity: number;
}

export interface ConsolidatedPickStop {
  stopNumber: number;
  sku: string;
  binCode: string;
  productTitle: string;
  variantTitle: string;
  image: string;
  location: WarehouseLocation3D;
  totalQuantity: number;
  orderAllocations: OrderAllocation[];
  isPicked?: boolean;
  pickedAt?: string | null;
}

export interface RouteMetrics {
  naiveSingleOrderMeters: number;
  alphabeticalSkuMeters: number;
  optimizedSshape2OptMeters: number;
  distanceSavedPercent: number;
  estimatedMinutes: number;
}

export interface OptimizedPickingPlan {
  stops: ConsolidatedPickStop[];
  totalUniqueSkus: number;
  totalItemsCount: number;
  routeMetrics: RouteMetrics;
  orderBaskets: Array<{
    orderId: string;
    orderNumber: string;
    boxNumber: number;
    basketLabel: string;
    totalQuantity: number;
  }>;
}

export interface WarehouseRoutingConfig {
  /** Distance between adjacent parallel aisles along x-axis in meters (default: 4.0m) */
  aislePitchMeters?: number;
  /** Distance between adjacent rack bays along y-axis in meters (default: 1.5m) */
  rackPitchMeters?: number;
  /** Total number of racks per aisle for front/back cross-aisle detour calculation (default: 10) */
  racksPerAisle?: number;
  /** Average walking speed in meters per minute (default: 60m/min = 1m/s) */
  walkingSpeedMpm?: number;
  /** Handling time penalty per pick stop in minutes (default: 0.35 min = ~21s) */
  stopHandlingMinutes?: number;
  /** Maximum iterations for 2-Opt local search improvement (default: 120) */
  max2OptIterations?: number;
}

/**
 * Parses warehouse bin codes such as "A-03-02-04", "WH01-A-03-02-B", or "PACK-00"
 * Extracts aisle, rack, level, and bin indices with 3D coordinates.
 */
export function parseWarehouseLocation3D(binCode: string): WarehouseLocation3D {
  const normalized = (binCode || '').trim().toUpperCase();

  if (normalized === 'PACK-00' || normalized.startsWith('PACK') || normalized.startsWith('DEPOT')) {
    return {
      binCode: 'PACK-00',
      aisle: 'PACK',
      aisleIndex: 0,
      rack: 0,
      level: 1,
      bin: 0,
      x: 0,
      y: 0,
      z: 1,
    };
  }

  // Support standard pattern e.g. A-03-02-04 or WH01-A-03-02-04
  const match = normalized.match(/(?:[A-Z0-9]+-)?([A-Z])-?(\d{1,2})-?(\d{1,2})-?(\d{1,2}|[A-Z])/i);
  if (match) {
    const aisle = match[1].toUpperCase();
    const aisleIndex = aisle.charCodeAt(0) - 65; // A -> 0, B -> 1, C -> 2...
    const rack = parseInt(match[2], 10);
    const level = parseInt(match[3], 10);
    const binRaw = match[4];
    const bin = /^\d+$/.test(binRaw) ? parseInt(binRaw, 10) : binRaw.charCodeAt(0) - 64;

    return {
      binCode: normalized,
      aisle,
      aisleIndex,
      rack,
      level,
      bin,
      x: aisleIndex,
      y: rack,
      z: level,
    };
  }

  // Fallback for non-standard formats
  return {
    binCode: normalized || 'A-01-01-01',
    aisle: 'A',
    aisleIndex: 0,
    rack: 1,
    level: 1,
    bin: 1,
    x: 0,
    y: 1,
    z: 1,
  };
}

/**
 * Calculates realistic warehouse walking distance in meters between two locations.
 * Takes into account cross-aisle turns: chooses minimum of front detour vs back detour.
 */
export function calculateWarehouseWalkingDistance(
  locA: WarehouseLocation3D,
  locB: WarehouseLocation3D,
  config?: WarehouseRoutingConfig
): number {
  if (locA.binCode === locB.binCode) {
    return 0;
  }

  const aislePitch = config?.aislePitchMeters ?? 4.0;
  const rackPitch = config?.rackPitchMeters ?? 1.5;
  const racksPerAisle = config?.racksPerAisle ?? 10;
  const backAisleCoordinate = racksPerAisle + 1;

  const yA = locA.y ?? locA.rack ?? 0;
  const yB = locB.y ?? locB.rack ?? 0;

  // Same aisle (and neither is the PACK depot station)
  if (locA.aisle === locB.aisle && locA.aisle !== 'PACK') {
    return Math.abs(yA - yB) * rackPitch;
  }

  // Cross-aisle traversal
  const xA = locA.aisleIndex ?? (locA.aisle === 'PACK' ? 0 : locA.aisle.charCodeAt(0) - 65);
  const xB = locB.aisleIndex ?? (locB.aisle === 'PACK' ? 0 : locB.aisle.charCodeAt(0) - 65);

  const crossAisleDist = Math.abs(xA - xB) * aislePitch;
  const frontCrossAisleDist = (yA + yB) * rackPitch;
  const backCrossAisleDist = ((backAisleCoordinate - yA) + (backAisleCoordinate - yB)) * rackPitch;
  const alongAisleDist = Math.min(frontCrossAisleDist, backCrossAisleDist);

  return crossAisleDist + alongAisleDist;
}

/**
 * Wave Consolidation + Serpentine S-Shape Traversal & 2-Opt TSP Route Optimizer.
 * 
 * 1. Groups identical items (SKU + binCode) across multiple customer orders into batch stops.
 * 2. Assigns Put-to-Wall box numbers for seamless multi-order picking.
 * 3. Applies Serpentine S-Shape heuristic:
 *    - Even visited aisle: Front to Back (ascending rack numbers: 1 -> N).
 *    - Odd visited aisle: Back to Front (descending rack numbers: N -> 1).
 * 4. Refines the tour using 2-Opt Local Search to eliminate cross-aisle crossings.
 * 5. Computes comparative walking metrics (Naive Single-Order vs Alphabetical SKU vs Optimized).
 */
export function optimizeSshape2OptRoute(
  items: PickOrderItem[],
  orderBoxMap?: Map<string, number>,
  config?: WarehouseRoutingConfig
): OptimizedPickingPlan {
  if (!items || items.length === 0) {
    return {
      stops: [],
      totalUniqueSkus: 0,
      totalItemsCount: 0,
      routeMetrics: {
        naiveSingleOrderMeters: 0,
        alphabeticalSkuMeters: 0,
        optimizedSshape2OptMeters: 0,
        distanceSavedPercent: 0,
        estimatedMinutes: 0,
      },
      orderBaskets: [],
    };
  }

  const walkingSpeedMpm = config?.walkingSpeedMpm ?? 60;
  const stopHandlingMinutes = config?.stopHandlingMinutes ?? 0.35;
  const maxIterations = config?.max2OptIterations ?? 120;

  // 1. Assign Box Number (Put-to-Wall Basket) for each distinct order
  const boxMap = orderBoxMap || new Map<string, number>();
  if (!orderBoxMap) {
    const distinctOrders = Array.from(new Set(items.map((it) => it.orderId)));
    distinctOrders.forEach((ordId, idx) => {
      boxMap.set(ordId, idx + 1);
    });
  }

  // Build order basket summary
  const orderBasketMap = new Map<
    string,
    { orderId: string; orderNumber: string; boxNumber: number; totalQuantity: number }
  >();

  for (const item of items) {
    const boxNumber = boxMap.get(item.orderId) || 1;
    if (!orderBasketMap.has(item.orderId)) {
      orderBasketMap.set(item.orderId, {
        orderId: item.orderId,
        orderNumber: item.orderNumber,
        boxNumber,
        totalQuantity: 0,
      });
    }
    orderBasketMap.get(item.orderId)!.totalQuantity += item.quantity;
  }

  const orderBaskets = Array.from(orderBasketMap.values()).map((b) => ({
    ...b,
    basketLabel: `Basket #${b.boxNumber} (${b.orderNumber})`,
  }));

  // 2. Wave Consolidation: Group items sharing the same (sku, binCode)
  const consolidatedMap = new Map<
    string,
    {
      sku: string;
      binCode: string;
      productTitle: string;
      variantTitle: string;
      image: string;
      location: WarehouseLocation3D;
      totalQuantity: number;
      orderAllocations: OrderAllocation[];
    }
  >();

  for (const item of items) {
    const key = `${item.sku}::${item.binCode}`;
    const boxNumber = boxMap.get(item.orderId) || 1;

    if (!consolidatedMap.has(key)) {
      consolidatedMap.set(key, {
        sku: item.sku,
        binCode: item.binCode,
        productTitle: item.productTitle || item.sku,
        variantTitle: item.variantTitle || '',
        image: item.image || '',
        location: parseWarehouseLocation3D(item.binCode),
        totalQuantity: 0,
        orderAllocations: [],
      });
    }

    const group = consolidatedMap.get(key)!;
    group.totalQuantity += item.quantity;
    const existingAlloc = group.orderAllocations.find((a) => a.orderId === item.orderId);
    if (existingAlloc) {
      existingAlloc.quantity += item.quantity;
    } else {
      group.orderAllocations.push({
        orderId: item.orderId,
        orderNumber: item.orderNumber,
        boxNumber,
        quantity: item.quantity,
      });
    }
  }

  const initialStops = Array.from(consolidatedMap.values());
  const packStation = parseWarehouseLocation3D('PACK-00');

  // 3. Strategy A: Naive Single-Order Walking Distance
  let naiveSingleOrderMeters = 0;
  const itemsByOrder = new Map<string, PickOrderItem[]>();
  for (const it of items) {
    if (!itemsByOrder.has(it.orderId)) {
      itemsByOrder.set(it.orderId, []);
    }
    itemsByOrder.get(it.orderId)!.push(it);
  }

  for (const orderItems of itemsByOrder.values()) {
    let curr = packStation;
    for (const ordItem of orderItems) {
      const loc = parseWarehouseLocation3D(ordItem.binCode);
      naiveSingleOrderMeters += calculateWarehouseWalkingDistance(curr, loc, config);
      curr = loc;
    }
    naiveSingleOrderMeters += calculateWarehouseWalkingDistance(curr, packStation, config);
  }

  // 4. Strategy B: Alphabetical SKU Walking Distance
  const azSortedStops = [...initialStops].sort((a, b) => a.sku.localeCompare(b.sku));
  let alphabeticalSkuMeters = 0;
  let currAz = packStation;
  for (const stop of azSortedStops) {
    alphabeticalSkuMeters += calculateWarehouseWalkingDistance(currAz, stop.location, config);
    currAz = stop.location;
  }
  alphabeticalSkuMeters += calculateWarehouseWalkingDistance(currAz, packStation, config);

  // 5. Strategy C: Serpentine S-Shape Aisle Traversal + 2-Opt Local Search Refinement
  const stopsByAisle = new Map<number, typeof initialStops>();
  for (const stop of initialStops) {
    const aisleIdx = stop.location.aisleIndex;
    if (!stopsByAisle.has(aisleIdx)) {
      stopsByAisle.set(aisleIdx, []);
    }
    stopsByAisle.get(aisleIdx)!.push(stop);
  }

  // Sort visited aisles in ascending order (A, B, C...)
  const sortedVisitedAisleIndices = Array.from(stopsByAisle.keys()).sort((a, b) => a - b);

  // S-Shape Traversal:
  // Even visited aisle: front-to-back (rack ascending)
  // Odd visited aisle: back-to-front (rack descending)
  const sShapeStops: typeof initialStops = [];
  sortedVisitedAisleIndices.forEach((aisleIdx, visitSeq) => {
    const aisleStops = stopsByAisle.get(aisleIdx)!;
    if (visitSeq % 2 === 0) {
      aisleStops.sort((a, b) => (a.location.rack || 0) - (b.location.rack || 0));
    } else {
      aisleStops.sort((a, b) => (b.location.rack || 0) - (a.location.rack || 0));
    }
    sShapeStops.push(...aisleStops);
  });

  // Refine S-Shape tour with 2-Opt Local Search
  const n = sShapeStops.length;
  let currentTourIndices = Array.from({ length: n }, (_, i) => i);
  let improved = true;
  let iterations = 0;

  while (improved && iterations < maxIterations) {
    improved = false;
    iterations++;

    for (let i = 0; i < n - 1; i++) {
      for (let j = i + 1; j < n; j++) {
        const u = i === 0 ? packStation : sShapeStops[currentTourIndices[i - 1]].location;
        const v = sShapeStops[currentTourIndices[i]].location;
        const w = sShapeStops[currentTourIndices[j]].location;
        const x = j === n - 1 ? packStation : sShapeStops[currentTourIndices[j + 1]].location;

        const currentDist =
          calculateWarehouseWalkingDistance(u, v, config) + calculateWarehouseWalkingDistance(w, x, config);
        const newDist =
          calculateWarehouseWalkingDistance(u, w, config) + calculateWarehouseWalkingDistance(v, x, config);

        if (newDist < currentDist - 0.001) {
          // Reverse segment from i to j
          const reversed = currentTourIndices.slice(i, j + 1).reverse();
          currentTourIndices.splice(i, j - i + 1, ...reversed);
          improved = true;
        }
      }
    }
  }

  // Build final stops in 2-opt order
  const finalOrderedStops: ConsolidatedPickStop[] = currentTourIndices.map((idx, seq) => {
    const raw = sShapeStops[idx];
    return {
      ...raw,
      stopNumber: seq + 1,
      isPicked: false,
      pickedAt: null,
    };
  });

  // Calculate final walking distance
  let optimizedSshape2OptMeters = 0;
  let currOpt = packStation;
  for (const stop of finalOrderedStops) {
    optimizedSshape2OptMeters += calculateWarehouseWalkingDistance(currOpt, stop.location, config);
    currOpt = stop.location;
  }
  optimizedSshape2OptMeters += calculateWarehouseWalkingDistance(currOpt, packStation, config);

  // Compute metrics
  const distanceSavedMeters = Math.max(0, naiveSingleOrderMeters - optimizedSshape2OptMeters);
  const distanceSavedPercent =
    naiveSingleOrderMeters > 0
      ? Math.round((distanceSavedMeters / naiveSingleOrderMeters) * 1000) / 10
      : 0;

  const totalItemsCount = items.reduce((sum, it) => sum + it.quantity, 0);

  // Estimate minutes: walking distance / walkingSpeed + stop count * handlingMinutes
  const estimatedMinutes =
    Math.round(
      (optimizedSshape2OptMeters / walkingSpeedMpm + finalOrderedStops.length * stopHandlingMinutes) * 10
    ) / 10;

  return {
    stops: finalOrderedStops,
    totalUniqueSkus: finalOrderedStops.length,
    totalItemsCount,
    routeMetrics: {
      naiveSingleOrderMeters: Math.round(naiveSingleOrderMeters * 10) / 10,
      alphabeticalSkuMeters: Math.round(alphabeticalSkuMeters * 10) / 10,
      optimizedSshape2OptMeters: Math.round(optimizedSshape2OptMeters * 10) / 10,
      distanceSavedPercent,
      estimatedMinutes,
    },
    orderBaskets,
  };
}
