import assert from 'node:assert';
import test from 'node:test';
import {
  BatchItemSchema,
  BatchManager,
  calculateRemainingTime,
  evaluateBatchExpiry,
  evaluateInventoryExpiry,
  evaluateStockLevel,
  formatStockAlertTelegramHtml,
  getExpiryStatusLabel,
  scanInventoryForAlerts,
  ShrinkageLogger,
  ShrinkageRecordSchema,
  StockAlertPayloadSchema,
  StockInventory,
  toNotifySystemAlert,
} from './index';

// ============================================================================
// 1. Fresh / Perishable Batch Management Tests
// ============================================================================
test('BatchManager manages perishable batches and calculates remaining time accurately', () => {
  const refDate = new Date('2026-10-01T08:00:00Z');

  // Batch expiring in 2 days and 4 hours (52 hours)
  const expiresAt = new Date('2026-10-03T12:00:00Z');
  const timeInfo = calculateRemainingTime(expiresAt, refDate);

  assert.strictEqual(timeInfo.isExpired, false);
  assert.strictEqual(timeInfo.remainingDays, 2);
  assert.strictEqual(timeInfo.remainingHours, 4);
  assert.strictEqual(timeInfo.totalHours, 52);

  // Past expiration date
  const pastExpiry = new Date('2026-09-30T08:00:00Z');
  const expiredInfo = calculateRemainingTime(pastExpiry, refDate);
  assert.strictEqual(expiredInfo.isExpired, true);
  assert.strictEqual(expiredInfo.remainingDays, 0);
  assert.strictEqual(expiredInfo.totalHours, 0);
});

test('BatchManager performs First-Expired, First-Out (FEFO) stock deduction correctly', () => {
  const refDate = new Date('2026-10-01T08:00:00Z');
  const manager = new BatchManager();

  // Batch 1: Expiring Oct 3 (earliest) - Qty: 10
  manager.addBatch({
    batchId: 'BATCH-BREAD-01',
    productId: 'PROD-BREAD',
    productName: 'Bánh mì hoa cúc',
    category: 'PASTRY',
    importedAt: new Date('2026-09-28T08:00:00Z'),
    expiresAt: new Date('2026-10-03T08:00:00Z'),
    initialQuantity: 10,
    currentQuantity: 10,
    unit: 'ổ',
    costPerUnit: 45000,
  });

  // Batch 2: Expiring Oct 5 (later) - Qty: 20
  manager.addBatch({
    batchId: 'BATCH-BREAD-02',
    productId: 'PROD-BREAD',
    productName: 'Bánh mì hoa cúc',
    category: 'PASTRY',
    importedAt: new Date('2026-09-29T08:00:00Z'),
    expiresAt: new Date('2026-10-05T08:00:00Z'),
    initialQuantity: 20,
    currentQuantity: 20,
    unit: 'ổ',
    costPerUnit: 45000,
  });

  // Batch 3: Already expired on Sept 30 - Qty: 5
  manager.addBatch({
    batchId: 'BATCH-BREAD-EXPIRED',
    productId: 'PROD-BREAD',
    productName: 'Bánh mì hoa cúc',
    category: 'PASTRY',
    importedAt: new Date('2026-09-25T08:00:00Z'),
    expiresAt: new Date('2026-09-30T08:00:00Z'),
    initialQuantity: 5,
    currentQuantity: 5,
    unit: 'ổ',
    costPerUnit: 45000,
  });

  // Check product stock calculations
  const stockInfo = manager.calculateProductStock('PROD-BREAD', refDate);
  assert.strictEqual(stockInfo.totalStock, 35);
  assert.strictEqual(stockInfo.usableStock, 30); // 10 + 20
  assert.strictEqual(stockInfo.expiredStock, 5);
  assert.strictEqual(stockInfo.activeBatchesCount, 2);

  // Deduct 15 units via FEFO: Should take 10 from Batch 01, and 5 from Batch 02
  const deduction = manager.deductStockFEFO('PROD-BREAD', 15, refDate);
  assert.strictEqual(deduction.isFullyFulfilled, true);
  assert.strictEqual(deduction.deductedQuantity, 15);
  assert.strictEqual(deduction.unfulfilledQuantity, 0);
  assert.strictEqual(deduction.deductions.length, 2);

  assert.strictEqual(deduction.deductions[0].batchId, 'BATCH-BREAD-01');
  assert.strictEqual(deduction.deductions[0].quantityDeducted, 10);
  assert.strictEqual(deduction.deductions[0].remainingInBatch, 0);

  assert.strictEqual(deduction.deductions[1].batchId, 'BATCH-BREAD-02');
  assert.strictEqual(deduction.deductions[1].quantityDeducted, 5);
  assert.strictEqual(deduction.deductions[1].remainingInBatch, 15);

  // Expired batch should remain untouched
  const expiredBatch = manager.getBatch('BATCH-BREAD-EXPIRED');
  assert.strictEqual(expiredBatch?.currentQuantity, 5);
});

