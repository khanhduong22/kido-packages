import assert from 'node:assert';
import test from 'node:test';
import {
  AhaMoveAdapter,
  CalculateShippingInputSchema,
  CoordinatesSchema,
  DEFAULT_SHIPPING_RULE,
  GHTKAdapter,
  GrabExpressAdapter,
  STANDARD_DELIVERY_SLOTS,
  calculateHaversineDistance,
  calculateShippingFee,
  getAllCarrierQuotes,
  getAvailableDeliverySlots,
  isWithinRadius,
  validateDeliverySlot,
} from './index';

// Coordinates for testing in Ho Chi Minh City
const STORE_COORDS = { latitude: 10.7951, longitude: 106.7218 }; // Landmark 81, Binh Thanh
const CUSTOMER_NEAR = { latitude: 10.7995, longitude: 106.7180 }; // ~0.65 km (under 2km)
const CUSTOMER_DISTANT = { latitude: 10.7725, longitude: 106.6980 }; // Ben Thanh Market (~3.53 km)
const CUSTOMER_FAR = { latitude: 10.8500, longitude: 106.7700 }; // Thu Duc (~8.0 km)

test('Haversine distance calculator - accurate distance calculation and zero distance test', () => {
  // Test same point
  const zeroDist = calculateHaversineDistance(STORE_COORDS, STORE_COORDS);
  assert.strictEqual(zeroDist, 0);

  // Test Landmark 81 to Ben Thanh Market (~3.53 km)
  const dist = calculateHaversineDistance(STORE_COORDS, CUSTOMER_DISTANT);
  assert.ok(dist >= 3.4 && dist <= 3.7, `Expected dist ~3.53 km, got ${dist}`);

  // Test with lat/lng alias keys
  const aliasDist = calculateHaversineDistance(
    { lat: 10.7951, lng: 106.7218 },
    { lat: 10.7725, lng: 106.6980 }
  );
  assert.strictEqual(aliasDist, dist);

  // Test isWithinRadius
  assert.strictEqual(isWithinRadius(STORE_COORDS, CUSTOMER_NEAR, 2), true);
  assert.strictEqual(isWithinRadius(STORE_COORDS, CUSTOMER_FAR, 5), false);
});

test('Haversine distance calculator - validates coordinates and rejects invalid lat/lng', () => {
  // Invalid latitude (> 90)
  assert.throws(() => {
    CoordinatesSchema.parse({ latitude: 95.0, longitude: 106.7 });
  });

  // Invalid longitude (< -180)
  assert.throws(() => {
    CoordinatesSchema.parse({ latitude: 10.0, longitude: -185.0 });
  });

  // Missing latitude or longitude
  assert.throws(() => {
    CoordinatesSchema.parse({ latitude: 10.0 });
  });
});

test('Tiered Shipping Pricing Engine - base distance and extra km calculation', () => {
  // Within base distance (<= 2km)
  const nearQuote = calculateShippingFee({
    origin: STORE_COORDS,
    destination: CUSTOMER_NEAR,
    orderTotal: 150000,
    isPeakHour: false,
    isRainy: false,
    isNight: false,
  });

  assert.strictEqual(nearQuote.distanceKm <= 2, true);
  assert.strictEqual(nearQuote.fee, 15000); // 15,000 VND base fee
  assert.strictEqual(nearQuote.breakdown.distanceFee, 0);
  assert.strictEqual(nearQuote.breakdown.isFreeShipping, false);

  // Beyond base distance: Landmark 81 to Ben Thanh Market (~3.53 km)
  // Distance: 3.53 km -> extra distance = 1.53 km.
  // Ceil extra distance: 2 km -> extra fee = 2 * 5,000 = 10,000 VND.
  // Total = 15,000 + 10,000 = 25,000 VND.
  const distantQuote = calculateShippingFee({
    origin: STORE_COORDS,
    destination: CUSTOMER_DISTANT,
    orderTotal: 200000,
    isPeakHour: false,
    isRainy: false,
    isNight: false,
  });

  assert.strictEqual(distantQuote.fee, 25000);
  assert.strictEqual(distantQuote.breakdown.baseFee, 15000);
  assert.strictEqual(distantQuote.breakdown.distanceFee, 10000);
});

