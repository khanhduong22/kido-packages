import assert from 'node:assert';
import test from 'node:test';
import {
  DEFAULT_FNB_RECIPES,
  InventoryRecord,
  Recipe,
  RecipeCatalog,
  analyzeStoreVariance,
  calculateItemVariance,
  calculateRecipeCost,
  convertUnit,
  createTransferOrder,
  dispatchTransfer,
  explodeBOM,
  explodeBatch,
  generateK80ReceiptData,
  verifyReceiveTransfer,
} from './index';

// ============================================================================
// 1. Unit Conversion Tests
// ============================================================================

test('convertUnit converts between weight and volume units correctly', () => {
  assert.strictEqual(convertUnit(1.5, 'kg', 'g'), 1500);
  assert.strictEqual(convertUnit(2500, 'g', 'kg'), 2.5);
  assert.strictEqual(convertUnit(2, 'l', 'ml'), 2000);
  assert.strictEqual(convertUnit(750, 'ml', 'l'), 0.75);
  assert.strictEqual(convertUnit(5, 'pcs', 'pcs'), 5);

  assert.throws(() => {
    convertUnit(10, 'kg' as any, 'ml' as any);
  }, /Cannot convert between incompatible units/);
});

// ============================================================================
// 2. Recipe Catalog & Multi-Level BOM Explosion Tests
// ============================================================================

test('RecipeCatalog registers and retrieves standard Vietnamese F&B recipes', () => {
  const catalog = new RecipeCatalog(DEFAULT_FNB_RECIPES);

  assert.strictEqual(catalog.getAllRecipes().length >= 14, true); // 10 finished + 4 semi-finished
  const traDao = catalog.getRecipe('RECIPE-TRA-DAO-CAM-SA');
  assert.ok(traDao);
  assert.strictEqual(traDao?.name, 'Trà Đào Cam Sả Tươi (Size L 500ml)');
  assert.strictEqual(traDao?.type, 'FINISHED_PRODUCT');

  const subKemMuoi = catalog.getRecipe('SUB-KEM-MUOI');
  assert.ok(subKemMuoi);
  assert.strictEqual(subKemMuoi?.type, 'SEMI_FINISHED');
});

test('explodeBOM resolves 1-level and multi-level components for Trà Đào Cam Sả', () => {
  const catalog = new RecipeCatalog(DEFAULT_FNB_RECIPES);
  const result = explodeBOM('RECIPE-TRA-DAO-CAM-SA', 1, catalog, { includeWaste: true });

  assert.strictEqual(result.recipeId, 'RECIPE-TRA-DAO-CAM-SA');
  assert.strictEqual(result.quantity, 1);

  // Check packaging presence
  const ly = result.packaging.find((p) => p.itemId === 'BB-LY-PP-500');
  const nap = result.packaging.find((p) => p.itemId === 'BB-NAP-KIM-CUONG');
  const ongHut = result.packaging.find((p) => p.itemId === 'BB-ONG-HUT-BOC-MANG');
  assert.ok(ly, 'Ly nhựa phải có trong kết quả phân rã');
  assert.ok(nap, 'Nắp phải có trong kết quả phân rã');
  assert.ok(ongHut, 'Ống hút phải có trong kết quả phân rã');

  // Check multi-level resolution: Sub-recipe Nước Đường was decomposed into Đường Cát and Nước Lọc
  const duongCat = result.rawMaterials.find((m) => m.itemId === 'NL-DUONG-CAT');
  assert.ok(duongCat, 'Đường cát từ công thức cấp con (Nước Đường 1:1) phải được giải phóng ra raw materials');
  assert.strictEqual(duongCat?.parentRecipeNames.includes('Trà Đào Cam Sả Tươi (Size L 500ml)'), true);

  // Verify total cost is positive and reasonable for 1 cup (selling price 45,000đ)
  assert.strictEqual(result.totalCost > 5000 && result.totalCost < 35000, true);
});

