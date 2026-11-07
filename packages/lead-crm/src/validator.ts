import {
  LeadInput,
  LeadInputSchema,
  LeadRecord,
  UtmParams,
  UtmParamsSchema,
} from './types';

/**
 * Vietnam Mobile Phone Prefixes (10-digit format):
 * 03x: Viettel (032-039)
 * 05x: Vietnamobile (052, 056, 058), Gmobile (059), Wintel (055)
 * 07x: Mobifone (070, 076-079)
 * 08x: Vinaphone (081-085, 088), Viettel (086), Wintel/Itelecom (087), Mobifone (089)
 * 09x: Viettel (096-098), Mobifone (090, 093), Vinaphone (091, 094), Vietnamobile (092), Gmobile (099)
 */
export const VN_PHONE_REGEX = /^0(3[2-9]|5[25689]|7[06-9]|8[1-9]|9\d)\d{7}$/;
export const VN_STANDARD_PREFIXES_REGEX = /^0[35789]\d{8}$/;

/**
 * Strips formatting characters (spaces, dashes, dots, brackets)
 * and standardizes Vietnamese country code (+84 or 84) to local 0 prefix.
 */
export function cleanPhoneNumber(rawPhone: string): string {
  if (!rawPhone || typeof rawPhone !== 'string') {
    return '';
  }

  // Remove common phone formatting characters: spaces, tabs, dots, dashes, parentheses
  let cleaned = rawPhone.replace(/[\s\t.\-()_]/g, '').trim();

  // Replace +84 or leading 0084 or leading 84 with 0
  if (cleaned.startsWith('+84')) {
    cleaned = '0' + cleaned.slice(3);
  } else if (cleaned.startsWith('0084')) {
    cleaned = '0' + cleaned.slice(4);
  } else if (cleaned.startsWith('84') && cleaned.length >= 11) {
    cleaned = '0' + cleaned.slice(2);
  }

  return cleaned;
}

/**
 * Checks if a phone number is a valid 10-digit Vietnamese mobile phone number
 * (Starting with 03, 05, 07, 08, 09).
 */
export function isValidVietnamesePhone(phone: string): boolean {
  const cleaned = cleanPhoneNumber(phone);
  return VN_STANDARD_PREFIXES_REGEX.test(cleaned);
}

/**
 * Identifies the telecommunications carrier for a valid Vietnamese mobile phone.
 */
export function getVietnameseCarrier(phone: string): string | null {
  const cleaned = cleanPhoneNumber(phone);
  if (!isValidVietnamesePhone(cleaned)) {
    return null;
  }

  const prefix3 = cleaned.slice(0, 3);

  // Viettel: 086, 096, 097, 098, 032-039
  if (
    ['086', '096', '097', '098'].includes(prefix3) ||
    (cleaned.startsWith('03') && parseInt(cleaned.slice(2, 3), 10) >= 2)
  ) {
    return 'Viettel';
  }

  // Mobifone: 089, 090, 093, 070, 076, 077, 078, 079
  if (
    ['089', '090', '093', '070', '076', '077', '078', '079'].includes(prefix3)
  ) {
    return 'Mobifone';
  }

  // Vinaphone: 088, 091, 094, 081, 082, 083, 084, 085
  if (
    ['088', '091', '094', '081', '082', '083', '084', '085'].includes(prefix3)
  ) {
    return 'Vinaphone';
  }

  // Vietnamobile: 092, 052, 056, 058
  if (['092', '052', '056', '058'].includes(prefix3)) {
    return 'Vietnamobile';
  }

  // Gmobile: 099, 059
  if (['099', '059'].includes(prefix3)) {
    return 'Gmobile';
  }

  // Wintel / Itelecom: 087, 055
  if (['087', '055'].includes(prefix3)) {
    return 'Wintel/Itelecom';
  }

  return 'Unknown';
}

/**
 * Formats a clean 10-digit Vietnamese phone into E.164 (+84XXXXXXXXX).
 */
export function formatPhoneE164(phone: string): string {
  const cleaned = cleanPhoneNumber(phone);
  if (cleaned.startsWith('0') && cleaned.length === 10) {
    return `+84${cleaned.slice(1)}`;
  }
  return cleaned;
}

/**
 * Formats a clean 10-digit Vietnamese phone for readable display (e.g. 0987 654 321).
 */
export function formatPhoneDisplay(phone: string): string {
  const cleaned = cleanPhoneNumber(phone);
  if (cleaned.length === 10) {
    return `${cleaned.slice(0, 4)} ${cleaned.slice(4, 7)} ${cleaned.slice(7)}`;
  }
  return cleaned;
}

/**
 * Normalizes UTM parameters from a URL string, query string, or key-value object.
 * Special support for Facebook Ads (fbclid) and TikTok Ads (ttclid).
 */