test('Tiered Shipping Pricing Engine - free shipping threshold logic', () => {
  // Order below threshold (350,000 < 500,000)
  const paidQuote = calculateShippingFee({
    origin: STORE_COORDS,
    destination: CUSTOMER_DISTANT,
    orderTotal: 350000,
    isPeakHour: false,
    isRainy: false,
    isNight: false,
  });
  assert.strictEqual(paidQuote.fee, 25000);
  assert.strictEqual(paidQuote.breakdown.isFreeShipping, false);
  assert.strictEqual(paidQuote.breakdown.discount, 0);

  // Order above threshold (550,000 >= 500,000)
  const freeQuote = calculateShippingFee({
    origin: STORE_COORDS,
    destination: CUSTOMER_DISTANT,
    orderTotal: 550000,
    isPeakHour: false,
    isRainy: false,
    isNight: false,
  });
  assert.strictEqual(freeQuote.fee, 0);
  assert.strictEqual(freeQuote.breakdown.isFreeShipping, true);
  assert.strictEqual(freeQuote.breakdown.discount, 25000);
});

test('Tiered Shipping Pricing Engine - surcharges for peak hour, rain, and night delivery', () => {
  // Base delivery without surcharge: 25,000 VND for CUSTOMER_DISTANT
  // 1. Peak hour surcharge: multiplier 1.2 (+20%) -> +5,000 VND
  const peakQuote = calculateShippingFee({
    origin: STORE_COORDS,
    destination: CUSTOMER_DISTANT,
    orderTotal: 100000,
    isPeakHour: true,
    isRainy: false,
    isNight: false,
  });
  assert.strictEqual(peakQuote.breakdown.surcharges.peakHour, 5000);
  assert.strictEqual(peakQuote.fee, 30000);

  // 2. Rainy weather surcharge: multiplier 1.25 (+25% of 25,000 = 6,250) + 5,000 flat = 11,250 VND
  const rainQuote = calculateShippingFee({
    origin: STORE_COORDS,
    destination: CUSTOMER_DISTANT,
    orderTotal: 100000,
    isPeakHour: false,
    isRainy: true,
    isNight: false,
  });
  assert.strictEqual(rainQuote.breakdown.surcharges.rain, 11250);
  assert.strictEqual(rainQuote.fee, 25000 + 11250);

  // 3. Night delivery surcharge: multiplier 1.3 (+30% of 25,000 = 7,500) + 10,000 flat = 17,500 VND
  const nightQuote = calculateShippingFee({
    origin: STORE_COORDS,
    destination: CUSTOMER_DISTANT,
    orderTotal: 100000,
    isPeakHour: false,
    isRainy: false,
    isNight: true,
  });
  assert.strictEqual(nightQuote.breakdown.surcharges.night, 17500);
  assert.strictEqual(nightQuote.fee, 25000 + 17500);

  // 4. Combined surcharges with slot surcharge
  const combinedQuote = calculateShippingFee({
    origin: STORE_COORDS,
    destination: CUSTOMER_DISTANT,
    orderTotal: 100000,
    isPeakHour: true,
    isRainy: true,
    isNight: false,
    slotType: 'EXPRESS_1H_2H', // +10,000 VND slot surcharge
  });
  assert.strictEqual(combinedQuote.breakdown.surcharges.slot, 10000);
  assert.strictEqual(
    combinedQuote.fee,
    25000 + 5000 + 11250 + 10000
  );
});

test('Tiered Shipping Pricing Engine - max delivery distance validation', () => {
  // Coordinate in Hanoi (~1140 km from HCMC)
  const HANOI_COORDS = { latitude: 21.0285, longitude: 105.8542 };

  assert.throws(
    () => {
      calculateShippingFee({
        origin: STORE_COORDS,
        destination: HANOI_COORDS,
        orderTotal: 100000,
      });
    },
    /vượt quá giới hạn tối đa/
  );
});

