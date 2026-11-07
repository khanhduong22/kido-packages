import {
  ConsumableItem,
  ConsumableItemSchema,
  ConsumableUsageResult,
} from './types';

export interface RecordSessionResult {
  paperResult: ConsumableUsageResult;
  ribbonResult?: ConsumableUsageResult;
  totalPrints: number;
  hasAnyWarning: boolean;
  warnings: string[];
}

export class ConsumablesMeter {
  private consumables: Map<string, ConsumableItem> = new Map();

  constructor(initialItems: ConsumableItem[] = []) {
    for (const item of initialItems) {
      this.registerConsumable(item);
    }
  }

  // ==========================================================================
  // Registration & Retrieval
  // ==========================================================================

  public registerConsumable(item: ConsumableItem): ConsumableItem {
    const validated = ConsumableItemSchema.parse(item);
    if (this.consumables.has(validated.id)) {
      throw new Error(`Consumable item with id "${validated.id}" already exists.`);
    }
    this.consumables.set(validated.id, { ...validated });
    return this.consumables.get(validated.id)!;
  }

  public getConsumable(id: string): ConsumableItem | undefined {
    const item = this.consumables.get(id);
    return item ? { ...item } : undefined;
  }

  public getAllConsumables(): ConsumableItem[] {
    return Array.from(this.consumables.values()).map((c) => ({ ...c }));
  }

  public getConsumablesByGearId(gearId: string): ConsumableItem[] {
    return this.getAllConsumables().filter((c) => c.assignedGearId === gearId);
  }

  // ==========================================================================
  // Factory Helpers for Common Event Hardware
  // ==========================================================================

  /**
   * Factory helper for standard DNP DS620 Dye-Sublimation Photo Paper Roll (400 prints 4x6 / 10x15cm).
   */
  public createDnpPaperRoll(params: {
    id: string;
    name?: string;
    totalPrints?: number;
    assignedGearId?: string;
    warningThresholdPercent?: number;
  }): ConsumableItem {
    return this.registerConsumable({
      id: params.id,
      name: params.name || 'Cuộn giấy in ảnh DNP DS620 (4x6 inch / 10x15cm)',
      type: 'DNP_PAPER_ROLL',
      totalCapacity: params.totalPrints || 400,
      remainingCapacity: params.totalPrints || 400,
      unit: 'prints',
      assignedGearId: params.assignedGearId,
      warningThresholdPercent: params.warningThresholdPercent ?? 20,
    });
  }

  /**
   * Factory helper for DNP DS620 Dye-Sublimation Ink Ribbon (matches paper roll capacity).
   */
  public createInkRibbon(params: {
    id: string;
    name?: string;
    totalPrints?: number;
    assignedGearId?: string;
    warningThresholdPercent?: number;
  }): ConsumableItem {
    return this.registerConsumable({
      id: params.id,
      name: params.name || 'Cuộn ruy băng mực DNP DS620 Ribbon',
      type: 'INK_RIBBON',
      totalCapacity: params.totalPrints || 400,
      remainingCapacity: params.totalPrints || 400,
      unit: 'prints',
      assignedGearId: params.assignedGearId,
      warningThresholdPercent: params.warningThresholdPercent ?? 20,
    });
  }

  /**
   * Factory helper for Camera / Video Battery (e.g. Sony NP-FZ100 or V-Mount).
   */
  public createCameraBattery(params: {
    id: string;
    name?: string;
    totalCapacity?: number;
    unit?: string;
    assignedGearId?: string;
    warningThresholdPercent?: number;
  }): ConsumableItem {
    return this.registerConsumable({
      id: params.id,
      name: params.name || 'Pin sạc máy quay Sony NP-FZ100',
      type: 'CAMERA_BATTERY',
      totalCapacity: params.totalCapacity || 100, // percentage or shots
      remainingCapacity: params.totalCapacity || 100,
      unit: params.unit || '%',
      assignedGearId: params.assignedGearId,
      warningThresholdPercent: params.warningThresholdPercent ?? 20,
    });
  }

  // ==========================================================================
  // Consumption & Metering Logic
  // ==========================================================================

