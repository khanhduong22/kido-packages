import { z } from 'zod';
import { parseBinLocation, type BinLocation } from './bin-location';

export const VelocityTierSchema = z.enum(['FAST', 'MEDIUM', 'SLOW']);
export type VelocityTier = z.infer<typeof VelocityTierSchema>;

export const PutawayItemSchema = z.object({
  sku: z.string().min(1),
  name: z.string().min(1),
  velocity: VelocityTierSchema.default('MEDIUM').describe(
    'FAST = FMCG / high turnover, MEDIUM = regular, SLOW = slow turnover'
  ),
  weightKg: z.number().positive(),
  volumeM3: z.number().nonnegative().optional().default(0.01),
  isFragile: z.boolean().optional().default(false),
  isHeavy: z.boolean().optional().describe('Flagged if exceeds heavy threshold'),
  category: z.string().optional(),
});

export type PutawayItem = z.infer<typeof PutawayItemSchema>;
export type PutawayItemInput = z.input<typeof PutawayItemSchema>;

export const StorageBinSchema = z.object({
  binLocation: z.string().min(1),
  maxWeightCapacityKg: z.number().positive().default(100),
  currentWeightKg: z.number().nonnegative().default(0),
  maxVolumeM3: z.number().positive().optional().default(1.0),
  currentVolumeM3: z.number().nonnegative().optional().default(0),
  currentSkus: z
    .array(
      z.object({
        sku: z.string(),
        quantity: z.number().int().nonnegative(),
      })
    )
    .optional()
    .default([]),
  zone: z.string().optional(),
  distanceToDispatchDoorMeters: z.number().nonnegative().optional(),
  isLocked: z.boolean().optional().default(false),
});

export type StorageBin = z.infer<typeof StorageBinSchema>;
export type StorageBinInput = z.input<typeof StorageBinSchema>;

export interface PutawayRuleOptions {
  /** Weight in kg above which an item is considered heavy (default: 15kg) */
  heavyWeightThresholdKg?: number;
  /** Maximum shelf level allowed for heavy items (default: 1, ground tier) */
  maxHeavyShelfLevel?: number;
  /** Prefer consolidating same SKU into existing bin (default: true) */
  preferSkuConsolidation?: boolean;
  /** Disallow mixing different SKUs in the same bin if true (default: false) */
  exclusiveSkuBins?: boolean;
  /** Warehouse door rack reference (default: rack 1 is closest) */
  dispatchDoorRackIndex?: number;
}

export interface PutawayRecommendation {
  binLocation: string;
  score: number;
  isEligible: boolean;
  rejectionReason?: string;
  scoreBreakdown: {
    rule: string;
    points: number;
    reason: string;
  }[];
  parsedLocation: BinLocation;
  availableWeightKg: number;
  availableVolumeM3: number;
}

export interface PutawayResult {
  item: PutawayItem;
  recommendedBin: PutawayRecommendation | null;
  candidates: PutawayRecommendation[];
}

/**
 * Evaluates and scores storage bins for putting away an inbound inventory item.
 * Implements WMS Putaway Rules:
 * 1. Heavy items (>15kg) MUST go to bottom shelves (Shelf 1) for ergonomics and structural safety.
 * 2. FMCG / Fast-moving goods placed on golden zone (Shelf 1-2) near dispatch doors/low rack numbers.
 * 3. Slow-moving items routed to high shelves (Shelf >= 4) and deeper warehouse racks.
 * 4. SKU Consolidation: bonus for storing in bins that already hold the same SKU.
 */
