import { CalculateShippingInput, CarrierQuote } from '../schemas/shipping.schema';

export interface ShippingCarrierAdapter {
  carrierId: string;
  carrierName: string;
  getQuote(input: CalculateShippingInput): Promise<CarrierQuote>;
}
