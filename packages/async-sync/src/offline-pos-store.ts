import { OutboxQueue } from './outbox-queue';
import {
  FinancialLedgerEntry,
  POSOrder,
  POSOrderItem,
  POSPaymentMethod,
  POSPaymentStatus,
  TempStockReservation,
} from './types';
import { uuidv7 } from './uuidv7';

export interface POSProduct {
  id: string;
  name: string;
  price: number;
  stock: number;
  sku?: string;
}

export interface CreatePOSOrderItemInput {
  productId: string;
  quantity: number;
  discount?: number;
}

export interface CreatePOSOrderInput {
  items: CreatePOSOrderItemInput[];
  cashierId?: string;
  notes?: string;
  taxRate?: number; // e.g. 0.08
  discountAmount?: number;
  paymentMethod?: POSPaymentMethod;
  bankAccount?: {
    bankCode: string;
    accountNumber: string;
    accountName: string;
  };
}

export class OfflinePOSStore {
  private queue: OutboxQueue;
  private products = new Map<string, POSProduct>();
  private orders = new Map<string, POSOrder>();
  private stockReservations: TempStockReservation[] = [];
  private ledgerEntries: FinancialLedgerEntry[] = [];
  private storeConfig = {
    name: 'KT SMART RETAIL STORE',
    address: '123 Nguyen Hue, Ben Nghe, District 1, HCMC',
    hotline: '1900 6868',
    defaultBankCode: '970422', // MBBank
    defaultAccountNumber: '0987654321',
    defaultAccountName: 'KT RETAIL CO LTD',
  };

  constructor(queue?: OutboxQueue) {
    this.queue = queue ?? new OutboxQueue();
  }

  getQueue(): OutboxQueue {
    return this.queue;
  }

  /**
   * Registers a product in local offline catalogue.
   */
  registerProduct(product: POSProduct): void {
    this.products.set(product.id, { ...product });
  }

  getProduct(productId: string): POSProduct | null {
    const p = this.products.get(productId);
    return p ? { ...p } : null;
  }

  /**
   * Computes available stock considering active offline reservations.
   */
  getAvailableStock(productId: string): number {
    const product = this.products.get(productId);
    if (!product) return 0;

    const reserved = this.stockReservations
      .filter((r) => r.productId === productId)
      .reduce((sum, r) => sum + r.quantity, 0);

    return Math.max(0, product.stock - reserved);
  }

