import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  haversineDistance,
  haversineDistanceMeters,
  estimateRoadDistance,
  estimateTravelTimeMinutes,
  VIETNAM_AIRPORTS,
  AIRPORT_FIXED_ROUTES,
  getAirportByCode,
  getFixedRouteById,
  findMatchingAirportRoute,
  calculateFare,
  createRouteQuote,
  isNightTime,
  isPeakHour,
  calculateDepositAmount,
  getOsrmRoute,
  RideBookingInputSchema,
  RouteQuoteSchema,
} from './index';

describe('@kido/geocoding-routing Package Test Suite', () => {
  // Test 1: Haversine distance & curvature estimation
  it('1. Calculates Haversine distance and estimates road distance with curvature factor', () => {
    // Noi Bai Airport to Hoan Kiem Lake
    const noiBai = { lat: 21.2212, lon: 105.8072 };
    const hoanKiem = { lat: 21.0285, lon: 105.8542 };

    const directKm = haversineDistance(noiBai, hoanKiem);
    const directMeters = haversineDistanceMeters(noiBai, hoanKiem);

    assert.ok(directKm > 20 && directKm < 25, `Expected directKm ~21-23km, got ${directKm}`);
    assert.equal(directMeters, Math.round(directKm * 1000));

    // Road distance with default 1.3 factor
    const roadKm = estimateRoadDistance(noiBai, hoanKiem);
    assert.ok(roadKm > directKm, 'Road distance must be greater than straight-line distance');
    assert.ok(roadKm >= directKm * 1.25 && roadKm <= directKm * 1.35, 'Road distance within curvature factor range');

    // Travel time estimate
    const travelMinutes = estimateTravelTimeMinutes(roadKm);
    assert.ok(travelMinutes >= 30 && travelMinutes <= 60, `Expected 30-60 mins, got ${travelMinutes}`);
  });

  // Test 2: Vietnam airport hubs lookup and fixed routes
  it('2. Correctly loads Vietnam airport hubs and validates fixed routes', () => {
    assert.ok(VIETNAM_AIRPORTS.length >= 7, 'Must have at least 7 major airports');

    const han = getAirportByCode('HAN');
    assert.ok(han, 'Should find Noi Bai Airport HAN');
    assert.equal(han?.city, 'Hà Nội');

    const sgn = getAirportByCode('sgn'); // Case-insensitive
    assert.ok(sgn, 'Should find Tan Son Nhat Airport SGN');
    assert.equal(sgn?.city, 'TP. Hồ Chí Minh');

    const hanRoute = getFixedRouteById('HAN-HN-CENTER');
    assert.ok(hanRoute, 'Should find HAN-HN-CENTER fixed route');
    assert.equal(hanRoute?.fares.SEDAN_4, 220000);
    assert.equal(hanRoute?.fares.SUV_7, 260000);
    assert.equal(hanRoute?.fares.VIP_CARNIVAL, 450000);

    // Matching route helper
    const matched = findMatchingAirportRoute(
      { lat: 21.2212, lon: 105.8072 }, // at Noi Bai
      { lat: 21.0285, lon: 105.8542 }  // at Hoan Kiem
    );
    assert.ok(matched, 'Should match fixed route for HAN -> Hoan Kiem');
    assert.equal(matched?.id, 'HAN-HN-CENTER');
  });

  // Test 3: Airport fixed route fare calculation with night & deposit logic
  it('3. Calculates airport fixed route fare, vehicle surcharge, and deposits', () => {
    // Daytime Sedan 4c
    const quote4c = calculateFare({
      distanceKm: 30,
      airportRouteId: 'HAN-HN-CENTER',
      vehicleType: 'SEDAN_4',
      pickupTime: '14:00',
    });
    assert.equal(quote4c.isFixedAirportRoute, true);
    assert.equal(quote4c.totalFare, 220000);
    assert.equal(quote4c.depositAmount, 100000);

    // SUV 7c at 23:30 (Night surcharge +50k)
    const quote7cNight = calculateFare({
      distanceKm: 30,
      airportRouteId: 'HAN-HN-CENTER',
      vehicleType: 'SUV_7',
      pickupTime: '23:30',
    });
    assert.equal(quote7cNight.isFixedAirportRoute, true);
    assert.equal(quote7cNight.baseFare, 260000);
    assert.equal(quote7cNight.nightSurcharge, 50000);
    assert.equal(quote7cNight.totalFare, 310000); // 260k + 50k
    assert.equal(quote7cNight.depositAmount, 200000); // >= 300k deposit is 200k

    // VIP Carnival
    const quoteVip = calculateFare({
      distanceKm: 30,
      airportRouteId: 'HAN-HN-CENTER',
      vehicleType: 'VIP_CARNIVAL',
      pickupTime: '10:00',
    });
    assert.equal(quoteVip.totalFare, 450000);
  });

  // Test 4: Tiered km distance fare calculation (1-5km, 6-30km, >30km discount)
  it('4. Computes tiered km distance fares with long-distance 15% discount', () => {
    // 10km Sedan 4c: 5km * 14000 + 5km * 12000 = 70000 + 60000 = 130000
    const fare10km = calculateFare({
      distanceKm: 10,
      vehicleType: 'SEDAN_4',
      pickupTime: '12:00',
    });
    assert.equal(fare10km.isFixedAirportRoute, false);
    assert.equal(fare10km.distanceFare, 130000);
    assert.equal(fare10km.totalFare, 130000);
    assert.equal(fare10km.tieredCharges.length, 2);

    // 50km Long-distance: 5km * 14k + 25km * 12k + 20km * (12k * 0.85 = 10.2k)
    // 70,000 + 300,000 + 204,000 = 574,000
    const fare50km = calculateFare({
      distanceKm: 50,
      vehicleType: 'SEDAN_4',
      pickupTime: '12:00',
    });
    assert.equal(fare50km.distanceFare, 574000);
    assert.equal(fare50km.totalFare, 574000);
    assert.equal(fare50km.tieredCharges.length, 3);
    assert.equal(fare50km.tieredCharges[2].ratePerKm, 10200);
  });

  // Test 5: Round trip discount and peak hours surcharge
  it('5. Handles 20% round trip discount and morning peak hour surcharge', () => {
    // Morning rush hour: 08:15 (peak surcharge +30k)
    assert.equal(isPeakHour('08:15'), true);
    assert.equal(isPeakHour('12:00'), false);
    assert.equal(isPeakHour('17:45'), true);
    assert.equal(isNightTime('23:00'), true);
    assert.equal(isNightTime('03:30'), true);
    assert.equal(isNightTime('09:00'), false);

    // Round trip 20km each way (total 40km) with morning peak hour
    const rtFare = calculateFare({
      distanceKm: 20,
      isRoundTrip: true,
      vehicleType: 'SEDAN_4',
      pickupTime: '08:00',
    });
    // 40km total: 5km * 14k + 25km * 12k + 10km * 10.2k = 70k + 300k + 102k = 472,000
    // Vehicle: 4c multiplier 1.0
    // Peak surcharge: +30,000
    // Subtotal before discount: 472k + 30k = 502k
    // Round trip discount: 20% of 472,000 = 94,400
    // Total fare: 502,000 - 94,400 = 407,600 -> rounded to 408,000
    assert.ok(rtFare.roundTripDiscount > 0, 'Round trip discount must be applied');
    assert.equal(rtFare.peakSurcharge, 30000);
    assert.equal(rtFare.totalFare, 408000);
  });

  // Test 6: OSRM Client and graceful fallback to Haversine
  it('6. OSRM routing works with mock fetch and gracefully falls back to Haversine on error', async () => {
    // Test 6a: Successful OSRM mock response
    const mockSuccessFetch = async () => {
      return {
        ok: true,
        json: async () => ({
          code: 'Ok',
          routes: [{ distance: 30000, duration: 2400 }],
        }),
      } as any;
    };

    const resSuccess = await getOsrmRoute(
      { lat: 21.0, lon: 105.8 },
      { lat: 21.2, lon: 105.8 },
      { fetchFn: mockSuccessFetch }
    );
    assert.equal(resSuccess.isFallback, false);
    assert.equal(resSuccess.source, 'osrm');
    assert.equal(resSuccess.distanceKm, 30);
    assert.equal(resSuccess.durationMinutes, 40);

    // Test 6b: Network failure triggers graceful Haversine fallback
    const mockFailingFetch = async () => {
      throw new Error('Network timeout');
    };

    const resFallback = await getOsrmRoute(
      { lat: 21.0, lon: 105.8 },
      { lat: 21.2, lon: 105.8 },
      { fetchFn: mockFailingFetch }
    );
    assert.equal(resFallback.isFallback, true);
    assert.equal(resFallback.source, 'haversine_fallback');
    assert.ok(resFallback.distanceKm > 20, 'Fallback calculates distance via Haversine');
    assert.ok(resFallback.durationMinutes > 0, 'Fallback calculates duration');
  });

  // Test 7: Zod Schemas Validation
  it('7. Zod schemas validate ride booking input and route quotes', () => {
    const validBooking = {
      customerName: 'Nguyễn Văn An',
      customerPhone: '0988123456',
      customerEmail: 'an.nguyen@vietride.vn',
      pickupAddress: '22 Hàng Buồm, Hoàn Kiếm, Hà Nội',
      dropoffAddress: 'Sân bay Quốc tế Nội Bài T2',
      vehicleType: 'SEDAN_4' as const,
      pickupTime: '2026-10-05T08:30',
      isRoundTrip: false,
      flightNumber: 'VN123',
    };

    const parsed = RideBookingInputSchema.safeParse(validBooking);
    assert.equal(parsed.success, true);

    // Invalid phone number test
    const invalidPhone = { ...validBooking, customerPhone: '123' };
    const parsedInvalid = RideBookingInputSchema.safeParse(invalidPhone);
    assert.equal(parsedInvalid.success, false);

    // Route quote creation helper
    const quote = createRouteQuote({
      pickupAddress: validBooking.pickupAddress,
      dropoffAddress: validBooking.dropoffAddress,
      distanceKm: 30,
      durationMinutes: 45,
      vehicleType: 'SEDAN_4',
      pickupTime: validBooking.pickupTime,
    });
    const quoteParsed = RouteQuoteSchema.safeParse(quote);
    assert.equal(quoteParsed.success, true);
    assert.equal(quote.totalFare > 0, true);
  });
});
