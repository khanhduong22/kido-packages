import { z } from 'zod';

export const BarcodeTypeSchema = z.enum([
  'EAN13',
  'CODE128',
  'GS1_128',
  'QR_CODE',
  'CARRIER_TRACKING',
  'UNKNOWN',
]);

export type BarcodeType = z.infer<typeof BarcodeTypeSchema>;

export interface GS1ParsedData {
  gtin?: string;
  batchLot?: string;
  expirationDate?: string; // YYYY-MM-DD
  serialNumber?: string;
  netWeightKg?: number;
  countUnits?: number;
  rawAiMap: Record<string, string>;
}

export interface ParsedBarcodeResult {
  raw: string;
  type: BarcodeType;
  isValid: boolean;
  validationError?: string;
  sku?: string;
  carrier?: string;
  gs1Data?: GS1ParsedData;
  qrPayload?: Record<string, unknown> | string;
}

export interface ScannedBarcodeEvent {
  rawText: string;
  parsed: ParsedBarcodeResult;
  durationMs: number;
  charCount: number;
  isPdaLaser: boolean;
  scannedAt: Date;
}

export interface ScannerBufferOptions {
  /** Maximum allowable delay (ms) between consecutive keystrokes from PDA scanner (default: 50ms) */
  maxInterKeyDelayMs?: number;
  /** Minimum length of a valid barcode string (default: 3) */
  minBarcodeLength?: number;
  /** Optional prefix characters to strip (e.g., STX \x02) */
  stripPrefixes?: string[];
  /** Optional suffix characters to strip (e.g., ETX \x03) */
  stripSuffixes?: string[];
  /** Callback fired when a valid barcode scan is completed */
  onScan?: (event: ScannedBarcodeEvent) => void;
}

/**
 * Calculates EAN-13 check digit using official GS1 Modulo 10 algorithm.
 * Odd position weight = 1, Even position weight = 3 (1-based index from left).
 */
export function calculateEan13CheckDigit(digits12: string): number {
  if (!/^\d{12}$/.test(digits12)) {
    throw new Error(`EAN-13 check digit requires exactly 12 numeric digits, got "${digits12}"`);
  }

  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const digit = parseInt(digits12[i], 10);
    // 1-based index: i=0 is position 1 (odd -> weight 1), i=1 is position 2 (even -> weight 3)
    sum += i % 2 === 0 ? digit * 1 : digit * 3;
  }

  return (10 - (sum % 10)) % 10;
}

/**
 * Validates whether a 13-digit string has a mathematically valid EAN-13 check digit.
 */
export function validateEan13(code: string): boolean {
  if (!/^\d{13}$/.test(code)) return false;
  const digits12 = code.slice(0, 12);
  const checkDigit = parseInt(code[12], 10);
  return calculateEan13CheckDigit(digits12) === checkDigit;
}

/**
 * Parses GS1-128 / UCC-EAN 128 barcode containing Application Identifiers (AIs).
 * Handles both human-readable bracketed format e.g. (01)08935000000018(10)LOT123(17)261231
 * and raw FNC1 (\x1D) delimited streams.
 */
