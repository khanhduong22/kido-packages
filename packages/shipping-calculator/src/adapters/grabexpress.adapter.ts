import { calculateHaversineDistance } from '../haversine/haversine';
import {
  CalculateShippingInput,
  CalculateShippingInputSchema,
  CarrierQuote,
  CarrierQuoteSchema,
} from '../schemas/shipping.schema';
import { ShippingCarrierAdapter } from './types';

export class GrabExpressAdapter implements ShippingCarrierAdapter {
  readonly carrierId = 'grabexpress';
  readonly carrierName = 'GrabExpress';

  async getQuote(input: CalculateShippingInput): Promise<CarrierQuote> {
    const validatedInput = CalculateShippingInputSchema.parse(input);
    const distanceKm = calculateHaversineDistance(
      validatedInput.origin,
      validatedInput.destination,
      { roundDecimals: 2 }
    );

    // GrabExpress Instant Bike Pricing Formula:
    // First 2km: 15,000 VND
    // Each additional km: 5,000 VND
    const baseDistance = 2;
    const baseRate = 15000;
    const perKmRate = 5000;

    const extraKm = Math.max(0, distanceKm - baseDistance);
    const standardFee = baseRate + Math.ceil(extraKm) * perKmRate;

    // Peak hour surge: 25%, Rain surge: 20%
    let surgeFee = 0;
    const notes: string[] = [];

    if (validatedInput.isPeakHour) {
      surgeFee += Math.round(standardFee * 0.25);
      notes.push('Phụ phí cao điểm (+25%)');
    }

    if (validatedInput.isRainy) {
      surgeFee += Math.round(standardFee * 0.2);
      notes.push('Phụ phí trời mưa (+20%)');
    }

    const totalFee = standardFee + surgeFee;
    const minMins = Math.round(15 + distanceKm * 2.5);
    const maxMins = Math.round(25 + distanceKm * 3.5);

    const quote: CarrierQuote = {
      carrierId: this.carrierId,
      carrierName: this.carrierName,
      serviceName: 'GrabExpress - Siêu Tốc',
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
      notes: notes.length > 0 ? notes.join(', ') : undefined,
    };

    return CarrierQuoteSchema.parse(quote);
  }
}