  /**
   * Records usage for a specific consumable item and checks low-stock thresholds.
   *
   * @param consumableId ID of the consumable item
   * @param usedUnits Number of units consumed during the show / rental
   * @param eventName Optional name or ID of the show for logging
   * @returns ConsumableUsageResult with updated capacities and warning alerts
   */
  public recordUsage(
    consumableId: string,
    usedUnits: number,
    eventName?: string
  ): ConsumableUsageResult {
    if (usedUnits < 0) {
      throw new Error(`Usage units cannot be negative (got ${usedUnits}).`);
    }

    const item = this.consumables.get(consumableId);
    if (!item) {
      throw new Error(`Consumable item "${consumableId}" not found.`);
    }

    const newRemaining = Math.max(0, item.remainingCapacity - usedUnits);
    item.remainingCapacity = newRemaining;

    const remainingPercentage = (newRemaining / item.totalCapacity) * 100;
    const isLowWarning = remainingPercentage <= item.warningThresholdPercent;

    let warningMessage: string | undefined;
    if (isLowWarning) {
      const eventPrefix = eventName ? `Sau show "${eventName}": ` : '';
      warningMessage =
        `${eventPrefix}CẢNH BÁO VẬT TƯ: [${item.name}] chỉ còn ${newRemaining}/${item.totalCapacity} ${item.unit} ` +
        `(${remainingPercentage.toFixed(1)}%). Đã chạm ngưỡng báo động ${item.warningThresholdPercent}%! ` +
        `Cần thay mới / nạp cuộn mới trước show tiếp theo.`;
    }

    return {
      updatedItem: { ...item },
      usedUnits,
      remainingPercentage,
      isLowWarning,
      warningMessage,
    };
  }

  /**
   * Convenient helper to record photobooth show prints for both Paper Roll and Ink Ribbon simultaneously.
   */
  public recordPhotoboothSession(params: {
    paperId: string;
    ribbonId?: string;
    photosPrinted: number;
    testPrints?: number;
    eventName?: string;
  }): RecordSessionResult {
    const { paperId, ribbonId, photosPrinted, testPrints = 0, eventName } = params;
    const totalPrints = photosPrinted + testPrints;

    const paperResult = this.recordUsage(paperId, totalPrints, eventName);
    let ribbonResult: ConsumableUsageResult | undefined;
    const warnings: string[] = [];

    if (paperResult.isLowWarning && paperResult.warningMessage) {
      warnings.push(paperResult.warningMessage);
    }

    if (ribbonId) {
      ribbonResult = this.recordUsage(ribbonId, totalPrints, eventName);
      if (ribbonResult.isLowWarning && ribbonResult.warningMessage) {
        warnings.push(ribbonResult.warningMessage);
      }
    }

    return {
      paperResult,
      ribbonResult,
      totalPrints,
      hasAnyWarning: warnings.length > 0,
      warnings,
    };
  }

  /**
   * Reloads / replaces a fresh roll or resets battery to full capacity.
   */
  public reloadConsumable(
    id: string,
    newTotalCapacity?: number
  ): ConsumableItem {
    const item = this.consumables.get(id);
    if (!item) {
      throw new Error(`Consumable item "${id}" not found.`);
    }

    if (newTotalCapacity !== undefined) {
      if (newTotalCapacity <= 0) {
        throw new Error('New total capacity must be greater than zero.');
      }
      item.totalCapacity = newTotalCapacity;
    }
    item.remainingCapacity = item.totalCapacity;

    return { ...item };
  }

  /**
   * Calculates how many upcoming shows this consumable can support given an average consumption per show.
   */
  public calculateShowsRemaining(
    consumableId: string,
    averageConsumptionPerShow: number
  ): number {
    if (averageConsumptionPerShow <= 0) {
      throw new Error('Average consumption per show must be greater than zero.');
    }

    const item = this.consumables.get(consumableId);
    if (!item) {
      throw new Error(`Consumable item "${consumableId}" not found.`);
    }

    return Math.floor(item.remainingCapacity / averageConsumptionPerShow);
  }
}
