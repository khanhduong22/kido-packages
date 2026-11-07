/**
 * Vietnamese Phone Number Normalization and Formatting Utilities
 */

const VIETNAMESE_PHONE_REGEX = /^0(3|5|7|8|9)[0-9]{8}$/;

/**
 * Normalizes any Vietnamese phone number string to the standard 10-digit format (e.g. "0912345678").
 * Handles:
 * - "+84912345678" -> "0912345678"
 * - "84912345678"  -> "0912345678"
 * - "840912345678" -> "0912345678"
 * - "912345678"    -> "0912345678"
 * - "0912 345 678" -> "0912345678"
 * - "0912-345-678" -> "0912345678"
 * - "0912.345.678" -> "0912345678"
 */
export function normalizeVietnamesePhoneNumber(phone: string): string {
  if (!phone || typeof phone !== 'string') {
    return '';
  }

  // Remove all non-digit characters
  let cleaned = phone.replace(/\D/g, '');

  // Handle prefix 840... -> 0...
  if (cleaned.startsWith('840')) {
    cleaned = cleaned.slice(2);
  } else if (cleaned.startsWith('84')) {
    cleaned = `0${cleaned.slice(2)}`;
  } else if (cleaned.length === 9 && /^[35789]/.test(cleaned)) {
    cleaned = `0${cleaned}`;
  }

  return cleaned;
}

/**
 * Validates if a phone number is a valid 10-digit Vietnamese mobile number.
 */
export function isValidVietnamesePhoneNumber(phone: string): boolean {
  const normalized = normalizeVietnamesePhoneNumber(phone);
  return VIETNAMESE_PHONE_REGEX.test(normalized);
}

/**
 * Formats a normalized Vietnamese phone number for display.
 * @param phone Raw or normalized phone number
 * @param format Display format ('national' | 'dotted' | 'international' | 'raw')
 */
export function formatVietnamesePhoneNumber(
  phone: string,
  format: 'national' | 'dotted' | 'international' | 'raw' = 'national',
): string {
  const normalized = normalizeVietnamesePhoneNumber(phone);
  if (!isValidVietnamesePhoneNumber(normalized)) {
    return phone;
  }

  const p1 = normalized.slice(0, 4);
  const p2 = normalized.slice(4, 7);
  const p3 = normalized.slice(7);

  switch (format) {
    case 'national':
      return `${p1} ${p2} ${p3}`;
    case 'dotted':
      return `${p1}.${p2}.${p3}`;
    case 'international':
      return `+84${normalized.slice(1)}`;
    case 'raw':
    default:
      return normalized;
  }
}
