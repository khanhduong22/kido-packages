export type StockActionType = 'RESERVE' | 'DEDUCT_PACK' | 'RESTORE_CANCEL';

export interface StockLedgerEntry {
  id: string;
  sequence: number;
  ledgerKey: string;
  tenantId: string;
  orderId: string;
  sku: string;
  actionType: StockActionType;
  quantity: number;
  previousStock: number;
  newStock: number;
  reason: string;
  createdAt: string;
}

export interface ChannelSyncTarget {
  id: string;
  name: string;
  platform: string;
  shopId?: string;
}

export interface SyncOutboxEntry {
  id: string;
  timestamp: string;
  mode: 'SANDBOX_DRY_RUN' | 'LIVE';
  action: 'INVENTORY_PUSH' | 'MULTI_CHANNEL_STOCK_SYNC';
  sku: string;
  previousStock: number;
  newStock: number;
  affectedShops: Array<{
    platform: string;
    shopName: string;
    shopId?: string;
    payload: {
      item_sku: string;
      stock_quantity: number;
      channel_sync_mode: 'DRY_RUN' | 'LIVE';
      sync_timestamp: string;
    };
    status: 'SIMULATED_SUCCESS' | 'QUEUED';
  }>;
  reason: string;
}

export interface StockMovementRequest {
  tenantId?: string;
  orderId: string;
  sku: string;
  actionType: StockActionType;
  quantity: number;
  reason?: string;
  syncChannels?: ChannelSyncTarget[];
}

export interface StockMovementResult {
  deduplicated: boolean;
  entry: StockLedgerEntry;
  updatedStock: number;
  outboxEntry?: SyncOutboxEntry;
}

export class IdempotentStockLedger {
  private ledgerStore = new Map<string, StockLedgerEntry>();
  private syncOutboxLogs: SyncOutboxEntry[] = [];
  private defaultChannels: ChannelSyncTarget[] = [];
  private sequenceCounter = 0;

  constructor(defaultChannels: ChannelSyncTarget[] = []) {
    this.defaultChannels = defaultChannels;
  }

  /**
   * Generates a deterministic composite ledger key to enforce idempotency.
   */
  public static buildLedgerKey(tenantId: string, orderId: string, sku: string, actionType: StockActionType): string {
    return `${tenantId}:${orderId}:${sku}:${actionType}`;
  }

  /**
   * Retrieves all ledger entries, sorted newest first.
   */
  public getEntries(): StockLedgerEntry[] {
    return Array.from(this.ledgerStore.values()).sort(
      (a, b) => b.sequence - a.sequence
    );
  }

  /**
   * Retrieves all outbox logs, newest first.
   */
  public getOutboxLogs(): SyncOutboxEntry[] {
    return [...this.syncOutboxLogs].reverse();
  }

  /**
   * Clears in-memory ledger and outbox logs (useful in tests).
   */
  public clear(): void {
    this.ledgerStore.clear();
    this.syncOutboxLogs.length = 0;
    this.sequenceCounter = 0;
  }

  /**
   * Executes an idempotent stock movement:
   * Uses unique ledgerKey: `${tenantId}:${orderId}:${sku}:${actionType}`
   * If already processed, returns { deduplicated: true } and never alters stock twice.
   */
  public execute(
    req: StockMovementRequest,
    productStockGetter: (sku: string) => number,
    productStockUpdater: (sku: string, newStock: number) => void
  ): StockMovementResult {
    const tenantId = req.tenantId || 'default';
    const ledgerKey = IdempotentStockLedger.buildLedgerKey(tenantId, req.orderId, req.sku, req.actionType);

    // Idempotency check: guard against duplicate webhooks or rapid double-clicks
    if (this.ledgerStore.has(ledgerKey)) {
      const existing = this.ledgerStore.get(ledgerKey)!;
      const currentStock = productStockGetter(req.sku);
      return {
        deduplicated: true,
        entry: existing,
        updatedStock: currentStock,
      };
    }

    const previousStock = productStockGetter(req.sku);
    let newStock = previousStock;

    if (req.actionType === 'DEDUCT_PACK') {
      newStock = Math.max(0, previousStock - req.quantity);
    } else if (req.actionType === 'RESTORE_CANCEL') {
      newStock = previousStock + req.quantity;
    } else if (req.actionType === 'RESERVE') {
      // Soft reservation maintains physical balance while recording hold
      newStock = previousStock;
    }

    // Mutate state via provided updater callback
    productStockUpdater(req.sku, newStock);

    const timestamp = new Date().toISOString();
    const entry: StockLedgerEntry = {
      id: `ledger-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      sequence: ++this.sequenceCounter,
      ledgerKey,
      tenantId,
      orderId: req.orderId,
      sku: req.sku,
      actionType: req.actionType,
      quantity: req.quantity,
      previousStock,
      newStock,
      reason: req.reason || `Stock ${req.actionType} for order ${req.orderId}`,
      createdAt: timestamp,
    };

    this.ledgerStore.set(ledgerKey, entry);

    // Build multi-channel sync outbox event
    const channels = req.syncChannels || this.defaultChannels;
    let outboxEntry: SyncOutboxEntry | undefined;

    if (channels.length > 0) {
      outboxEntry = {
        id: `outbox-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
        timestamp,
        mode: 'SANDBOX_DRY_RUN',
        action: 'MULTI_CHANNEL_STOCK_SYNC',
        sku: req.sku,
        previousStock,
        newStock,
        affectedShops: channels.map((shop) => ({
          platform: shop.platform,
          shopName: shop.name,
          shopId: shop.shopId,
          payload: {
            item_sku: req.sku,
            stock_quantity: newStock,
            channel_sync_mode: 'DRY_RUN' as const,
            sync_timestamp: timestamp,
          },
          status: 'SIMULATED_SUCCESS' as const,
        })),
        reason: req.reason || `Idempotent ${req.actionType} for order ${req.orderId}`,
      };

      this.syncOutboxLogs.push(outboxEntry);
    }

    return {
      deduplicated: false,
      entry,
      updatedStock: newStock,
      outboxEntry,
    };
  }
}
