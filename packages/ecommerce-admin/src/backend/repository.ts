import fs from 'node:fs';
import path from 'node:path';
import type {
  CreateOrderInput,
  EcommerceMetrics,
  OrderFilterParams,
  OrderRecord,
  OrderStatus,
} from '../types';

export interface SqliteOrderRepositoryOptions {
  dbPath?: string;
  db?: any;
  exchangeRate?: number;
}

export interface IEcommerceOrderRepository {
  init(): void | Promise<void>;
  createOrder(input: CreateOrderInput): OrderRecord;
  getOrderById(id: string): OrderRecord | null;
  listOrders(filters?: OrderFilterParams): {
    records: OrderRecord[];
    total: number;
    limit: number;
    offset: number;
  };
  updateOrderStatus(
    id: string,
    status: OrderStatus | string,
    notes?: string,
    paymentRef?: string
  ): OrderRecord | null;
  updatePaymentInfo(
    id: string,
    paymentMethod: string,
    paymentRef?: string,
    status?: OrderStatus | string
  ): OrderRecord | null;
  deleteOrder(id: string): boolean;
  getMetrics(exchangeRate?: number): EcommerceMetrics;
  close(): void;
}

export class SqliteOrderRepository implements IEcommerceOrderRepository {
  private db: any;
  private exchangeRate: number;
  private initialized = false;

  constructor(optionsOrPath?: string | SqliteOrderRepositoryOptions) {
    let resolvedOptions: SqliteOrderRepositoryOptions = {};

    if (typeof optionsOrPath === 'string') {
      resolvedOptions = { dbPath: optionsOrPath };
    } else if (optionsOrPath) {
      resolvedOptions = optionsOrPath;
    }

    this.exchangeRate = resolvedOptions.exchangeRate || 25400;

    if (resolvedOptions.db) {
      this.db = resolvedOptions.db;
    } else {
      const dbPath =
        resolvedOptions.dbPath ||
        process.env.DATABASE_PATH ||
        ':memory:';

      if (dbPath !== ':memory:') {
        const dir = path.dirname(dbPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
      }

      // Load Bun's native SQLite Database engine
      try {
        const { Database } = require('bun:sqlite');
        this.db = new Database(dbPath);
      } catch (err) {
        throw new Error(
          `Failed to initialize bun:sqlite Database at '${dbPath}'. Ensure you are running in Bun runtime or provide a custom db instance. Error: ${String(
            err
          )}`
        );
      }
    }

    this.init();
  }

  public init(): void {
    if (this.initialized) return;

    // Enable WAL mode & optimal pragmas for high-throughput concurrency
    try {
      this.db.run('PRAGMA journal_mode = WAL;');
      this.db.run('PRAGMA synchronous = NORMAL;');
      this.db.run('PRAGMA foreign_keys = ON;');
    } catch {
      // Memory DB or already configured
    }

    // Auto-create orders table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        tier_id TEXT NOT NULL,
        tier_name TEXT,
        quantity INTEGER NOT NULL DEFAULT 1,
        unit_price REAL NOT NULL DEFAULT 0,
        subtotal REAL NOT NULL DEFAULT 0,
        shipping_fee REAL NOT NULL DEFAULT 0,
        discount_amount REAL NOT NULL DEFAULT 0,
        total_amount REAL NOT NULL DEFAULT 0,
        currency TEXT NOT NULL DEFAULT 'USD',
        status TEXT NOT NULL DEFAULT 'PENDING_PAYMENT',
        payment_method TEXT NOT NULL DEFAULT 'card',
        payment_ref TEXT,
        notes TEXT,
        slots_json TEXT,
        customer_name TEXT NOT NULL,
        customer_email TEXT NOT NULL,
        customer_phone TEXT,
        shipping_address TEXT,
        city TEXT,
        state TEXT,
        zip TEXT,
        metadata_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    // Safe schema additions for preexisting tables
    const safeAddColumns = [
      "ALTER TABLE orders ADD COLUMN tier_name TEXT;",
      "ALTER TABLE orders ADD COLUMN discount_amount REAL NOT NULL DEFAULT 0;",
      "ALTER TABLE orders ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'card';",
      "ALTER TABLE orders ADD COLUMN payment_ref TEXT;",
      "ALTER TABLE orders ADD COLUMN notes TEXT;",
      "ALTER TABLE orders ADD COLUMN metadata_json TEXT;",
    ];

    for (const ddl of safeAddColumns) {
      try {
        this.db.run(ddl);
      } catch {
        // Column already exists
      }
    }

    // Indexes for fast querying & filtering
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_orders_customer_email ON orders(customer_email);`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_orders_customer_phone ON orders(customer_phone);`);

    this.initialized = true;
  }