test('Delivery Slot Validator - validates express, morning, afternoon, evening slots', () => {
  // Test 1: Express 1h-2h at 14:00 today (during store hours) -> Valid
  const orderTime1400 = new Date('2026-09-30T14:00:00+07:00');
  const expressRes = validateDeliverySlot('EXPRESS_1H_2H', {
    orderTime: orderTime1400,
    targetDate: orderTime1400,
  });
  assert.strictEqual(expressRes.isValid, true);
  assert.ok(expressRes.estimatedDeliveryWindow);

  // Test 2: Express 1h-2h at 23:00 today (outside store hours) -> Invalid
  const orderTime2300 = new Date('2026-09-30T23:00:00+07:00');
  const lateExpressRes = validateDeliverySlot('EXPRESS_1H_2H', {
    orderTime: orderTime2300,
    targetDate: orderTime2300,
  });
  assert.strictEqual(lateExpressRes.isValid, false);
  assert.ok(lateExpressRes.reason?.includes('Đã quá giờ nhận đơn hỏa tốc'));

  // Test 3: Morning slot (cutoff 10:30) evaluated at 11:00 am same day -> Invalid
  const orderTime1100 = new Date('2026-09-30T11:00:00+07:00');
  const morningExpiredRes = validateDeliverySlot('MORNING', {
    orderTime: orderTime1100,
    targetDate: orderTime1100,
  });
  assert.strictEqual(morningExpiredRes.isValid, false);
  assert.ok(morningExpiredRes.reason?.includes('Đã qua thời gian nhận đơn'));

  // Test 4: Morning slot evaluated at 09:00 am same day -> Valid
  const orderTime0900 = new Date('2026-09-30T09:00:00+07:00');
  const morningValidRes = validateDeliverySlot('MORNING', {
    orderTime: orderTime0900,
    targetDate: orderTime0900,
  });
  assert.strictEqual(morningValidRes.isValid, true);

  // Test 5: Morning slot for next day -> Valid even if ordered at 22:00
  const tomorrow = new Date('2026-10-01T10:00:00+07:00');
  const futureRes = validateDeliverySlot('MORNING', {
    orderTime: orderTime2300,
    targetDate: tomorrow,
  });
  assert.strictEqual(futureRes.isValid, true);

  // Test 6: Past date -> Invalid
  const yesterday = new Date('2026-09-29T10:00:00+07:00');
  const pastRes = validateDeliverySlot('AFTERNOON', {
    orderTime: orderTime0900,
    targetDate: yesterday,
  });
  assert.strictEqual(pastRes.isValid, false);
  assert.ok(pastRes.reason?.includes('quá khứ'));

  // Test 7: getAvailableDeliverySlots returns array of available slots
  const available = getAvailableDeliverySlots({ orderTime: orderTime1400 });
  assert.ok(Array.isArray(available));
  assert.ok(available.length > 0);
  assert.ok(available.some((s) => s.id === 'AFTERNOON'));
  assert.ok(available.some((s) => s.id === 'EVENING'));
});

test('Carrier Mock Adapters - calculates quotes for AhaMove, GrabExpress, and GHTK', async () => {
  const input = {
    origin: STORE_COORDS,
    destination: CUSTOMER_DISTANT, // ~3.53 km
    orderTotal: 200000,
    isPeakHour: false,
    isRainy: false,
  };

  // AhaMove: 3km = 16,000, +1km (ceil of 0.53km) * 5,500 = 21,500 VND
  const ahaMove = new AhaMoveAdapter();
  const ahaQuote = await ahaMove.getQuote(input);
  assert.strictEqual(ahaQuote.carrierId, 'ahamove');
  assert.strictEqual(ahaQuote.fee, 21500);
  assert.ok(ahaQuote.estimatedMinutes.min > 0);

  // AhaMove with rain surge (+20% of 21,500 = 4,300 -> 25,800 VND)
  const ahaRainQuote = await ahaMove.getQuote({ ...input, isRainy: true });
  assert.strictEqual(ahaRainQuote.fee, 21500 + 4300);

  // GrabExpress: 2km = 15,000, +2km (ceil of 1.53km) * 5,000 = 25,000 VND
  const grab = new GrabExpressAdapter();
  const grabQuote = await grab.getQuote(input);
  assert.strictEqual(grabQuote.carrierId, 'grabexpress');
  assert.strictEqual(grabQuote.fee, 25000);

  // GrabExpress with peak hour surge (+25% of 25,000 = 6,250 -> 31,250 VND)
  const grabPeakQuote = await grab.getQuote({ ...input, isPeakHour: true });
  assert.strictEqual(grabPeakQuote.fee, 31250);

  // GHTK: 5km flat = 22,000 VND (3.53 km is under 5km)
  const ghtk = new GHTKAdapter();
  const ghtkQuote = await ghtk.getQuote(input);
  assert.strictEqual(ghtkQuote.carrierId, 'ghtk');
  assert.strictEqual(ghtkQuote.fee, 22000);

  // getAllCarrierQuotes returns quotes from all 3 carriers sorted by price
  const allQuotes = await getAllCarrierQuotes(input);
  assert.strictEqual(allQuotes.length, 3);
  assert.ok(allQuotes[0].fee <= allQuotes[1].fee);
  assert.ok(allQuotes[1].fee <= allQuotes[2].fee);
});

test('Zod Schemas - validates CalculateShippingInput and defaults', () => {
  const parsed = CalculateShippingInputSchema.parse({
    origin: { lat: 10.7951, lng: 106.7218 },
    destination: { lat: 10.7725, lng: 106.6980 },
  });

  assert.strictEqual(parsed.origin.latitude, 10.7951);
  assert.strictEqual(parsed.origin.longitude, 106.7218);
  assert.strictEqual(parsed.orderTotal, 0); // default
});