  /**
   * Creates an order completely offline:
   * 1. Checks available stock.
   * 2. Temporarily reserves stock.
   * 3. Calculates VAT, discounts, subtotal, and total.
   * 4. Generates standard VietQR EMVCo deposit payload.
   * 5. Generates K80 Thermal Receipt text (48 columns).
   * 6. Automatically commits to OutboxQueue for sync when reconnected.
   */
  async createOrder(input: CreatePOSOrderInput): Promise<POSOrder> {
    const orderId = uuidv7();
    const orderDate = new Date();
    const dateStr = orderDate.toISOString().slice(0, 10).replace(/-/g, '');
    const randSuffix = orderId.substring(0, 6).toUpperCase();
    const orderCode = `ORD-${dateStr}-${randSuffix}`;

    // Verify stock & calculate items
    const orderItems: POSOrderItem[] = [];
    let subtotal = 0;

    for (const itemInput of input.items) {
      const product = this.products.get(itemInput.productId);
      if (!product) {
        throw new Error(`Product not found: ${itemInput.productId}`);
      }

      const available = this.getAvailableStock(itemInput.productId);
      if (available < itemInput.quantity) {
        throw new Error(
          `Insufficient stock for "${product.name}". Available: ${available}, Requested: ${itemInput.quantity}`
        );
      }

      const unitPrice = product.price;
      const discount = itemInput.discount ?? 0;
      const lineTotal = Math.max(0, unitPrice * itemInput.quantity - discount);

      orderItems.push({
        productId: product.id,
        productName: product.name,
        sku: product.sku,
        quantity: itemInput.quantity,
        unitPrice,
        discount,
        lineTotal,
      });

      subtotal += lineTotal;
    }

    // Temporary stock reservation
    for (const item of orderItems) {
      this.stockReservations.push({
        productId: item.productId,
        orderId,
        quantity: item.quantity,
        reservedAt: Date.now(),
      });
    }

    const discountAmount = input.discountAmount ?? 0;
    const discountedSubtotal = Math.max(0, subtotal - discountAmount);
    const taxRate = input.taxRate ?? 0.08; // 8% VAT standard
    const taxAmount = Math.round(discountedSubtotal * taxRate);
    const totalAmount = discountedSubtotal + taxAmount;
    const paymentMethod = input.paymentMethod ?? 'VIETQR';
    const paymentStatus: POSPaymentStatus = 'UNPAID';

    // VietQR payload generation for offline customer scan
    const bankCode = input.bankAccount?.bankCode ?? this.storeConfig.defaultBankCode;
    const accountNumber = input.bankAccount?.accountNumber ?? this.storeConfig.defaultAccountNumber;
    const vietQrPayload = this.generateVietQrPayload({
      bankCode,
      accountNumber,
      amount: totalAmount,
      orderCode,
    });

    const now = Date.now();
    const order: POSOrder = {
      id: orderId,
      orderCode,
      items: orderItems,
      subtotal,
      discountAmount,
      taxRate,
      taxAmount,
      totalAmount,
      depositAmount: 0,
      paymentMethod,
      paymentStatus,
      status: 'CONFIRMED',
      vietQrPayload,
      createdAt: now,
      updatedAt: now,
      cashierId: input.cashierId ?? 'OFFLINE_POS_CASHIER_01',
      notes: input.notes,
    };

    // Generate K80 thermal print slip
    order.k80Receipt = this.formatK80Receipt(order);

    // Save locally
    this.orders.set(order.id, order);

    // Enqueue order mutation to OutboxQueue
    await this.queue.enqueue({
      id: order.id,
      entityType: 'ORDER',
      action: 'CREATE',
      payload: order as unknown as Record<string, unknown>,
      timestamp: now,
      isFinancial: false,
    });

    return order;
  }

  /**
   * Accepts a VietQR deposit payment while offline:
   * 1. Updates order deposit amount & status.
   * 2. Creates an immutable financial ledger entry (Append-Only).
   * 3. Enqueues a high-priority financial mutation to OutboxQueue.
   */
  async receiveVietQrDeposit(
    orderId: string,
    amount: number,
    transactionRef: string,
    note?: string
  ): Promise<POSOrder> {
    const order = this.orders.get(orderId);
    if (!order) {
      throw new Error(`Order "${orderId}" not found in offline store.`);
    }
    if (amount <= 0) {
      throw new Error('Deposit amount must be positive.');
    }

    const now = Date.now();
    const nextDeposit = order.depositAmount + amount;
    const newPaymentStatus: POSPaymentStatus =
      nextDeposit >= order.totalAmount ? 'PAID' : 'PARTIALLY_PAID';

    order.depositAmount = nextDeposit;
    order.paymentStatus = newPaymentStatus;
    order.updatedAt = now;
    order.k80Receipt = this.formatK80Receipt(order);

    // Append-only Financial Ledger Entry
    const ledgerId = uuidv7();
    const ledgerEntry: FinancialLedgerEntry = {
      id: ledgerId,
      orderId,
      transactionType: 'DEPOSIT',
      amount,
      referenceCode: transactionRef,
      timestamp: now,
      balanceAfter: Math.max(0, order.totalAmount - nextDeposit),
      note: note ?? `Offline VietQR deposit for ${order.orderCode}`,
    };
    this.ledgerEntries.push(ledgerEntry);

    // Enqueue Append-Only Financial Mutation to Outbox
    await this.queue.enqueue({
      id: ledgerId,
      entityType: 'FINANCIAL_TRANSACTION',
      action: 'CREATE',
      payload: ledgerEntry as unknown as Record<string, unknown>,
      timestamp: now,
      isFinancial: true,
    });

    return order;
  }

  getOrder(orderId: string): POSOrder | null {
    const o = this.orders.get(orderId);
    return o ? { ...o } : null;
  }

  listOrders(): POSOrder[] {
    return Array.from(this.orders.values()).map((o) => ({ ...o }));
  }

