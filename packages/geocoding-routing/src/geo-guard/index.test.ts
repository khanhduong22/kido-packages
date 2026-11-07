import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  haversineDistance,
  vincentyDistance,
  isInsideGeofence,
  checkMockProviderFlag,
  checkAccuracyAnomaly,
  checkTeleportation,
  checkKinematicSensor,
  detectMockLocation,
  verifyPhotoProof,
  extractExifFromBuffer,
  createSyntheticExifJpeg,
  calculateTierPricingAndCredit,
  getVolumeDiscountPercent,
  DEFAULT_TIER_DISCOUNTS,
} from './index';

describe('@kido/geo-guard Test Suite', () => {
  // Test coordinates:
  // Ben Thanh Market, District 1, HCMC: 10.772565, 106.698020
  // Saigon Notre-Dame Cathedral: 10.779786, 106.699018 (~800m away)
  // Grocery Store A (Tiệm tạp hóa Cô Ba): 10.772500, 106.698000 (~7.2m away from Ben Thanh)
  // Hanoi Old Quarter (Hoan Kiem): 21.028511, 105.854444 (~1138 km away)
  const BEN_THANH = { lat: 10.772565, lon: 106.69802 };
  const NEARBY_STORE = { lat: 10.7725, lon: 106.698 };
  const FARAWAY_CATHEDRAL = { lat: 10.779786, lon: 106.699018 };
  const HANOI = { lat: 21.028511, lon: 105.854444 };

  // ========================================================
  // 1. Geofencing & Distance Formulas (Haversine & Vincenty)
  // ========================================================

  describe('Geofence & Distance Calculations', () => {
    it('1. should calculate Haversine distance accurately between HCMC and Hanoi (~1138 km)', () => {
      const dist = haversineDistance(BEN_THANH, HANOI);
      // Expected: ~1,138,000 meters (+- 5,000m on sphere model)
      assert.ok(dist > 1130000 && dist < 1145000, `Expected ~1138km, got ${dist}m`);
    });

    it('2. should calculate Vincenty distance with sub-meter precision for nearby points', () => {
      const distV = vincentyDistance(BEN_THANH, NEARBY_STORE);
      const distH = haversineDistance(BEN_THANH, NEARBY_STORE);

      // Distance should be approximately 7.5 meters
      assert.ok(distV > 6 && distV < 10, `Vincenty distance: ${distV}m`);
      assert.ok(Math.abs(distV - distH) < 0.5, 'Vincenty and Haversine should closely align locally');
    });

    it('3. should verify user is INSIDE geofence when within allowed 50m radius', () => {
      const result = isInsideGeofence(BEN_THANH, NEARBY_STORE, 50);

      assert.equal(result.isInside, true);
      assert.equal(result.allowedRadiusMeters, 50);
      assert.ok(result.distanceMeters < 50);
      assert.ok(result.deltaMeters < 0, 'deltaMeters should be negative (margin remaining)');
    });

    it('4. should verify user is OUTSIDE geofence when beyond 50m radius (Notre-Dame Cathedral)', () => {
      const result = isInsideGeofence(BEN_THANH, FARAWAY_CATHEDRAL, 50);

      assert.equal(result.isInside, false);
      assert.ok(result.distanceMeters > 700);
      assert.ok(result.deltaMeters > 650, 'deltaMeters should show excess distance');
    });

    it('5. should respect tolerance parameter for boundary edge cases', () => {
      // Distance is ~808m
      const strictResult = isInsideGeofence(BEN_THANH, FARAWAY_CATHEDRAL, 800, {
        toleranceMeters: 0,
      });
      assert.equal(strictResult.isInside, false);

      const tolerantResult = isInsideGeofence(BEN_THANH, FARAWAY_CATHEDRAL, 800, {
        toleranceMeters: 20,
      });
      assert.equal(tolerantResult.isInside, true);
    });
  });

  // ========================================================
  // 2. 4-Layer Fake GPS Guard (mock-detector.ts)
  // ========================================================

  describe('4-Layer Fake GPS Guard', () => {
    it('6. Layer 1: should detect native mock provider flags (isFromMockProvider / isMockProvider)', () => {
      const cleanCheck = checkMockProviderFlag({ lat: 10.77, lon: 106.69 });
      assert.equal(cleanCheck.flagged, false);

      const mockCheck1 = checkMockProviderFlag({
        lat: 10.77,
        lon: 106.69,
        isFromMockProvider: true,
      });
      assert.equal(mockCheck1.flagged, true);

      const mockCheck2 = checkMockProviderFlag({
        lat: 10.77,
        lon: 106.69,
        isMockProvider: true,
      });
      assert.equal(mockCheck2.flagged, true);
    });

    it('7. Layer 2: should flag GPS accuracy of exactly 0.0m or sub-centimeter precision', () => {
      const normalGps = checkAccuracyAnomaly({ lat: 10.77, lon: 106.69, accuracy: 8.5 });
      assert.equal(normalGps.flagged, false);

      const zeroAccuracy = checkAccuracyAnomaly({ lat: 10.77, lon: 106.69, accuracy: 0 });
      assert.equal(zeroAccuracy.flagged, true);
      assert.match(zeroAccuracy.details, /exactly 0\.0m/i);

      const subCentimeter = checkAccuracyAnomaly({ lat: 10.77, lon: 106.69, accuracy: 0.001 });
      assert.equal(subCentimeter.flagged, true);
      assert.match(subCentimeter.details, /unnaturally precise/i);
    });

    it('8. Layer 3: should flag teleportation (> 150 km/h) between 2 consecutive check-ins', () => {
      const baseTime = Date.now();

      // Rep jumped 20km in 60 seconds (1200 km/h velocity - impossible ground travel)
      const prevLoc = {
        lat: 10.772565,
        lon: 106.69802,
        timestamp: baseTime - 60 * 1000,
      };
      const currentLoc = {
        lat: 10.95, // ~20km North
        lon: 106.69802,
        timestamp: baseTime,
      };

      const teleportResult = checkTeleportation(currentLoc, prevLoc, 150);
      assert.equal(teleportResult.flagged, true);
      assert.ok((teleportResult.calculatedSpeedKmh ?? 0) > 1000);
      assert.match(teleportResult.details, /Impossible velocity/i);
    });

    it('9. Layer 3: should pass normal motorcycle travel speed (< 60 km/h)', () => {
      const baseTime = Date.now();

      // Rep traveled 1km in 3 minutes (20 km/h - typical city traffic)
      const prevLoc = {
        lat: 10.772565,
        lon: 106.69802,
        timestamp: baseTime - 180 * 1000,
      };
      const currentLoc = {
        lat: 10.781,
        lon: 106.69802,
        timestamp: baseTime,
      };

      const normalResult = checkTeleportation(currentLoc, prevLoc, 150);
      assert.equal(normalResult.flagged, false);
      assert.ok((normalResult.calculatedSpeedKmh ?? 0) < 60);
    });

    it('10. Layer 4: Kinematic check should detect Android emulator static sensor signature (zero variance)', () => {
      // Emulator static reading: constant (0, 0, 9.81) with zero variance
      const emulatorSamples = [
        { x: 0, y: 0, z: 9.81, timestamp: 1 },
        { x: 0, y: 0, z: 9.81, timestamp: 2 },
        { x: 0, y: 0, z: 9.81, timestamp: 3 },
        { x: 0, y: 0, z: 9.81, timestamp: 4 },
      ];

      const emulatorResult = checkKinematicSensor(emulatorSamples);
      assert.equal(emulatorResult.flagged, true);
      assert.equal(emulatorResult.isEmulatorLikely, true);
      assert.match(emulatorResult.details, /Static sensor signature/i);
    });

    it('11. Layer 4: Kinematic check should verify natural human hand tremor', () => {
      // Natural human holding phone with subtle micro-tremors (8-12Hz)
      const humanHandSamples = [
        { x: 0.12, y: 0.08, z: 9.78, timestamp: 1 },
        { x: 0.19, y: 0.14, z: 9.86, timestamp: 2 },
        { x: 0.08, y: 0.03, z: 9.72, timestamp: 3 },
        { x: 0.22, y: 0.18, z: 9.92, timestamp: 4 },
        { x: 0.15, y: 0.11, z: 9.81, timestamp: 5 },
      ];

      const humanResult = checkKinematicSensor(humanHandSamples);
      assert.equal(humanResult.flagged, false);
      assert.equal(humanResult.isEmulatorLikely, false);
      assert.match(humanResult.details, /Natural human hand tremor verified/i);
    });

    it('12. Full Mock Detector should aggregate threat score and classify risk levels', () => {
      const fraudulentInput = {
        currentLocation: {
          lat: 10.77,
          lon: 106.69,
          accuracy: 0, // Flag 1: 0m accuracy
          isMockProvider: true, // Flag 2: Mock provider active
          timestamp: Date.now(),
        },
        previousLocation: {
          lat: 11.5, // 80km away
          lon: 106.69,
          timestamp: Date.now() - 30 * 1000, // 30s ago -> Flag 3: Teleportation
        },
        accelerometerSamples: [
          { x: 0, y: 0, z: 9.81 },
          { x: 0, y: 0, z: 9.81 },
          { x: 0, y: 0, z: 9.81 }, // Flag 4: Zero variance emulator
        ],
      };

      const result = detectMockLocation(fraudulentInput);
      assert.equal(result.isMock, true);
      assert.equal(result.riskLevel, 'CRITICAL');
      assert.equal(result.threatScore, 100);
      assert.ok(result.reasons.includes('MOCK_PROVIDER_FLAG_ACTIVE'));
      assert.ok(result.reasons.includes('GPS_ACCURACY_EXACTLY_ZERO'));
      assert.ok(result.reasons.includes('TELEPORTATION_EXCESSIVE_SPEED'));
      assert.ok(result.reasons.includes('KINEMATIC_ZERO_VARIANCE_EMULATOR'));
    });
  });

  // ========================================================
  // 3. EXIF Shelf Photo Verifier (exif-verifier.ts)
  // ========================================================

  describe('Shelf Photo EXIF Verifier', () => {
    it('13. should extract EXIF from synthetic JPEG buffer and verify live store photo', () => {
      const now = new Date();
      // Create synthetic JPEG with GPS at Ben Thanh Market, taken 2 minutes ago
      const photoTime = new Date(now.getTime() - 2 * 60 * 1000);
      const jpegBuffer = createSyntheticExifJpeg({
        lat: BEN_THANH.lat,
        lon: BEN_THANH.lon,
        capturedAt: photoTime,
        make: 'Apple',
        model: 'iPhone 15 Pro',
      });

      // Extract metadata directly
      const metadata = extractExifFromBuffer(jpegBuffer);
      assert.equal(metadata.hasExif, true);
      assert.equal(metadata.cameraMake, 'Apple');
      assert.equal(metadata.cameraModel, 'iPhone 15 Pro');
      assert.ok(metadata.gps !== undefined);
      assert.ok(Math.abs((metadata.gps?.latitude ?? 0) - BEN_THANH.lat) < 0.001);
      assert.ok(Math.abs((metadata.gps?.longitude ?? 0) - BEN_THANH.lon) < 0.001);

      // Verify photo against current device location (at Ben Thanh Market)
      const context = {
        deviceCoordinates: BEN_THANH,
        submissionTimestamp: now,
      };

      const verification = verifyPhotoProof(jpegBuffer, context);
      assert.equal(verification.isValid, true);
      assert.ok(verification.flags.includes('VALID_AUTHENTIC_PHOTO'));
      assert.ok((verification.distanceMeters ?? 999) < 20);
      assert.ok((verification.timeDeltaSeconds ?? 999) <= 150);
    });

    it('14. should detect and reject stale photo from gallery taken 2 days ago', () => {
      const now = new Date();
      const twoDaysAgo = new Date(now.getTime() - 48 * 3600 * 1000);

      const staleJpeg = createSyntheticExifJpeg({
        lat: BEN_THANH.lat,
        lon: BEN_THANH.lon,
        capturedAt: twoDaysAgo,
      });

      const context = {
        deviceCoordinates: BEN_THANH,
        submissionTimestamp: now,
      };

      const verification = verifyPhotoProof(staleJpeg, context, {
        maxTimeDeltaSeconds: 600, // 10 minutes max
      });

      assert.equal(verification.isValid, false);
      assert.ok(verification.flags.includes('PHOTO_STALE_GALLERY_FRAUD'));
      assert.ok((verification.timeDeltaSeconds ?? 0) > 100000);
    });

    it('15. should reject photo taken 15 km away at different coordinates', () => {
      const now = new Date();
      // Photo was taken in Thu Duc City (~15km away)
      const farawayLoc = { lat: 10.85, lon: 106.75 };
      const farawayJpeg = createSyntheticExifJpeg({
        lat: farawayLoc.lat,
        lon: farawayLoc.lon,
        capturedAt: new Date(now.getTime() - 60 * 1000),
      });

      const context = {
        deviceCoordinates: BEN_THANH,
        submissionTimestamp: now,
      };

      const verification = verifyPhotoProof(farawayJpeg, context, {
        maxDistanceMeters: 100,
      });

      assert.equal(verification.isValid, false);
      assert.ok(verification.flags.includes('COORDINATES_MISMATCH'));
      assert.ok((verification.distanceMeters ?? 0) > 10000);
    });

    it('16. should reject photo missing EXIF metadata when requireGps is true', () => {
      // Random dummy bytes without EXIF
      const dummyBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
      const context = {
        deviceCoordinates: BEN_THANH,
        submissionTimestamp: new Date(),
      };

      const verification = verifyPhotoProof(dummyBuffer, context, { requireGps: true });
      assert.equal(verification.isValid, false);
      assert.ok(verification.flags.includes('MISSING_EXIF_METADATA'));
    });
  });

  // ========================================================
  // 4. FMCG B2B Tier Pricing & Credit Limit Guard
  // ========================================================

  describe('FMCG B2B Tier Pricing & Credit Limit Guard', () => {
    it('17. should apply correct base discounts by Dealer Tier (Tier 2: 15%, Tier 1: 20%, Gold: 25%)', () => {
      assert.equal(DEFAULT_TIER_DISCOUNTS.TIER_2, 15);
      assert.equal(DEFAULT_TIER_DISCOUNTS.TIER_1, 20);
      assert.equal(DEFAULT_TIER_DISCOUNTS.GOLD, 25);

      const request = {
        dealer: {
          id: 'DLR-001',
          name: 'Đại lý Cấp 1 Miền Nam',
          tier: 'TIER_1' as const,
          creditLimit: 500000000, // 500M VND
          currentDebt: 100000000, // 100M VND
        },
        items: [
          {
            productId: 'SKU-COCA-330',
            productName: 'Nước ngọt Coca Cola 330ml (Thùng 24 lon)',
            unitPrice: 200000, // 200,000 VND / thùng
            quantity: 50, // 50 thùng -> < 100 units -> no volume discount
          },
        ],
      };

      const pricing = calculateTierPricingAndCredit(request);
      assert.equal(pricing.dealerTier, 'TIER_1');
      assert.equal(pricing.items[0].baseTierDiscountPercent, 20);
      assert.equal(pricing.items[0].volumeDiscountPercent, 0);
      assert.equal(pricing.items[0].totalDiscountPercent, 20);
      assert.equal(pricing.grossTotal, 10000000); // 10,000,000 VND
      assert.equal(pricing.totalDiscount, 2000000); // 20% = 2,000,000 VND
      assert.equal(pricing.netTotal, 8000000); // 8,000,000 VND
    });

    it('18. should apply tiered volume discounts for large orders (100+ -> +2%, 500+ -> +5%)', () => {
      assert.equal(getVolumeDiscountPercent(50), 0);
      assert.equal(getVolumeDiscountPercent(150), 2);
      assert.equal(getVolumeDiscountPercent(600), 5);
      assert.equal(getVolumeDiscountPercent(1200), 8);

      const request = {
        dealer: {
          id: 'DLR-VIP-01',
          name: 'Đại lý Vàng Hải Phòng',
          tier: 'GOLD' as const,
          creditLimit: 1000000000, // 1 tỷ VND
          currentDebt: 200000000,  // 200M VND
        },
        items: [
          {
            productId: 'SKU-SNACK-OISHI',
            productName: 'Bim Bim Oishi Bắp Cay (Thùng 80 gói)',
            unitPrice: 100000,
            quantity: 500, // 500 units -> Gold (25%) + Volume (5%) = 30% discount
          },
        ],
      };

      const pricing = calculateTierPricingAndCredit(request);
      const item = pricing.items[0];
      assert.equal(item.baseTierDiscountPercent, 25);
      assert.equal(item.volumeDiscountPercent, 5);
      assert.equal(item.totalDiscountPercent, 30);
      assert.equal(pricing.grossTotal, 50000000); // 50,000,000 VND
      assert.equal(pricing.totalDiscount, 15000000); // 30% = 15,000,000 VND
      assert.equal(pricing.netTotal, 35000000); // 35,000,000 VND
    });

    it('19. should approve order when projected debt is within credit limit', () => {
      const request = {
        dealer: {
          id: 'DLR-002',
          name: 'Tạp hóa Bình Dân',
          tier: 'TIER_2' as const,
          creditLimit: 50000000, // 50M VND
          currentDebt: 20000000, // 20M VND
        },
        items: [
          {
            productId: 'SKU-MIO-01',
            productName: 'Mì Hảo Hảo Tôm Chua Cay',
            unitPrice: 120000,
            quantity: 100, // 100 x 120,000 = 12M gross. Tier 2 (15%) + Vol (2%) = 17% -> ~9.96M net
          },
        ],
      };

      const result = calculateTierPricingAndCredit(request);
      assert.equal(result.isLocked, false);
      assert.equal(result.lockReason, undefined);
      assert.equal(result.excessDebtAmount, 0);
      assert.ok(result.projectedDebt < result.creditLimit);
      assert.ok(result.remainingCreditAfterOrder > 0);
    });

    it('20. should automatically lock order when projected debt exceeds credit limit', () => {
      const request = {
        dealer: {
          id: 'DLR-DEBT-OVER',
          name: 'Đại lý Công Nợ Cao',
          tier: 'TIER_2' as const,
          creditLimit: 50000000, // 50,000,000 VND
          currentDebt: 45000000, // 45,000,000 VND (Only 5M credit left!)
        },
        items: [
          {
            productId: 'SKU-BEER-HEINEKEN',
            productName: 'Bia Heineken Sleek 330ml (Thùng 24 lon)',
            unitPrice: 420000,
            quantity: 50, // 50 x 420,000 = 21,000,000 VND gross. 15% discount -> 17,850,000 VND net
          },
        ],
      };

      const result = calculateTierPricingAndCredit(request);
      // Net order = ~17.85M VND. Projected debt = 45M + 17.85M = 62.85M > 50M limit!
      assert.equal(result.isLocked, true);
      assert.equal(result.lockReason, 'CREDIT_LIMIT_EXCEEDED');
      assert.ok(result.excessDebtAmount > 12000000, `Excess: ${result.excessDebtAmount}`);
      assert.equal(result.availableCreditBeforeOrder, 5000000);
      assert.ok(result.remainingCreditAfterOrder < 0);
    });
  });
});
