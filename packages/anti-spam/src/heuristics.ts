import { HeuristicScanResult } from './types';

/**
 * Heuristic regexes for common spam, invite farming, and phishing patterns.
 */
export const SPAM_PATTERNS = {
  // Zalo group invites and QR joins
  ZALO_INVITE:
    /(?:https?:\/\/)?(?:www\.)?zalo\.me\/(?:g|join|qr\/p)\/[a-zA-Z0-9_\-]+/gi,

  // Telegram group invites and public channels
  TELEGRAM_INVITE:
    /(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\/(?:\+[a-zA-Z0-9_\-]+|joinchat\/[a-zA-Z0-9_\-]+|[a-zA-Z0-9_]{5,})/gi,

  // High-risk URL shorteners commonly used in spam/phishing
  URL_SHORTENER:
    /(?:https?:\/\/)?(?:www\.)?(?:bit\.ly|tinyurl\.com|is\.gd|cutt\.ly|rb\.gy|t\.co|s\.id|shorturl\.at|gg\.gg)\/[a-zA-Z0-9_\-]+/gi,

  // Vietnamese phone numbers (with spaces, dots, dashes)
  PHONE_NUMBER:
    /(?:\+84|0)(?:3[2-9]|5[2689]|7[06-9]|8[1-9]|9[0-9])[\s.\-_]?[0-9]{3}[\s.\-_]?[0-9]{3,4}\b/g,
};

const FNV64_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV64_PRIME = 0x100000001b3n;

/**
 * 64-bit FNV-1a ultra-fast content hashing for duplicate flood detection.
 * Produces a deterministic 16-hex character fingerprint.
 */
export function hashContent(text: string): string {
  if (!text) return '0000000000000000';

  let hash = FNV64_OFFSET_BASIS;
  const len = text.length;

  for (let i = 0; i < len; i++) {
    const code = text.charCodeAt(i);

    if (code <= 0x7f) {
      hash ^= BigInt(code);
      hash = (hash * FNV64_PRIME) & 0xffffffffffffffffn;
    } else {
      const b1 = (code >> 8) & 0xff;
      const b2 = code & 0xff;
      hash ^= BigInt(b1);
      hash = (hash * FNV64_PRIME) & 0xffffffffffffffffn;
      hash ^= BigInt(b2);
      hash = (hash * FNV64_PRIME) & 0xffffffffffffffffn;
    }
  }

  return hash.toString(16).padStart(16, '0');
}

/**
 * Scan text for suspicious spam heuristics (Zalo/Telegram invite links, URL shorteners, spam phones).
 */
export function scanHeuristics(
  text: string,
  compactText?: string,
): HeuristicScanResult {
  if (!text) {
    return {
      hasSuspiciousLink: false,
      hasPhoneSpam: false,
      links: [],
      phoneNumbers: [],
      reasons: [],
    };
  }

  const detectedLinks: string[] = [];
  const detectedPhones: string[] = [];
  const reasons: string[] = [];

  // 1. Zalo invites
  const zaloMatches = text.match(SPAM_PATTERNS.ZALO_INVITE);
  if (zaloMatches && zaloMatches.length > 0) {
    detectedLinks.push(...zaloMatches);
    reasons.push('Chứa liên kết nhóm Zalo');
  } else if (compactText && SPAM_PATTERNS.ZALO_INVITE.test(compactText)) {
    reasons.push('Chứa liên kết nhóm Zalo lẩn tránh');
  }

  // 2. Telegram invites
  const teleMatches = text.match(SPAM_PATTERNS.TELEGRAM_INVITE);
  if (teleMatches && teleMatches.length > 0) {
    detectedLinks.push(...teleMatches);
    reasons.push('Chứa liên kết nhóm/kênh Telegram');
  } else if (compactText && SPAM_PATTERNS.TELEGRAM_INVITE.test(compactText)) {
    reasons.push('Chứa liên kết nhóm/kênh Telegram lẩn tránh');
  }

  // 3. High-risk URL shorteners
  const shortenerMatches = text.match(SPAM_PATTERNS.URL_SHORTENER);
  if (shortenerMatches && shortenerMatches.length > 0) {
    detectedLinks.push(...shortenerMatches);
    reasons.push('Chứa liên kết rút gọn rủi ro cao');
  } else if (compactText && SPAM_PATTERNS.URL_SHORTENER.test(compactText)) {
    reasons.push('Chứa liên kết rút gọn rủi ro cao lẩn tránh');
  }

  // 4. Phone numbers
  const phoneMatches = text.match(SPAM_PATTERNS.PHONE_NUMBER);
  if (phoneMatches && phoneMatches.length > 0) {
    detectedPhones.push(...phoneMatches);
    if (phoneMatches.length >= 2) {
      reasons.push('Chứa nhiều số điện thoại liên hệ spam');
    }
  }

  const hasSuspiciousLink = detectedLinks.length > 0 || (reasons.some((r) => r.includes('liên kết')));
  const hasPhoneSpam = detectedPhones.length >= 2;

  return {
    hasSuspiciousLink,
    hasPhoneSpam,
    links: Array.from(new Set(detectedLinks)),
    phoneNumbers: Array.from(new Set(detectedPhones)),
    reasons,
  };
}
