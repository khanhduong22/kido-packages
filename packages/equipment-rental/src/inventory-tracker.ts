import {
  GearItem,
  GearStatus,
  WarehouseLocation,
  GearCategory,
  TransferOrder,
  TransferOrderStatus,
  GearItemSchema,
  TransferOrderSchema,
} from './types';

export interface CreateTransferOrderParams {
  id?: string;
  gearIds: string[];
  sourceLocation: WarehouseLocation;
  targetLocation: WarehouseLocation;
  notes?: string;
}

export interface InventorySummary {
  locations: Record<WarehouseLocation, {
    total: number;
    byStatus: Record<GearStatus, number>;
    byCategory: Partial<Record<GearCategory, number>>;
  }>;
  totalGears: number;
  inTransitCount: number;
  maintenanceCount: number;
  damagedCount: number;
}

export class InventoryTracker {
  private gears: Map<string, GearItem> = new Map();
  private transferOrders: Map<string, TransferOrder> = new Map();

  constructor(initialGears: GearItem[] = []) {
    for (const gear of initialGears) {
      this.addGear(gear);
    }
  }

  // ==========================================================================
  // Gear CRUD & State Management
  // ==========================================================================

  public addGear(gear: GearItem): GearItem {
    const validated = GearItemSchema.parse(gear);
    if (this.gears.has(validated.id)) {
      throw new Error(`Gear item with id "${validated.id}" already exists.`);
    }
    this.gears.set(validated.id, { ...validated });
    return this.gears.get(validated.id)!;
  }

  public addGears(gears: GearItem[]): GearItem[] {
    return gears.map((g) => this.addGear(g));
  }

  public getGear(id: string): GearItem | undefined {
    const gear = this.gears.get(id);
    return gear ? { ...gear } : undefined;
  }

  public getAllGears(): GearItem[] {
    return Array.from(this.gears.values()).map((g) => ({ ...g }));
  }

  public getGearsByLocation(location: WarehouseLocation): GearItem[] {
    return this.getAllGears().filter((g) => g.warehouseLocation === location);
  }

  public getGearsByCategory(
    category: GearCategory,
    location?: WarehouseLocation
  ): GearItem[] {
    return this.getAllGears().filter(
      (g) =>
        g.category === category &&
        (!location || g.warehouseLocation === location)
    );
  }

  public getGearsByStatus(
    status: GearStatus,
    location?: WarehouseLocation
  ): GearItem[] {
    return this.getAllGears().filter(
      (g) =>
        g.status === status && (!location || g.warehouseLocation === location)
    );
  }

  /**
   * Updates the lifecycle status of a gear item with transition validation.
   */
  public updateGearStatus(
    gearId: string,
    newStatus: GearStatus,
    notes?: string
  ): GearItem {
    const gear = this.gears.get(gearId);
    if (!gear) {
      throw new Error(`Gear with id "${gearId}" not found.`);
    }

    // Validate lifecycle transitions if moving out of or into IN_TRANSIT directly
    if (newStatus === 'IN_TRANSIT' && gear.status !== 'AVAILABLE' && gear.status !== 'HOLD_PENDING') {
      throw new Error(
        `Cannot put gear "${gearId}" into IN_TRANSIT from current status "${gear.status}". Only AVAILABLE or HOLD_PENDING gears can be transferred.`
      );
    }

    gear.status = newStatus;
    if (notes) {
      gear.maintenanceNotes = notes;
    }

    return { ...gear };
  }

  // ==========================================================================
  // Inter-Branch Transfer Orders (Đà Nẵng <-> TP.HCM)
  // ==========================================================================

  /**
   * Creates a new Transfer Order to move gears between branches.
   */
  public createTransferOrder(params: CreateTransferOrderParams): TransferOrder {
    const {
      id = `TR-${Date.now()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`,
      gearIds,
      sourceLocation,
      targetLocation,
      notes,
    } = params;

    if (sourceLocation === targetLocation) {
      throw new Error(
        `Source location and target location cannot be identical (${sourceLocation}).`
      );
    }

    if (gearIds.length === 0) {
      throw new Error('Transfer order must contain at least one gear item.');
    }

    // Verify all gears exist and are currently at sourceLocation
    for (const gid of gearIds) {
      const gear = this.gears.get(gid);
      if (!gear) {
        throw new Error(`Gear "${gid}" not found in inventory.`);
      }
      if (gear.warehouseLocation !== sourceLocation) {
        throw new Error(
          `Gear "${gid}" (${gear.name}) is at location ${gear.warehouseLocation}, not source location ${sourceLocation}.`
        );
      }
      if (gear.status === 'IN_TRANSIT') {
        throw new Error(`Gear "${gid}" is already in transit.`);
      }
      if (gear.status === 'DAMAGED') {
        throw new Error(
          `Gear "${gid}" is DAMAGED. Repair or write off before transferring.`
        );
      }
    }

    const orderData = TransferOrderSchema.parse({
      id,
      gearIds,
      sourceLocation,
      targetLocation,
      status: 'PENDING',
      createdAt: new Date(),
      notes,
    });

    this.transferOrders.set(orderData.id, orderData);
    return { ...orderData };
  }

