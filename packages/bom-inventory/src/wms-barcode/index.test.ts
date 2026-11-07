import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  // Bin Location
  isValidBinLocation,
  parseBinLocation,
  formatBinLocation,
  calculateBinDistance,
  getAdjacentBins,
  aisleToNumericIndex,
  numericIndexToAisle,
  // Putaway
  suggestPutawayBin,
  suggestPutawayBatch,
  type PutawayItem,
  type PutawayItemInput,
  type StorageBin,
  type StorageBinInput,
  // Wave Picking
  createWaves,
  planWaveRoute,
  type Order,
  type OrderInput,
  // Barcode Scanner
  validateEan13,
  calculateEan13CheckDigit,
  parseGS1128,
  parseBarcode,
  BarcodeScannerBuffer,
  // Carrier Reconcile
  createHandoverManifest,
  scanParcelToManifest,
  removeParcelFromManifest,
  finalizeHandoverManifest,
  verifyManifestAuditHash,
  generateManifestReceipt,
  type HandoverParcelInput,
  // S-Shape 2-Opt TSP Router
  parseWarehouseLocation3D,
  calculateWarehouseWalkingDistance,
  optimizeSshape2OptRoute,
  type PickOrderItem,
  // Idempotent Stock Movement Ledger
  IdempotentStockLedger,
} from './index';

