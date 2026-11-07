import { calculateHaversineDistance } from '../haversine/haversine';
import {
  CalculateShippingInput,
  CalculateShippingInputSchema,
  CarrierQuote,
  CarrierQuoteSchema,
} from '../schemas/shipping.schema';
import { ShippingCarrierAdapter } from './types';

export class AhaMoveAdapter implements ShippingCarrierAdapter {
  readonly carrierId = 'ahamove';
  readonly carrierName = 'AhaMove';

  async getQuote(input: CalculateShippingInput): Promise<CarrierQuote> {
    const validatedInput = CalculateShippingInputSchema.parse(input);
    const distanceKm = calculateHaversineDistance(
      validatedInput.origin,
      validatedInput.destination,
      { roundDecimals: 2 }
    );

    // AhaMove Bike Pricing Formula:
    // First 3km: 16,000 VND
    // Each additional km: 5,500 VND
    const baseDistance = 3;
    const baseRate = 16000;
    const perKmRate = 5500;

    const extraKm = Math.max(0, distanceKm - baseDistance);
    const standardFee = baseRate + Math.ceil(extraKm) * perKmRate;

    // Bad weather surcharge: 20%
    let surgeFee = 0;
    if (validatedInput.isRainy) {
      surgeFee += Math.round(standardFee * 0.2);
    }

    const totalFee = standardFee + surgeFee;
    const minMins = Math.round(20 + distanceKm * 3);
    const maxMins = Math.round(35 + distanceKm * 4.5);

    const quote: CarrierQuote = {
      carrierId: this.carrierId,
      carrierName: this.carrierName,
      serviceName: 'AhaMove - Siêu Tốc',
      fee: totalFee,
      currency: 'VND',
      distanceKm,
      estimatedMinutes: {
        min: minMins,
        max: maxMins,
      },
      breakdown: {
        baseFee: standardFee,
        surgeFee,
      },
      notes: validatedInput.isRainy ? 'Bao gồm phụ phí thời tiết mưa (+20%)' : undefined,
    };

    return CarrierQuoteSchema.parse(quote);
  }
}
