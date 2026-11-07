import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateTruckPacking,
  TRUCK_PRESETS,
  type CargoItem,
  calculateHaversineDistanceKm,
  optimizeDeliveryRoute,
  type LocationCoordinate,
  estimateRouteFuel,
  reconcileFuelReceipt,
  type DriverFuelReceipt,
  computeSha256,
  signElectronicProofOfDelivery,
  verifyEpodIntegrity,
  generateEpodCertificateMarkdown,
  type EpodSubmissionInput,
} from './index';

describe('@kido/fleet-routing Unit Tests', () => {
  /* ========================================================================
   * 1. 3D TRUCK PACKING & CAPACITY OPTIMIZER
   * ======================================================================== */
  describe('1. 3D Truck Packing (truck-packing.ts)', () => {
    it('1.1 Should correctly pack normal cargo into 1.5T truck within payload and volume', () => {
      const items: CargoItem[] = [
        {
          id: 'BOX-01',
          name: 'Thùng Dầu Nhớt 20L',
          weightKg: 20,
          lengthM: 0.4,
          widthM: 0.3,
          heightM: 0.3,
          quantity: 20, // 20 * 20kg = 400kg, 20 * 0.036m3 = 0.72m3
          stackable: true,
        },
        {
          id: 'BOX-02',
          name: 'Kiện Phụ Tùng Linh Kiện',
          weightKg: 15,
          lengthM: 0.5,
          widthM: 0.4,
          heightM: 0.4,
          quantity: 15, // 15 * 15kg = 225kg, 15 * 0.08m3 = 1.2m3
          stackable: true,
        },
      ];

      const result = calculateTruckPacking('DRY_VAN_1_5T', items);

      assert.equal(result.isFit, true);
      assert.equal(result.isOverweight, false);
      assert.equal(result.isOvervolume, false);
      assert.equal(result.totalWeightKg, 625);
      assert.equal(result.maxPayloadKg, 1500);
      assert.ok(result.weightUtilizationPct < 50);
      assert.equal(result.placedCount, 35);
      assert.equal(result.unpackedPackages.length, 0);
      assert.ok(result.placedPackages.length === 35);
    });

    it('1.2 Should detect overweight violation when payload exceeds truck limit', () => {
      const items: CargoItem[] = [
        {
          id: 'STEEL-01',
          name: 'Cuộn Thép Công Nghiệp Nặng',
          weightKg: 800,
          lengthM: 1.0,
          widthM: 1.0,
          heightM: 0.8,
          quantity: 3, // 2,400 kg > 1,500 kg capacity!
          stackable: false,
        },
      ];

      const result = calculateTruckPacking('DRY_VAN_1_5T', items);

      assert.equal(result.isOverweight, true);
      assert.equal(result.isFit, false);
      assert.ok(result.totalWeightKg > 1500);
      assert.ok(result.warnings.some((w) => w.includes('Quá tải trọng')));
    });

    it('1.3 Should enforce cold-chain requirement: warns on Dry Van, passes on Reefer', () => {
      const frozenItems: CargoItem[] = [
        {
          id: 'ICE-01',
          name: 'Hải Sản Đông Lạnh Xuất Khẩu',
          weightKg: 25,
          lengthM: 0.6,
          widthM: 0.4,
          heightM: 0.3,
          quantity: 10,
          requiresRefrigeration: true,
          targetTempCelsius: -18,
        },
      ];

      // Test Dry Van: Should fail refrigeration check
      const dryResult = calculateTruckPacking('DRY_VAN_1_5T', frozenItems);
      assert.equal(dryResult.isRefrigerationCompatible, false);
      assert.equal(dryResult.isFit, false);
      assert.ok(dryResult.warnings.some((w) => w.includes('hàng lạnh')));

      // Test Reefer: Should pass refrigeration check
      const reeferResult = calculateTruckPacking('REEFER_FROZEN', frozenItems);
      assert.equal(reeferResult.isRefrigerationCompatible, true);
      assert.equal(reeferResult.isFit, true);
    });

    it('1.4 Should detect dimension violation when item is physically larger than truck cavity', () => {
      const giantItem: CargoItem[] = [
        {
          id: 'POLE-01',
          name: 'Thanh Dầm Thép Siêu Dài',
          weightKg: 100,
          lengthM: 5.5, // 1.5T box length is only 3.2m
          widthM: 0.5,
          heightM: 0.5,
          quantity: 1,
        },
      ];

      const result = calculateTruckPacking('DRY_VAN_1_5T', giantItem);
      assert.equal(result.isDimensionViolated, true);
      assert.equal(result.isFit, false);
    });

    it('1.5 Should compute center of gravity and axle load distribution', () => {
      const items: CargoItem[] = [
        {
          id: 'CARGO-MID',
          name: 'Kiện Hàng Chuẩn',
          weightKg: 50,
          lengthM: 0.8,
          widthM: 0.6,
          heightM: 0.5,
          quantity: 8,
        },
      ];

      const result = calculateTruckPacking('DRY_VAN_2_5T', items);
      assert.ok(result.axleLoadDistribution.frontAxlePct > 0);
      assert.ok(result.axleLoadDistribution.rearAxlePct > 0);
      assert.equal(
        Math.round(result.axleLoadDistribution.frontAxlePct + result.axleLoadDistribution.rearAxlePct),
        100
      );
    });
  });

  /* ========================================================================
   * 2. VRP MULTI-STOP ROUTE OPTIMIZER
   * ======================================================================== */
  describe('2. VRP Multi-Stop Route Optimizer (vrp-optimizer.ts)', () => {
    const centralDepot: LocationCoordinate = {
      id: 'DEPOT-HCM',
      name: 'Kho Tổng Logistics Tân Bình',
      address: '280 Trường Chinh, P. 13, Q. Tân Bình, TP.HCM',
      latitude: 10.8035,
      longitude: 106.6432,
      serviceMinutes: 15,
    };

    const deliveryStops: LocationCoordinate[] = [
      {
        id: 'STOP-Q1',
        name: 'Đại Lý Bến Thành Q1',
        address: '136 Lê Thị Hồng Gấm, P. Cầu Ông Lãnh, Quận 1',
        latitude: 10.7685,
        longitude: 106.6975,
        serviceMinutes: 10,
      },
      {
        id: 'STOP-Q3',
        name: 'Chi Nhánh Võ Văn Tần Q3',
        address: '210 Võ Văn Tần, Phường 5, Quận 3',
        latitude: 10.7758,
        longitude: 106.6854,
        serviceMinutes: 12,
      },
      {
        id: 'STOP-Q5',
        name: 'Trung Tâm Chợ Lớn Q5',
        address: '88 Hải Thượng Lãn Ông, Phường 10, Quận 5',
        latitude: 10.7512,
        longitude: 106.6578,
        serviceMinutes: 15,
      },
      {
        id: 'STOP-Q7',
        name: 'Kho Phú Mỹ Hưng Q7',
        address: '105 Tôn Dật Tiên, Tân Phú, Quận 7',
        latitude: 10.7289,
        longitude: 106.7214,
        serviceMinutes: 15,
      },
      {
        id: 'STOP-BT',
        name: 'Đại Lý Hàng Xanh Bình Thạnh',
        address: '450 Điện Biên Phủ, Phường 21, Bình Thạnh',
        latitude: 10.7989,
        longitude: 106.7123,
        serviceMinutes: 10,
      },
      {
        id: 'STOP-TD',
        name: 'Chi Nhánh Thủ Đức',
        address: '216 Võ Văn Ngân, Linh Chiểu, TP. Thủ Đức',
        latitude: 10.8523,
        longitude: 106.7712,
        serviceMinutes: 15,
      },
    ];

    it('2.1 Should calculate Haversine distance with road tortuosity factor accurately', () => {
      // Distance between Depot Tan Binh and Ben Thanh Q1 (~6.8km straight, ~9km road)
      const dist = calculateHaversineDistanceKm(
        centralDepot.latitude,
        centralDepot.longitude,
        deliveryStops[0].latitude,
        deliveryStops[0].longitude,
        1.32
      );
      assert.ok(dist >= 8.0 && dist <= 12.0, `Expected distance ~9-11km, got ${dist}`);
    });

    it('2.2 Should optimize multi-stop route and achieve distance savings vs naive order', () => {
      // Deliberately shuffle stops into a crisscrossing inefficient order
      const scrambledStops = [
        deliveryStops[3], // Q7 (South)
        deliveryStops[5], // Thu Duc (Far East)
        deliveryStops[2], // Q5 (Southwest)
        deliveryStops[4], // Binh Thanh (Northeast)
        deliveryStops[0], // Q1 (Center)
        deliveryStops[1], // Q3 (Center-West)
      ];

      const result = optimizeDeliveryRoute(centralDepot, scrambledStops, {
        averageSpeedKmH: 28,
        returnToDepot: true,
        departureTime: '08:00',
      });

      assert.equal(result.optimizedSequence.length, 6);
      assert.ok(result.optimizedDistanceKm > 0);
      assert.ok(result.originalDistanceKm >= result.optimizedDistanceKm);
      assert.ok(result.distanceSavedKm >= 0);
      assert.ok(result.savingsPercentage >= 0);
      assert.ok(result.legs.length === 7); // 6 stops + 1 return leg to depot

      // Validate first leg departs depot at 08:00
      assert.equal(result.legs[0].fromId, 'DEPOT-HCM');
      assert.ok(result.legs[0].arrivalEstimatedTime.length === 5);
      assert.ok(result.fullGoogleMapsUrl.includes('google.com/maps/dir/'));
    });

    it('2.3 Should handle empty delivery stops without crashing', () => {
      const result = optimizeDeliveryRoute(centralDepot, []);
      assert.equal(result.optimizedSequence.length, 0);
      assert.equal(result.originalDistanceKm, 0);
      assert.equal(result.distanceSavedKm, 0);
    });
  });

  /* ========================================================================
   * 3. FUEL CALCULATOR & RECONCILIATION
   * ======================================================================== */
  describe('3. Fuel Calculator & Reconciliation (fuel-calculator.ts)', () => {
    it('3.1 Should estimate fuel consumption for 2.5T truck on 80km city route', () => {
      const estimate = estimateRouteFuel({
        truckType: 'DRY_VAN_2_5T',
        distanceKm: 80,
        payloadKg: 1800,
        maxPayloadKg: 2500,
        trafficCondition: 'MODERATE_CITY',
        dieselPriceVndPerLiter: 21500,
      });

      // Base 13.5 L/100km * load(+13%) * traffic(+15%) = ~17.5 L/100km -> 80km = ~14 liters
      assert.equal(estimate.truckType, 'DRY_VAN_2_5T');
      assert.equal(estimate.distanceKm, 80);
      assert.ok(estimate.totalEstimatedLiters >= 12 && estimate.totalEstimatedLiters <= 17);
      assert.ok(estimate.totalEstimatedCostVnd > 250000 && estimate.totalEstimatedCostVnd < 380000);
    });

    it('3.2 Should include reefer compressor fuel consumption for frozen cargo truck', () => {
      const estimate = estimateRouteFuel({
        truckType: 'REEFER_FROZEN',
        distanceKm: 100,
        reeferHours: 4, // 4 hours * 2.8 L/h = 11.2 liters extra
        trafficCondition: 'NORMAL',
        dieselPriceVndPerLiter: 21500,
      });

      assert.ok(estimate.reeferLiters >= 11);
      assert.ok(estimate.totalEstimatedLiters > estimate.drivingLiters);
    });

    it('3.3 Should reconcile driver fuel receipt with NORMAL status within tolerance', () => {
      const estimate = estimateRouteFuel({
        truckType: 'DRY_VAN_1_5T',
        distanceKm: 100,
        trafficCondition: 'NORMAL',
        dieselPriceVndPerLiter: 21500,
      });

      const receipt: DriverFuelReceipt = {
        receiptId: 'REC-001',
        driverId: 'DRV-101',
        driverName: 'Nguyễn Văn Hùng',
        truckLicensePlate: '51D-882.34',
        stationName: 'Petrolimex Cửa Hàng 15',
        invoiceNumber: 'HD-2026-9931',
        timestamp: new Date().toISOString(),
        actualLiters: estimate.totalEstimatedLiters + 0.3, // slight variance +2.8%
        actualCostVnd: Math.round((estimate.totalEstimatedLiters + 0.3) * 21500),
      };

      const audit = reconcileFuelReceipt(receipt, estimate);
      assert.equal(audit.status, 'NORMAL');
      assert.equal(audit.isFlaggedForAudit, false);
      assert.ok(audit.variancePct <= 8);
    });

    it('3.4 Should flag HIGH_RISK_ANOMALY when fuel consumption exceeds 18%', () => {
      const estimate = estimateRouteFuel({
        truckType: 'DRY_VAN_5_0T',
        distanceKm: 100,
        dieselPriceVndPerLiter: 21500,
      });

      const abnormalReceipt: DriverFuelReceipt = {
        receiptId: 'REC-002',
        driverId: 'DRV-102',
        driverName: 'Trần Văn Bình',
        truckLicensePlate: '51D-921.11',
        stationName: 'Petrolimex Quốc Lộ 1A',
        invoiceNumber: 'HD-2026-9988',
        timestamp: new Date().toISOString(),
        actualLiters: estimate.totalEstimatedLiters * 1.35, // +35% excessive fuel!
        actualCostVnd: Math.round(estimate.totalEstimatedLiters * 1.35 * 21500),
      };

      const audit = reconcileFuelReceipt(abnormalReceipt, estimate);
      assert.equal(audit.status, 'HIGH_RISK_ANOMALY');
      assert.equal(audit.isFlaggedForAudit, true);
      assert.ok(audit.variancePct > 18);
      assert.ok(audit.actionRecommendation.includes('KHÓA THANH TOÁN'));
    });
  });

  /* ========================================================================
   * 4. ELECTRONIC PROOF OF DELIVERY (e-POD) & SHA-256 SIGNER
   * ======================================================================== */
  describe('4. e-POD Anti-Tamper Signer (epod-signer.ts)', () => {
    it('4.1 Should compute standard SHA-256 matching official FIPS test vectors', () => {
      // Known standard SHA-256 test vectors:
      // Empty string: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
      assert.equal(
        computeSha256(''),
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
      );

      // "The quick brown fox jumps over the lazy dog"
      // d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592
      assert.equal(
        computeSha256('The quick brown fox jumps over the lazy dog'),
        'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592'
      );
    });

    it('4.2 Should sign e-POD and verify cryptographic integrity as valid', () => {
      const input: EpodSubmissionInput = {
        orderCode: 'POD-HCM-2026-0930-01',
        tripId: 'TRIP-8821',
        stopId: 'STOP-Q1',
        truckLicensePlate: '51D-892.45',
        driverId: 'DRV-101',
        driverName: 'Nguyễn Văn Hùng',
        recipientName: 'Lê Hoàng Anh',
        recipientPhone: '0908123456',
        deliveryAddress: '136 Lê Thị Hồng Gấm, Quận 1, TP.HCM',
        gpsLocation: {
          latitude: 10.7685,
          longitude: 106.6975,
          accuracyMeters: 4.5,
        },
        timestamp: '2026-09-30T10:15:00Z',
        signatureData: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjxwYXRoIGQ9Ik0xMCAxMEx5MCAyMCIvPjwvc3ZnPg==',
        cargoDeliveredCount: 8,
        cargoCondition: 'INTACT_SEALED',
        customerNotes: 'Đã nhận đủ 8 kiện hàng nguyên seal niêm phong chì.',
      };

      const epod = signElectronicProofOfDelivery(input);

      assert.ok(epod.epodId.startsWith('EPOD-'));
      assert.equal(epod.verificationHash.length, 64);
      assert.equal(epod.status, 'DELIVERED_VERIFIED');

      // Verify integrity
      const verification = verifyEpodIntegrity(epod);
      assert.equal(verification.isValid, true);
      assert.equal(verification.actualHash, epod.verificationHash);
    });

    it('4.3 Should detect anti-tamper alteration when any payload field is manipulated', () => {
      const input: EpodSubmissionInput = {
        orderCode: 'POD-HCM-2026-0930-02',
        tripId: 'TRIP-8822',
        stopId: 'STOP-Q3',
        truckLicensePlate: '51D-771.22',
        driverId: 'DRV-103',
        driverName: 'Phạm Minh Trí',
        recipientName: 'Vũ Thị Mai',
        recipientPhone: '0912345678',
        deliveryAddress: '210 Võ Văn Tần, Quận 3, TP.HCM',
        gpsLocation: {
          latitude: 10.7758,
          longitude: 106.6854,
        },
        timestamp: '2026-09-30T11:00:00Z',
        signatureData: 'signature-stroke-data-1234567890',
        cargoDeliveredCount: 5,
        cargoCondition: 'INTACT_SEALED',
      };

      const epod = signElectronicProofOfDelivery(input);

      // Tamper 1: Attacker changes delivered count from 5 to 4
      const tamperedCountEpod = { ...epod, cargoDeliveredCount: 4 };
      assert.equal(verifyEpodIntegrity(tamperedCountEpod).isValid, false);

      // Tamper 2: GPS coordinate shifted
      const tamperedGpsEpod = {
        ...epod,
        gpsLocation: { ...epod.gpsLocation, latitude: 10.7759 },
      };
      assert.equal(verifyEpodIntegrity(tamperedGpsEpod).isValid, false);

      // Tamper 3: Signature forged
      const tamperedSigEpod = { ...epod, signatureData: 'forged-signature-stroke' };
      assert.equal(verifyEpodIntegrity(tamperedSigEpod).isValid, false);
    });

    it('4.4 Should generate human-readable markdown e-POD certificate', () => {
      const input: EpodSubmissionInput = {
        orderCode: 'POD-HCM-2026-0930-03',
        tripId: 'TRIP-8823',
        stopId: 'STOP-Q5',
        truckLicensePlate: '51D-555.88',
        driverId: 'DRV-105',
        driverName: 'Đặng Tuấn Khang',
        recipientName: 'Công Ty TNHH Sao Mai',
        recipientPhone: '02838383838',
        deliveryAddress: '88 Hải Thượng Lãn Ông, Quận 5, TP.HCM',
        gpsLocation: {
          latitude: 10.7512,
          longitude: 106.6578,
          accuracyMeters: 3.2,
        },
        timestamp: '2026-09-30T14:20:00Z',
        signatureData: 'customer-signature-base64-data',
        cargoDeliveredCount: 12,
        cargoCondition: 'TEMP_VERIFIED',
        coldChainTemperatureCelsius: -18.5,
      };

      const epod = signElectronicProofOfDelivery(input);
      const certMarkdown = generateEpodCertificateMarkdown(epod);

      assert.ok(certMarkdown.includes('BIÊN BẢN BÀN GIAO ĐIỆN TỬ'));
      assert.ok(certMarkdown.includes('51D-555.88'));
      assert.ok(certMarkdown.includes('-18.5°C'));
      assert.ok(certMarkdown.includes(epod.verificationHash));
      assert.ok(certMarkdown.includes('ĐÃ XÁC THỰC TOÀN VẸN (SHA-256)'));
    });
  });
});
