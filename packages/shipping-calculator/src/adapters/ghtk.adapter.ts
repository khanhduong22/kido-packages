import { calculateHaversineDistance } from '../haversine/haversine';
import {
  CalculateShippingInput,
  CalculateShippingInputSchema,
  CarrierQuote,
  CarrierQuoteSchema,
} from '../schemas/shipping.schema';
import { ShippingCarrierAdapter } from './types';

export class GHTKAdapter implements ShippingCarrierAdapter {
  readonly carrierId = 'ghtk';
  readonly carrierName = 'Giao Hàng Tiết Kiệm (GHTK)';

  async getQuote(input: CalculateShippingInput): Promise<CarrierQuote> {
    const validatedInput = CalculateShippingInputSchema.parse(input);
    const distanceKm = calculateHaversineDistance(
      validatedInput.origin,
      validatedInput.destination,
      { roundDecimals: 2 }
    );

    // GHTK Economy / Same-Day Urban Delivery Formula:
    // Up to 5km: flat 22,000 VND
    // Each additional km: 3,000 VND
    const baseDistance = 5;
    const baseRate = 22000;
    const perKmRate = 3000;

    const extraKm = Math.max(0, distanceKm - baseDistance);
    const standardFee = baseRate + Math.ceil(extraKm) * perKmRate;

    // GHTK generally has fixed tariffs without dynamic rain surges
    const totalFee = standardFee;

    // Standard courier delivery timeframe: 4 - 6 hours (240 - 360 mins)
    const minMins = 240;
    const maxMins = 360;

    const quote: CarrierQuote = {
      carrierId: this.carrierId,
      carrierName: this.carrierName,
      serviceName: 'GHTK - Tiết Kiệm Trong Ngày',
      fee: totalFee,
      currency: 'VND',
      distanceKm,
      estimatedMinutes: {
        min: minMins,
        max: maxMins,
      },
      breakdown: {
        baseFee: standardFee,
        surgeFee: 0,
      },
      notes: 'Giao tiết kiệm trong 4-6 giờ hoặc ca kế tiếp',
    };

    return CarrierQuoteSchema.parse(quote);
  }
}
