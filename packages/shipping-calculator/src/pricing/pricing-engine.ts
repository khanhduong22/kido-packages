import { calculateHaversineDistance } from '../haversine/haversine';
import {
  CalculateShippingInput,
  CalculateShippingInputSchema,
  ShippingQuote,
  ShippingRule,
  ShippingRuleSchema,
} from '../schemas/shipping.schema';
import { STANDARD_DELIVERY_SLOTS, validateDeliverySlot } from '../slots/slot-validator';

export const DEFAULT_SHIPPING_RULE: ShippingRule = {
  baseDistanceKm: 2,
  baseFee: 15000,
  perKmFee: 5000,
  freeShippingThreshold: 500000,
  maxDeliveryDistanceKm: 40,
  surcharges: {
    peakHourMultiplier: 1.2,
    peakHourFlatFee: 0,
    rainMultiplier: 1.25,
    rainFlatFee: 5000,
    nightMultiplier: 1.3,
    nightFlatFee: 10000,
    customFlatFee: 0,
  },
};

function getVNHoursAndMinutes(date: Date): { hours: number; minutes: number } {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Ho_Chi_Minh',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  let hours = date.getHours();
  let minutes = date.getMinutes();
  for (const part of parts) {
    if (part.type === 'hour') hours = parseInt(part.value, 10);
    if (part.type === 'minute') minutes = parseInt(part.value, 10);
  }
  if (hours === 24) hours = 0;
  return { hours, minutes };
}

/**
 * Checks if a given Date falls within typical peak meal hours in Vietnam
 * (11:00 - 13:00 for lunch, 17:30 - 19:30 for dinner)
 */
export function isPeakHourTime(date: Date): boolean {
  const { hours, minutes } = getVNHoursAndMinutes(date);
  const currentTotalMins = hours * 60 + minutes;

  // Lunch rush: 11:00 - 13:00 (660 to 780 mins)
  const isLunchRush = currentTotalMins >= 11 * 60 && currentTotalMins <= 13 * 60;

  // Dinner rush: 17:30 - 19:30 (1050 to 1170 mins)
  const isDinnerRush = currentTotalMins >= 17 * 60 + 30 && currentTotalMins <= 19 * 60 + 30;

  return isLunchRush || isDinnerRush;
}

/**
 * Checks if a given Date is during late night / early morning hours (21:00 - 06:00)
 */
export function isNightDeliveryTime(date: Date): boolean {
  const { hours } = getVNHoursAndMinutes(date);
  return hours >= 21 || hours < 6;
}

export interface PricingEngineOptions {
  /**
   * Whether to round up extra distance to the nearest whole kilometer (default: true).
   * E.g. 1.2 km extra distance -> 2 km billed.
   */
  roundUpExtraKm?: boolean;
}

/**
 * Tiered Shipping Pricing Engine
 * Calculates accurate shipping fees based on Haversine distance, tiered pricing rules,
 * free shipping threshold, and situational surcharges (weather, peak hours, night hours, delivery slots).
 */