test('explodeBOM scales quantities proportionally for 50 cups of Trà Sữa Trân Châu Hoàng Kim', () => {
  const catalog = new RecipeCatalog(DEFAULT_FNB_RECIPES);
  const qty = 50;
  const result = explodeBOM('RECIPE-TS-HOANG-KIM', qty, catalog, { includeWaste: false });

  assert.strictEqual(result.quantity, 50);

  // 1 cup has 20g trà đen -> 50 cups = 1000g trà đen
  const traDen = result.rawMaterials.find((m) => m.itemId === 'NL-TRA-DEN-OPA');
  assert.ok(traDen);
  assert.strictEqual(traDen?.totalQuantity, 1000);

  // 1 cup has 35g bột sữa -> 50 cups = 1750g bột sữa
  const botSua = result.rawMaterials.find((m) => m.itemId === 'NL-BOT-SUA-BEO');
  assert.ok(botSua);
  assert.strictEqual(botSua?.totalQuantity, 1750);

  // 1 cup uses 50g trân châu hoàng kim bán thành phẩm.
  // Trân châu hoàng kim recipe yields 1000g with 500g hạt trân châu khô.
  // 50 cups * 50g = 2500g trân châu chín.
  // 2500g trân châu chín cần: 2500 * (500/1000) = 1250g hạt trân châu khô.
  const hatTcKho = result.rawMaterials.find((m) => m.itemId === 'NL-HAT-TC-KHO');
  assert.ok(hatTcKho);
  assert.strictEqual(hatTcKho?.totalQuantity, 1250);
});

test('explodeBOM detects and prevents cyclic recipe dependencies', () => {
  const badRecipe1: Recipe = {
    id: 'REC-CYCLIC-A',
    sku: 'CYC-A',
    name: 'Cyclic A',
    category: 'Test',
    type: 'FINISHED_PRODUCT',
    yieldQuantity: 1,
    unit: 'pcs',
    components: [
      {
        itemId: 'REC-CYCLIC-B',
        name: 'Cyclic B',
        type: 'SEMI_FINISHED',
        quantity: 1,
        unit: 'pcs',
        isSubRecipe: true,
        subRecipeId: 'REC-CYCLIC-B',
      },
    ],
  };

  const badRecipe2: Recipe = {
    id: 'REC-CYCLIC-B',
    sku: 'CYC-B',
    name: 'Cyclic B',
    category: 'Test',
    type: 'SEMI_FINISHED',
    yieldQuantity: 1,
    unit: 'pcs',
    components: [
      {
        itemId: 'REC-CYCLIC-A',
        name: 'Cyclic A',
        type: 'SEMI_FINISHED',
        quantity: 1,
        unit: 'pcs',
        isSubRecipe: true,
        subRecipeId: 'REC-CYCLIC-A',
      },
    ],
  };

  const catalog = new RecipeCatalog([badRecipe1, badRecipe2]);

  assert.throws(() => {
    explodeBOM('REC-CYCLIC-A', 1, catalog);
  }, /Phát hiện vòng lặp đệ quy trong BOM/);
});

test('explodeBatch simulates multiple drinks sold at POS and aggregates materials', () => {
  const catalog = new RecipeCatalog(DEFAULT_FNB_RECIPES);
  const orderItems = [
    { recipeId: 'RECIPE-TRA-DAO-CAM-SA', quantity: 30 },
    { recipeId: 'RECIPE-CF-MUOI', quantity: 20 },
    { recipeId: 'RECIPE-TS-HOANG-KIM', quantity: 50 },
  ];

  const batchResult = explodeBatch(orderItems, catalog);
  assert.strictEqual(batchResult.totalOrders, 3);
  assert.strictEqual(batchResult.totalQuantity, 100);
  assert.strictEqual(batchResult.perRecipeResults.length, 3);
  assert.strictEqual(batchResult.aggregatedMaterials.length > 5, true);

  // Verify Robusta coffee from 20 Cà phê muối: 20 * 25g * (1 + 0.02 waste) = 510g
  const cfRobusta = batchResult.aggregatedMaterials.find(
    (m) => m.itemId === 'NL-CA-PHE-ROBUSTA'
  );
  assert.ok(cfRobusta);
  assert.strictEqual(cfRobusta?.totalQuantity, 510);
});

test('calculateRecipeCost calculates accurate COGS', () => {
  const catalog = new RecipeCatalog(DEFAULT_FNB_RECIPES);
  const cost = calculateRecipeCost('RECIPE-CF-MUOI', catalog);
  assert.strictEqual(cost > 0, true);
  assert.strictEqual(cost < 38000, true); // Cost should be less than retail selling price 38,000 VND
});

// ============================================================================
// 3. Variance Analyzer & Leakage Alert Tests
// ============================================================================

