import { InvoiceData } from './types';

/**
 * Format a number to Vietnamese Dong currency string (e.g. 150000 -> "150.000 đ")
 */
export function formatCurrencyVND(amount: number | undefined | null): string {
  if (amount === undefined || amount === null || isNaN(amount)) {
    return '0 đ';
  }
  const formatted = Math.round(amount)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${formatted} đ`;
}

/**
 * Format Date to standard Vietnamese string: DD/MM/YYYY HH:mm:ss or DD/MM/YYYY HH:mm
 */
export function formatDateTimeVN(
  dateInput: Date | string | undefined | null,
  includeSeconds = false
): string {
  const date = dateInput ? new Date(dateInput) : new Date();
  if (isNaN(date.getTime())) {
    return '';
  }

  const pad = (n: number) => n.toString().padStart(2, '0');
  const day = pad(date.getDate());
  const month = pad(date.getMonth() + 1);
  const year = date.getFullYear();
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());

  if (includeSeconds) {
    const seconds = pad(date.getSeconds());
    return `${day}/${month}/${year} ${hours}:${minutes}:${seconds}`;
  }

  return `${day}/${month}/${year} ${hours}:${minutes}`;
}

/**
 * Remove Vietnamese accents / diacritics for legacy thermal printers without Unicode font
 */
export function removeVietnameseDiacritics(str: string): string {
  if (!str) return '';
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
}

/**
 * Calculate display width of string in monospace columns (accounting for fullwidth characters)
 */
export function getStringDisplayWidth(str: string): number {
  if (!str) return 0;
  let width = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    // East Asian wide and fullwidth ranges
    if (
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe19) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6)
    ) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

/**
 * Centers text inside a fixed width column
 */
export function centerText(text: string, width: number): string {
  const textWidth = getStringDisplayWidth(text);
  if (textWidth >= width) return text;
  const leftPadding = Math.floor((width - textWidth) / 2);
  const rightPadding = width - textWidth - leftPadding;
  return ' '.repeat(leftPadding) + text + ' '.repeat(rightPadding);
}

/**
 * Creates a divider line (e.g. "----------------" or "================")
 */
export function divider(char = '-', width = 48): string {
  return char.repeat(Math.max(1, width));
}

/**
 * Wraps text into multiple lines keeping words intact if possible
 */
export function wrapText(text: string, maxWidth: number): string[] {
  if (!text) return [];
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let currentLine = '';

  for (const word of words) {
    if (!word) continue;
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    if (getStringDisplayWidth(testLine) <= maxWidth) {
      currentLine = testLine;
    } else {
      if (currentLine) {
        lines.push(currentLine);
      }
      // If a single word is longer than maxWidth, break it forcibly
      if (getStringDisplayWidth(word) > maxWidth) {
        let chunk = '';
        for (const char of word) {
          if (getStringDisplayWidth(chunk + char) <= maxWidth) {
            chunk += char;
          } else {
            lines.push(chunk);
            chunk = char;
          }
        }
        currentLine = chunk;
      } else {
        currentLine = word;
      }
    }
  }

  if (currentLine) {
    lines.push(currentLine);
  }

  return lines.length > 0 ? lines : [''];
}

/**
 * Formats a two-column line with left and right aligned content
 * Example: padLine("Cộng tiền hàng:", "150.000 đ", 48)
 */
export function padLine(left: string, right: string, width: number): string {
  const leftWidth = getStringDisplayWidth(left);
  const rightWidth = getStringDisplayWidth(right);

  if (leftWidth + rightWidth + 1 <= width) {
    const spaces = width - leftWidth - rightWidth;
    return left + ' '.repeat(spaces) + right;
  }

  // If left is too long, wrap left and align right on the last line
  const maxLeftWidth = Math.max(1, width - rightWidth - 1);
  const wrappedLeft = wrapText(left, maxLeftWidth);
  const result: string[] = [];

  for (let i = 0; i < wrappedLeft.length - 1; i++) {
    result.push(wrappedLeft[i]);
  }

  const lastLine = wrappedLeft[wrappedLeft.length - 1] || '';
  const lastLineWidth = getStringDisplayWidth(lastLine);
  const spaces = Math.max(1, width - lastLineWidth - rightWidth);
  result.push(lastLine + ' '.repeat(spaces) + right);

  return result.join('\n');
}

/**
 * Converts Vietnamese numbers to spoken words
 * E.g.: 150000 -> "Một trăm năm mươi nghìn đồng chẵn"
 */
export function numberToVietnameseWords(amount: number): string {
  if (isNaN(amount) || amount === 0) {
    return 'Không đồng chẵn';
  }

  const digits = ['không', 'một', 'hai', 'ba', 'bốn', 'năm', 'sáu', 'bảy', 'tám', 'chín'];
  const units = ['', 'nghìn', 'triệu', 'tỷ', 'nghìn tỷ', 'triệu tỷ'];

  let num = Math.abs(Math.round(amount));

  // Split into triplets of 3 digits
  const triplets: number[] = [];
  while (num > 0) {
    triplets.push(num % 1000);
    num = Math.floor(num / 1000);
  }

  function readTriplet(n: number, isHighest: boolean): string {
    const hundreds = Math.floor(n / 100);
    const tens = Math.floor((n % 100) / 10);
    const ones = n % 10;
    const parts: string[] = [];

    if (hundreds > 0 || !isHighest) {
      parts.push(`${digits[hundreds]} trăm`);
    }

    if (tens > 1) {
      parts.push(`${digits[tens]} mươi`);
      if (ones === 1) {
        parts.push('mốt');
      } else if (ones === 5) {
        parts.push('lăm');
      } else if (ones > 0) {
        parts.push(digits[ones]);
      }
    } else if (tens === 1) {
      parts.push('mười');
      if (ones === 5) {
        parts.push('lăm');
      } else if (ones > 0) {
        parts.push(digits[ones]);
      }
    } else if (tens === 0) {
      if (hundreds > 0 || !isHighest) {
        if (ones > 0) {
          parts.push(`lẻ ${digits[ones]}`);
        }
      } else {
        if (ones > 0) {
          parts.push(digits[ones]);
        }
      }
    }

    return parts.join(' ');
  }

  const words: string[] = [];
  for (let i = triplets.length - 1; i >= 0; i--) {
    const val = triplets[i];
    if (val > 0) {
      const isHighest = i === triplets.length - 1;
      const tripletText = readTriplet(val, isHighest);
      if (tripletText) {
        words.push(tripletText);
        if (units[i]) {
          words.push(units[i]);
        }
      }
    }
  }

  let result = words.join(' ').trim();
  if (result.length > 0) {
    result = result.charAt(0).toUpperCase() + result.slice(1);
    result = `${result} đồng chẵn`;
  } else {
    result = 'Không đồng chẵn';
  }

  return amount < 0 ? `Âm ${result}` : result;
}

/**
 * Reconcile and calculate invoice subtotal, VAT, discount and totalAmount
 */
export function computeInvoiceTotals(data: InvoiceData): {
  subtotal: number;
  discountAmount: number;
  shippingFee: number;
  vatAmount: number;
  totalAmount: number;
} {
  const calculatedSubtotal = data.items.reduce((sum, item) => {
    const itemTotal =
      item.totalPrice !== undefined
        ? item.totalPrice
        : item.quantity * item.unitPrice - (item.discount || 0);
    return sum + Math.max(0, itemTotal);
  }, 0);

  const subtotal = data.subtotal !== undefined ? data.subtotal : calculatedSubtotal;

  let discount = data.discountAmount || 0;
  if (data.discountPercent && data.discountPercent > 0) {
    discount += Math.round((subtotal * data.discountPercent) / 100);
  }

  const shipping = data.shippingFee || 0;
  const taxableAmount = Math.max(0, subtotal - discount);

  let vat = data.vatAmount || 0;
  if ((!data.vatAmount || data.vatAmount === 0) && data.vatRate && data.vatRate > 0) {
    vat = Math.round((taxableAmount * data.vatRate) / 100);
  }

  const calculatedTotal = taxableAmount + vat + shipping;
  const totalAmount = data.totalAmount !== undefined ? data.totalAmount : calculatedTotal;

  return {
    subtotal,
    discountAmount: discount,
    shippingFee: shipping,
    vatAmount: vat,
    totalAmount,
  };
}