  public createOrder(input: CreateOrderInput): OrderRecord {
    this.init();

    const orderId =
      input.id ||
      `ord_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const nowIso = new Date().toISOString();

    const quantity = input.quantity ?? 1;
    const unitPrice = input.unitPrice ?? 0;
    const subtotal = input.subtotal ?? Math.round(quantity * unitPrice * 100) / 100;
    const shippingFee = input.shippingFee ?? 0;
    const discountAmount = input.discountAmount ?? 0;
    const totalAmount =
      input.totalAmount ??
      Math.max(0, Math.round((subtotal + shippingFee - discountAmount) * 100) / 100);

    const slotsJson = input.slots ? JSON.stringify(input.slots) : null;
    const metadataJson = input.metadata ? JSON.stringify(input.metadata) : null;

    const insertStmt = this.db.query(`
      INSERT INTO orders (
        id, tier_id, tier_name, quantity, unit_price, subtotal, shipping_fee, discount_amount, total_amount,
        currency, status, payment_method, payment_ref, notes, slots_json, customer_name, customer_email,
        customer_phone, shipping_address, city, state, zip, metadata_json, created_at, updated_at
      ) VALUES (
        $id, $tier_id, $tier_name, $quantity, $unit_price, $subtotal, $shipping_fee, $discount_amount, $total_amount,
        $currency, $status, $payment_method, $payment_ref, $notes, $slots_json, $customer_name, $customer_email,
        $customer_phone, $shipping_address, $city, $state, $zip, $metadata_json, $created_at, $updated_at
      )
    `);

    insertStmt.run({
      $id: orderId,
      $tier_id: input.tierId,
      $tier_name: input.tierName || null,
      $quantity: quantity,
      $unit_price: unitPrice,
      $subtotal: subtotal,
      $shipping_fee: shippingFee,
      $discount_amount: discountAmount,
      $total_amount: totalAmount,
      $currency: input.currency || 'USD',
      $status: input.status || 'PENDING_PAYMENT',
      $payment_method: input.paymentMethod || 'card',
      $payment_ref: input.paymentRef || null,
      $notes: input.notes || null,
      $slots_json: slotsJson,
      $customer_name: input.customer.name,
      $customer_email: input.customer.email,
      $customer_phone: input.customer.phone || null,
      $shipping_address: input.customer.address || null,
      $city: input.customer.city || null,
      $state: input.customer.state || null,
      $zip: input.customer.zip || null,
      $metadata_json: metadataJson,
      $created_at: nowIso,
      $updated_at: nowIso,
    });

    const record = this.getOrderById(orderId);
    if (!record) {
      throw new Error(`Failed to retrieve newly created order '${orderId}'`);
    }

    return record;
  }

  public getOrderById(id: string): OrderRecord | null {
    this.init();
    const query = this.db.query(`SELECT * FROM orders WHERE id = $id`);
    const record = query.get({ $id: id });
    return record || null;
  }

  public listOrders(filters: OrderFilterParams = {}): {
    records: OrderRecord[];
    total: number;
    limit: number;
    offset: number;
  } {
    this.init();

    const limit =
      filters.limit && filters.limit > 0 ? Math.min(filters.limit, 100) : 50;
    const offset =
      filters.offset && filters.offset >= 0
        ? filters.offset
        : filters.page && filters.page > 0
        ? (filters.page - 1) * limit
        : 0;

    const conditions: string[] = [];
    const params: Record<string, any> = {};

    if (filters.status && filters.status !== 'ALL' && filters.status.trim() !== '') {
      conditions.push(`status = $status`);
      params.$status = filters.status.trim();
    }

    if (filters.paymentMethod && filters.paymentMethod !== 'ALL') {
      conditions.push(`payment_method LIKE $paymentMethod`);
      params.$paymentMethod = `%${filters.paymentMethod.trim()}%`;
    }

    if (filters.search && filters.search.trim().length > 0) {
      const term = `%${filters.search.trim()}%`;
      conditions.push(
        `(id LIKE $term OR customer_name LIKE $term OR customer_email LIKE $term OR customer_phone LIKE $term OR payment_ref LIKE $term)`
      );
      params.$term = term;
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countQuery = this.db.query(
      `SELECT COUNT(*) as count FROM orders ${whereClause}`
    );
    const totalCount = countQuery.get(params)?.count || 0;

    const sortCol = filters.sortBy === 'total_amount' ? 'total_amount' : 'created_at';
    const sortDir = filters.sortOrder === 'asc' ? 'ASC' : 'DESC';

    const ordersQuery = this.db.query(
      `SELECT * FROM orders ${whereClause} ORDER BY ${sortCol} ${sortDir} LIMIT $limit OFFSET $offset`
    );
    const records = ordersQuery.all({
      ...params,
      $limit: limit,
      $offset: offset,
    });

    return {
      records,
      total: totalCount,
      limit,
      offset,
    };
  }

  public updateOrderStatus(
    id: string,
    status: OrderStatus | string,
    notes?: string,
    paymentRef?: string
  ): OrderRecord | null {
    this.init();
    const nowIso = new Date().toISOString();

    const updateStmt = this.db.query(`
      UPDATE orders
      SET status = $status,
          notes = COALESCE($notes, notes),
          payment_ref = COALESCE($payment_ref, payment_ref),
          updated_at = $updated_at
      WHERE id = $id
    `);

    updateStmt.run({
      $status: status,
      $notes: notes || null,
      $payment_ref: paymentRef || null,
      $updated_at: nowIso,
      $id: id,
    });

    return this.getOrderById(id);
  }

  public updatePaymentInfo(
    id: string,
    paymentMethod: string,
    paymentRef?: string,
    status?: OrderStatus | string
  ): OrderRecord | null {
    this.init();
    const nowIso = new Date().toISOString();

    const updateStmt = this.db.query(`
      UPDATE orders
      SET payment_method = $payment_method,
          payment_ref = COALESCE($payment_ref, payment_ref),
          status = COALESCE($status, status),
          updated_at = $updated_at
      WHERE id = $id
    `);

    updateStmt.run({
      $payment_method: paymentMethod,
      $payment_ref: paymentRef || null,
      $status: status || null,
      $updated_at: nowIso,
      $id: id,
    });

    return this.getOrderById(id);
  }

  public deleteOrder(id: string): boolean {
    this.init();
    const deleteStmt = this.db.query(`DELETE FROM orders WHERE id = $id`);
    const result = deleteStmt.run({ $id: id });
    return result.changes > 0;
  }

  public getMetrics(customExchangeRate?: number): EcommerceMetrics {
    this.init();
    const rate = customExchangeRate || this.exchangeRate;

    const totalOrdersRow =
      this.db.query(`SELECT COUNT(*) as count FROM orders`).get() || { count: 0 };
    const totalOrders = totalOrdersRow.count;

    const paidRow =
      this.db
        .query(
          `SELECT COUNT(*) as count, COALESCE(SUM(total_amount), 0) as revenue, COALESCE(SUM(quantity), 0) as units 
           FROM orders 
           WHERE status = 'PAID'`
        )
        .get() || { count: 0, revenue: 0, units: 0 };

    const paidOrders = paidRow.count;
    const totalRevenueUsd = Math.round(paidRow.revenue * 100) / 100;
    const totalRevenueVnd = Math.round(totalRevenueUsd * rate);
    const unitsSold = paidRow.units;

    const pendingRow =
      this.db
        .query(
          `SELECT COUNT(*) as count FROM orders WHERE status = 'PENDING_PAYMENT' OR status = 'PENDING'`
        )
        .get() || { count: 0 };
    const pendingOrders = pendingRow.count;

    const shippedRow =
      this.db
        .query(`SELECT COUNT(*) as count FROM orders WHERE status = 'SHIPPED'`)
        .get() || { count: 0 };
    const shippedOrders = shippedRow.count;

    const deliveredRow =
      this.db
        .query(`SELECT COUNT(*) as count FROM orders WHERE status = 'DELIVERED'`)
        .get() || { count: 0 };
    const deliveredOrders = deliveredRow.count;

    const cancelledRow =
      this.db
        .query(`SELECT COUNT(*) as count FROM orders WHERE status = 'CANCELLED'`)
        .get() || { count: 0 };
    const cancelledOrders = cancelledRow.count;

    const conversionRate =
      totalOrders > 0
        ? Math.round((paidOrders / totalOrders) * 10000) / 100
        : 0;

    const averageOrderValueUsd =
      paidOrders > 0 ? Math.round((totalRevenueUsd / paidOrders) * 100) / 100 : 0;
    const averageOrderValueVnd = Math.round(averageOrderValueUsd * rate);

    return {
      totalRevenueUsd,
      totalRevenueVnd,
      totalOrders,
      paidOrders,
      pendingOrders,
      shippedOrders,
      deliveredOrders,
      cancelledOrders,
      unitsSold,
      conversionRate,
      averageOrderValueUsd,
      averageOrderValueVnd,
    };
  }

  public close(): void {
    if (this.db) {
      try {
        this.db.close();
      } catch {
        // Ignore
      }
    }
  }
}