test('calculateItemVariance categorizes NORMAL variance correctly', () => {
  const record: InventoryRecord = {
    itemId: 'NL-TRA-LAI-KHO',
    name: 'Trà Lài Bảo Lộc',
    unit: 'g',
    unitCost: 280,
    openingStock: 5000,
    transfersIn: 2000,
    transfersOut: 0,
    theoreticalUsage: 3000,
    actualCount: 3970, // theoreticalClosing = 5000 + 2000 - 3000 = 4000. Actual = 3970 -> diff = -30g (-1%)
  };

  const result = calculateItemVariance(record);
  assert.strictEqual(result.theoreticalClosing, 4000);
  assert.strictEqual(result.varianceQty, -30);
  assert.strictEqual(result.variancePercent, -1);
  assert.strictEqual(result.severity, 'NORMAL');
  assert.strictEqual(result.suggestedReason, 'NORMAL_TOLERANCE');
});

test('calculateItemVariance identifies CRITICAL and INVESTIGATION_REQUIRED leakage', () => {
  // Severe raw material shortage (> 10% or high financial loss)
  const record: InventoryRecord = {
    itemId: 'NL-WHIP-CREAM',
    name: 'Whipping Cream Anchor',
    unit: 'ml',
    unitCost: 110,
    openingStock: 10000,
    transfersIn: 5000,
    transfersOut: 0,
    theoreticalUsage: 6000,
    actualCount: 7500, // theoreticalClosing = 9000. Diff = -1500ml (-25%), cost = -165.000đ
  };

  const result = calculateItemVariance(record);
  assert.strictEqual(result.theoreticalClosing, 9000);
  assert.strictEqual(result.varianceQty, -1500);
  assert.strictEqual(result.variancePercent, -25);
  assert.strictEqual(result.severity, 'INVESTIGATION_REQUIRED');
  assert.strictEqual(result.suggestedReason, 'THEFT_OR_LEAKAGE');
});

test('analyzeStoreVariance detects covert material leakage when cups match but materials drop', () => {
  const records: InventoryRecord[] = [
    // Packaging matches nearly perfectly (< 1% variance)
    {
      itemId: 'BB-LY-PP-500',
      name: 'Ly Nhựa PP 500ml',
      unit: 'pcs',
      unitCost: 650,
      openingStock: 1000,
      transfersIn: 1000,
      transfersOut: 0,
      theoreticalUsage: 1200,
      actualCount: 798, // diff = -2 pcs (-0.17%) -> Normal
    },
    // Raw material 1 heavily depleted (-15%)
    {
      itemId: 'NL-SIRO-DAO',
      name: 'Siro Đào Monin',
      unit: 'ml',
      unitCost: 350,
      openingStock: 5000,
      transfersIn: 5000,
      transfersOut: 0,
      theoreticalUsage: 4000,
      actualCount: 5400, // theoreticalClosing = 6000 -> diff = -600ml (-15%)
    },
    // Raw material 2 heavily depleted (-12%)
    {
      itemId: 'NL-MATCHA-UJI',
      name: 'Bột Matcha Uji',
      unit: 'g',
      unitCost: 1200,
      openingStock: 1000,
      transfersIn: 500,
      transfersOut: 0,
      theoreticalUsage: 400,
      actualCount: 1052, // theoreticalClosing = 1100 -> diff = -48g (-12%)
    },
  ];

  const summary = analyzeStoreVariance('BRANCH-HOAN-KIEM', 'Chi nhánh Hoàn Kiếm', records);
  assert.strictEqual(summary.branchId, 'BRANCH-HOAN-KIEM');
  assert.strictEqual(summary.leakageAlert, true, 'Hệ thống phải bật cờ cảnh báo rò rỉ nguyên vật liệu');
  assert.strictEqual(summary.highRiskItemsCount >= 2, true);
  assert.strictEqual(summary.overallHealthScore < 80, true);
});

// ============================================================================
// 4. Store Transfer Order (STO) Workflow Tests
// ============================================================================

test('createTransferOrder creates valid STO with correct codes and items', () => {
  const order = createTransferOrder({
    sourceBranchId: 'CENTRAL-LONG-BIEN',
    sourceBranchName: 'Bếp Tổng Long Biên',
    destBranchId: 'BRANCH-CAU-GIAY',
    destBranchName: 'Chi nhánh Cầu Giấy',
    items: [
      {
        itemId: 'SUB-KEM-MUOI',
        name: 'Kem Muối Biển Hộp 500ml',
        category: 'Bán Thành Phẩm Bếp Tổng',
        requestedQty: 10,
        dispatchedQty: 10,
        unit: 'ml',
        unitCost: 42000,
      },
      {
        itemId: 'NL-TRA-LAI-KHO',
        name: 'Trà Lài Bảo Lộc (Gói 1kg)',
        category: 'Nguyên Liệu Khô',
        requestedQty: 5,
        dispatchedQty: 5,
        unit: 'kg',
        unitCost: 280000,
      },
    ],
  });

  assert.strictEqual(order.status, 'DRAFT');
  assert.strictEqual(order.orderCode.startsWith('STO-LB-CG-'), true);
  assert.strictEqual(order.items.length, 2);
  assert.strictEqual(order.totalItems, 2);
  assert.strictEqual(order.totalValue, 10 * 42000 + 5 * 280000);
  assert.strictEqual(order.hasDiscrepancy, false);
});

