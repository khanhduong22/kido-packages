import { CalculateShippingInput, CarrierQuote } from '../schemas/shipping.schema';
import { AhaMoveAdapter } from './ahamove.adapter';
import { GHTKAdapter } from './ghtk.adapter';
import { GrabExpressAdapter } from './grabexpress.adapter';
import { ShippingCarrierAdapter } from './types';

export * from './types';
export * from './ahamove.adapter';
export * from './grabexpress.adapter';
export * from './ghtk.adapter';

export const defaultCarrierAdapters: ShippingCarrierAdapter[] = [
  new AhaMoveAdapter(),
  new GrabExpressAdapter(),
  new GHTKAdapter(),
];

/**
 * Fetches quotes from all integrated carriers (AhaMove, GrabExpress, GHTK) in parallel.
 *
 * @param input Calculate shipping input parameters
 * @param adapters Custom carrier adapter array (defaults to standard adapters)
 * @returns Array of carrier quotes sorted by fee (ascending)
 */
export async function getAllCarrierQuotes(
  input: CalculateShippingInput,
  adapters: ShippingCarrierAdapter[] = defaultCarrierAdapters
): Promise<CarrierQuote[]> {
  const quotePromises = adapters.map(async (adapter) => {
    try {
      return await adapter.getQuote(input);
    } catch (error) {
      console.error(`Lỗi khi lấy báo giá từ đối tác ${adapter.carrierName}:`, error);
      return null;
    }
  });

  const quotes = await Promise.all(quotePromises);
  const validQuotes = quotes.filter((q): q is CarrierQuote => q !== null);

  // Default sorting: lowest price first
  return validQuotes.sort((a, b) => a.fee - b.fee);
}