export function parseGS1128(raw: string): GS1ParsedData {
  const aiMap: Record<string, string> = {};
  const cleaned = raw.replace(/[\x02\x03]/g, '').trim();

  // Pattern A: Bracketed AI format e.g. (01)08935000000018(10)LOT1234(17)261231(21)SN98765
  if (cleaned.includes('(') && cleaned.includes(')')) {
    const regex = /\((\d{2,4})\)([^()]+)/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(cleaned)) !== null) {
      aiMap[match[1]] = match[2];
    }
  } else {
    // Pattern B: FNC1 / Stream format
    // Common AI prefixes: 01 (14 chars), 17 (6 chars), 10 (var up to 20), 21 (var up to 20)
    let pointer = 0;
    while (pointer < cleaned.length) {
      const ai2 = cleaned.slice(pointer, pointer + 2);
      const ai4 = cleaned.slice(pointer, pointer + 4);

      if (ai2 === '01') {
        // GTIN: fixed 14 digits
        aiMap['01'] = cleaned.slice(pointer + 2, pointer + 16);
        pointer += 16;
      } else if (ai2 === '17') {
        // Expiration date: fixed 6 digits (YYMMDD)
        aiMap['17'] = cleaned.slice(pointer + 2, pointer + 8);
        pointer += 8;
      } else if (ai2 === '10') {
        // Batch / Lot: variable up to 20 chars ending with \x1D or end of string
        pointer += 2;
        let lot = '';
        while (pointer < cleaned.length && cleaned[pointer] !== '\x1D') {
          lot += cleaned[pointer++];
        }
        if (cleaned[pointer] === '\x1D') pointer++;
        aiMap['10'] = lot;
      } else if (ai2 === '21') {
        // Serial number: variable up to 20 chars ending with \x1D or end of string
        pointer += 2;
        let sn = '';
        while (pointer < cleaned.length && cleaned[pointer] !== '\x1D') {
          sn += cleaned[pointer++];
        }
        if (cleaned[pointer] === '\x1D') pointer++;
        aiMap['21'] = sn;
      } else if (ai4.startsWith('310')) {
        // Net weight in kg (310x where x is decimals)
        const decimals = parseInt(ai4[3], 10);
        const weightRaw = cleaned.slice(pointer + 4, pointer + 10);
        aiMap[ai4] = weightRaw;
        pointer += 10;
      } else {
        // Unknown or trailing, break
        break;
      }
    }
  }

  // Format parsed date YYMMDD into YYYY-MM-DD
  let expirationDate: string | undefined;
  if (aiMap['17'] && /^\d{6}$/.test(aiMap['17'])) {
    const yy = parseInt(aiMap['17'].slice(0, 2), 10);
    const mm = aiMap['17'].slice(2, 4);
    const dd = aiMap['17'].slice(4, 6);
    const year = yy >= 50 ? 1900 + yy : 2000 + yy;
    expirationDate = `${year}-${mm}-${dd}`;
  }

  // Parse weight if present (310x)
  let netWeightKg: number | undefined;
  const weightAi = Object.keys(aiMap).find((k) => k.startsWith('310'));
  if (weightAi && aiMap[weightAi]) {
    const decimals = parseInt(weightAi[3], 10);
    const rawVal = parseFloat(aiMap[weightAi]);
    netWeightKg = rawVal / Math.pow(10, decimals);
  }

  return {
    gtin: aiMap['01'],
    batchLot: aiMap['10'],
    expirationDate,
    serialNumber: aiMap['21'],
    netWeightKg,
    countUnits: aiMap['37'] ? parseInt(aiMap['37'], 10) : undefined,
    rawAiMap: aiMap,
  };
}

/**
 * Detects carrier from tracking number pattern.
 */
function detectCarrier(code: string): string | null {
  const upper = code.trim().toUpperCase();
  if (/^GHN[A-Z0-9]{6,12}$/.test(upper) || /^[0-9]{8,11}$/.test(upper)) {
    return 'GHN';
  }
  if (/^(SPX|VND|VN)[A-Z0-9]{9,15}$/.test(upper)) {
    return 'SPX';
  }
  if (/^(VT|VTP)[0-9]{8,12}$/.test(upper)) {
    return 'VIETTEL_POST';
  }
  return null;
}

/**
 * Universal barcode parser supporting EAN-13, GS1-128, Code128, QR Code, and Carrier tracking.
 */
export function parseBarcode(rawInput: string): ParsedBarcodeResult {
  const trimmed = rawInput.trim();

  // 1. Check for QR Code (JSON payload or structured WMS prefix)
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const parsedJson = JSON.parse(trimmed);
      return {
        raw: trimmed,
        type: 'QR_CODE',
        isValid: true,
        qrPayload: parsedJson,
      };
    } catch {
      // not valid JSON, continue
    }
  }

  if (trimmed.startsWith('WMS:') || trimmed.startsWith('wms://')) {
    return {
      raw: trimmed,
      type: 'QR_CODE',
      isValid: true,
      qrPayload: trimmed,
    };
  }

  // 2. Check for GS1-128 with Application Identifiers
  if (
    (trimmed.includes('(') && trimmed.includes(')') && /\(\d{2}\)/.test(trimmed)) ||
    (trimmed.startsWith('01') && trimmed.length >= 16 && /^\d+/.test(trimmed))
  ) {
    const gs1 = parseGS1128(trimmed);
    const hasData = Object.keys(gs1.rawAiMap).length > 0;
    return {
      raw: trimmed,
      type: 'GS1_128',
      isValid: hasData,
      gs1Data: gs1,
      sku: gs1.gtin,
    };
  }

  // 3. Check for EAN-13 (13 digits)
  if (/^\d{13}$/.test(trimmed)) {
    const valid = validateEan13(trimmed);
    return {
      raw: trimmed,
      type: 'EAN13',
      isValid: valid,
      validationError: valid ? undefined : 'Invalid EAN-13 check digit',
      sku: trimmed,
    };
  }

  // 4. Check for Carrier Tracking Code
  const carrier = detectCarrier(trimmed);
  if (carrier) {
    return {
      raw: trimmed,
      type: 'CARRIER_TRACKING',
      isValid: true,
      carrier,
    };
  }

  // 5. Default to Code 128 / Alphanumeric Warehouse Barcode
  const isValidCode128 = /^[\x20-\x7E]+$/.test(trimmed) && trimmed.length >= 3;
  return {
    raw: trimmed,
    type: 'CODE128',
    isValid: isValidCode128,
    validationError: isValidCode128 ? undefined : 'Invalid Code128 character set',
    sku: trimmed,
  };
}

