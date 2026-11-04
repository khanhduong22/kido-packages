import type {
  DetectTrafficSourceOptions,
  TrafficSourceInfo,
} from './types';
import { getHeaderValue } from './prefetch-filter';

interface MatchRule {
  platform: string;
  channel: 'ai_agent' | 'search_engine' | 'social_network';
  category: 'ai' | 'search' | 'social';
  isAiAgent: boolean;
  isSearch: boolean;
  isSocial: boolean;
  refererPatterns?: RegExp[];
  userAgentPatterns?: RegExp[];
}

const DETECTION_RULES: MatchRule[] = [
  // --- 1. AI Agents & Chatbots ---
  {
    platform: 'chatgpt',
    channel: 'ai_agent',
    category: 'ai',
    isAiAgent: true,
    isSearch: false,
    isSocial: false,
    refererPatterns: [/^(.*\.)?chatgpt\.com$/i, /^(.*\.)?chat\.openai\.com$/i, /^(.*\.)?openai\.com$/i],
    userAgentPatterns: [/ChatGPT-User/i, /GPTBot/i, /OAI-SearchBot/i],
  },
  {
    platform: 'claude',
    channel: 'ai_agent',
    category: 'ai',
    isAiAgent: true,
    isSearch: false,
    isSocial: false,
    refererPatterns: [/^(.*\.)?claude\.ai$/i, /^(.*\.)?anthropic\.com$/i],
    userAgentPatterns: [/ClaudeBot/i, /Claude-Web/i, /anthropic-ai/i],
  },
  {
    platform: 'gemini',
    channel: 'ai_agent',
    category: 'ai',
    isAiAgent: true,
    isSearch: false,
    isSocial: false,
    refererPatterns: [/^(.*\.)?gemini\.google\.com$/i, /^(.*\.)?bard\.google\.com$/i],
    userAgentPatterns: [/Google-Extended/i, /GoogleOther/i],
  },
  {
    platform: 'perplexity',
    channel: 'ai_agent',
    category: 'ai',
    isAiAgent: true,
    isSearch: false,
    isSocial: false,
    refererPatterns: [/^(.*\.)?perplexity\.ai$/i],
    userAgentPatterns: [/PerplexityBot/i],
  },
  {
    platform: 'copilot',
    channel: 'ai_agent',
    category: 'ai',
    isAiAgent: true,
    isSearch: false,
    isSocial: false,
    refererPatterns: [/^(.*\.)?copilot\.microsoft\.com$/i],
    userAgentPatterns: [/Bing-Chat/i, /Copilot/i],
  },
  {
    platform: 'deepseek',
    channel: 'ai_agent',
    category: 'ai',
    isAiAgent: true,
    isSearch: false,
    isSocial: false,
    refererPatterns: [/^(.*\.)?deepseek\.com$/i, /^(.*\.)?chat\.deepseek\.com$/i],
    userAgentPatterns: [/DeepSeekBot/i],
  },
  {
    platform: 'grok',
    channel: 'ai_agent',
    category: 'ai',
    isAiAgent: true,
    isSearch: false,
    isSocial: false,
    refererPatterns: [/^(.*\.)?grok\.com$/i, /^(.*\.)?x\.ai$/i],
    userAgentPatterns: [/Grok/i],
  },

  // --- 2. Social Networks (Domestic Vietnam & Global) ---
  {
    platform: 'zalo',
    channel: 'social_network',
    category: 'social',
    isAiAgent: false,
    isSearch: false,
    isSocial: true,
    refererPatterns: [/^(.*\.)?zalo\.me$/i, /^(.*\.)?chat\.zalo\.me$/i],
    userAgentPatterns: [/Zalo/i, /ZaloTheme/i, /ZaloPC/i, /ZaloMobile/i],
  },
  {
    platform: 'tiktok',
    channel: 'social_network',
    category: 'social',
    isAiAgent: false,
    isSearch: false,
    isSocial: true,
    refererPatterns: [/^(.*\.)?tiktok\.com$/i, /^(.*\.)?musical\.ly$/i],
    userAgentPatterns: [/TikTok/i, /musical_ly/i, /ByteLocale/i],
  },
  {
    platform: 'facebook',
    channel: 'social_network',
    category: 'social',
    isAiAgent: false,
    isSearch: false,
    isSocial: true,
    refererPatterns: [
      /^(.*\.)?facebook\.com$/i,
      /^(.*\.)?fb\.com$/i,
      /^(.*\.)?messenger\.com$/i,
      /^(.*\.)?m\.facebook\.com$/i,
      /^(.*\.)?l\.facebook\.com$/i,
      /^(.*\.)?lm\.facebook\.com$/i,
    ],
    userAgentPatterns: [/FBAN/i, /FBAV/i, /facebookexternalhit/i, /FB_IAB/i],
  },
  {
    platform: 'telegram',
    channel: 'social_network',
    category: 'social',
    isAiAgent: false,
    isSearch: false,
    isSocial: true,
    refererPatterns: [/^(.*\.)?t\.me$/i, /^(.*\.)?telegram\.org$/i, /^(.*\.)?web\.telegram\.org$/i],
    userAgentPatterns: [/TelegramBot/i, /Telegram/i],
  },
  {
    platform: 'youtube',
    channel: 'social_network',
    category: 'social',
    isAiAgent: false,
    isSearch: false,
    isSocial: true,
    refererPatterns: [/^(.*\.)?youtube\.com$/i, /^(.*\.)?youtu\.be$/i],
    userAgentPatterns: [/YouTube/i],
  },
  {
    platform: 'instagram',
    channel: 'social_network',
    category: 'social',
    isAiAgent: false,
    isSearch: false,
    isSocial: true,
    refererPatterns: [/^(.*\.)?instagram\.com$/i, /^(.*\.)?l\.instagram\.com$/i],
    userAgentPatterns: [/Instagram/i],
  },
  {
    platform: 'twitter',
    channel: 'social_network',
    category: 'social',
    isAiAgent: false,
    isSearch: false,
    isSocial: true,
    refererPatterns: [/^(.*\.)?twitter\.com$/i, /^(.*\.)?x\.com$/i, /^(.*\.)?t\.co$/i],
    userAgentPatterns: [/Twitterbot/i],
  },
  {
    platform: 'threads',
    channel: 'social_network',
    category: 'social',
    isAiAgent: false,
    isSearch: false,
    isSocial: true,
    refererPatterns: [/^(.*\.)?threads\.net$/i],
    userAgentPatterns: [/Threads/i],
  },
  {
    platform: 'linkedin',
    channel: 'social_network',
    category: 'social',
    isAiAgent: false,
    isSearch: false,
    isSocial: true,
    refererPatterns: [/^(.*\.)?linkedin\.com$/i, /^(.*\.)?lnkd\.in$/i],
    userAgentPatterns: [/LinkedInBot/i],
  },

  // --- 3. Search Engines ---
  {
    platform: 'google',
    channel: 'search_engine',
    category: 'search',
    isAiAgent: false,
    isSearch: true,
    isSocial: false,
    refererPatterns: [
      /^(www\.)?google\.(com|com\.[a-z]{2}|[a-z]{2})$/i,
      /^(.*\.)?google\.(com|com\.[a-z]{2}|[a-z]{2})$/i,
    ],
    userAgentPatterns: [/Googlebot/i],
  },
  {
    platform: 'coccoc',
    channel: 'search_engine',
    category: 'search',
    isAiAgent: false,
    isSearch: true,
    isSocial: false,
    refererPatterns: [/^(.*\.)?coccoc\.com$/i, /^(.*\.)?coccoc\.com\.vn$/i],
    userAgentPatterns: [/CocCoc/i, /coccocbot/i],
  },
  {
    platform: 'bing',
    channel: 'search_engine',
    category: 'search',
    isAiAgent: false,
    isSearch: true,
    isSocial: false,
    refererPatterns: [/^(.*\.)?bing\.com$/i],
    userAgentPatterns: [/bingbot/i, /BingPreview/i],
  },
  {
    platform: 'duckduckgo',
    channel: 'search_engine',
    category: 'search',
    isAiAgent: false,
    isSearch: true,
    isSocial: false,
    refererPatterns: [/^(.*\.)?duckduckgo\.com$/i],
    userAgentPatterns: [/DuckDuckBot/i],
  },
  {
    platform: 'yahoo',
    channel: 'search_engine',
    category: 'search',
    isAiAgent: false,
    isSearch: true,
    isSocial: false,
    refererPatterns: [/^(.*\.)?yahoo\.com$/i, /^(search\.)?yahoo\.co\.[a-z]{2}$/i],
    userAgentPatterns: [/Slurp/i],
  },
  {
    platform: 'baidu',
    channel: 'search_engine',
    category: 'search',
    isAiAgent: false,
    isSearch: true,
    isSocial: false,
    refererPatterns: [/^(.*\.)?baidu\.com$/i],
    userAgentPatterns: [/Baiduspider/i],
  },
  {
    platform: 'yandex',
    channel: 'search_engine',
    category: 'search',
    isAiAgent: false,
    isSearch: true,
    isSocial: false,
    refererPatterns: [/^(.*\.)?yandex\.(com|ru)$/i],
    userAgentPatterns: [/YandexBot/i],
  },
];

