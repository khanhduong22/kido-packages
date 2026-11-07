import { z } from 'zod';

/**
 * Zod Schema for parsed Bin Location
 * Standard WMS Format: WH-AISLE-RACK-SHELF-BIN (e.g., WH01-A-02-03-B)
 */
export const BinLocationSchema = z.object({
  warehouse: z.string().min(2).max(10).describe('Warehouse code e.g. WH01'),
  aisle: z.string().min(1).max(4).describe('Aisle identifier e.g. A, B, 01'),
  rack: z.number().int().min(1).max(999).describe('Rack / Bay number e.g. 2'),
  shelf: z.number().int().min(1).max(99).describe('Vertical level / tier e.g. 3 (1 is bottom)'),
  bin: z.string().min(1).max(6).describe('Bin slot within shelf e.g. B or 01'),
  rawCode: z.string().optional().describe('Original raw string representation'),
});

export type BinLocation = z.infer<typeof BinLocationSchema>;

export type BinLocationInput = {
  warehouse: string;
  aisle: string;
  rack: number;
  shelf: number;
  bin: string;
};

export interface WarehouseLayoutConfig {
  /** Width between adjacent aisles in meters (default: 3.0m) */
  aisleWidthMeters?: number;
  /** Length per rack bay along the aisle in meters (default: 1.5m) */
  rackLengthMeters?: number;
  /** Height per vertical shelf tier in meters (default: 1.0m) */
  shelfHeightMeters?: number;
  /** Extra penalty factor for vertical movement vs horizontal walking (default: 2.0) */
  verticalEffortFactor?: number;
  /** Total racks per aisle to compute cross-aisle turns (default: 30) */
  racksPerAisle?: number;
}

export interface AdjacentBins {
  sameAisleAbove: string | null;
  sameAisleBelow: string | null;
  sameAisleLeftRack: string | null;
  sameAisleRightRack: string | null;
  oppositeRackInAisle: string | null;
}

// Regex matching standard format: WH01-A-02-03-B or WH-HCM-B-12-04-01
const BIN_LOCATION_REGEX = /^([A-Z0-9_-]{2,12})-([A-Z0-9]{1,4})-([0-9]{2,3})-([0-9]{2})-([A-Z0-9]{1,6})$/i;

/**
 * Validates whether a given string adheres to the standard WMS Bin Location format.
 */
export function isValidBinLocation(code: string): boolean {
  if (typeof code !== 'string') return false;
  return BIN_LOCATION_REGEX.test(code.trim());
}

/**
 * Formats a bin location object into the canonical WMS string representation.
 * Pads rack and shelf with leading zeros for uniform indexing (e.g. WH01-A-02-03-B).
 */
export function formatBinLocation(input: BinLocationInput): string {
  const wh = input.warehouse.trim().toUpperCase();
  const aisle = input.aisle.trim().toUpperCase();
  const rack = String(input.rack).padStart(2, '0');
  const shelf = String(input.shelf).padStart(2, '0');
  const bin = input.bin.trim().toUpperCase();

  return `${wh}-${aisle}-${rack}-${shelf}-${bin}`;
}

/**
 * Parses a standard WMS string into a structured BinLocation object.
 * Throws an Error if format is invalid.
 */
export function parseBinLocation(code: string): BinLocation {
  const trimmed = code.trim().toUpperCase();
  const match = trimmed.match(BIN_LOCATION_REGEX);

  if (!match) {
    throw new Error(
      `Invalid bin location format: "${code}". Expected format: WH-AISLE-RACK-SHELF-BIN (e.g. WH01-A-02-03-B)`
    );
  }

  const [, warehouse, aisle, rackStr, shelfStr, bin] = match;

  const result: BinLocation = {
    warehouse,
    aisle,
    rack: parseInt(rackStr, 10),
    shelf: parseInt(shelfStr, 10),
    bin,
    rawCode: trimmed,
  };

  return BinLocationSchema.parse(result);
}

/**
 * Safely parses a bin location string, returning null if invalid.
 */
export function safeParseBinLocation(code: string): BinLocation | null {
  try {
    return parseBinLocation(code);
  } catch {
    return null;
  }
}

/**
 * Converts aisle identifier (e.g., 'A', 'B', 'AA', '01') into numeric index (1-based).
 */
export function aisleToNumericIndex(aisle: string): number {
  const cleaned = aisle.toUpperCase().trim();
  if (/^\d+$/.test(cleaned)) {
    return parseInt(cleaned, 10);
  }
  let index = 0;
  for (let i = 0; i < cleaned.length; i++) {
    index = index * 26 + (cleaned.charCodeAt(i) - 64);
  }
  return index;
}