  getLedgerEntries(): FinancialLedgerEntry[] {
    return [...this.ledgerEntries];
  }

  /**
   * Generates or retrieves formatted K80 Thermal Receipt text for an order.
   */
  printK80Receipt(orderId: string): string {
    const order = this.orders.get(orderId);
    if (!order) {
      throw new Error(`Order "${orderId}" not found.`);
    }
    return this.formatK80Receipt(order);
  }

  /**
   * Formats K80 Thermal Receipt (80mm width standard, 48 character monospace columns).
   */
  formatK80Receipt(order: POSOrder): string {
    const width = 48;
    const divider = '-'.repeat(width);
    const doubleDivider = '='.repeat(width);

    const center = (text: string) => {
      if (text.length >= width) return text;
      const pad = Math.floor((width - text.length) / 2);
      return ' '.repeat(pad) + text;
    };

    const row2 = (left: string, right: string) => {
      const space = width - left.length - right.length;
      return left + ' '.repeat(Math.max(1, space)) + right;
    };

    const formatVND = (num: number) => num.toLocaleString('vi-VN') + ' đ';

    const lines: string[] = [
      doubleDivider,
      center(this.storeConfig.name),
      center(this.storeConfig.address),
      center(`Hotline: ${this.storeConfig.hotline}`),
      center('*** HÓA ĐƠN THANH TOÁN (K80) ***'),
      doubleDivider,
      row2(`Mã ĐH: ${order.orderCode}`, new Date(order.createdAt).toLocaleTimeString('vi-VN')),
      row2(`Ngày: ${new Date(order.createdAt).toLocaleDateString('vi-VN')}`, `Thu ngân: ${order.cashierId ?? 'POS'}`),
      divider,
      row2('Tên hàng hóa (SL x Giá)', 'Thành tiền'),
      divider,
    ];

    for (const item of order.items) {
      lines.push(item.productName);
      const subLine = `  ${item.quantity} x ${formatVND(item.unitPrice)}${item.discount > 0 ? ` (-${formatVND(item.discount)})` : ''}`;
      lines.push(row2(subLine, formatVND(item.lineTotal)));
    }

    lines.push(divider);
    lines.push(row2('Tạm tính:', formatVND(order.subtotal)));
    if (order.discountAmount > 0) {
      lines.push(row2('Giảm giá:', `-${formatVND(order.discountAmount)}`));
    }
    lines.push(row2(`Thuế GTGT (${Math.round(order.taxRate * 100)}%):`, formatVND(order.taxAmount)));
    lines.push(doubleDivider);
    lines.push(row2('TỔNG CỘNG THANH TOÁN:', formatVND(order.totalAmount)));
    if (order.depositAmount > 0) {
      lines.push(row2('Đã thanh toán / Cọc VietQR:', formatVND(order.depositAmount)));
      const remaining = Math.max(0, order.totalAmount - order.depositAmount);
      lines.push(row2('Còn lại:', formatVND(remaining)));
    }
    lines.push(row2('Phương thức TT:', `${order.paymentMethod} [${order.paymentStatus}]`));
    lines.push(doubleDivider);

    if (order.vietQrPayload) {
      lines.push(center('[ QUÉT MÃ VIETQR ĐỂ THANH TOÁN ]'));
      lines.push(center(order.vietQrPayload));
      lines.push(divider);
    }

    lines.push(center('Quý khách vui lòng kiểm tra hóa đơn trước khi rời quầy.'));
    lines.push(center('Cảm ơn quý khách & Hẹn gặp lại!'));
    lines.push(doubleDivider);

    return lines.join('\n');
  }

  /**
   * Generates a standard VietQR QuickLink / EMVCo payload string.
   */
  generateVietQrPayload(options: {
    bankCode: string;
    accountNumber: string;
    amount: number;
    orderCode: string;
  }): string {
    const encodedOrderCode = encodeURIComponent(options.orderCode);
    // Standard VietQR QuickLink URL format compatible with all Vietnamese banking apps
    return `https://img.vietqr.io/image/${options.bankCode}-${options.accountNumber}-compact2.png?amount=${options.amount}&addInfo=${encodedOrderCode}`;
  }
}
