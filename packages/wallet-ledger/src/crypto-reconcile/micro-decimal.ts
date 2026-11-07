import {
  AllocatedSlot,
  CapacityInfo,
  CryptoNetwork,
  PriorityTier,
  SlotAllocationRequest,
} from './types';

export const TIER_CONFIG: Record<PriorityTier, { decimals: number; maxSlots: number }> = {
  TIER_1_2_DECIMALS: { decimals: 2, maxSlots: 99 },
  TIER_2_3_DECIMALS: { decimals: 3, maxSlots: 999 },
  TIER_3_4_DECIMALS: { decimals: 4, maxSlots: 9999 },
  TIER_4_5_DECIMALS: { decimals: 5, maxSlots: 99999 },
  TIER_5_6_DECIMALS: { decimals: 6, maxSlots: 999999 },
};

export const DEFAULT_TTL_SECONDS = 900; // 15 minutes

export class MicroDecimalAmountGenerator {
  // poolKey -> Set of active suffix strings (e.g. "0142")
  private activeSuffixes: Map<string, Set<string>> = new Map();

  // slotKey -> AllocatedSlot
  private slotMap: Map<string, AllocatedSlot> = new Map();

  // orderId -> slotKey
  private orderToSlotMap: Map<string, string> = new Map();

  // poolKey -> last sequential index for round-robin distribution
  private lastIndexMap: Map<string, number> = new Map();

  /**
   * Normalize base amount to standard string representation (e.g. 100 or "100.00" -> "100")
   */
  public normalizeBaseAmount(amount: string | number): string {
    const raw = typeof amount === 'number' ? amount.toString() : amount.trim();
    if (!raw || isNaN(Number(raw))) {
      throw new Error(`Invalid baseAmount: "${amount}" must be a valid positive number.`);
    }
    const [integerPart] = raw.split('.');
    if (BigInt(integerPart) < 0n) {
      throw new Error(`baseAmount cannot be negative: ${amount}`);
    }
    return integerPart;
  }

  /**
   * Build unique pool key for a specific base amount, currency, and network
   */
  public buildPoolKey(network: CryptoNetwork, currency: string, baseAmount: string): string {
    return `${network.toUpperCase()}:${currency.toUpperCase()}:${baseAmount}`;
  }

  /**
   * Build unique slot key
   */
  public buildSlotKey(poolKey: string, decimalSuffix: string): string {
    return `${poolKey}:${decimalSuffix}`;
  }

  /**
   * Format high-precision combined amount without floating-point inaccuracies
   */
  public combineBaseAndSuffix(
    normalizedBase: string,
    suffixNumber: number,
    decimals: number
  ): { suffixStr: string; totalAmount: string } {
    const suffixStr = suffixNumber.toString().padStart(decimals, '0');
    return {
      suffixStr,
      totalAmount: `${normalizedBase}.${suffixStr}`,
    };
  }

  /**
   * Resolve appropriate tier based on request or requested decimals
   */
  private resolveTier(requestedTier?: PriorityTier, requestedDecimals?: number): PriorityTier {
    if (requestedTier) return requestedTier;
    if (requestedDecimals) {
      switch (requestedDecimals) {
        case 2:
          return 'TIER_1_2_DECIMALS';
        case 3:
          return 'TIER_2_3_DECIMALS';
        case 4:
          return 'TIER_3_4_DECIMALS';
        case 5:
          return 'TIER_4_5_DECIMALS';
        case 6:
          return 'TIER_5_6_DECIMALS';
        default:
          if (requestedDecimals > 6) return 'TIER_5_6_DECIMALS';
          return 'TIER_3_4_DECIMALS';
      }
    }
    // Default to TIER_3_4_DECIMALS (up to 9,999 slots per base amount), auto-escalating if full
    return 'TIER_3_4_DECIMALS';
  }