/**
 * Converts 1-based numeric index back to letter aisle (1 -> 'A', 26 -> 'Z', 27 -> 'AA').
 */
export function numericIndexToAisle(index: number): string {
  let str = '';
  let n = index;
  while (n > 0) {
    const rem = (n - 1) % 26;
    str = String.fromCharCode(65 + rem) + str;
    n = Math.floor((n - 1) / 26);
  }
  return str;
}

/**
 * Resolves a bin input which can be either a string or already parsed BinLocation.
 */
function resolveBinLocation(input: string | BinLocation): BinLocation {
  return typeof input === 'string' ? parseBinLocation(input) : input;
}

/**
 * Computes realistic warehouse travel distance (in meters) between two bin locations.
 * Models aisle traversal with cross-aisles at the front (rack 0) and rear of the warehouse.
 */
export function calculateBinDistance(
  binA: string | BinLocation,
  binB: string | BinLocation,
  config: WarehouseLayoutConfig = {}
): number {
  const a = resolveBinLocation(binA);
  const b = resolveBinLocation(binB);

  // If different warehouses, return infinity
  if (a.warehouse !== b.warehouse) {
    return Number.POSITIVE_INFINITY;
  }

  const aisleWidth = config.aisleWidthMeters ?? 3.0;
  const rackLength = config.rackLengthMeters ?? 1.5;
  const shelfHeight = config.shelfHeightMeters ?? 1.0;
  const verticalFactor = config.verticalEffortFactor ?? 2.0;
  const racksPerAisle = config.racksPerAisle ?? 30;

  const aisleIndexA = aisleToNumericIndex(a.aisle);
  const aisleIndexB = aisleToNumericIndex(b.aisle);

  const aisleDiff = Math.abs(aisleIndexA - aisleIndexB);
  const verticalDistance = Math.abs(a.shelf - b.shelf) * shelfHeight * verticalFactor;

  // Case 1: Same aisle -> picker simply walks straight along the aisle
  if (aisleDiff === 0) {
    const rackDist = Math.abs(a.rack - b.rack) * rackLength;
    return Number((rackDist + verticalDistance).toFixed(2));
  }

  // Case 2: Different aisles -> picker must exit via front cross-aisle or rear cross-aisle
  // Front cross-aisle path: walk to rack 0, cross aisles, walk to rack B
  const viaFrontDist = (a.rack + b.rack) * rackLength;

  // Rear cross-aisle path: walk to end of aisle, cross aisles, walk to rack B
  const viaRearDist = (2 * racksPerAisle - a.rack - b.rack) * rackLength;

  const optimalAlongAisleDist = Math.min(viaFrontDist, viaRearDist);
  const crossAisleDist = aisleDiff * aisleWidth;

  const totalDist = crossAisleDist + optimalAlongAisleDist + verticalDistance;
  return Number(totalDist.toFixed(2));
}

/**
 * Generates neighboring bin locations around a given bin.
 * Useful for overflow storage, consolidation, or nearest available searches.
 */
export function getAdjacentBins(binInput: string | BinLocation): AdjacentBins {
  const loc = resolveBinLocation(binInput);

  // Above
  const aboveLoc: BinLocationInput = { ...loc, shelf: loc.shelf + 1 };
  // Below (minimum shelf is 1)
  const belowLoc: BinLocationInput | null = loc.shelf > 1 ? { ...loc, shelf: loc.shelf - 1 } : null;
  // Left rack (rack - 1, min 1)
  const leftRack: BinLocationInput | null = loc.rack > 1 ? { ...loc, rack: loc.rack - 1 } : null;
  // Right rack (rack + 1)
  const rightRack: BinLocationInput = { ...loc, rack: loc.rack + 1 };

  // Opposite rack across the same aisle face (odd vs even rack convention: 01 vs 02)
  const oppositeRackNum = loc.rack % 2 === 1 ? loc.rack + 1 : loc.rack - 1;
  const oppositeRack: BinLocationInput | null =
    oppositeRackNum >= 1 ? { ...loc, rack: oppositeRackNum } : null;

  return {
    sameAisleAbove: formatBinLocation(aboveLoc),
    sameAisleBelow: belowLoc ? formatBinLocation(belowLoc) : null,
    sameAisleLeftRack: leftRack ? formatBinLocation(leftRack) : null,
    sameAisleRightRack: formatBinLocation(rightRack),
    oppositeRackInAisle: oppositeRack ? formatBinLocation(oppositeRack) : null,
  };
}
