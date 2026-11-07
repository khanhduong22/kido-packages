import {
  GearItem,
  GearCategory,
  WarehouseLocation,
  RentalBooking,
  ConflictCheckResult,
} from './types';

/**
 * Normalizes input date/time to a numeric timestamp (milliseconds).
 */
function toTimestamp(dateInput: Date | string | number): number {
  if (dateInput instanceof Date) {
    return dateInput.getTime();
  }
  if (typeof dateInput === 'number') {
    return dateInput;
  }
  const parsed = new Date(dateInput).getTime();
  if (isNaN(parsed)) {
    throw new Error(`Invalid date format: ${dateInput}`);
  }
  return parsed;
}

/**
 * Checks if a specific gear item has any scheduling conflict for a requested time interval,
 * taking into account setup and teardown buffer time (default 2 hours).
 *
 * @param gearId The unique ID of the equipment
 * @param requestedStart Start time of requested rental
 * @param requestedEnd End time of requested rental
 * @param existingBookings List of existing bookings to check against
 * @param bufferHours Buffer time in hours for setup and teardown (default: 2 hours)
 * @returns ConflictCheckResult indicating whether conflict exists and which bookings clash
 */
export function checkGearConflict(
  gearId: string,
  requestedStart: Date | string | number,
  requestedEnd: Date | string | number,
  existingBookings: RentalBooking[],
  bufferHours: number = 2
): ConflictCheckResult {
  const reqStart = toTimestamp(requestedStart);
  const reqEnd = toTimestamp(requestedEnd);

  if (reqStart >= reqEnd) {
    throw new Error(
      `requestedStart (${new Date(reqStart).toISOString()}) must be earlier than requestedEnd (${new Date(reqEnd).toISOString()})`
    );
  }

  const defaultBufferMs = bufferHours * 3600 * 1000;
  const conflictingBookings: RentalBooking[] = [];

  for (const booking of existingBookings) {
    // Ignore cancelled bookings
    if (booking.status === 'CANCELLED') {
      continue;
    }

    // Check if the requested gear is part of this booking
    if (!booking.gearIds.includes(gearId)) {
      continue;
    }

    const bookStart = toTimestamp(booking.startTime);
    const bookEnd = toTimestamp(booking.endTime);

    // Apply buffer: setup buffer before start, teardown buffer after end
    const setupBufferMs =
      booking.setupBufferHours !== undefined
        ? booking.setupBufferHours * 3600 * 1000
        : defaultBufferMs;

    const teardownBufferMs =
      booking.teardownBufferHours !== undefined
        ? booking.teardownBufferHours * 3600 * 1000
        : defaultBufferMs;

    // The effective window blocked for this gear by the existing booking
    const blockedStart = bookStart - setupBufferMs;
    const blockedEnd = bookEnd + teardownBufferMs;

    // Two intervals [A, B] and [C, D] overlap if A < D and B > C
    const isOverlapping = reqStart < blockedEnd && reqEnd > blockedStart;

    if (isOverlapping) {
      conflictingBookings.push(booking);
    }
  }

  const hasConflict = conflictingBookings.length > 0;
  let reason: string | undefined;

  if (hasConflict) {
    const bookingSummary = conflictingBookings
      .map(
        (b) =>
          `Booking #${b.id} (${b.customerName}, ${new Date(b.startTime).toISOString()} - ${new Date(b.endTime).toISOString()})`
      )
      .join('; ');
    reason = `Gear ${gearId} conflicts with ${conflictingBookings.length} booking(s) within ${bufferHours}h buffer: ${bookingSummary}`;
  }

  return {
    hasConflict,
    gearId,
    conflictingBookings,
    reason,
    effectiveInterval: {
      start: new Date(reqStart),
      end: new Date(reqEnd),
    },
  };
}

/**
 * Helper to quickly check if a gear is available (boolean return).
 */
export function isGearAvailable(
  gearId: string,
  requestedStart: Date | string | number,
  requestedEnd: Date | string | number,
  existingBookings: RentalBooking[],
  bufferHours: number = 2
): boolean {
  return !checkGearConflict(gearId, requestedStart, requestedEnd, existingBookings, bufferHours).hasConflict;
}

/**
 * Finds all available gear items matching category, warehouse location, and time window.
 *
 * @param gears Pool of equipment
 * @param bookings All existing bookings
 * @param startTime Desired start time
 * @param endTime Desired end time
 * @param category Optional category filter (e.g. PHOTOBOOTH_GLAMBOT, CAMERA_BODY)
 * @param location Optional warehouse location filter (DA_NANG or HO_CHI_MINH)
 * @param bufferHours Setup/teardown turnaround buffer hours (default: 2)
 * @returns Array of available GearItem instances
 */
export function findAvailableGear(
  gears: GearItem[],
  bookings: RentalBooking[],
  startTime: Date | string | number,
  endTime: Date | string | number,
  category?: GearCategory,
  location?: WarehouseLocation,
  bufferHours: number = 2
): GearItem[] {
  return gears.filter((gear) => {
    // 1. Exclude broken or unavailable equipment
    if (
      gear.status === 'DAMAGED' ||
      gear.status === 'MAINTENANCE' ||
      gear.status === 'IN_TRANSIT'
    ) {
      return false;
    }

    // 2. Filter by category if specified
    if (category && gear.category !== category) {
      return false;
    }

    // 3. Filter by warehouse location if specified
    if (location && gear.warehouseLocation !== location) {
      return false;
    }

    // 4. Check for double booking conflicts with buffer
    const conflict = checkGearConflict(
      gear.id,
      startTime,
      endTime,
      bookings,
      bufferHours
    );

    return !conflict.hasConflict;
  });
}