/**
 * PDA HID Keyboard Scanner Buffer
 * 
 * Hardware scanners (Zebra, Sunmi, Datalogic) act as USB/Bluetooth HID Keyboards.
 * They transmit character bursts in ultra-rapid succession (< 50ms per key)
 * terminated by an Enter ('\n' or '\r').
 * 
 * BarcodeScannerBuffer collects incoming keystrokes, verifies inter-key speed,
 * strips hardware control prefixes/suffixes, and emits parsed scan events.
 */
export class BarcodeScannerBuffer {
  private buffer = '';
  private lastKeyTimestamp = 0;
  private scanStartTime = 0;
  private readonly maxInterKeyDelayMs: number;
  private readonly minBarcodeLength: number;
  private readonly stripPrefixes: string[];
  private readonly stripSuffixes: string[];
  private listeners: ((event: ScannedBarcodeEvent) => void)[] = [];

  constructor(options: ScannerBufferOptions = {}) {
    this.maxInterKeyDelayMs = options.maxInterKeyDelayMs ?? 50;
    this.minBarcodeLength = options.minBarcodeLength ?? 3;
    this.stripPrefixes = options.stripPrefixes ?? ['\x02']; // STX
    this.stripSuffixes = options.stripSuffixes ?? ['\x03', '\r']; // ETX, CR

    if (options.onScan) {
      this.listeners.push(options.onScan);
    }
  }

  /**
   * Register a scan event listener callback.
   */
  public onScan(callback: (event: ScannedBarcodeEvent) => void): () => void {
    this.listeners.push(callback);
    return () => {
      this.listeners = this.listeners.filter((cb) => cb !== callback);
    };
  }

  /**
   * Feeds a single key stroke or character into the buffer.
   * If Enter is detected, checks timing and dispatches scan event if valid.
   */
  public handleKeyPress(key: string, now: number = Date.now()): ScannedBarcodeEvent | null {
    // Check for Enter termination (Enter, \n, or \r)
    if (key === 'Enter' || key === '\n' || key === '\r') {
      return this.flushScan(now);
    }

    // Single character input
    if (key.length === 1) {
      const timeSinceLastKey = now - this.lastKeyTimestamp;

      // If delay between keys exceeds maxInterKeyDelayMs, reset buffer
      // (indicates manual human typing or broken transmission)
      if (this.buffer.length > 0 && timeSinceLastKey > this.maxInterKeyDelayMs) {
        this.reset();
      }

      if (this.buffer.length === 0) {
        this.scanStartTime = now;
      }

      this.buffer += key;
      this.lastKeyTimestamp = now;
    }

    return null;
  }

  /**
   * Feeds a simulated rapid stream of characters or full string directly (for tests or bulk feeds).
   */
  public feedString(input: string, interKeyDelayMs: number = 5): ScannedBarcodeEvent | null {
    let now = Date.now();
    for (const char of input) {
      this.handleKeyPress(char, now);
      now += interKeyDelayMs;
    }
    return this.handleKeyPress('Enter', now);
  }

  /**
   * Resets the current scanner buffer state.
   */
  public reset(): void {
    this.buffer = '';
    this.lastKeyTimestamp = 0;
    this.scanStartTime = 0;
  }

  /**
   * Returns current internal buffer content.
   */
  public getCurrentBuffer(): string {
    return this.buffer;
  }

  private flushScan(flushTime: number): ScannedBarcodeEvent | null {
    if (this.buffer.length < this.minBarcodeLength) {
      this.reset();
      return null;
    }

    let cleaned = this.buffer;
    for (const prefix of this.stripPrefixes) {
      if (cleaned.startsWith(prefix)) {
        cleaned = cleaned.slice(prefix.length);
      }
    }
    for (const suffix of this.stripSuffixes) {
      if (cleaned.endsWith(suffix)) {
        cleaned = cleaned.slice(0, cleaned.length - suffix.length);
      }
    }

    cleaned = cleaned.trim();
    if (cleaned.length < this.minBarcodeLength) {
      this.reset();
      return null;
    }

    const durationMs = Math.max(1, flushTime - this.scanStartTime);
    const avgInterKey = durationMs / Math.max(1, this.buffer.length);
    // Real PDA laser scanners complete full barcode in < 50ms average per key
    const isPdaLaser = avgInterKey <= this.maxInterKeyDelayMs;

    const parsed = parseBarcode(cleaned);

    const event: ScannedBarcodeEvent = {
      rawText: cleaned,
      parsed,
      durationMs,
      charCount: cleaned.length,
      isPdaLaser,
      scannedAt: new Date(flushTime),
    };

    this.reset();

    for (const listener of this.listeners) {
      listener(event);
    }

    return event;
  }
}
