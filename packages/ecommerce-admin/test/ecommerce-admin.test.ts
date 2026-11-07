import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  SqliteOrderRepository,
  EcommerceOrderService,
  createEcommerceAdminRoutes,
  mapRecordToAdminOrder,
  formatVndAmount,
  formatUsdAmount,
  formatOrderCurrency,
  isValidOrderStatus,
  getOrderStatusColor,
  getOrderStatusLabel,
  type CreateOrderInput,
  type OrderRecord,
} from '../src';
import { generateVietQrImageUrl } from '@kido/payment-vietqr';

describe('@kido/ecommerce-admin Unit Test Suite', () => {
  let repository: SqliteOrderRepository;
  let service: EcommerceOrderService;

  beforeEach(() => {
    // Isolated in-memory SQLite database for each test
    repository = new SqliteOrderRepository(':memory:');
    service = new EcommerceOrderService(repository);
  });

  afterEach(() => {
    repository.close();
  });

  // ==========================================================================
  // 1. SqliteOrderRepository Tests
  // ==========================================================================
  describe('SqliteOrderRepository', () => {
    it('initializes table schema and indexes without error', () => {
      // Calling init multiple times should be safe (idempotent)
      expect(() => repository.init()).not.toThrow();
    });

    it('creates an order and stores all fields properly', () => {
      const input: CreateOrderInput = {
        tierId: 'tier-3-flashlight',
        tierName: 'Buy 3 Flashlights (Mega Value)',
        quantity: 3,
        unitPrice: 18.33,
        subtotal: 54.99,
        shippingFee: 0,
        discountAmount: 5.0,
        totalAmount: 49.99,
        currency: 'USD',
        status: 'PAID',
        paymentMethod: 'vietqr',
        paymentRef: 'MB-12345',
        notes: 'Giao trong giờ hành chính',
        slots: [
          { slotIndex: 1, selectedVariantId: 'tactical-black', variantName: 'Black' },
          { slotIndex: 2, selectedVariantId: 'camo-green', variantName: 'Camo Green' },
          { slotIndex: 3, selectedVariantId: 'orange', variantName: 'Safety Orange' },
        ],
        customer: {
          name: 'Trần Minh Quân',
          email: 'quan.tran@example.com',
          phone: '0912345678',
          address: 'Landmark 81, P.22',
          city: 'Hồ Chí Minh',
        },
      };

      const record = repository.createOrder(input);

      expect(record.id).toBeDefined();
      expect(record.tier_id).toBe('tier-3-flashlight');
      expect(record.tier_name).toBe('Buy 3 Flashlights (Mega Value)');
      expect(record.quantity).toBe(3);
      expect(record.unit_price).toBe(18.33);
      expect(record.subtotal).toBe(54.99);
      expect(record.shipping_fee).toBe(0);
      expect(record.discount_amount).toBe(5.0);
      expect(record.total_amount).toBe(49.99);
      expect(record.currency).toBe('USD');
      expect(record.status).toBe('PAID');
      expect(record.payment_method).toBe('vietqr');
      expect(record.payment_ref).toBe('MB-12345');
      expect(record.customer_name).toBe('Trần Minh Quân');
      expect(record.customer_email).toBe('quan.tran@example.com');
      expect(record.customer_phone).toBe('0912345678');
      expect(record.slots_json).toContain('tactical-black');
    });

    it('calculates subtotal and totalAmount automatically if omitted', () => {
      const record = repository.createOrder({
        tierId: 'tier-1',
        quantity: 2,
        unitPrice: 20.0,
        shippingFee: 5.0,
        customer: {
          name: 'Nguyễn Văn A',
          email: 'vana@example.com',
        },
      });

      expect(record.subtotal).toBe(40.0);
      expect(record.total_amount).toBe(45.0); // 40 + 5
    });

    it('retrieves an existing order by ID and returns null for non-existing', () => {
      const created = repository.createOrder({
        tierId: 'tier-1',
        quantity: 1,
        unitPrice: 25.0,
        customer: {
          name: 'Lê Hoàng Yến',
          email: 'yenle@example.com',
        },
      });

      const found = repository.getOrderById(created.id);
      expect(found).not.toBeNull();
      expect(found?.id).toBe(created.id);
      expect(found?.customer_name).toBe('Lê Hoàng Yến');

      const nonExistent = repository.getOrderById('non_existent_id');
      expect(nonExistent).toBeNull();
    });

    it('lists orders with pagination and filtering', () => {
      // Seed 3 orders
      repository.createOrder({
        tierId: 'tier-1',
        customer: { name: 'Customer One', email: 'one@test.com', phone: '0901111111' },
        status: 'PAID',
        paymentMethod: 'vietqr',
      });
      repository.createOrder({
        tierId: 'tier-2',
        customer: { name: 'Customer Two', email: 'two@test.com', phone: '0902222222' },
        status: 'PENDING_PAYMENT',
        paymentMethod: 'card',
      });
      repository.createOrder({
        tierId: 'tier-3',
        customer: { name: 'Special VIP', email: 'vip@test.com', phone: '0903333333' },
        status: 'PAID',
        paymentMethod: 'card',
      });

      // 1. List all
      const listAll = repository.listOrders();
      expect(listAll.total).toBe(3);
      expect(listAll.records.length).toBe(3);

      // 2. Filter by status
      const paidOnly = repository.listOrders({ status: 'PAID' });
      expect(paidOnly.total).toBe(2);
      expect(paidOnly.records.every((r) => r.status === 'PAID')).toBe(true);

      // 3. Search query
      const searched = repository.listOrders({ search: 'Special VIP' });
      expect(searched.total).toBe(1);
      expect(searched.records[0].customer_name).toBe('Special VIP');

      // 4. Pagination
      const page1 = repository.listOrders({ limit: 2, offset: 0 });
      expect(page1.records.length).toBe(2);
      const page2 = repository.listOrders({ limit: 2, offset: 2 });
      expect(page2.records.length).toBe(1);
    });

    it('updates order status and payment information', () => {
      const order = repository.createOrder({
        tierId: 'tier-1',
        customer: { name: 'Test User', email: 'test@user.com' },
        status: 'PENDING_PAYMENT',
      });

      const updated = repository.updateOrderStatus(order.id, 'PAID', 'Đã duyệt qua app ngân hàng', 'MB-778899');
      expect(updated).not.toBeNull();
      expect(updated?.status).toBe('PAID');
      expect(updated?.notes).toBe('Đã duyệt qua app ngân hàng');
      expect(updated?.payment_ref).toBe('MB-778899');

      const paymentUpdated = repository.updatePaymentInfo(order.id, 'airwallex_card', 'awx_charge_123', 'PAID');
      expect(paymentUpdated?.payment_method).toBe('airwallex_card');
      expect(paymentUpdated?.payment_ref).toBe('awx_charge_123');
    });

    it('deletes an order', () => {
      const order = repository.createOrder({
        tierId: 'tier-delete',
        customer: { name: 'To Delete', email: 'del@user.com' },
      });

      const deleted = repository.deleteOrder(order.id);
      expect(deleted).toBe(true);
      expect(repository.getOrderById(order.id)).toBeNull();

      const deleteAgain = repository.deleteOrder(order.id);
      expect(deleteAgain).toBe(false);
    });

    it('computes aggregated metrics accurately', () => {
      // 2 paid orders ($50, $100), 1 pending ($30), 1 shipped ($80)
      repository.createOrder({
        tierId: 't1',
        quantity: 2,
        totalAmount: 50.0,
        status: 'PAID',
        customer: { name: 'P1', email: 'p1@test.com' },
      });
      repository.createOrder({
        tierId: 't2',
        quantity: 3,
        totalAmount: 100.0,
        status: 'PAID',
        customer: { name: 'P2', email: 'p2@test.com' },
      });
      repository.createOrder({
        tierId: 't3',
        quantity: 1,
        totalAmount: 30.0,
        status: 'PENDING',
        customer: { name: 'P3', email: 'p3@test.com' },
      });
      repository.createOrder({
        tierId: 't4',
        quantity: 2,
        totalAmount: 80.0,
        status: 'SHIPPED',
        customer: { name: 'P4', email: 'p4@test.com' },
      });

      const metrics = repository.getMetrics(25400);

      expect(metrics.totalOrders).toBe(4);
      expect(metrics.paidOrders).toBe(2);
      expect(metrics.totalRevenueUsd).toBe(150.0);
      expect(metrics.totalRevenueVnd).toBe(150 * 25400);
      expect(metrics.unitsSold).toBe(5); // 2 + 3
      expect(metrics.pendingOrders).toBe(1);
      expect(metrics.shippedOrders).toBe(1);
      expect(metrics.conversionRate).toBe(50.0); // 2 / 4 = 50%
      expect(metrics.averageOrderValueUsd).toBe(75.0); // 150 / 2 = 75
    });
  });

  // ==========================================================================
  // 2. EcommerceOrderService Tests
  // ==========================================================================
  describe('EcommerceOrderService', () => {
    it('maps database record to normalized AdminOrder domain model', () => {
      const rawRecord: OrderRecord = {
        id: 'ord_123',
        tier_id: 't-flash',
        tier_name: 'Flashlight Pack',
        quantity: 2,
        unit_price: 25.0,
        subtotal: 50.0,
        shipping_fee: 5.0,
        discount_amount: 0,
        total_amount: 55.0,
        currency: 'USD',
        status: 'PAID',
        payment_method: 'vietqr',
        payment_ref: 'MB-999',
        notes: 'Priority shipping',
        slots_json: JSON.stringify([{ slotIndex: 1, selectedVariantId: 'black' }]),
        customer_name: 'Nguyen Van B',
        customer_email: 'vanb@gmail.com',
        customer_phone: '0988776655',
        shipping_address: '123 Le Loi',
        city: 'Da Nang',
        state: 'DN',
        zip: '550000',
        metadata_json: JSON.stringify({ source: 'landing_fb' }),
        created_at: '2026-10-01T10:00:00.000Z',
        updated_at: '2026-10-01T10:00:00.000Z',
      };

      const adminOrder = mapRecordToAdminOrder(rawRecord);

      expect(adminOrder.id).toBe('ord_123');
      expect(adminOrder.tierId).toBe('t-flash');
      expect(adminOrder.tierName).toBe('Flashlight Pack');
      expect(adminOrder.slots.length).toBe(1);
      expect(adminOrder.slots[0].selectedVariantId).toBe('black');
      expect(adminOrder.customer.name).toBe('Nguyen Van B');
      expect(adminOrder.customer.phone).toBe('0988776655');
      expect(adminOrder.metadata?.source).toBe('landing_fb');
    });

    it('formats currencies accurately', () => {
      expect(formatUsdAmount(49.99)).toBe('$49.99');
      expect(formatVndAmount(1250000)).toContain('1.250.000');
      expect(formatOrderCurrency(49.99, 'USD')).toBe('$49.99');
      expect(formatOrderCurrency(1250000, 'VND')).toContain('1.250.000');
    });

    it('validates order status and returns proper badges/labels', () => {
      expect(isValidOrderStatus('PAID')).toBe(true);
      expect(isValidOrderStatus('PENDING_PAYMENT')).toBe(true);
      expect(isValidOrderStatus('SHIPPED')).toBe(true);
      expect(isValidOrderStatus('INVALID_STATUS')).toBe(false);

      expect(getOrderStatusLabel('PAID')).toBe('Đã thanh toán');
      expect(getOrderStatusLabel('PENDING')).toBe('Chờ thanh toán');
      expect(getOrderStatusLabel('SHIPPED')).toBe('Đã gửi hàng');

      const color = getOrderStatusColor('PAID');
      expect(color.bg).toContain('emerald');
    });

    it('delegates CRUD and metrics methods correctly', () => {
      const created = service.createOrder({
        tierId: 't-srv',
        customer: { name: 'Service User', email: 'srv@test.com' },
        quantity: 1,
        unitPrice: 30,
        status: 'PAID',
      });

      expect(created.id).toBeDefined();
      expect(service.getOrder(created.id)?.customer.name).toBe('Service User');

      const list = service.listOrders();
      expect(list.total).toBe(1);
      expect(list.page).toBe(1);

      const metrics = service.getMetrics();
      expect(metrics.totalOrders).toBe(1);
      expect(metrics.paidOrders).toBe(1);
      expect(metrics.recentOrders?.length).toBe(1);
    });
  });

  // ==========================================================================
  // 3. Hono API Routes Tests
  // ==========================================================================
  describe('Hono Admin API Routes', () => {
    let app: any;

    beforeEach(() => {
      app = createEcommerceAdminRoutes(service);
    });

    it('GET /metrics returns 200 and metrics payload', async () => {
      service.createOrder({
        tierId: 't1',
        totalAmount: 100,
        status: 'PAID',
        customer: { name: 'Metric Customer', email: 'm@c.com' },
      });

      const res = await app.request('/metrics');
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.metrics.totalOrders).toBe(1);
      expect(data.metrics.totalRevenueUsd).toBe(100);
    });

    it('GET /orders returns 200 and paginated list', async () => {
      service.createOrder({
        tierId: 't1',
        customer: { name: 'Alice', email: 'alice@example.com' },
      });
      service.createOrder({
        tierId: 't2',
        customer: { name: 'Bob', email: 'bob@example.com' },
      });

      const res = await app.request('/orders?limit=10&page=1');
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.total).toBe(2);
      expect(data.orders.length).toBe(2);
    });

    it('GET /orders/:id returns 200 for existing order, 404 for unknown', async () => {
      const order = service.createOrder({
        tierId: 't1',
        customer: { name: 'Charlie', email: 'charlie@example.com' },
      });

      const res = await app.request(`/orders/${order.id}`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.order.id).toBe(order.id);

      const notFoundRes = await app.request('/orders/unknown_id');
      expect(notFoundRes.status).toBe(404);
    });

    it('POST /orders creates order with validation', async () => {
      const payload = {
        tierId: 'flash-tier-3',
        quantity: 3,
        unitPrice: 18.0,
        customer: {
          name: 'David Beck',
          email: 'david@beck.com',
          phone: '0933445566',
        },
      };

      const res = await app.request('/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.order.customer.name).toBe('David Beck');
    });

    it('POST /orders returns 400 when missing required fields', async () => {
      const invalidPayload = {
        // missing tierId and customer
      };

      const res = await app.request('/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(invalidPayload),
      });

      expect(res.status).toBe(400);
    });

    it('PATCH /orders/:id/status updates status and returns updated order', async () => {
      const order = service.createOrder({
        tierId: 't1',
        status: 'PENDING_PAYMENT',
        customer: { name: 'Eve', email: 'eve@example.com' },
      });

      const res = await app.request(`/orders/${order.id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'PAID',
          notes: 'Duyệt thủ công',
          paymentRef: 'REF_9988',
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.order.status).toBe('PAID');
      expect(data.order.notes).toBe('Duyệt thủ công');
      expect(data.order.paymentRef).toBe('REF_9988');
    });

    it('PATCH /orders/:id/payment updates payment info', async () => {
      const order = service.createOrder({
        tierId: 't1',
        customer: { name: 'Frank', email: 'frank@example.com' },
      });

      const res = await app.request(`/orders/${order.id}/payment`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          paymentMethod: 'vietqr_vcb',
          paymentRef: 'TXN_VCB_123',
          status: 'PAID',
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.order.paymentMethod).toBe('vietqr_vcb');
      expect(data.order.paymentRef).toBe('TXN_VCB_123');
      expect(data.order.status).toBe('PAID');
    });

    it('DELETE /orders/:id deletes order', async () => {
      const order = service.createOrder({
        tierId: 't1',
        customer: { name: 'George', email: 'george@example.com' },
      });

      const res = await app.request(`/orders/${order.id}`, {
        method: 'DELETE',
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.id).toBe(order.id);

      // Verify deletion
      expect(service.getOrder(order.id)).toBeNull();

      // Deleting again returns 404
      const secondDel = await app.request(`/orders/${order.id}`, {
        method: 'DELETE',
      });
      expect(secondDel.status).toBe(404);
    });
  });

  // ==========================================================================
  // 4. VietQR Generation & Bill K80 Integration Tests
  // ==========================================================================
  describe('VietQR & Receipt Integration', () => {
    it('generates dynamic VietQR image url with correct parameters', () => {
      const qrUrl = generateVietQrImageUrl({
        bank: 'MBBank',
        accountNumber: '0912345678',
        accountName: 'KIDO ECOMMERCE',
        amount: 1250000,
        description: 'DH ORD123',
        template: 'compact2',
      });

      expect(qrUrl).toContain('img.vietqr.io');
      expect(qrUrl).toContain('0912345678');
      expect(qrUrl).toContain('amount=1250000');
      expect(qrUrl).toContain('DH+ORD123');
    });
  });
});