// ============================================================================
// 2. Expiry Status Evaluator Tests
// ============================================================================
test('Expiry Evaluator classifies batches into FRESH, EXPIRING_SOON, and EXPIRED', () => {
  const refDate = new Date('2026-10-01T08:00:00Z');

  // Test Food item with 72h default window:
  // Expiring in 24 hours -> EXPIRING_SOON + urgent clearance needed
  const expiringFood = {
    batchId: 'BATCH-MEAT-01',
    productId: 'PROD-BEEF',
    productName: 'Thịt bò tươi Wagyu A5',
    category: 'FOOD' as const,
    importedAt: new Date('2026-09-30T08:00:00Z'),
    expiresAt: new Date('2026-10-02T08:00:00Z'), // 24 hours left
    initialQuantity: 10,
    currentQuantity: 8,
    unit: 'kg',
    costPerUnit: 1500000,
  };
  const evalExpiring = evaluateBatchExpiry(expiringFood, { referenceDate: refDate });
  assert.strictEqual(evalExpiring.status, 'EXPIRING_SOON');
  assert.strictEqual(evalExpiring.isUrgentClearanceNeeded, true);
  assert.strictEqual(getExpiryStatusLabel(evalExpiring.status), '⚠️ SẮP HẾT HẠN');

  // Flower item with 24h threshold:
  // Expiring in 30 hours (> 24h threshold for flowers) -> FRESH
  const freshFlower = {
    batchId: 'BATCH-ROSE-01',
    productId: 'PROD-ROSE',
    productName: 'Hoa hồng Ecuador đỏ',
    category: 'FLOWERS' as const,
    importedAt: new Date('2026-10-01T00:00:00Z'),
    expiresAt: new Date('2026-10-02T14:00:00Z'), // 30 hours left
    initialQuantity: 50,
    currentQuantity: 50,
    unit: 'bó',
    costPerUnit: 250000,
  };
  const evalFlower = evaluateBatchExpiry(freshFlower, { referenceDate: refDate });
  assert.strictEqual(evalFlower.status, 'FRESH');
  assert.strictEqual(getExpiryStatusLabel(evalFlower.status), '🟢 TƯƠI MỚI (AN TOÀN)');

  // Expired item
  const expiredPastry = {
    batchId: 'BATCH-CAKE-01',
    productId: 'PROD-CAKE',
    productName: 'Bánh Tiramisu Ý',
    category: 'PASTRY' as const,
    importedAt: new Date('2026-09-27T08:00:00Z'),
    expiresAt: new Date('2026-09-30T20:00:00Z'), // Past
    initialQuantity: 12,
    currentQuantity: 4,
    unit: 'hộp',
    costPerUnit: 120000,
  };
  const evalExpired = evaluateBatchExpiry(expiredPastry, { referenceDate: refDate });
  assert.strictEqual(evalExpired.status, 'EXPIRED');
  assert.strictEqual(evalExpired.isExpired, true);
  assert.strictEqual(getExpiryStatusLabel(evalExpired.status), '❌ ĐÃ QUÁ HẠN');

  // Test inventory aggregate evaluation
  const inventoryReport = evaluateInventoryExpiry(
    [expiringFood, freshFlower, expiredPastry],
    { referenceDate: refDate }
  );

  assert.strictEqual(inventoryReport.stats.freshCount, 1);
  assert.strictEqual(inventoryReport.stats.expiringSoonCount, 1);
  assert.strictEqual(inventoryReport.stats.expiredCount, 1);
  assert.strictEqual(inventoryReport.stats.totalUsableQty, 58); // 8 + 50
  assert.strictEqual(inventoryReport.stats.totalExpiredQty, 4);
  assert.strictEqual(inventoryReport.clearanceCandidates.length, 1);
  assert.strictEqual(inventoryReport.clearanceCandidates[0].batchId, 'BATCH-MEAT-01');
});