  /**
   * Allocate a non-colliding micro-decimal slot for a deposit order.
   * Auto-escalates tiers if current tier is saturated.
   */
  public allocate(req: SlotAllocationRequest): AllocatedSlot {
    const now = Date.now();
    this.cleanupExpired(now);

    if (this.orderToSlotMap.has(req.orderId)) {
      const existingSlotKey = this.orderToSlotMap.get(req.orderId)!;
      const existing = this.slotMap.get(existingSlotKey);
      if (existing && existing.status === 'ACTIVE' && existing.expiresAt > now) {
        return existing;
      }
    }

    const baseStr = this.normalizeBaseAmount(req.baseAmount);
    const poolKey = this.buildPoolKey(req.network, req.currency, baseStr);
    const ttlSeconds = req.ttlSeconds && req.ttlSeconds > 0 ? req.ttlSeconds : DEFAULT_TTL_SECONDS;
    const expiresAt = now + ttlSeconds * 1000;

    let tier = this.resolveTier(req.priorityTier, req.decimals);
    let activeSet = this.activeSuffixes.get(poolKey);
    if (!activeSet) {
      activeSet = new Set<string>();
      this.activeSuffixes.set(poolKey, activeSet);
    }

    // Attempt allocation; if tier is saturated, escalate up to TIER_5_6_DECIMALS (999,999 slots)
    const tierList: PriorityTier[] = [
      'TIER_1_2_DECIMALS',
      'TIER_2_3_DECIMALS',
      'TIER_3_4_DECIMALS',
      'TIER_4_5_DECIMALS',
      'TIER_5_6_DECIMALS',
    ];
    let tierIndex = tierList.indexOf(tier);

    let allocatedSuffixNum: number | null = null;
    let allocatedDecimals = TIER_CONFIG[tier].decimals;

    while (tierIndex < tierList.length) {
      const currentTier = tierList[tierIndex];
      const { decimals, maxSlots } = TIER_CONFIG[currentTier];

      // Sequential scan starting from last index with pseudo-random offset
      let startIdx = (this.lastIndexMap.get(poolKey) || 0) + 1;
      if (startIdx > maxSlots) startIdx = 1;

      for (let attempt = 0; attempt < maxSlots; attempt++) {
        const candidateNum = ((startIdx + attempt - 1) % maxSlots) + 1;
        const candidateSuffix = candidateNum.toString().padStart(decimals, '0');

        if (!activeSet.has(candidateSuffix)) {
          allocatedSuffixNum = candidateNum;
          allocatedDecimals = decimals;
          tier = currentTier;
          this.lastIndexMap.set(poolKey, candidateNum);
          break;
        }
      }

      if (allocatedSuffixNum !== null) {
        break;
      }

      // Current tier saturated, try next tier
      tierIndex++;
    }

    if (allocatedSuffixNum === null) {
      throw new Error(
        `MicroDecimalAmountGenerator capacity exhausted for pool ${poolKey} across all priority tiers.`
      );
    }

    const { suffixStr, totalAmount } = this.combineBaseAndSuffix(
      baseStr,
      allocatedSuffixNum,
      allocatedDecimals
    );
    const slotKey = this.buildSlotKey(poolKey, suffixStr);

    activeSet.add(suffixStr);

    const slot: AllocatedSlot = {
      slotKey,
      orderId: req.orderId,
      baseAmount: baseStr,
      decimalSuffix: `0.${suffixStr}`,
      totalExpectedAmount: totalAmount,
      currency: req.currency.toUpperCase(),
      network: req.network,
      decimals: allocatedDecimals,
      allocatedAt: now,
      expiresAt,
      status: 'ACTIVE',
      metadata: req.metadata,
    };

    this.slotMap.set(slotKey, slot);
    this.orderToSlotMap.set(req.orderId, slotKey);

    return slot;
  }

