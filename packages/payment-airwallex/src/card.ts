import { AirwallexCardInput, CardBrand, CardValidationResult } from './types';

/**
 * Detects card brand based on Primary Account Number (PAN) prefix
 * Supports Visa, Mastercard, American Express, JCB, Discover, Diners Club, UnionPay
 */
export function detectCardBrand(cardNumber: string): CardBrand {
  if (!cardNumber) return 'unknown';
  const clean = cardNumber.replace(/\D/g, '');
  if (!clean) return 'unknown';

  // Visa: starts with 4
  if (/^4/.test(clean)) {
    return 'visa';
  }

  // Mastercard: 51-55 or 2221-2720
  if (
    /^5[1-5]/.test(clean) ||
    /^(222[1-9]|22[3-9]\d|2[3-6]\d{2}|27[01]\d|2720)/.test(clean)
  ) {
    return 'mastercard';
  }

  // American Express: 34 or 37
  if (/^3[47]/.test(clean)) {
    return 'amex';
  }

  // JCB: 35 (or 2131, 1800)
  if (/^(?:35|2131|1800)/.test(clean)) {
    return 'jcb';
  }

  // Discover: 6011, 65, 644-649, 622
  if (/^(?:6011|65|64[4-9]|622)/.test(clean)) {
    return 'discover';
  }

  // Diners Club: 300-305, 36, 38
  if (/^(?:30[0-5]|36|38)/.test(clean)) {
    return 'diners';
  }

  // UnionPay: 62
  if (/^62/.test(clean)) {
    return 'unionpay';
  }

  return 'unknown';
}

/**
 * Formats a raw card number string into standard spacing.
 * Handles 4-6-5 format for Amex, 4-4-4-4 for standard cards.
 */
export function formatCardNumber(value: string): string {
  const clean = value.replace(/\D/g, '');
  const brand = detectCardBrand(clean);

  if (brand === 'amex') {
    // 4 - 6 - 5
    const part1 = clean.slice(0, 4);
    const part2 = clean.slice(4, 10);
    const part3 = clean.slice(10, 15);
    return [part1, part2, part3].filter(Boolean).join(' ');
  }

  // 4 - 4 - 4 - 4
  const parts: string[] = [];
  for (let i = 0; i < clean.length; i += 4) {
    parts.push(clean.slice(i, i + 4));
  }
  return parts.join(' ');
}

/**
 * Formats MMYY string to MM / YY format
 */
export function formatExpiry(value: string): string {
  const clean = value.replace(/\D/g, '').slice(0, 4);
  if (clean.length <= 2) return clean;
  return `${clean.slice(0, 2)} / ${clean.slice(2)}`;
}

/**
 * Validates a card number using ISO/IEC 7812 Luhn checksum algorithm (Mod 10)
 */
export function checkLuhn(cardNumber: string): boolean {
  if (!cardNumber) return false;
  const clean = cardNumber.replace(/\D/g, '');
  if (clean.length < 13 || clean.length > 19) return false;

  let sum = 0;
  let shouldDouble = false;

  for (let i = clean.length - 1; i >= 0; i--) {
    let digit = parseInt(clean.charAt(i), 10);
    if (Number.isNaN(digit)) return false;

    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }

  return sum % 10 === 0;
}

export const isValidLuhn = checkLuhn;

/**
 * Validates card input components (cardholder name, PAN, expiry, CVC)
 */
export function validateCardInput(card: AirwallexCardInput): CardValidationResult {
  const errors: Record<string, string> = {};

  // 1. Cardholder Name validation
  const name = card.name ?? card.cardholderName;
  if (!name || name.trim().length < 2) {
    errors.name = 'Cardholder name is required (minimum 2 characters)';
  }

  // 2. Card Number & Luhn Check
  const cleanNumber = card.cardNumber ? card.cardNumber.replace(/\D/g, '') : '';
  const brand = detectCardBrand(cleanNumber);

  if (!cleanNumber) {
    errors.cardNumber = 'Card number is required';
  } else if (cleanNumber.length < 13 || cleanNumber.length > 19) {
    errors.cardNumber = 'Card number must be between 13 and 19 digits';
  } else if (!checkLuhn(cleanNumber)) {
    errors.cardNumber = 'Invalid card number (failed Luhn checksum)';
  }

  // 3. Expiration Date validation
  let month = Number.NaN;
  let rawYear = Number.NaN;

  if (card.expMonth && card.expYear) {
    month = parseInt(card.expMonth, 10);
    rawYear = parseInt(card.expYear, 10);
  } else if (card.expiry) {
    const parts = card.expiry.split('/');
    if (parts.length === 2) {
      month = parseInt(parts[0]!.trim(), 10);
      rawYear = parseInt(parts[1]!.trim(), 10);
    }
  }

  if (Number.isNaN(month) || month < 1 || month > 12) {
    errors.expiry = 'Invalid expiration month (must be 01-12)';
  } else if (Number.isNaN(rawYear) || rawYear < 0) {
    errors.expiry = 'Invalid expiration year';
  } else {
    const fullYear = rawYear < 100 ? 2000 + rawYear : rawYear;
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1;

    if (fullYear < currentYear || (fullYear === currentYear && month < currentMonth)) {
      errors.expiry = 'Card has expired';
    } else if (fullYear > currentYear + 25) {
      errors.expiry = 'Expiration year is invalid';
    }
  }

  // 4. CVC / Security Code validation
  const cleanCvc = card.cvc ? card.cvc.replace(/\D/g, '') : '';
  if (!cleanCvc) {
    errors.cvc = 'CVC is required';
  } else if (brand === 'amex') {
    if (cleanCvc.length !== 4) {
      errors.cvc = 'American Express requires a 4-digit CVC';
    }
  } else if (brand !== 'unknown') {
    if (cleanCvc.length !== 3) {
      errors.cvc = 'CVC must be 3 digits';
    }
  } else if (cleanCvc.length < 3 || cleanCvc.length > 4) {
    errors.cvc = 'CVC must be 3 or 4 digits';
  }

  return {
    isValid: Object.keys(errors).length === 0,
    brand,
    errors,
  };
}

export const validateCard = validateCardInput;