// ============================================================================
// 3. Low-Stock Alert Engine Tests (with Telegram Bot Payload)
// ============================================================================
test('Low-Stock Alert Engine compares stock thresholds and formats Telegram notifications', () => {
  const refDate = new Date('2026-10-01T08:00:00Z');

  // Inventory 1: Critical Low
  const lowStockInv: StockInventory = {
    productId: 'PROD-MILK',
    productName: 'Sữa tươi thanh trùng Dalat Milk',
    sku: 'DLM-1000ML',
    category: 'FOOD',
    unit: 'chai',
    minStockThreshold: 20,
    criticalThreshold: 5,
    reorderQuantity: 30,
    batches: [
      {
        batchId: 'BATCH-MILK-01',
        productId: 'PROD-MILK',
        productName: 'Sữa tươi thanh trùng Dalat Milk',
        category: 'FOOD',
        importedAt: new Date('2026-09-28T08:00:00Z'),
        expiresAt: new Date('2026-10-02T12:00:00Z'), // Expiring soon (< 72h)
        initialQuantity: 10,
        currentQuantity: 3, // <= criticalThreshold (5)
        unit: 'chai',
        costPerUnit: 35000,
      },
    ],
  };

  const alert = evaluateStockLevel(lowStockInv, {
    referenceDate: refDate,
    appTitle: 'BẾP TRUNG TÂM & FASTFOOD',
  });

  assert.strictEqual(alert.stockStatus, 'CRITICAL_LOW');
  assert.strictEqual(alert.severity, 'ERROR');
  assert.strictEqual(alert.usableStock, 3);
  assert.strictEqual(alert.expiringBatchesCount, 1);
  assert.strictEqual(alert.recommendedReorderQty, 30);
  assert.ok(alert.telegramHtml?.includes('BÁO ĐỘNG ĐỎ - SẮP CẠN KIỆT'));
  assert.ok(alert.telegramHtml?.includes('Sữa tươi thanh trùng Dalat Milk'));
  assert.ok(alert.telegramHtml?.includes('Tồn khả dụng:</b> <b>3 chai</b>'));

  // Test compatibility converter to @kido/notify SystemAlertPayload
  const notifyAlert = toNotifySystemAlert(alert, 'INVENTORY_ALERT');
  assert.strictEqual(notifyAlert.service, 'INVENTORY_ALERT');
  assert.strictEqual(notifyAlert.level, 'ERROR');
  assert.ok(notifyAlert.title.includes('Sữa tươi thanh trùng Dalat Milk'));
  assert.strictEqual(notifyAlert.context?.productId, 'PROD-MILK');
  assert.strictEqual(notifyAlert.context?.usableStock, 3);

  // Inventory 2: Out of Stock (physical stock exists but all expired!)
  const expiredInv: StockInventory = {
    productId: 'PROD-YOGURT',
    productName: 'Sữa chua Hy Lạp',
    category: 'FOOD',
    unit: 'hũ',
    minStockThreshold: 10,
    batches: [
      {
        batchId: 'BATCH-YOGURT-01',
        productId: 'PROD-YOGURT',
        productName: 'Sữa chua Hy Lạp',
        category: 'FOOD',
        importedAt: new Date('2026-09-20T08:00:00Z'),
        expiresAt: new Date('2026-09-29T08:00:00Z'), // Expired
        initialQuantity: 15,
        currentQuantity: 15,
        unit: 'hũ',
        costPerUnit: 22000,
      },
    ],
  };

  const outOfStockAlert = evaluateStockLevel(expiredInv, { referenceDate: refDate });
  assert.strictEqual(outOfStockAlert.stockStatus, 'OUT_OF_STOCK');
  assert.strictEqual(outOfStockAlert.severity, 'CRITICAL');
  assert.strictEqual(outOfStockAlert.usableStock, 0);
  assert.strictEqual(outOfStockAlert.expiredStock, 15);

  // Test scanInventoryForAlerts multi-item scanner
  const scanResults = scanInventoryForAlerts([lowStockInv, expiredInv], {
    referenceDate: refDate,
  });
  assert.strictEqual(scanResults.allAlerts.length, 2);
  assert.strictEqual(scanResults.attentionRequired.length, 2);
  assert.strictEqual(scanResults.criticalAlerts.length, 2); // 1 ERROR + 1 CRITICAL
});

