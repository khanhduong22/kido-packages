import {
  DeliverySlot,
  DeliverySlotType,
  DeliverySlotValidationResult,
} from '../schemas/shipping.schema';

export const STANDARD_DELIVERY_SLOTS: Record<DeliverySlotType, DeliverySlot> = {
  EXPRESS_1H_2H: {
    id: 'EXPRESS_1H_2H',
    label: 'Giao hỏa tốc 1h - 2h',
    description: 'Nhận hàng nhanh chóng trong vòng 60 đến 120 phút',
    startTime: '08:00',
    endTime: '21:00',
    cutoffTime: '20:00',
    surcharge: 10000,
  },
  MORNING: {
    id: 'MORNING',
    label: 'Ca sáng (08:00 - 12:00)',
    description: 'Giao hàng buổi sáng',
    startTime: '08:00',
    endTime: '12:00',
    cutoffTime: '10:30',
    surcharge: 0,
  },
  AFTERNOON: {
    id: 'AFTERNOON',
    label: 'Ca chiều (13:00 - 17:00)',
    description: 'Giao hàng buổi chiều',
    startTime: '13:00',
    endTime: '17:00',
    cutoffTime: '15:30',
    surcharge: 0,
  },
  EVENING: {
    id: 'EVENING',
    label: 'Ca tối (18:00 - 21:30)',
    description: 'Giao hàng buổi tối',
    startTime: '18:00',
    endTime: '21:30',
    cutoffTime: '19:30',
    surcharge: 5000,
  },
};

export interface ValidateSlotOptions {
  orderTime?: Date;
  targetDate?: Date | string;
  storeOpeningHour?: number; // default: 8 (08:00)
  storeClosingHour?: number; // default: 21 (21:00)
}

function parseTimeToMinutes(timeStr: string): number {
  const [hours, minutes] = timeStr.split(':').map(Number);
  return hours * 60 + minutes;
}

function getVNParts(date: Date): { year: number; month: number; day: number; hour: number; minute: number } {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const partMap: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== 'literal') {
      partMap[part.type] = parseInt(part.value, 10);
    }
  }
  return {
    year: partMap.year || date.getFullYear(),
    month: partMap.month || date.getMonth() + 1,
    day: partMap.day || date.getDate(),
    hour: (partMap.hour === 24 ? 0 : partMap.hour) ?? date.getHours(),
    minute: partMap.minute ?? date.getMinutes(),
  };
}

function isSameDay(d1: Date, d2: Date): boolean {
  const p1 = getVNParts(d1);
  const p2 = getVNParts(d2);
  return p1.year === p2.year && p1.month === p2.month && p1.day === p2.day;
}

function isPastDay(target: Date, reference: Date): boolean {
  const p1 = getVNParts(target);
  const p2 = getVNParts(reference);
  const t1 = p1.year * 10000 + p1.month * 100 + p1.day;
  const t2 = p2.year * 10000 + p2.month * 100 + p2.day;
  return t1 < t2;
}

/**
 * Validates whether a delivery slot is available and valid for a given order time and delivery date.
 */
export function validateDeliverySlot(
  slotType: DeliverySlotType,
  options: ValidateSlotOptions = {}
): DeliverySlotValidationResult {
  const orderTime = options.orderTime ? new Date(options.orderTime) : new Date();
  const targetDate = options.targetDate ? new Date(options.targetDate) : new Date(orderTime);

  const slot = STANDARD_DELIVERY_SLOTS[slotType];
  if (!slot) {
    return {
      isValid: false,
      slotType,
      reason: `Khung giờ giao hàng không xác định: ${slotType}`,
    };
  }

  // Reject dates in the past
  if (isPastDay(targetDate, orderTime)) {
    return {
      isValid: false,
      slotType,
      slot,
      reason: 'Ngày giao hàng đã qua trong quá khứ.',
    };
  }

  const isToday = isSameDay(targetDate, orderTime);
  const vnTime = getVNParts(orderTime);
  const currentMinutes = vnTime.hour * 60 + vnTime.minute;

  // If EXPRESS_1H_2H
  if (slotType === 'EXPRESS_1H_2H') {
    if (!isToday) {
      return {
        isValid: false,
        slotType,
        slot,
        reason: 'Giao hỏa tốc 1h-2h chỉ áp dụng cho đơn giao ngay trong ngày hôm nay.',
      };
    }

    const openingMinutes = (options.storeOpeningHour ?? 8) * 60;
    const cutoffMinutes = slot.cutoffTime
      ? parseTimeToMinutes(slot.cutoffTime)
      : (options.storeClosingHour ?? 21) * 60 - 60;

    if (currentMinutes < openingMinutes) {
      return {
        isValid: false,
        slotType,
        slot,
        reason: `Cửa hàng chưa mở cửa (giờ mở cửa: ${Math.floor(openingMinutes / 60)}:00).`,
      };
    }

    if (currentMinutes > cutoffMinutes) {
      return {
        isValid: false,
        slotType,
        slot,
        reason: `Đã quá giờ nhận đơn hỏa tốc hôm nay (hạn chót nhận đơn: ${slot.cutoffTime}).`,
      };
    }

    const estimatedStart = new Date(orderTime.getTime() + 60 * 60 * 1000); // +1 hour
    const estimatedEnd = new Date(orderTime.getTime() + 120 * 60 * 1000); // +2 hours

    return {
      isValid: true,
      slotType,
      slot,
      estimatedDeliveryWindow: {
        startTime: estimatedStart,
        endTime: estimatedEnd,
      },
    };
  }

  // Scheduled slots (MORNING, AFTERNOON, EVENING)
  if (isToday && slot.cutoffTime) {
    const cutoffMinutes = parseTimeToMinutes(slot.cutoffTime);
    if (currentMinutes >= cutoffMinutes) {
      return {
        isValid: false,
        slotType,
        slot,
        reason: `Đã qua thời gian nhận đơn cho ${slot.label} trong ngày (hạn chót: ${slot.cutoffTime}). Quý khách vui lòng chọn ca tiếp theo hoặc giao vào ngày mai.`,
      };
    }
  }

  // Construct delivery window
  const [startHour, startMin] = slot.startTime.split(':').map(Number);
  const [endHour, endMin] = slot.endTime.split(':').map(Number);

  const windowStart = new Date(targetDate);
  windowStart.setHours(startHour, startMin, 0, 0);

  const windowEnd = new Date(targetDate);
  windowEnd.setHours(endHour, endMin, 0, 0);

  return {
    isValid: true,
    slotType,
    slot,
    estimatedDeliveryWindow: {
      startTime: windowStart,
      endTime: windowEnd,
    },
  };
}

/**
 * Returns all currently available delivery slots for the specified order time and date.
 */
export function getAvailableDeliverySlots(
  options: ValidateSlotOptions = {}
): Array<DeliverySlot & { estimatedDeliveryWindow?: { startTime: Date; endTime: Date } }> {
  const slotTypes: DeliverySlotType[] = [
    'EXPRESS_1H_2H',
    'MORNING',
    'AFTERNOON',
    'EVENING',
  ];

  const available: Array<
    DeliverySlot & { estimatedDeliveryWindow?: { startTime: Date; endTime: Date } }
  > = [];

  for (const slotType of slotTypes) {
    const res = validateDeliverySlot(slotType, options);
    if (res.isValid && res.slot) {
      available.push({
        ...res.slot,
        estimatedDeliveryWindow: res.estimatedDeliveryWindow,
      });
    }
  }

  return available;
}
