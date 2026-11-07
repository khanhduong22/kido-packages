import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  GearItem,
  RentalBooking,
  createGearItem,
  createRentalBooking,
  checkGearConflict,
  isGearAvailable,
  findAvailableGear,
  InventoryTracker,
  ConsumablesMeter,
  HandoverAuditService,
  formatVND,
} from './index';

describe('@kido/equipment-rental Test Suite', () => {
  // Sample Gears Pool using createGearItem to ensure all defaults are populated
  const mockGears: GearItem[] = [
    createGearItem({
      id: 'GEAR-GLAMBOT-01',
      name: 'Glambot High-Speed Robotic Arm 4K',
      category: 'PHOTOBOOTH_GLAMBOT',
      serialNumber: 'GLM-2026-DN01',
      warehouseLocation: 'DA_NANG',
      status: 'AVAILABLE',
      standardAccessories: [
        'Dây nguồn 3 pha',
        'Cáp tín hiệu HDMI 10m',
        'Bệ đỡ sàn 50kg',
        'Màn hình cảm ứng 15 inch',
      ],
      accessoryCosts: {
        'Cáp tín hiệu HDMI 10m': 350_000,
        'Dây nguồn 3 pha': 500_000,
      },
      replacementValue: 150_000_000,
      dailyRate: 15_000_000,
    }),
    createGearItem({
      id: 'GEAR-MIRROR-01',
      name: 'Magic Mirror Photobooth 65 inch Gold Frame',
      category: 'MAGIC_MIRROR',
      serialNumber: 'MMR-2026-DN02',
      warehouseLocation: 'DA_NANG',
      status: 'AVAILABLE',
      standardAccessories: [
        'Khung gương viền vàng',
        'Dây nguồn 220V',
        'Máy in DNP DS620',
        'Đèn flash tròn',
      ],
      accessoryCosts: {
        'Dây nguồn 220V': 150_000,
      },
      replacementValue: 80_000_000,
      dailyRate: 8_000_000,
    }),
    createGearItem({
      id: 'GEAR-CAM-A7M4-SG',
      name: 'Sony Alpha A7 IV Mirrorless Camera',
      category: 'CAMERA_BODY',
      serialNumber: 'SNY-A74-HCM01',
      warehouseLocation: 'HO_CHI_MINH',
      status: 'AVAILABLE',
      standardAccessories: [
        'Pin NP-FZ100',
        'Sạc kép Sony',
        'Thẻ nhớ SD 128GB V90',
        'Dây đeo máy',
      ],
      accessoryCosts: {
        'Thẻ nhớ SD 128GB V90': 1_200_000,
        'Pin NP-FZ100': 1_500_000,
      },
      replacementValue: 48_000_000,
      dailyRate: 600_000,
    }),
    createGearItem({
      id: 'GEAR-LENS-2470-SG',
      name: 'Sony FE 24-70mm f/2.8 GM II Lens',
      category: 'LENS',
      serialNumber: 'SNY-2470-HCM02',
      warehouseLocation: 'HO_CHI_MINH',
      status: 'MAINTENANCE',
      standardAccessories: ['Cap trước', 'Cap sau', 'Hood che sáng', 'Filter B+W'],
      replacementValue: 42_000_000,
      dailyRate: 400_000,
    }),
  ];

  // ==========================================================================
  // 1. Double Booking Prevention & Interval Overlap Check with 2h Buffer
  // ==========================================================================
  describe('1. Double Booking & Buffer 2h Overlap Engine', () => {
    // Existing Booking: 2026-10-10 10:00 to 14:00 (Da Nang)
    const existingBookings: RentalBooking[] = [
      createRentalBooking({
        id: 'BOOKING-101',
        customerName: 'Vinpearl Luxury Wedding',
        gearIds: ['GEAR-GLAMBOT-01'],
        startTime: new Date('2026-10-10T10:00:00.000Z'),
        endTime: new Date('2026-10-10T14:00:00.000Z'),
        status: 'CONFIRMED',
        location: 'DA_NANG',
        setupBufferHours: 2,
        teardownBufferHours: 2,
        eventName: 'Vinpearl Wedding Show',
      }),
      createRentalBooking({
        id: 'BOOKING-102-CANCELLED',
        customerName: 'Cancelled Client',
        gearIds: ['GEAR-GLAMBOT-01'],
        startTime: new Date('2026-10-10T18:00:00.000Z'),
        endTime: new Date('2026-10-10T22:00:00.000Z'),
        status: 'CANCELLED',
        location: 'DA_NANG',
      }),
    ];

    it('1.1 should detect direct interval overlap when requested within booking hours', () => {
      // Requested: 11:00 to 13:00 (Directly inside 10:00 - 14:00)
      const res = checkGearConflict(
        'GEAR-GLAMBOT-01',
        new Date('2026-10-10T11:00:00.000Z'),
        new Date('2026-10-10T13:00:00.000Z'),
        existingBookings
      );

      assert.strictEqual(res.hasConflict, true);
      assert.strictEqual(res.conflictingBookings.length, 1);
      assert.strictEqual(res.conflictingBookings[0].id, 'BOOKING-101');
      assert.ok(res.reason?.includes('conflicts with 1 booking'));
    });

    it('1.2 should detect conflict during 2-hour teardown buffer (14:00 to 16:00)', () => {
      // Booking ends at 14:00. Buffer is 2h, so gear is blocked until 16:00.
      // Requesting 15:00 to 18:00 conflicts with teardown buffer!
      const res = checkGearConflict(
        'GEAR-GLAMBOT-01',
        new Date('2026-10-10T15:00:00.000Z'),
        new Date('2026-10-10T18:00:00.000Z'),
        existingBookings,
        2 // 2h buffer
      );

      assert.strictEqual(res.hasConflict, true);
      assert.strictEqual(res.conflictingBookings.length, 1);
    });

    it('1.3 should detect conflict during 2-hour setup buffer (08:00 to 10:00)', () => {
      // Booking starts at 10:00. Buffer is 2h, so gear is blocked from 08:00.
      // Requesting 07:00 to 08:30 conflicts with setup buffer!
      const res = checkGearConflict(
        'GEAR-GLAMBOT-01',
        new Date('2026-10-10T07:00:00.000Z'),
        new Date('2026-10-10T08:30:00.000Z'),
        existingBookings,
        2
      );

      assert.strictEqual(res.hasConflict, true);
    });

    it('1.4 should ALLOW booking when requested exactly after the 2-hour teardown buffer (at or after 16:00)', () => {
      // Booking ends at 14:00. Teardown buffer ends at 16:00.
      // Requesting 16:00 to 20:00 is completely safe!
      const res = checkGearConflict(
        'GEAR-GLAMBOT-01',
        new Date('2026-10-10T16:00:00.000Z'),
        new Date('2026-10-10T20:00:00.000Z'),
        existingBookings,
        2
      );

      assert.strictEqual(res.hasConflict, false);
      assert.strictEqual(res.conflictingBookings.length, 0);
      assert.strictEqual(
        isGearAvailable(
          'GEAR-GLAMBOT-01',
          '2026-10-10T16:00:00.000Z',
          '2026-10-10T20:00:00.000Z',
          existingBookings
        ),
        true
      );
    });

    it('1.5 should ignore CANCELLED bookings and not report false conflicts', () => {
      // Slot 18:00 - 22:00 was previously booked by BOOKING-102-CANCELLED
      const res = checkGearConflict(
        'GEAR-GLAMBOT-01',
        new Date('2026-10-10T18:00:00.000Z'),
        new Date('2026-10-10T22:00:00.000Z'),
        existingBookings
      );

      assert.strictEqual(res.hasConflict, false);
    });
  });

  // ==========================================================================
  // 2. Gear Discovery & Warehouse Filtering
  // ==========================================================================
  describe('2. Warehouse & Category Filter (findAvailableGear)', () => {
    const existingBookings: RentalBooking[] = [
      createRentalBooking({
        id: 'BOOKING-DN-01',
        customerName: 'Resort Wedding',
        gearIds: ['GEAR-GLAMBOT-01'],
        startTime: new Date('2026-10-15T08:00:00.000Z'),
        endTime: new Date('2026-10-15T12:00:00.000Z'),
        status: 'CONFIRMED',
        location: 'DA_NANG',
      }),
    ];

    it('2.1 should filter available gears strictly by warehouse location', () => {
      // Find gears in HO_CHI_MINH
      const hcmGears = findAvailableGear(
        mockGears,
        existingBookings,
        '2026-10-15T08:00:00.000Z',
        '2026-10-15T12:00:00.000Z',
        undefined,
        'HO_CHI_MINH'
      );

      // GEAR-CAM-A7M4-SG is available in HCM.
      // GEAR-LENS-2470-SG is in HCM but status is MAINTENANCE -> excluded!
      assert.strictEqual(hcmGears.length, 1);
      assert.strictEqual(hcmGears[0].id, 'GEAR-CAM-A7M4-SG');
    });

    it('2.2 should filter available gears by category and exclude conflicted gears', () => {
      // Find PHOTOBOOTH_GLAMBOT in DA_NANG during 08:00-12:00 (GEAR-GLAMBOT-01 is booked)
      const dnGlambots = findAvailableGear(
        mockGears,
        existingBookings,
        '2026-10-15T08:00:00.000Z',
        '2026-10-15T12:00:00.000Z',
        'PHOTOBOOTH_GLAMBOT',
        'DA_NANG'
      );
      assert.strictEqual(dnGlambots.length, 0);

      // Find MAGIC_MIRROR in DA_NANG at the same time (GEAR-MIRROR-01 is free)
      const dnMirrors = findAvailableGear(
        mockGears,
        existingBookings,
        '2026-10-15T08:00:00.000Z',
        '2026-10-15T12:00:00.000Z',
        'MAGIC_MIRROR',
        'DA_NANG'
      );
      assert.strictEqual(dnMirrors.length, 1);
      assert.strictEqual(dnMirrors[0].id, 'GEAR-MIRROR-01');
    });
  });

  // ==========================================================================
  // 3. Multi-Warehouse Inventory Management & Transfer Orders
  // ==========================================================================
  describe('3. Multi-Branch Inventory Tracking & Transfer Orders', () => {
    it('3.1 should track gear status transitions and summary by branch', () => {
      const tracker = new InventoryTracker(mockGears);
      const summaryBefore = tracker.getInventorySummary();

      assert.strictEqual(summaryBefore.totalGears, 4);
      assert.strictEqual(summaryBefore.locations.DA_NANG.total, 2);
      assert.strictEqual(summaryBefore.locations.HO_CHI_MINH.total, 2);
      assert.strictEqual(summaryBefore.maintenanceCount, 1); // 24-70 GM II lens

      // Update A7M4 status to ASSIGNED_SHOW
      tracker.updateGearStatus('GEAR-CAM-A7M4-SG', 'ASSIGNED_SHOW');
      assert.strictEqual(
        tracker.getGear('GEAR-CAM-A7M4-SG')?.status,
        'ASSIGNED_SHOW'
      );
    });

    it('3.2 should execute complete Transfer Order lifecycle (Da Nang -> TP.HCM)', () => {
      const tracker = new InventoryTracker(mockGears);

      // 1. Create Transfer Order to move GEAR-MIRROR-01 from Da Nang to TP.HCM
      const order = tracker.createTransferOrder({
        gearIds: ['GEAR-MIRROR-01'],
        sourceLocation: 'DA_NANG',
        targetLocation: 'HO_CHI_MINH',
        notes: 'Điều chuyển phục vụ sự kiện City Marathon HCM',
      });

      assert.strictEqual(order.status, 'PENDING');
      assert.strictEqual(order.sourceLocation, 'DA_NANG');
      assert.strictEqual(order.targetLocation, 'HO_CHI_MINH');

      // 2. Dispatch Transfer
      const dispatched = tracker.dispatchTransfer(order.id);
      assert.strictEqual(dispatched.status, 'IN_TRANSIT');
      assert.strictEqual(
        tracker.getGear('GEAR-MIRROR-01')?.status,
        'IN_TRANSIT'
      );

      // 3. Receive Transfer at TP.HCM
      const received = tracker.receiveTransfer(order.id);
      assert.strictEqual(received.status, 'COMPLETED');

      const gearAfterTransfer = tracker.getGear('GEAR-MIRROR-01');
      assert.strictEqual(gearAfterTransfer?.warehouseLocation, 'HO_CHI_MINH');
      assert.strictEqual(gearAfterTransfer?.status, 'AVAILABLE');
    });

    it('3.3 should revert gear to source warehouse when transfer order is cancelled', () => {
      const tracker = new InventoryTracker(mockGears);

      const order = tracker.createTransferOrder({
        gearIds: ['GEAR-GLAMBOT-01'],
        sourceLocation: 'DA_NANG',
        targetLocation: 'HO_CHI_MINH',
      });
      tracker.dispatchTransfer(order.id);

      const cancelled = tracker.cancelTransfer(order.id, 'Xe tải bị hỏng lốp');
      assert.strictEqual(cancelled.status, 'CANCELLED');
      assert.strictEqual(
        tracker.getGear('GEAR-GLAMBOT-01')?.warehouseLocation,
        'DA_NANG'
      );
      assert.strictEqual(
        tracker.getGear('GEAR-GLAMBOT-01')?.status,
        'AVAILABLE'
      );
    });
  });

  // ==========================================================================
  // 4. Consumable Metering (DNP DS620 Paper Rolls & Batteries)
  // ==========================================================================
  describe('4. Consumables Metering & Low Stock Alerts', () => {
    it('4.1 should correctly deduct DNP paper prints and warn when remaining < 20%', () => {
      const meter = new ConsumablesMeter();

      // Create a standard DNP DS620 paper roll (400 prints)
      const roll = meter.createDnpPaperRoll({
        id: 'ROLL-DNP-001',
        totalPrints: 400,
        warningThresholdPercent: 20, // < 80 prints triggers warning
      });

      assert.strictEqual(roll.remainingCapacity, 400);

      // Show 1: Corporate Gala prints 250 photos + 5 test prints = 255 prints
      const usage1 = meter.recordUsage('ROLL-DNP-001', 255, 'Annual Tech Summit 2026');
      assert.strictEqual(usage1.updatedItem.remainingCapacity, 145);
      assert.strictEqual(usage1.remainingPercentage, 36.25);
      assert.strictEqual(usage1.isLowWarning, false);

      // Show 2: Wedding prints 80 photos -> remaining 65 prints (16.25% <= 20%)
      const usage2 = meter.recordUsage('ROLL-DNP-001', 80, 'Wedding Minh & Lan');
      assert.strictEqual(usage2.updatedItem.remainingCapacity, 65);
      assert.strictEqual(usage2.remainingPercentage, 16.25);
      assert.strictEqual(usage2.isLowWarning, true);
      assert.ok(usage2.warningMessage?.includes('CẢNH BÁO VẬT TƯ'));
      assert.ok(usage2.warningMessage?.includes('chỉ còn 65/400 prints'));
    });

    it('4.2 should support simultaneous paper and ribbon session recording', () => {
      const meter = new ConsumablesMeter();
      meter.createDnpPaperRoll({ id: 'PAPER-01', totalPrints: 400 });
      meter.createInkRibbon({ id: 'RIBBON-01', totalPrints: 400 });

      const session = meter.recordPhotoboothSession({
        paperId: 'PAPER-01',
        ribbonId: 'RIBBON-01',
        photosPrinted: 350,
        testPrints: 10,
        eventName: 'Tech Expo 2026',
      });

      assert.strictEqual(session.totalPrints, 360);
      assert.strictEqual(session.paperResult.updatedItem.remainingCapacity, 40);
      assert.strictEqual(
        session.ribbonResult?.updatedItem.remainingCapacity,
        40
      );
      assert.strictEqual(session.hasAnyWarning, true);
      assert.strictEqual(session.warnings.length, 2);
    });

    it('4.3 should accurately calculate remaining shows and reload rolls', () => {
      const meter = new ConsumablesMeter();
      meter.createDnpPaperRoll({ id: 'PAPER-02', totalPrints: 400 });

      // Use 160 prints -> 240 remaining
      meter.recordUsage('PAPER-02', 160);

      // If average consumption per show is 100 prints -> 240 / 100 = 2 full shows remaining
      const showsLeft = meter.calculateShowsRemaining('PAPER-02', 100);
      assert.strictEqual(showsLeft, 2);

      // Reload fresh roll
      const reloaded = meter.reloadConsumable('PAPER-02');
      assert.strictEqual(reloaded.remainingCapacity, 400);
    });
  });

  // ==========================================================================
  // 5. Checklist & Handover Audit (Check-Out, Check-In, K80 Receipt)
  // ==========================================================================
  describe('5. Handover Checklist & K80 Receipt Generator', () => {
    const booking: RentalBooking = createRentalBooking({
      id: 'BK-SHOW-777',
      customerName: 'Công ty Cổ phần Sự kiện ABC',
      gearIds: ['GEAR-GLAMBOT-01', 'GEAR-CAM-A7M4-SG'],
      startTime: new Date('2026-10-12T08:00:00.000Z'),
      endTime: new Date('2026-10-12T20:00:00.000Z'),
      status: 'CONFIRMED',
      location: 'DA_NANG',
      eventName: 'Lễ ra mắt Xe Điện VinFast',
    });

    it('5.1 should generate Check-Out inspection with zero penalty and valid K80 text', () => {
      const checkout = HandoverAuditService.createCheckOutInspection({
        booking,
        gears: mockGears,
        inspectorName: 'Nguyễn Văn Kỹ Thuật',
        customerRepresentative: 'Trần Thị Khách Hàng',
      });

      assert.strictEqual(checkout.type, 'CHECK_OUT');
      assert.strictEqual(checkout.totalPenaltyFee, 0);
      assert.strictEqual(checkout.items.length, 2);
      assert.ok(checkout.k80ReceiptText?.includes('BIÊN BẢN BÀN GIAO THIẾT BỊ (CHECK-OUT)'));
      assert.ok(checkout.k80ReceiptText?.includes('T-RED MEDIA & PHOTOBOOTH'));
      assert.ok(checkout.k80ReceiptText?.includes('Lễ ra mắt Xe Điện VinFast'));
      assert.ok(checkout.k80ReceiptText?.includes('BÊN GIAO'));
      assert.ok(checkout.k80ReceiptText?.includes('BÊN NHẬN'));
    });

    it('5.2 should calculate penalty for missing accessories and damaged equipment on Check-In', () => {
      const checkin = HandoverAuditService.createCheckInInspection({
        booking,
        gears: mockGears,
        inspectorName: 'Nguyễn Văn Kỹ Thuật',
        customerRepresentative: 'Trần Thị Khách Hàng',
        itemAudits: [
          {
            gearId: 'GEAR-GLAMBOT-01',
            condition: 'GOOD',
            missingAccessories: ['Cáp tín hiệu HDMI 10m'], // Defined cost: 350,000 VND
          },
          {
            gearId: 'GEAR-CAM-A7M4-SG',
            condition: 'SCRATCHED', // 10% of replacement value 48,000,000 = 4,800,000 VND
            missingAccessories: ['Dây đeo máy'], // Default cost: 200,000 VND
            damageNote: 'Vỡ kính ngắm EVF và xước thân máy góc trái',
          },
        ],
      });

      assert.strictEqual(checkin.type, 'CHECK_IN');

      const glambotReport = checkin.items.find(
        (i) => i.gearId === 'GEAR-GLAMBOT-01'
      )!;
      assert.strictEqual(glambotReport.accessoryPenaltyFee, 350_000);
      assert.strictEqual(glambotReport.damagePenaltyFee, 0);
      assert.strictEqual(glambotReport.totalPenaltyFee, 350_000);

      const cameraReport = checkin.items.find(
        (i) => i.gearId === 'GEAR-CAM-A7M4-SG'
      )!;
      assert.strictEqual(cameraReport.accessoryPenaltyFee, 200_000);
      assert.strictEqual(cameraReport.damagePenaltyFee, 4_800_000);
      assert.strictEqual(cameraReport.totalPenaltyFee, 5_000_000);

      // Total = 350,000 + 5,000,000 = 5,350,000 VND
      assert.strictEqual(checkin.totalPenaltyFee, 5_350_000);

      // Check receipt printout formatting
      assert.ok(
        checkin.k80ReceiptText?.includes(
          'BIÊN BẢN THU HỒI THIẾT BỊ (CHECK-IN)'
        )
      );
      assert.ok(checkin.k80ReceiptText?.includes('(!) MẤT PHỤ KIỆN'));
      assert.ok(checkin.k80ReceiptText?.includes('Cáp tín hiệu HDMI 10m'));
      assert.ok(
        checkin.k80ReceiptText?.includes('Vỡ kính ngắm EVF và xước thân máy')
      );
      assert.ok(
        checkin.k80ReceiptText?.includes('TỔNG TIỀN BỒI THƯỜNG:')
      );
    });

    it('5.3 should format VND currency properly', () => {
      const formatted = formatVND(15_000_000);
      assert.ok(formatted.includes('15.000.000') || formatted.includes('15,000,000'));
    });
  });
});