// ============================================================================
// 4. Shrinkage / Wastage Logger Tests
// ============================================================================
test('ShrinkageLogger records wastage, computes loss values and calculates shrinkage rate', () => {
  const logger = new ShrinkageLogger();

  // Log 1: Damaged during transport (Dập nát)
  const record1 = logger.logShrinkage({
    productId: 'PROD-TULIP',
    productName: 'Hoa Tulip Hà Lan',
    batchId: 'BATCH-TULIP-01',
    quantity: 10,
    unit: 'cành',
    unitCost: 30000,
    reason: 'DAMAGED_CRUSHED',
    note: 'Bị gãy cành khi dỡ hàng từ xe lạnh',
    recordedBy: 'Kho vận Tuấn',
  });

  assert.strictEqual(record1.totalLossValue, 300000); // 10 * 30000

  // Log 2: Expired discarded (Hết hạn tiêu hủy)
  const record2 = logger.logShrinkage({
    productId: 'PROD-CAKE',
    productName: 'Bánh Mousse Chanh Leo',
    batchId: 'BATCH-CAKE-05',
    quantity: 5,
    unit: 'bánh',
    unitCost: 80000,
    reason: 'EXPIRED',
    note: 'Quá hạn 2 ngày, tiêu hủy định kỳ',
  });

  assert.strictEqual(record2.totalLossValue, 400000); // 5 * 80000

  // Log 3: Quality degraded (Héo úa)
  logger.logShrinkage({
    productId: 'PROD-ROSE',
    productName: 'Hoa hồng đỏ',
    quantity: 15,
    unit: 'bông',
    unitCost: 15000,
    reason: 'QUALITY_DEGRADED',
  });

  // Calculate total monetary loss
  const totalLoss = logger.calculateTotalLossValue();
  assert.strictEqual(totalLoss, 300000 + 400000 + 225000); // 925,000 VND

  // Calculate shrinkage rate percentage: Total lost = 10 + 5 + 15 = 30 units. Total received = 500 units.
  // 30 / 500 = 6%
  const rate = logger.calculateShrinkageRate(500);
  assert.strictEqual(rate, 6.0);

  // Generate breakdown summary
  const summary = logger.getSummary(500);
  assert.strictEqual(summary.totalRecords, 3);
  assert.strictEqual(summary.totalQuantityLoss, 30);
  assert.strictEqual(summary.totalValueLoss, 925000);
  assert.strictEqual(summary.shrinkageRatePercent, 6.0);
  assert.strictEqual(summary.byReason.DAMAGED_CRUSHED.quantity, 10);
  assert.strictEqual(summary.byReason.EXPIRED.quantity, 5);
  assert.strictEqual(summary.byReason.QUALITY_DEGRADED.quantity, 15);
});

// ============================================================================
// 5. Type-safe Zod Schema Validation Tests
// ============================================================================
test('Zod schemas enforce validation and catch invalid data structures', () => {
  // Negative initialQuantity should throw
  assert.throws(() => {
    BatchItemSchema.parse({
      batchId: 'B-01',
      productId: 'P-01',
      productName: 'Bánh Tart Trứng',
      initialQuantity: -5,
      currentQuantity: 0,
      importedAt: new Date(),
      expiresAt: new Date(),
    });
  });

  // Empty batchId should throw
  assert.throws(() => {
    BatchItemSchema.parse({
      batchId: '',
      productId: 'P-01',
      productName: 'Bánh Tart Trứng',
      initialQuantity: 10,
      currentQuantity: 10,
      importedAt: new Date(),
      expiresAt: new Date(),
    });
  });

  // Valid Shrinkage Record parses successfully
  const validShrinkage = ShrinkageRecordSchema.parse({
    id: 'SHR-001',
    productId: 'P-99',
    productName: 'Dâu tây Đà Lạt',
    quantity: 2.5,
    unit: 'kg',
    unitCost: 200000,
    totalLossValue: 500000,
    reason: 'SAMPLE_TASTING',
    loggedAt: new Date().toISOString(),
  });
  assert.strictEqual(validShrinkage.reason, 'SAMPLE_TASTING');

  // Valid StockAlertPayload parses successfully
  const validAlert = StockAlertPayloadSchema.parse({
    alertId: 'ALT-01',
    productId: 'P-01',
    productName: 'Croissant Bơ Pháp',
    unit: 'cái',
    currentStock: 2,
    usableStock: 2,
    expiredStock: 0,
    minStockThreshold: 10,
    stockStatus: 'CRITICAL_LOW',
    expiringBatchesCount: 0,
    recommendedReorderQty: 18,
    severity: 'ERROR',
    message: 'Tồn kho thấp',
    timestamp: new Date(),
  });
  assert.strictEqual(validAlert.stockStatus, 'CRITICAL_LOW');
});