  /**
   * Release an allocated slot back to pool (e.g. order cancelled or expired)
   */
  public release(orderIdOrKey: string): boolean {
    let slotKey = orderIdOrKey;
    if (this.orderToSlotMap.has(orderIdOrKey)) {
      slotKey = this.orderToSlotMap.get(orderIdOrKey)!;
    }

    const slot = this.slotMap.get(slotKey);
    if (!slot) return false;

    slot.status = 'RELEASED';
    this.orderToSlotMap.delete(slot.orderId);

    const poolKey = this.buildPoolKey(slot.network, slot.currency, slot.baseAmount);
    const rawSuffix = slot.decimalSuffix.replace('0.', '');
    const activeSet = this.activeSuffixes.get(poolKey);
    if (activeSet) {
      activeSet.delete(rawSuffix);
      if (activeSet.size === 0) {
        this.activeSuffixes.delete(poolKey);
      }
    }

    this.slotMap.delete(slotKey);
    return true;
  }

  /**
   * Mark slot as successfully matched
   */
  public markMatched(orderIdOrKey: string): boolean {
    let slotKey = orderIdOrKey;
    if (this.orderToSlotMap.has(orderIdOrKey)) {
      slotKey = this.orderToSlotMap.get(orderIdOrKey)!;
    }

    const slot = this.slotMap.get(slotKey);
    if (!slot) return false;

    slot.status = 'MATCHED';
    this.orderToSlotMap.delete(slot.orderId);

    const poolKey = this.buildPoolKey(slot.network, slot.currency, slot.baseAmount);
    const rawSuffix = slot.decimalSuffix.replace('0.', '');
    const activeSet = this.activeSuffixes.get(poolKey);
    if (activeSet) {
      activeSet.delete(rawSuffix);
      if (activeSet.size === 0) {
        this.activeSuffixes.delete(poolKey);
      }
    }

    this.slotMap.delete(slotKey);
    return true;
  }

  /**
   * Get slot by order ID
   */
  public getSlotByOrderId(orderId: string): AllocatedSlot | undefined {
    const slotKey = this.orderToSlotMap.get(orderId);
    if (!slotKey) return undefined;
    return this.slotMap.get(slotKey);
  }

  /**
   * Get slot by full slot key
   */
  public getSlotByKey(slotKey: string): AllocatedSlot | undefined {
    return this.slotMap.get(slotKey);
  }

  /**
   * Garbage collect expired slots
   */
  public cleanupExpired(now: number = Date.now()): number {
    let expiredCount = 0;
    for (const [slotKey, slot] of this.slotMap.entries()) {
      if (slot.status === 'ACTIVE' && slot.expiresAt <= now) {
        slot.status = 'EXPIRED';
        this.orderToSlotMap.delete(slot.orderId);

        const poolKey = this.buildPoolKey(slot.network, slot.currency, slot.baseAmount);
        const rawSuffix = slot.decimalSuffix.replace('0.', '');
        const activeSet = this.activeSuffixes.get(poolKey);
        if (activeSet) {
          activeSet.delete(rawSuffix);
          if (activeSet.size === 0) {
            this.activeSuffixes.delete(poolKey);
          }
        }

        this.slotMap.delete(slotKey);
        expiredCount++;
      }
    }
    return expiredCount;
  }

  /**
   * Total number of currently active slots
   */
  public getActiveCount(): number {
    return this.slotMap.size;
  }

  /**
   * Inspect capacity info for a specific pool
   */
  public getCapacityInfo(
    network: CryptoNetwork,
    currency: string,
    baseAmount: string | number,
    tier: PriorityTier = 'TIER_5_6_DECIMALS'
  ): CapacityInfo {
    const baseStr = this.normalizeBaseAmount(baseAmount);
    const poolKey = this.buildPoolKey(network, currency, baseStr);
    const activeSet = this.activeSuffixes.get(poolKey);
    const activeSlots = activeSet ? activeSet.size : 0;
    const { decimals, maxSlots } = TIER_CONFIG[tier];

    return {
      network,
      currency: currency.toUpperCase(),
      baseAmount: baseStr,
      tier,
      decimals,
      totalSlots: maxSlots,
      activeSlots,
      availableSlots: Math.max(0, maxSlots - activeSlots),
    };
  }

  /**
   * Clear all internal state (for testing)
   */
  public clear(): void {
    this.activeSuffixes.clear();
    this.slotMap.clear();
    this.orderToSlotMap.clear();
    this.lastIndexMap.clear();
  }
}