export function normalizeUtm(input?: unknown): UtmParams {
  const params: Record<string, string> = {};

  if (typeof input === 'string') {
    try {
      // Check if it's a full URL or a query string
      let search = input;
      if (input.includes('?')) {
        search = input.slice(input.indexOf('?'));
      } else if (!input.startsWith('?')) {
        search = `?${input}`;
      }
      const urlParams = new URLSearchParams(search);
      for (const [key, value] of urlParams.entries()) {
        params[key] = value;
      }
    } catch {
      // If parsing fails, proceed with empty params
    }
  } else if (input && typeof input === 'object') {
    for (const [key, value] of Object.entries(input)) {
      if (value !== undefined && value !== null) {
        params[key] = String(value);
      }
    }
  }

  // Extract raw keys (support both snake_case and camelCase)
  let utm_source = (
    params.utm_source ||
    params.utmSource ||
    params.source ||
    ''
  ).trim().toLowerCase();

  let utm_medium = (
    params.utm_medium ||
    params.utmMedium ||
    params.medium ||
    ''
  ).trim().toLowerCase();

  let utm_campaign = (
    params.utm_campaign ||
    params.utmCampaign ||
    params.campaign ||
    ''
  ).trim();

  const utm_term = (
    params.utm_term ||
    params.utmTerm ||
    params.term ||
    ''
  ).trim();

  const utm_content = (
    params.utm_content ||
    params.utmContent ||
    params.content ||
    ''
  ).trim();

  const fbclid = params.fbclid ? params.fbclid.trim() : undefined;
  const ttclid = params.ttclid ? params.ttclid.trim() : undefined;
  const gclid = params.gclid ? params.gclid.trim() : undefined;

  // Auto-detect Facebook / TikTok ads if parameters are missing
  if (fbclid && (!utm_source || utm_source === 'direct')) {
    utm_source = 'facebook';
    if (!utm_medium) utm_medium = 'cpc';
  } else if (
    utm_source.includes('fb') ||
    utm_source.includes('facebook') ||
    utm_source.includes('meta')
  ) {
    utm_source = 'facebook';
    if (!utm_medium) utm_medium = 'paid_social';
  }

  if (ttclid && (!utm_source || utm_source === 'direct')) {
    utm_source = 'tiktok';
    if (!utm_medium) utm_medium = 'cpc';
  } else if (utm_source.includes('tiktok') || utm_source.includes('bytedance')) {
    utm_source = 'tiktok';
    if (!utm_medium) utm_medium = 'paid_social';
  }

  if (gclid && (!utm_source || utm_source === 'direct')) {
    utm_source = 'google';
    if (!utm_medium) utm_medium = 'cpc';
  }

  return UtmParamsSchema.parse({
    utm_source,
    utm_medium,
    utm_campaign,
    utm_term,
    utm_content,
    fbclid,
    ttclid,
    gclid,
  });
}

export type IngestLeadResult =
  | { success: true; data: LeadRecord }
  | { success: false; errors: string[] };

/**
 * Validates, cleans, and enriches raw lead input into a structured LeadRecord.
 */
export function ingestLead(rawInput: unknown): IngestLeadResult {
  if (!rawInput || typeof rawInput !== 'object') {
    return {
      success: false,
      errors: ['Dữ liệu lead không hợp lệ (phải là object).'],
    };
  }

  const rawObj = rawInput as Record<string, unknown>;

  // Handle name / fullName aliases
  const fullName = String(
    rawObj.fullName || rawObj.name || rawObj.customerName || ''
  ).trim();

  const rawPhone = String(
    rawObj.phone || rawObj.phoneNumber || rawObj.tel || ''
  ).trim();

  const phoneCleaned = cleanPhoneNumber(rawPhone);

  const errors: string[] = [];

  if (!fullName) {
    errors.push('Họ và tên khách hàng không được để trống.');
  }

  if (!phoneCleaned) {
    errors.push('Số điện thoại không được để trống.');
  } else if (!isValidVietnamesePhone(phoneCleaned)) {
    errors.push(
      `Số điện thoại '${rawPhone}' không hợp lệ: Phải là số di động Việt Nam chuẩn 10 chữ số (đầu 03, 05, 07, 08, 09).`
    );
  }

  if (errors.length > 0) {
    return { success: false, errors };
  }

  // Parse UTM parameters
  const rawUtm =
    (rawObj.utm as Record<string, unknown> | string | undefined) ||
    rawObj.query ||
    rawObj;
  const utm = normalizeUtm(rawUtm);

  // Derive source
  const source =
    String(rawObj.source || '').trim() ||
    utm.utm_source ||
    (utm.fbclid ? 'facebook' : utm.ttclid ? 'tiktok' : 'direct');

  const nowIso = new Date().toISOString();
  const randomSuffix = Math.random().toString(36).substring(2, 9);
  const id = String(rawObj.id || `LEAD-${Date.now()}-${randomSuffix}`);

  const email = rawObj.email ? String(rawObj.email).trim() : '';
  const note = String(rawObj.note || '').trim();
  const productInterest = String(
    rawObj.productInterest || rawObj.product || rawObj.service || ''
  ).trim();

  const carrier = getVietnameseCarrier(phoneCleaned) || undefined;
  const phoneE164 = formatPhoneE164(phoneCleaned);

  const metadata =
    rawObj.metadata && typeof rawObj.metadata === 'object'
      ? (rawObj.metadata as Record<string, unknown>)
      : undefined;

  const leadRecord: LeadRecord = {
    id,
    fullName,
    phone: phoneCleaned,
    phoneRaw: rawPhone,
    phoneE164,
    carrier,
    email: email || undefined,
    note,
    productInterest,
    source,
    utm,
    status: 'NEW',
    metadata,
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  return {
    success: true,
    data: leadRecord,
  };
}
