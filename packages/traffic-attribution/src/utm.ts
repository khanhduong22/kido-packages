import type {
  ResolveUtmOptions,
  TrafficSourceInfo,
  UtmParams,
} from './types';

const TRACKING_PARAMS_TO_STRIP = new Set([
  'fbclid',
  'gclid',
  'dclid',
  'msclkid',
  'ttclid',
  'twclid',
  'igshid',
  '_ga',
  '_gl',
  'mc_cid',
  'mc_eid',
  'wickedid',
]);

const STANDARD_UTM_KEYS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
] as const;

/**
 * Normalizes and extracts UTM parameters from a URL string, URL object, or query dictionary.
 */
export function resolveUtmParams(
  input: string | URL | Record<string, string | undefined>,
  options: ResolveUtmOptions = {}
): UtmParams {
  const result: UtmParams = {};

  if (typeof input === 'string' || input instanceof URL) {
    try {
      const url = typeof input === 'string' ? new URL(input.startsWith('http') ? input : `http://localhost/${input.replace(/^\/?/, '')}`) : input;
      for (const [key, value] of url.searchParams.entries()) {
        const lowerKey = key.toLowerCase();
        if (lowerKey.startsWith('utm_') || options.preserveExisting) {
          result[lowerKey] = value.trim();
        }
      }
    } catch {
      // In case of malformed URL, return defaults/overrides
    }
  } else if (input && typeof input === 'object') {
    for (const [key, value] of Object.entries(input)) {
      if (typeof value === 'string') {
        const lowerKey = key.toLowerCase();
        result[lowerKey] = value.trim();
      }
    }
  }

  // Apply defaults for missing values
  if (options.defaults) {
    for (const [k, v] of Object.entries(options.defaults)) {
      if (v && !result[k]) {
        result[k] = v.trim();
      }
    }
  }

  // Apply explicit overrides
  if (options.override) {
    for (const [k, v] of Object.entries(options.override)) {
      if (v !== undefined) {
        result[k] = v.trim();
      }
    }
  }

  // Normalize source and medium to lowercase
  if (result.utm_source) result.utm_source = result.utm_source.toLowerCase();
  if (result.utm_medium) result.utm_medium = result.utm_medium.toLowerCase();

  return result;
}

/**
 * Injects or updates UTM parameters in a target URL string, preserving hashes and existing unrelated query params.
 */
export function injectUtmParams(targetUrl: string, utm: UtmParams): string {
  try {
    const isRelative = !targetUrl.startsWith('http://') && !targetUrl.startsWith('https://');
    const dummyBase = 'http://relative-placeholder.internal';
    const parsed = new URL(targetUrl, dummyBase);

    for (const [key, value] of Object.entries(utm)) {
      if (value !== undefined && value !== null && value !== '') {
        parsed.searchParams.set(key, value);
      }
    }

    if (isRelative) {
      return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
    return parsed.toString();
  } catch {
    return targetUrl;
  }
}

/**
 * Removes invasive third-party ad click tracking parameters (fbclid, gclid, ttclid, etc.)
 * while leaving legitimate UTM tags and application parameters intact.
 */
export function stripTrackingParameters(urlStr: string): string {
  try {
    const isRelative = !urlStr.startsWith('http://') && !urlStr.startsWith('https://');
    const dummyBase = 'http://relative-placeholder.internal';
    const parsed = new URL(urlStr, dummyBase);

    for (const key of Array.from(parsed.searchParams.keys())) {
      if (TRACKING_PARAMS_TO_STRIP.has(key.toLowerCase())) {
        parsed.searchParams.delete(key);
      }
    }

    if (isRelative) {
      return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
    return parsed.toString();
  } catch {
    return urlStr;
  }
}

/**
 * Automatically builds standardized UTM parameters based on detected traffic source info.
 */
export function buildDynamicUtm(
  sourceInfo: TrafficSourceInfo,
  options: {
    campaign?: string;
    content?: string;
    term?: string;
    id?: string;
  } = {}
): UtmParams {
  let medium: string;

  switch (sourceInfo.channel) {
    case 'ai_agent':
      medium = sourceInfo.isBot ? 'ai_crawler' : 'ai_referral';
      break;
    case 'search_engine':
      medium = 'organic';
      break;
    case 'social_network':
      medium = 'social';
      break;
    case 'referral':
      medium = 'referral';
      break;
    case 'internal':
      medium = 'internal';
      break;
    case 'direct':
    default:
      medium = 'none';
      break;
  }

  const utm: UtmParams = {
    utm_source: sourceInfo.platform.toLowerCase(),
    utm_medium: medium,
  };

  if (options.campaign) utm.utm_campaign = options.campaign;
  if (options.content) utm.utm_content = options.content;
  if (options.term) utm.utm_term = options.term;
  if (options.id) utm.utm_id = options.id;

  return utm;
}