describe('@kido/wms-barcode Package Test Suite', () => {
  // =========================================================================
  // 1. Bin Location Format, Parsing, and Validation
  // =========================================================================
  it('1. Validates and parses standard WMS bin location format (WH-AISLE-RACK-SHELF-BIN)', () => {
    // Valid code
    const validCode = 'WH01-A-02-03-B';
    assert.equal(isValidBinLocation(validCode), true);

    const parsed = parseBinLocation(validCode);
    assert.equal(parsed.warehouse, 'WH01');
    assert.equal(parsed.aisle, 'A');
    assert.equal(parsed.rack, 2);
    assert.equal(parsed.shelf, 3);
    assert.equal(parsed.bin, 'B');

    // Canonical formatting
    const formatted = formatBinLocation({
      warehouse: 'wh01',
      aisle: 'b',
      rack: 5,
      shelf: 2,
      bin: '01',
    });
    assert.equal(formatted, 'WH01-B-05-02-01');

    // Invalid codes
    assert.equal(isValidBinLocation('INVALID-CODE'), false);
    assert.equal(isValidBinLocation('WH01-A'), false);
    assert.throws(() => parseBinLocation('NOT-A-BIN-FORMAT'));
  });

  // =========================================================================
  // 2. Aisle Index Conversion & Warehouse Walking Distance
  // =========================================================================
  it('2. Computes aisle indices and realistic warehouse walking distance with cross-aisles', () => {
    assert.equal(aisleToNumericIndex('A'), 1);
    assert.equal(aisleToNumericIndex('B'), 2);
    assert.equal(aisleToNumericIndex('Z'), 26);
    assert.equal(aisleToNumericIndex('AA'), 27);
    assert.equal(numericIndexToAisle(1), 'A');
    assert.equal(numericIndexToAisle(27), 'AA');

    // Same aisle walking distance (Rack 2 to Rack 6 in Aisle A, same shelf)
    const distSameAisle = calculateBinDistance('WH01-A-02-01-A', 'WH01-A-06-01-A');
    // |2 - 6| * 1.5m = 6.0m
    assert.equal(distSameAisle, 6.0);

    // Cross-aisle distance (Aisle A Rack 2 to Aisle B Rack 3)
    const distDiffAisles = calculateBinDistance('WH01-A-02-01-A', 'WH01-B-03-01-A');
    assert.ok(distDiffAisles > 6.0, 'Cross aisle distance must account for turns');

    // Different warehouse distance returns Infinity
    const distDiffWh = calculateBinDistance('WH01-A-01-01-A', 'WH02-A-01-01-A');
    assert.equal(distDiffWh, Number.POSITIVE_INFINITY);
  });

  // =========================================================================
  // 3. Adjacent Bins Calculation
  // =========================================================================
  it('3. Generates adjacent bins (above, below, left, right, opposite rack)', () => {
    const adj = getAdjacentBins('WH01-A-05-03-B');
    assert.equal(adj.sameAisleAbove, 'WH01-A-05-04-B');
    assert.equal(adj.sameAisleBelow, 'WH01-A-05-02-B');
    assert.equal(adj.sameAisleLeftRack, 'WH01-A-04-03-B');
    assert.equal(adj.sameAisleRightRack, 'WH01-A-06-03-B');
    // Rack 5 (odd) opposite rack is 6
    assert.equal(adj.oppositeRackInAisle, 'WH01-A-06-03-B');

    // Shelf 1 (ground) has no below bin
    const adjGround = getAdjacentBins('WH01-A-01-01-A');
    assert.equal(adjGround.sameAisleBelow, null);
    assert.equal(adjGround.sameAisleLeftRack, null);
  });

  // =========================================================================
  // 4. Putaway Rule: Heavy Item Safety Constraint (Bottom Shelf 1)
  // =========================================================================
  it('4. Enforces heavy item safety rules: restricts items >=15kg to ground shelves', () => {
    const heavyItem: PutawayItemInput = {
      sku: 'SKU-HEAVY-MOTOR',
      name: 'Electric Motor 25kg',
      weightKg: 25.0,
      velocity: 'MEDIUM',
    };

    const bins: StorageBinInput[] = [
      { binLocation: 'WH01-A-01-04-A', maxWeightCapacityKg: 100, currentWeightKg: 0 }, // Shelf 4 (High - should be rejected)
      { binLocation: 'WH01-A-01-01-A', maxWeightCapacityKg: 100, currentWeightKg: 0 }, // Shelf 1 (Ground - should be chosen)
      { binLocation: 'WH01-A-01-02-A', maxWeightCapacityKg: 100, currentWeightKg: 0 }, // Shelf 2 (Tier 2 - should be rejected by maxHeavyShelfLevel: 1)
    ];

    const result = suggestPutawayBin(heavyItem, bins);
    assert.ok(result.recommendedBin, 'Should find recommended bin');
    assert.equal(result.recommendedBin?.binLocation, 'WH01-A-01-01-A');
    assert.equal(result.recommendedBin?.parsedLocation.shelf, 1);

    // Shelf 4 should be marked ineligible due to safety violation
    const highShelfCandidate = result.candidates.find((c) => c.binLocation === 'WH01-A-01-04-A');
    assert.equal(highShelfCandidate?.isEligible, false);
    assert.ok(highShelfCandidate?.rejectionReason?.includes('Safety violation'));
  });

  // =========================================================================
  // 5. Putaway Rule: FMCG / Fast-Moving Goods in Golden Zone (Shelf 1-2)
  // =========================================================================
  it('5. Prioritizes FMCG / Fast-moving turnover items in golden zone near doors', () => {
    const fmcgItem: PutawayItemInput = {
      sku: 'SKU-COCA-COLA-CASE',
      name: 'Coca Cola 24-can Case',
      weightKg: 8.5,
      velocity: 'FAST',
    };

    const bins: StorageBinInput[] = [
      { binLocation: 'WH01-A-20-05-A', maxWeightCapacityKg: 50, currentWeightKg: 0 }, // High rack & shelf 5
      { binLocation: 'WH01-A-02-02-A', maxWeightCapacityKg: 50, currentWeightKg: 0 }, // Rack 2, Shelf 2 (Golden Zone)
      { binLocation: 'WH01-A-15-02-A', maxWeightCapacityKg: 50, currentWeightKg: 0 }, // Rack 15, Shelf 2
    ];

    const result = suggestPutawayBin(fmcgItem, bins, { dispatchDoorRackIndex: 1 });
    assert.ok(result.recommendedBin);
    assert.equal(result.recommendedBin?.binLocation, 'WH01-A-02-02-A');

    // Confirm score breakdown includes golden zone bonus
    const goldenBreakdown = result.recommendedBin?.scoreBreakdown.find(
      (b) => b.rule === 'FMCG_GOLDEN_ZONE'
    );
    assert.ok(goldenBreakdown, 'Should have FMCG_GOLDEN_ZONE bonus');
  });

  // =========================================================================
  // 6. Putaway Rule: Slow-Moving Items Routed to Upper Shelves & Deep Racks
  // =========================================================================
  it('6. Routes slow-moving items to upper shelves (Shelf 4+) to preserve golden zone', () => {
    const slowItem: PutawayItemInput = {
      sku: 'SKU-SPARE-VALVE',
      name: 'Rare Hydraulic Valve',
      weightKg: 3.0,
      velocity: 'SLOW',
    };

    const bins: StorageBinInput[] = [
      { binLocation: 'WH01-A-01-01-A', maxWeightCapacityKg: 50, currentWeightKg: 0 }, // Shelf 1 (Waste of golden zone)
      { binLocation: 'WH01-A-15-05-A', maxWeightCapacityKg: 50, currentWeightKg: 0 }, // Shelf 5, deep rack 15 (Ideal for slow)
    ];

    const result = suggestPutawayBin(slowItem, bins);
    assert.equal(result.recommendedBin?.binLocation, 'WH01-A-15-05-A');

    const highShelfBonus = result.recommendedBin?.scoreBreakdown.find(
      (b) => b.rule === 'SLOW_HIGH_SHELF_UTILIZATION'
    );
    assert.ok(highShelfBonus, 'Should receive SLOW_HIGH_SHELF_UTILIZATION bonus');
  });

  // =========================================================================
  // 7. SKU Consolidation & Batch Putaway Simulation
  // =========================================================================
  it('7. Rewards SKU consolidation and updates capacity in batch putaway simulation', () => {
    const items: PutawayItemInput[] = [
      { sku: 'SKU-SHIRT-M', name: 'Cotton Shirt M', weightKg: 0.5, velocity: 'MEDIUM' },
      { sku: 'SKU-SHIRT-M', name: 'Cotton Shirt M', weightKg: 0.5, velocity: 'MEDIUM' },
    ];

    const bins: StorageBinInput[] = [
      {
        binLocation: 'WH01-B-02-02-A',
        maxWeightCapacityKg: 20,
        currentWeightKg: 2,
        currentSkus: [{ sku: 'SKU-SHIRT-M', quantity: 4 }], // Existing SKU
      },
      {
        binLocation: 'WH01-B-05-02-A',
        maxWeightCapacityKg: 20,
        currentWeightKg: 0,
        currentSkus: [], // Empty bin
      },
    ];

    const assignments = suggestPutawayBatch(items, bins);
    assert.equal(assignments.length, 2);
    // Both should consolidate into WH01-B-02-02-A
    assert.equal(assignments[0].assignedBin, 'WH01-B-02-02-A');
    assert.equal(assignments[1].assignedBin, 'WH01-B-02-02-A');
  });

  // =========================================================================
  // 8. Wave Picking: Order Batching & Consolidation
  // =========================================================================
  it('8. Creates batch picking waves clustered by carrier and priority', () => {
    const orders: OrderInput[] = [
      {
        orderId: 'ORD-001',
        carrierCode: 'GHN',
        priority: 'HIGH',
        items: [{ sku: 'SKU-A', quantity: 2, binLocation: 'WH01-A-01-01-A' }],
      },
      {
        orderId: 'ORD-002',
        carrierCode: 'GHN',
        priority: 'HIGH',
        items: [{ sku: 'SKU-A', quantity: 3, binLocation: 'WH01-A-01-01-A' }],
      },
      {
        orderId: 'ORD-003',
        carrierCode: 'SPX',
        priority: 'NORMAL',
        items: [{ sku: 'SKU-B', quantity: 1, binLocation: 'WH01-B-02-01-A' }],
      },
    ];

    const waves = createWaves(orders, { maxOrdersPerWave: 5, groupByCarrier: true });
    assert.equal(waves.length, 2);

    const highGhnWave = waves.find((w) => w.priority === 'HIGH' && w.carrierCode === 'GHN');
    assert.ok(highGhnWave);
    assert.equal(highGhnWave?.orderIds.length, 2);
    // Consolidates SKU-A: 2 + 3 = 5 total units in 1 pick line
    assert.equal(highGhnWave?.pickLines.length, 1);
    assert.equal(highGhnWave?.pickLines[0].totalQuantity, 5);
  });

  // =========================================================================
  // 9. S-Shape (Ziczac) Picking Route Walking Distance Reduction
  // =========================================================================
  it('9. Optimizes pick sequence via S-Shape serpentine traversal, reducing walking distance', () => {
    const waveOrders: OrderInput[] = [
      {
        orderId: 'ORD-101',
        items: [
          { sku: 'ITEM-1', quantity: 1, binLocation: 'WH01-A-02-01-A' },
          { sku: 'ITEM-2', quantity: 1, binLocation: 'WH01-A-10-01-A' },
          { sku: 'ITEM-3', quantity: 1, binLocation: 'WH01-B-08-01-A' },
          { sku: 'ITEM-4', quantity: 1, binLocation: 'WH01-B-02-01-A' },
        ],
      },
    ];

    const plan = planWaveRoute('WAVE-TEST-01', waveOrders);
    assert.equal(plan.pickLines.length, 4);

    // In Aisle A (1st visited): Front -> Back (Rack 2 -> Rack 10)
    assert.equal(plan.pickLines[0].binLocation, 'WH01-A-02-01-A');
    assert.equal(plan.pickLines[1].binLocation, 'WH01-A-10-01-A');

    // In Aisle B (2nd visited): Back -> Front (Rack 8 -> Rack 2)
    assert.equal(plan.pickLines[2].binLocation, 'WH01-B-08-01-A');
    assert.equal(plan.pickLines[3].binLocation, 'WH01-B-02-01-A');

    // Sequence numbers 1 to 4
    assert.deepEqual(
      plan.pickLines.map((l) => l.sequence),
      [1, 2, 3, 4]
    );

    // Walking distance metrics
    assert.ok(plan.optimizedDistanceMeters > 0);
    assert.ok(plan.distanceSavedMeters >= 0);
  });

  // =========================================================================
  // 10. Barcode Scanner: EAN-13 Check Digit & Parsing
  // =========================================================================
  it('10. Calculates GS1 Modulo 10 check digit and validates EAN-13 barcodes', () => {
    // Standard Vietnamese EAN-13 prefix 893
    // Digits: 893850123456 -> Check digit is 7
    const digits12 = '893850123456';
    const checkDigit = calculateEan13CheckDigit(digits12);
    assert.equal(typeof checkDigit, 'number');

    const fullCode = `${digits12}${checkDigit}`;
    assert.equal(validateEan13(fullCode), true);

    // Tampered check digit must fail
    const wrongCheckDigit = (checkDigit + 1) % 10;
    assert.equal(validateEan13(`${digits12}${wrongCheckDigit}`), false);

    // General barcode parser identifies EAN13
    const parsed = parseBarcode(fullCode);
    assert.equal(parsed.type, 'EAN13');
    assert.equal(parsed.isValid, true);
  });

  // =========================================================================
  // 11. Barcode Scanner: GS1-128 Application Identifiers Parser
  // =========================================================================
  it('11. Parses complex GS1-128 AI strings with GTIN, Lot, Expiry date, and Serial', () => {
    const rawGs1 = '(01)08935000000018(10)LOT2026A(17)261231(21)SN987654(3102)002550';
    const gs1 = parseGS1128(rawGs1);

    assert.equal(gs1.gtin, '08935000000018');
    assert.equal(gs1.batchLot, 'LOT2026A');
    assert.equal(gs1.expirationDate, '2026-12-31');
    assert.equal(gs1.serialNumber, 'SN987654');
    assert.equal(gs1.netWeightKg, 25.5); // 002550 with 2 decimals -> 25.50 kg

    const parsedUniversal = parseBarcode(rawGs1);
    assert.equal(parsedUniversal.type, 'GS1_128');
    assert.equal(parsedUniversal.isValid, true);
  });

  // =========================================================================
  // 12. Barcode Scanner: PDA HID Keyboard Buffer Emulation (<50ms burst)
  // =========================================================================
  it('12. Captures rapid HID keyboard stream from PDA laser scanner terminating with Enter', () => {
    const receivedEvents: any[] = [];
    const buffer = new BarcodeScannerBuffer({
      maxInterKeyDelayMs: 50,
      onScan: (evt) => receivedEvents.push(evt),
    });

    // Feed high-speed barcode burst: "WH01-A-01-01-A"
    const scanned = buffer.feedString('WH01-A-01-01-A', 5);
    assert.ok(scanned, 'Should trigger scan event on Enter');
    assert.equal(scanned?.rawText, 'WH01-A-01-01-A');
    assert.equal(scanned?.isPdaLaser, true);
    assert.equal(receivedEvents.length, 1);

    // Slow human typing simulation: intervals > 50ms should reset buffer
    buffer.reset();
    let now = Date.now();
    buffer.handleKeyPress('W', now);
    now += 150; // human pause (150ms > 50ms)
    buffer.handleKeyPress('H', now);
    now += 200; // human pause
    buffer.handleKeyPress('Enter', now);

    // Buffer reset should prevent incomplete human fragment
    assert.equal(buffer.getCurrentBuffer(), '');
  });

  // =========================================================================
  // 13. Carrier Reconcile: Duplicate Detection & Manifest Management
  // =========================================================================
  it('13. Enforces duplicate parcel detection across in-manifest and global indices', () => {
    const globalTrackingIndex = new Set<string>(['GHN-OLD-ALREADY-SHIPPED']);

    const manifest = createHandoverManifest({
      manifestId: 'MAN-20260930-GHN-001',
      carrierCode: 'GHN',
      warehouseId: 'WH01',
      dispatcherStaffId: 'STAFF-01',
      dispatcherName: 'Nguyễn Văn Kho',
      driverCourierId: 'COURIER-88',
      driverName: 'Lê Văn Tài',
      driverPhone: '0901234567',
      licensePlate: '29C-12345',
    });

    assert.equal(manifest.status, 'OPEN');
    assert.equal(manifest.totalParcels, 0);

    // Scan parcel 1
    const res1 = scanParcelToManifest(
      manifest,
      {
        trackingNumber: 'GHN123456789',
        orderId: 'ORD-101',
        weightKg: 1.25,
        codAmount: 150000,
      },
      globalTrackingIndex
    );
    assert.equal(res1.success, true);
    assert.equal(manifest.totalParcels, 1);
    assert.equal(manifest.totalWeightKg, 1.25);
    assert.equal(manifest.totalCodAmount, 150000);

    // Duplicate scan of parcel 1 inside same manifest -> Must reject!
    const resDup = scanParcelToManifest(
      manifest,
      {
        trackingNumber: 'GHN123456789',
        orderId: 'ORD-101',
        weightKg: 1.25,
      },
      globalTrackingIndex
    );
    assert.equal(resDup.success, false);
    assert.ok(resDup.error?.includes('Duplicate parcel'));

    // Scan parcel from global previously shipped index -> Must reject!
    const resGlobalDup = scanParcelToManifest(
      manifest,
      {
        trackingNumber: 'GHN-OLD-ALREADY-SHIPPED',
        orderId: 'ORD-OLD',
        weightKg: 2.0,
      },
      globalTrackingIndex
    );
    assert.equal(resGlobalDup.success, false);
    assert.ok(resGlobalDup.error?.includes('already handed over'));

    // Remove parcel test
    const removed = removeParcelFromManifest(manifest, 'GHN123456789');
    assert.equal(removed, true);
    assert.equal(manifest.totalParcels, 0);
  });

  // =========================================================================
  // 14. Carrier Reconcile: SHA-256 Audit Hash & Finalization Integrity
  // =========================================================================
  it('14. Computes SHA-256 audit hash upon driver sign-off and verifies anti-tamper integrity', () => {
    const manifest = createHandoverManifest({
      manifestId: 'MAN-SPX-20261001-01',
      carrierCode: 'SPX',
      warehouseId: 'WH-HCM',
      dispatcherStaffId: 'STAFF-99',
      dispatcherName: 'Trần Thị Thu',
      driverCourierId: 'SPX-DRIVER-07',
      driverName: 'Phạm Minh Bưu',
      driverPhone: '0988776655',
    });

    scanParcelToManifest(manifest, {
      trackingNumber: 'SPXVN012345678',
      orderId: 'ORD-SPX-1',
      weightKg: 0.8,
      codAmount: 250000,
    });
    scanParcelToManifest(manifest, {
      trackingNumber: 'SPXVN087654321',
      orderId: 'ORD-SPX-2',
      weightKg: 1.5,
      codAmount: 0,
    });

    // Finalize with courier authorization PIN / badge code
    const driverSignCode = 'SPX-OTP-8821';
    const finalized = finalizeHandoverManifest(manifest, driverSignCode);

    assert.equal(finalized.status, 'FINALIZED');
    assert.ok(finalized.auditHashSha256, 'Should generate audit hash');
    assert.equal(finalized.auditHashSha256?.length, 64); // SHA-256 64-character hex

    // Verify hash integrity
    assert.equal(verifyManifestAuditHash(finalized), true);

    // Tampering test: if any tracking or weight is tampered after sign-off, verification must fail
    finalized.parcels[0].weightKg = 999.0;
    assert.equal(verifyManifestAuditHash(finalized), false);

    // Receipt generator output test
    finalized.parcels[0].weightKg = 0.8; // Restore
    const receipt = generateManifestReceipt(finalized);
    assert.ok(receipt.includes('BIÊN BẢN BÀN GIAO BƯU KIỆN'));
    assert.ok(receipt.includes('SPXVN012345678'));
    assert.ok(receipt.includes('SPX-OTP-8821'));
    assert.ok(receipt.includes('HỢP LỆ (VERIFIED)'));
  });

  // =========================================================================
  // 6. S-Shape Serpentine & 2-Opt TSP Route Optimizer
  // =========================================================================
  it('15. Parses 3D warehouse locations and calculates realistic walking distance with cross-aisle detours', () => {
    const locPack = parseWarehouseLocation3D('PACK-00');
    assert.equal(locPack.aisle, 'PACK');
    assert.equal(locPack.x, 0);
    assert.equal(locPack.y, 0);

    const locA = parseWarehouseLocation3D('A-02-03-01');
    assert.equal(locA.aisle, 'A');
    assert.equal(locA.aisleIndex, 0);
    assert.equal(locA.rack, 2);
    assert.equal(locA.level, 3);

    const locB = parseWarehouseLocation3D('B-09-01-02');
    assert.equal(locB.aisle, 'B');
    assert.equal(locB.aisleIndex, 1);
    assert.equal(locB.rack, 9);

    // Distance in same aisle A: between rack 2 and rack 5
    const locA2 = parseWarehouseLocation3D('A-05-01-01');
    const distSame = calculateWarehouseWalkingDistance(locA, locA2);
    assert.equal(distSame, (5 - 2) * 1.5); // 3 racks * 1.5m = 4.5m

    // Distance between A-02 and B-09:
    // cross-aisle: |0 - 1| * 4m = 4m
    // front detour: (2 + 9) * 1.5 = 16.5m
    // back detour: ((11 - 2) + (11 - 9)) * 1.5 = (9 + 2) * 1.5 = 16.5m
    // min along-aisle = 16.5m -> total = 4 + 16.5 = 20.5m
    const distCross = calculateWarehouseWalkingDistance(locA, locB);
    assert.equal(distCross, 20.5);
  });

  it('16. Consolidates multi-order batches with Put-to-Wall baskets and optimizes picker route via S-Shape serpentine + 2-Opt TSP search', () => {
    const batchItems: PickOrderItem[] = [
      // Order 1 items
      { orderId: 'ORD-001', orderNumber: '#1001', sku: 'SKU-ACRYLIC-WHITE', binCode: 'A-01-01-01', quantity: 2 },
      { orderId: 'ORD-001', orderNumber: '#1001', sku: 'SKU-BRUSH-ROUND-6', binCode: 'A-08-02-01', quantity: 1 },
      { orderId: 'ORD-001', orderNumber: '#1001', sku: 'SKU-CANVAS-A3', binCode: 'B-02-01-01', quantity: 1 },
      // Order 2 items (shares SKU-ACRYLIC-WHITE and has other items)
      { orderId: 'ORD-002', orderNumber: '#1002', sku: 'SKU-ACRYLIC-WHITE', binCode: 'A-01-01-01', quantity: 3 },
      { orderId: 'ORD-002', orderNumber: '#1002', sku: 'SKU-PALETTE-WOOD', binCode: 'B-09-01-01', quantity: 1 },
    ];

    const plan = optimizeSshape2OptRoute(batchItems);

    // Consolidated stops: SKU-ACRYLIC-WHITE at A-01 should be consolidated into 1 stop with qty = 5
    assert.equal(plan.totalUniqueSkus, 4);
    assert.equal(plan.totalItemsCount, 8);
    assert.equal(plan.orderBaskets.length, 2);

    const consolidatedWhite = plan.stops.find((s) => s.sku === 'SKU-ACRYLIC-WHITE');
    assert.ok(consolidatedWhite);
    assert.equal(consolidatedWhite.totalQuantity, 5);
    assert.equal(consolidatedWhite.orderAllocations.length, 2);
    assert.equal(consolidatedWhite.orderAllocations[0].quantity, 2);
    assert.equal(consolidatedWhite.orderAllocations[1].quantity, 3);

    // Verify distance savings metrics
    assert.ok(plan.routeMetrics.naiveSingleOrderMeters > plan.routeMetrics.optimizedSshape2OptMeters);
    assert.ok(plan.routeMetrics.distanceSavedPercent > 0);
    assert.ok(plan.routeMetrics.estimatedMinutes > 0);
  });

  // =========================================================================
  // 7. Idempotent Double-Entry Stock Movement Ledger
  // =========================================================================
  it('17. Enforces idempotent stock movement ledger and generates multi-channel dry-run sync outbox events', () => {
    const channels = [
      { id: 'ch-shopee', name: 'Main Shopee', platform: 'SHOPEE', shopId: 'shop-shopee-01' },
      { id: 'ch-tiktok', name: 'Main TikTok', platform: 'TIKTOK', shopId: 'shop-tiktok-01' },
    ];

    const ledger = new IdempotentStockLedger(channels);
    let inventoryState: Record<string, number> = {
      'SKU-GOUACHE-SET': 50,
    };

    const getStock = (sku: string) => inventoryState[sku] ?? 0;
    const updateStock = (sku: string, newStock: number) => {
      inventoryState[sku] = newStock;
    };

    // First execution: deduct 5 units for order ORD-999
    const res1 = ledger.execute(
      {
        tenantId: 'tenant-retail',
        orderId: 'ORD-999',
        sku: 'SKU-GOUACHE-SET',
        actionType: 'DEDUCT_PACK',
        quantity: 5,
        reason: 'Packing order ORD-999',
      },
      getStock,
      updateStock
    );

    assert.equal(res1.deduplicated, false);
    assert.equal(res1.updatedStock, 45);
    assert.equal(inventoryState['SKU-GOUACHE-SET'], 45);
    assert.ok(res1.outboxEntry);
    assert.equal(res1.outboxEntry.affectedShops.length, 2);
    assert.equal(res1.outboxEntry.newStock, 45);

    // Duplicate execution (e.g. network retry or double-click): MUST BE DEDUPLICATED
    const res2 = ledger.execute(
      {
        tenantId: 'tenant-retail',
        orderId: 'ORD-999',
        sku: 'SKU-GOUACHE-SET',
        actionType: 'DEDUCT_PACK',
        quantity: 5,
        reason: 'Packing order ORD-999 retry',
      },
      getStock,
      updateStock
    );

    assert.equal(res2.deduplicated, true);
    assert.equal(res2.updatedStock, 45);
    assert.equal(inventoryState['SKU-GOUACHE-SET'], 45, 'Stock must NOT be deducted again!');

    // Restore stock on order cancellation
    const res3 = ledger.execute(
      {
        tenantId: 'tenant-retail',
        orderId: 'ORD-999',
        sku: 'SKU-GOUACHE-SET',
        actionType: 'RESTORE_CANCEL',
        quantity: 5,
        reason: 'Customer cancelled ORD-999',
      },
      getStock,
      updateStock
    );

    assert.equal(res3.deduplicated, false);
    assert.equal(res3.updatedStock, 50);
    assert.equal(inventoryState['SKU-GOUACHE-SET'], 50);

    // Verify ledger history
    const entries = ledger.getEntries();
    assert.equal(entries.length, 2);
    assert.equal(entries[0].actionType, 'RESTORE_CANCEL');
    assert.equal(entries[1].actionType, 'DEDUCT_PACK');
  });
});