export function calculateShippingFee(
  input: CalculateShippingInput,
  options: PricingEngineOptions = { roundUpExtraKm: true }
): ShippingQuote {
  const validatedInput = CalculateShippingInputSchema.parse(input);

  // Merge default rule with input-specific rule overrides
  const rule: ShippingRule = ShippingRuleSchema.parse({
    ...DEFAULT_SHIPPING_RULE,
    ...validatedInput.rule,
    surcharges: {
      ...DEFAULT_SHIPPING_RULE.surcharges,
      ...(validatedInput.rule?.surcharges || {}),
    },
  });

  // Calculate distance between origin and destination
  const distanceKm = calculateHaversineDistance(
    validatedInput.origin,
    validatedInput.destination,
    { roundDecimals: 2 }
  );

  if (distanceKm > rule.maxDeliveryDistanceKm) {
    throw new Error(
      `Khoảng cách giao hàng (${distanceKm} km) vượt quá giới hạn tối đa của cửa hàng (${rule.maxDeliveryDistanceKm} km).`
    );
  }

  // 1. Calculate Base Fee and Distance Fee
  let baseFee = rule.baseFee;
  let distanceFee = 0;
  let extraDistanceKm = 0;

  if (distanceKm <= rule.baseDistanceKm) {
    // Within base distance
    extraDistanceKm = 0;
    distanceFee = 0;
  } else {
    // Beyond base distance
    extraDistanceKm = distanceKm - rule.baseDistanceKm;

    if (rule.tiers && rule.tiers.length > 0) {
      // Custom tiered pricing calculation
      let remainingDist = extraDistanceKm;
      let prevUpTo = 0;

      for (const tier of rule.tiers) {
        if (remainingDist <= 0) break;
        const tierCapacity = tier.upToKm - prevUpTo;
        const distInTier = Math.min(remainingDist, tierCapacity);

        if (tier.flatFee !== undefined) {
          distanceFee += tier.flatFee;
        } else if (tier.ratePerKm !== undefined) {
          const billedDist = options.roundUpExtraKm ? Math.ceil(distInTier) : distInTier;
          distanceFee += billedDist * tier.ratePerKm;
        }

        remainingDist -= distInTier;
        prevUpTo = tier.upToKm;
      }

      // If still remaining after all tiers, use default perKmFee
      if (remainingDist > 0) {
        const billedExtra = options.roundUpExtraKm ? Math.ceil(remainingDist) : remainingDist;
        distanceFee += billedExtra * rule.perKmFee;
      }
    } else {
      // Standard per km tiered formula
      const billedExtraKm = options.roundUpExtraKm
        ? Math.ceil(extraDistanceKm)
        : Math.round(extraDistanceKm * 100) / 100;
      distanceFee = billedExtraKm * rule.perKmFee;
    }
  }

  const subtotalBeforeSurcharges = baseFee + distanceFee;

  // 2. Free shipping threshold evaluation
  const freeThreshold = rule.freeShippingThreshold;
  const isFreeShipping =
    freeThreshold !== undefined &&
    freeThreshold > 0 &&
    validatedInput.orderTotal >= freeThreshold;

  let discount = 0;
  if (isFreeShipping) {
    // Waives standard base + distance delivery fee
    discount = subtotalBeforeSurcharges;
  }

  // 3. Surcharges evaluation
  const evaluationDate = validatedInput.deliveryDate
    ? new Date(validatedInput.deliveryDate)
    : new Date();

  const isPeakHour =
    validatedInput.isPeakHour !== undefined
      ? validatedInput.isPeakHour
      : isPeakHourTime(evaluationDate);

  const isRainy = Boolean(validatedInput.isRainy);

  const isNight =
    validatedInput.isNight !== undefined
      ? validatedInput.isNight
      : isNightDeliveryTime(evaluationDate);

  const surchargesConfig = rule.surcharges;

  // Peak hour surcharge
  let peakHourSurcharge = 0;
  if (isPeakHour) {
    peakHourSurcharge =
      Math.round(subtotalBeforeSurcharges * (surchargesConfig.peakHourMultiplier - 1)) +
      surchargesConfig.peakHourFlatFee;
  }

  // Bad weather / Rain surcharge
  let rainSurcharge = 0;
  if (isRainy) {
    rainSurcharge =
      Math.round(subtotalBeforeSurcharges * (surchargesConfig.rainMultiplier - 1)) +
      surchargesConfig.rainFlatFee;
  }

  // Night delivery surcharge
  let nightSurcharge = 0;
  if (isNight) {
    nightSurcharge =
      Math.round(subtotalBeforeSurcharges * (surchargesConfig.nightMultiplier - 1)) +
      surchargesConfig.nightFlatFee;
  }

  // Delivery slot surcharge & validation
  let slotSurcharge = 0;
  let slotInfo: ShippingQuote['slotInfo'] | undefined = undefined;

  if (validatedInput.slotType) {
    const slotDef = STANDARD_DELIVERY_SLOTS[validatedInput.slotType];
    const validation = validateDeliverySlot(validatedInput.slotType, {
      orderTime: evaluationDate,
      targetDate: evaluationDate,
    });

    slotInfo = {
      type: validatedInput.slotType,
      label: slotDef ? slotDef.label : validatedInput.slotType,
      valid: validation.isValid,
      reason: validation.reason,
    };

    if (slotDef && slotDef.surcharge > 0) {
      slotSurcharge = slotDef.surcharge;
    }
  }

  const totalSurcharges =
    peakHourSurcharge + rainSurcharge + nightSurcharge + slotSurcharge;

  // 4. Final fee calculation
  const finalFee = Math.max(
    0,
    subtotalBeforeSurcharges - discount + totalSurcharges
  );

  // Estimated delivery time
  const minMinutes = Math.round(15 + distanceKm * 3.5);
  const maxMinutes = Math.round(25 + distanceKm * 5);

  return {
    distanceKm,
    fee: finalFee,
    currency: 'VND',
    breakdown: {
      distanceKm,
      baseDistanceKm: rule.baseDistanceKm,
      baseFee,
      extraDistanceKm: Math.round(extraDistanceKm * 100) / 100,
      distanceFee,
      subtotalBeforeSurcharges,
      surcharges: {
        peakHour: peakHourSurcharge,
        rain: rainSurcharge,
        night: nightSurcharge,
        slot: slotSurcharge,
        total: totalSurcharges,
      },
      discount,
      finalFee,
      isFreeShipping,
    },
    estimatedDeliveryMinutes: {
      min: minMinutes,
      max: maxMinutes,
    },
    slotInfo,
  };
}