export function suggestPutawayBin(
  itemInput: PutawayItemInput,
  binsInput: StorageBinInput[],
  options: PutawayRuleOptions = {}
): PutawayResult {
  const item = PutawayItemSchema.parse(itemInput);
  const parsedBins = binsInput.map((b) => StorageBinSchema.parse(b));
  const heavyThreshold = options.heavyWeightThresholdKg ?? 15.0;
  const maxHeavyShelf = options.maxHeavyShelfLevel ?? 1;
  const isHeavyItem = item.isHeavy || item.weightKg >= heavyThreshold;
  const doorRack = options.dispatchDoorRackIndex ?? 1;

  const candidates: PutawayRecommendation[] = [];

  for (const bin of parsedBins) {
    const parsedLoc = parseBinLocation(bin.binLocation);
    const availableWeight = bin.maxWeightCapacityKg - bin.currentWeightKg;
    const maxVol = bin.maxVolumeM3 ?? 1.0;
    const curVol = bin.currentVolumeM3 ?? 0.0;
    const availableVolume = maxVol - curVol;

    const breakdown: PutawayRecommendation['scoreBreakdown'] = [];
    let isEligible = true;
    let rejectionReason: string | undefined;

    // Hard Constraint 1: Bin locked
    if (bin.isLocked) {
      isEligible = false;
      rejectionReason = 'Bin is currently locked or undergoing maintenance';
    }

    // Hard Constraint 2: Weight capacity
    if (isEligible && availableWeight < item.weightKg) {
      isEligible = false;
      rejectionReason = `Weight capacity exceeded (Needs ${item.weightKg}kg, available ${availableWeight.toFixed(1)}kg)`;
    }

    // Hard Constraint 3: Volume capacity
    if (isEligible && availableVolume < (item.volumeM3 ?? 0)) {
      isEligible = false;
      rejectionReason = `Volume capacity exceeded (Needs ${item.volumeM3}m3, available ${availableVolume.toFixed(2)}m3)`;
    }

    // Hard Constraint 4: Heavy safety rule - Heavy items (>15kg) cannot go to high shelves
    if (isEligible && isHeavyItem && parsedLoc.shelf > maxHeavyShelf) {
      isEligible = false;
      rejectionReason = `Safety violation: Heavy item (${item.weightKg}kg >= ${heavyThreshold}kg) cannot be stored above shelf ${maxHeavyShelf} (current shelf: ${parsedLoc.shelf})`;
    }

    // Hard Constraint 5: Exclusive SKU bins
    if (isEligible && options.exclusiveSkuBins && bin.currentSkus && bin.currentSkus.length > 0) {
      const hasDifferentSku = bin.currentSkus.some((s) => s.sku !== item.sku);
      if (hasDifferentSku) {
        isEligible = false;
        rejectionReason = 'Exclusive SKU rule: Bin contains different SKUs';
      }
    }

    if (!isEligible) {
      candidates.push({
        binLocation: bin.binLocation,
        score: -999,
        isEligible: false,
        rejectionReason,
        scoreBreakdown: [],
        parsedLocation: parsedLoc,
        availableWeightKg: availableWeight,
        availableVolumeM3: availableVolume,
      });
      continue;
    }

    // Scoring calculation for eligible bins
    let totalScore = 100; // Base baseline score

    // 1. Velocity & Shelf/Rack alignment
    if (item.velocity === 'FAST') {
      // Golden zone: shelf 1-2 (waist to chest height)
      if (parsedLoc.shelf <= 2) {
        const pts = 50;
        totalScore += pts;
        breakdown.push({
          rule: 'FMCG_GOLDEN_ZONE',
          points: pts,
          reason: `FMCG item stored on shelf ${parsedLoc.shelf} (Golden Pick Zone 1-2)`,
        });
      } else {
        const penalty = -(parsedLoc.shelf - 2) * 20;
        totalScore += penalty;
        breakdown.push({
          rule: 'FMCG_HIGH_SHELF_PENALTY',
          points: penalty,
          reason: `FMCG item placed on high shelf ${parsedLoc.shelf}, slowing pick cycles`,
        });
      }

      // Proximity to dispatch door / low rack numbers
      const rackDistance = Math.abs(parsedLoc.rack - doorRack);
      const proximityPoints = Math.max(0, 30 - rackDistance * 3);
      totalScore += proximityPoints;
      breakdown.push({
        rule: 'FMCG_DOOR_PROXIMITY',
        points: proximityPoints,
        reason: `Rack ${parsedLoc.rack} proximity to dispatch door (+${proximityPoints} pts)`,
      });
    } else if (item.velocity === 'SLOW') {
      // Slow items should go to upper shelves (level 4+) to save lower space
      if (parsedLoc.shelf >= 4) {
        const pts = 45;
        totalScore += pts;
        breakdown.push({
          rule: 'SLOW_HIGH_SHELF_UTILIZATION',
          points: pts,
          reason: `Slow-moving item placed on top shelf ${parsedLoc.shelf}, preserving golden zone`,
        });
      } else if (parsedLoc.shelf <= 2) {
        const penalty = -35;
        totalScore += penalty;
        breakdown.push({
          rule: 'SLOW_GOLDEN_ZONE_WASTE',
          points: penalty,
          reason: `Slow item placed on shelf ${parsedLoc.shelf} wastes prime pick space`,
        });
      }

      // Deeper racks bonus for slow items
      if (parsedLoc.rack > 10) {
        const pts = 20;
        totalScore += pts;
        breakdown.push({
          rule: 'SLOW_DEEP_RACK',
          points: pts,
          reason: `Slow item stored in deep rack ${parsedLoc.rack}`,
        });
      }
    } else {
      // MEDIUM velocity items: shelf 2 or 3 is ideal
      if (parsedLoc.shelf === 2 || parsedLoc.shelf === 3) {
        const pts = 30;
        totalScore += pts;
        breakdown.push({
          rule: 'MEDIUM_MID_TIER',
          points: pts,
          reason: `Medium velocity item placed on convenient mid-tier shelf ${parsedLoc.shelf}`,
        });
      }
    }

    // 2. Heavy Weight Placement Bonus (Ergonomics)
    if (isHeavyItem && parsedLoc.shelf === 1) {
      const pts = 40;
      totalScore += pts;
      breakdown.push({
        rule: 'HEAVY_BOTTOM_SHELF_SAFETY',
        points: pts,
        reason: `Heavy item (${item.weightKg}kg) placed on bottom shelf 1 for ergonomics and safety`,
      });
    }

    // 3. SKU Consolidation / Affinity Bonus
    const existingSkuMatch = bin.currentSkus?.find((s) => s.sku === item.sku);
    if (existingSkuMatch && (options.preferSkuConsolidation ?? true)) {
      const pts = 35;
      totalScore += pts;
      breakdown.push({
        rule: 'SKU_CONSOLIDATION',
        points: pts,
        reason: `Bin already contains ${existingSkuMatch.quantity} units of SKU ${item.sku}`,
      });
    }

    // 4. Space Efficiency (prefer partially occupied bins over cracking open new empty ones)
    if (bin.currentSkus && bin.currentSkus.length > 0) {
      const pts = 10;
      totalScore += pts;
      breakdown.push({
        rule: 'BIN_DENSITY_UTILIZATION',
        points: pts,
        reason: 'Consolidating storage into active occupied bin',
      });
    }

    candidates.push({
      binLocation: bin.binLocation,
      score: totalScore,
      isEligible: true,
      scoreBreakdown: breakdown,
      parsedLocation: parsedLoc,
      availableWeightKg: availableWeight,
      availableVolumeM3: availableVolume,
    });
  }

  // Sort candidates by score descending
  candidates.sort((a, b) => {
    if (a.isEligible !== b.isEligible) {
      return a.isEligible ? -1 : 1;
    }
    return b.score - a.score;
  });

  const topEligible = candidates.find((c) => c.isEligible) ?? null;

  return {
    item,
    recommendedBin: topEligible,
    candidates,
  };
}