const BOT_PATTERNS = [
  /bot\b/i,
  /crawler/i,
  /spider/i,
  /headless/i,
  /ahrefs/i,
  /semrush/i,
  /petalbot/i,
  /curl/i,
  /wget/i,
  /python-requests/i,
];

function extractHostname(urlStr?: string): string | null {
  if (!urlStr) return null;
  try {
    const parsed = new URL(urlStr.startsWith('http') ? urlStr : `https://${urlStr}`);
    return parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
}

function extractSearchQuery(refererUrl?: string): string | undefined {
  if (!refererUrl) return undefined;
  try {
    const parsed = new URL(refererUrl.startsWith('http') ? refererUrl : `https://${refererUrl}`);
    const q = parsed.searchParams.get('q') || parsed.searchParams.get('query') || parsed.searchParams.get('p');
    return q || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Intelligent traffic source attribution:
 * Identifies AI chatbots (ChatGPT, Claude, Gemini, Perplexity), search engines (Google, Bing, CocCoc),
 * and social networks (Zalo, TikTok, Facebook, Telegram) via referer URL and User-Agent.
 */
export function detectTrafficSource(options: DetectTrafficSourceOptions = {}): TrafficSourceInfo {
  const referer = options.referer ?? (options.headers ? getHeaderValue(options.headers, 'referer') : null) ?? undefined;
  const userAgent = options.userAgent ?? (options.headers ? getHeaderValue(options.headers, 'user-agent') : null) ?? undefined;
  const internalDomains = (options.internalDomains ?? []).map((d) => d.toLowerCase());

  const refererHost = extractHostname(referer);

  // 1. Check internal domain
  if (refererHost && internalDomains.some((d) => refererHost === d || refererHost.endsWith(`.${d}`))) {
    return {
      channel: 'internal',
      platform: refererHost,
      isAiAgent: false,
      isSearch: false,
      isSocial: false,
      isBot: false,
      category: 'internal',
      rawReferer: referer,
      rawUserAgent: userAgent,
    };
  }

  // 2. Check matching rules (AI, Social, Search)
  for (const rule of DETECTION_RULES) {
    let matchedByReferer = false;
    let matchedByUA = false;

    if (refererHost && rule.refererPatterns) {
      matchedByReferer = rule.refererPatterns.some((pattern) => pattern.test(refererHost));
    }

    if (userAgent && rule.userAgentPatterns) {
      matchedByUA = rule.userAgentPatterns.some((pattern) => pattern.test(userAgent));
    }

    if (matchedByReferer || matchedByUA) {
      const isBot = matchedByUA || (userAgent ? BOT_PATTERNS.some((p) => p.test(userAgent)) : false);
      const query = rule.isSearch ? extractSearchQuery(referer) : undefined;

      return {
        channel: rule.channel,
        platform: rule.platform,
        isAiAgent: rule.isAiAgent,
        isSearch: rule.isSearch,
        isSocial: rule.isSocial,
        isBot,
        category: rule.category,
        rawReferer: referer,
        rawUserAgent: userAgent,
        details: {
          clientApp: matchedByUA ? rule.platform : undefined,
          searchQueryParam: query,
        },
      };
    }
  }

  // 3. Check generic bot
  const isGenericBot = userAgent ? BOT_PATTERNS.some((p) => p.test(userAgent)) : false;

  // 4. External referral
  if (refererHost) {
    return {
      channel: 'referral',
      platform: refererHost,
      isAiAgent: false,
      isSearch: false,
      isSocial: false,
      isBot: isGenericBot,
      category: 'referral',
      rawReferer: referer,
      rawUserAgent: userAgent,
    };
  }

  // 5. Direct
  return {
    channel: 'direct',
    platform: 'direct',
    isAiAgent: false,
    isSearch: false,
    isSocial: false,
    isBot: isGenericBot,
    category: 'direct',
    rawReferer: undefined,
    rawUserAgent: userAgent,
  };
}

/**
 * Returns true if the detected source is an AI Agent or Chatbot.
 */
export function isAiTraffic(source: TrafficSourceInfo): boolean {
  return source.isAiAgent || source.channel === 'ai_agent';
}

/**
 * Returns true if the detected source is a social network.
 */
export function isSocialTraffic(source: TrafficSourceInfo): boolean {
  return source.isSocial || source.channel === 'social_network';
}