  /**
   * Dispatches the transfer order: marks order and all gears as IN_TRANSIT.
   */
  public dispatchTransfer(orderId: string): TransferOrder {
    const order = this.transferOrders.get(orderId);
    if (!order) {
      throw new Error(`Transfer order "${orderId}" not found.`);
    }
    if (order.status !== 'PENDING') {
      throw new Error(
        `Cannot dispatch order "${orderId}" with status "${order.status}". Must be PENDING.`
      );
    }

    // Update gear statuses
    for (const gid of order.gearIds) {
      const gear = this.gears.get(gid);
      if (gear) {
        gear.status = 'IN_TRANSIT';
      }
    }

    order.status = 'IN_TRANSIT';
    order.dispatchedAt = new Date();
    return { ...order };
  }

  /**
   * Receives the transfer order at the destination warehouse:
   * updates warehouseLocation to targetLocation and resets status to AVAILABLE.
   */
  public receiveTransfer(orderId: string): TransferOrder {
    const order = this.transferOrders.get(orderId);
    if (!order) {
      throw new Error(`Transfer order "${orderId}" not found.`);
    }
    if (order.status !== 'IN_TRANSIT') {
      throw new Error(
        `Cannot receive order "${orderId}" with status "${order.status}". Must be IN_TRANSIT.`
      );
    }

    // Update gears to target warehouse and AVAILABLE status
    for (const gid of order.gearIds) {
      const gear = this.gears.get(gid);
      if (gear) {
        gear.warehouseLocation = order.targetLocation;
        gear.status = 'AVAILABLE';
      }
    }

    order.status = 'COMPLETED';
    order.receivedAt = new Date();
    return { ...order };
  }

  /**
   * Cancels a pending or in-transit transfer order, returning gears to source location & AVAILABLE.
   */
  public cancelTransfer(orderId: string, reason?: string): TransferOrder {
    const order = this.transferOrders.get(orderId);
    if (!order) {
      throw new Error(`Transfer order "${orderId}" not found.`);
    }
    if (order.status === 'COMPLETED') {
      throw new Error(`Cannot cancel a COMPLETED transfer order "${orderId}".`);
    }

    // Revert gears
    for (const gid of order.gearIds) {
      const gear = this.gears.get(gid);
      if (gear) {
        gear.warehouseLocation = order.sourceLocation;
        gear.status = 'AVAILABLE';
      }
    }

    order.status = 'CANCELLED';
    if (reason) {
      order.notes = order.notes ? `${order.notes} [Cancelled: ${reason}]` : `Cancelled: ${reason}`;
    }
    return { ...order };
  }

  public getTransferOrder(id: string): TransferOrder | undefined {
    const order = this.transferOrders.get(id);
    return order ? { ...order } : undefined;
  }

  public getAllTransferOrders(): TransferOrder[] {
    return Array.from(this.transferOrders.values()).map((o) => ({ ...o }));
  }

  // ==========================================================================
  // Multi-Warehouse Inventory Summary & Analytics
  // ==========================================================================

  public getInventorySummary(): InventorySummary {
    const locations: InventorySummary['locations'] = {
      DA_NANG: {
        total: 0,
        byStatus: {
          AVAILABLE: 0,
          HOLD_PENDING: 0,
          ASSIGNED_SHOW: 0,
          IN_TRANSIT: 0,
          MAINTENANCE: 0,
          DAMAGED: 0,
        },
        byCategory: {},
      },
      HO_CHI_MINH: {
        total: 0,
        byStatus: {
          AVAILABLE: 0,
          HOLD_PENDING: 0,
          ASSIGNED_SHOW: 0,
          IN_TRANSIT: 0,
          MAINTENANCE: 0,
          DAMAGED: 0,
        },
        byCategory: {},
      },
    };

    let inTransitCount = 0;
    let maintenanceCount = 0;
    let damagedCount = 0;

    for (const gear of this.gears.values()) {
      const locSummary = locations[gear.warehouseLocation];
      locSummary.total++;
      locSummary.byStatus[gear.status]++;
      locSummary.byCategory[gear.category] =
        (locSummary.byCategory[gear.category] || 0) + 1;

      if (gear.status === 'IN_TRANSIT') inTransitCount++;
      if (gear.status === 'MAINTENANCE') maintenanceCount++;
      if (gear.status === 'DAMAGED') damagedCount++;
    }

    return {
      locations,
      totalGears: this.gears.size,
      inTransitCount,
      maintenanceCount,
      damagedCount,
    };
  }
}