/**
 * Assigns multiple inbound items to storage bins in sequence,
 * incrementally updating simulated bin capacities as items are allocated.
 */
export function suggestPutawayBatch(
  items: PutawayItemInput[],
  bins: StorageBinInput[],
  options: PutawayRuleOptions = {}
): Array<{ item: PutawayItem; assignedBin: string | null; recommendation: PutawayRecommendation | null }> {
  // Parse and deep clone bins to simulate occupancy
  const workingBins: StorageBin[] = bins.map((raw) => {
    const b = StorageBinSchema.parse(raw);
    return {
      ...b,
      currentSkus: b.currentSkus ? b.currentSkus.map((s) => ({ ...s })) : [],
    };
  });

  const assignments: Array<{
    item: PutawayItem;
    assignedBin: string | null;
    recommendation: PutawayRecommendation | null;
  }> = [];

  for (const rawItem of items) {
    const result = suggestPutawayBin(rawItem, workingBins, options);
    if (result.recommendedBin) {
      const targetBin = workingBins.find((b) => b.binLocation === result.recommendedBin!.binLocation);
      if (targetBin) {
        targetBin.currentWeightKg += result.item.weightKg;
        targetBin.currentVolumeM3 = (targetBin.currentVolumeM3 ?? 0) + (result.item.volumeM3 ?? 0);
        const existingSku = targetBin.currentSkus?.find((s) => s.sku === result.item.sku);
        if (existingSku) {
          existingSku.quantity += 1;
        } else {
          targetBin.currentSkus = targetBin.currentSkus || [];
          targetBin.currentSkus.push({ sku: result.item.sku, quantity: 1 });
        }
      }
      assignments.push({
        item: result.item,
        assignedBin: result.recommendedBin.binLocation,
        recommendation: result.recommendedBin,
      });
    } else {
      assignments.push({
        item: result.item,
        assignedBin: null,
        recommendation: null,
      });
    }
  }

  return assignments;
}