test('dispatchTransfer and verifyReceiveTransfer lifecycle with and without discrepancy', () => {
  // Create order
  const order = createTransferOrder({
    destBranchId: 'BRANCH-HOAN-KIEM',
    destBranchName: 'Chi nhánh Hoàn Kiếm',
    items: [
      {
        itemId: 'SUB-KEM-TRUNG',
        name: 'Kem Trứng Nướng Hộp 500ml',
        requestedQty: 6,
        dispatchedQty: 6,
        unit: 'pcs',
        unitCost: 48000,
      },
      {
        itemId: 'NL-SIRO-DAO',
        name: 'Siro Đào Chai 1000ml',
        requestedQty: 4,
        dispatchedQty: 4,
        unit: 'pcs',
        unitCost: 350000,
      },
    ],
  });

  // Dispatch transfer
  const dispatched = dispatchTransfer({
    order,
    driverName: 'Trần Văn Hoàng',
    vehiclePlate: '29H-882.35 (Xe Lạnh 1.5 Tấn)',
    sealNumber: 'SEAL-LB-9901',
    dispatchedBy: 'Thủ kho Nguyễn Tuấn',
  });

  assert.strictEqual(dispatched.status, 'DISPATCHED');
  assert.strictEqual(dispatched.driverName, 'Trần Văn Hoàng');
  assert.strictEqual(dispatched.sealNumber, 'SEAL-LB-9901');
  assert.ok(dispatched.dispatchedAt);

  // Case 1: Receive with discrepancy (Chi nhánh phát hiện hụt 1 hộp kem trứng)
  const receivedDiscrepancy = verifyReceiveTransfer({
    order: dispatched,
    scannedItems: [
      { itemId: 'SUB-KEM-TRUNG', receivedQty: 5, notes: 'Bể vỡ 1 hộp khi vận chuyển' },
      { itemId: 'NL-SIRO-DAO', receivedQty: 4 },
    ],
    receivedBy: 'Barista Trưởng Lê Linh',
    generalNotes: 'Thùng hàng có 1 hộp kem trứng bị móp bung nắp',
  });

  assert.strictEqual(receivedDiscrepancy.status, 'DISCREPANCY');
  assert.strictEqual(receivedDiscrepancy.hasDiscrepancy, true);
  assert.ok(receivedDiscrepancy.discrepancyNotes?.includes('thiếu -1'));

  // Case 2: Receive 100% full
  const receivedPerfect = verifyReceiveTransfer({
    order: dispatched,
    scannedItems: [
      { itemId: 'SUB-KEM-TRUNG', receivedQty: 6 },
      { itemId: 'NL-SIRO-DAO', receivedQty: 4 },
    ],
    receivedBy: 'Barista Trưởng Lê Linh',
  });

  assert.strictEqual(receivedPerfect.status, 'RECEIVED');
  assert.strictEqual(receivedPerfect.hasDiscrepancy, false);
});

test('generateK80ReceiptData formats thermal receipt layout properly', () => {
  const order = createTransferOrder({
    destBranchId: 'BRANCH-HA-DONG',
    destBranchName: 'Chi nhánh Hà Đông',
    items: [
      {
        itemId: 'NL-BOT-MATCHA-UJI',
        name: 'Bột Matcha Uji (Túi 500g)',
        requestedQty: 2,
        dispatchedQty: 2,
        unit: 'pcs',
        unitCost: 600000,
      },
    ],
  });

  const receipt = generateK80ReceiptData(order);
  assert.strictEqual(receipt.title, 'PHIẾU XUẤT ĐIỀU CHUYỂN BẾP TỔNG');
  assert.strictEqual(receipt.receiptNumber, order.orderCode);
  assert.strictEqual(receipt.lines.length, 1);
  assert.strictEqual(receipt.totalPackages, 1);
  assert.ok(receipt.signatures.dispatcher);
  assert.ok(receipt.signatures.transporter);
  assert.ok(receipt.signatures.receiver);
});
