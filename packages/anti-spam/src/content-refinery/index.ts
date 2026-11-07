/**
 * @kido/anti-spam — Content Refinery & RSS/Atom Feed Normalizer
 *
 * Harvested & generalized from production news ingestion pipelines:
 * 1. Zero-dependency lightweight RSS 2.0 / Atom / RDF XML feed parser & normalizer
 * 2. Scraped article quality & anti-clickbait / bot-wall / paywall refinery
 * 3. Bilingual EN/VI structured editorial extraction schema & prompt builder
 */

export interface NormalizedFeedItem {
  title: string | null;
  link: string | null;
  pubDate: string | null;
  publishedAt: Date;
  hostname: string;
  sourceUrl?: string;
}

export type ArticleRejectReason =
  | 'banned_domain'
  | 'bot_detection_or_captcha'
  | 'cookie_or_paywall'
  | 'insufficient_content'
  | 'repetitive_filler'
  | 'empty_title';

export interface EvaluateArticleQualityInput {
  title?: string | null;
  content?: string | null;
  site?: string | null;
  url?: string | null;
  bannedDomains?: string[];
  minContentLength?: number;
}

export interface ArticleRefineryResult {
  isValid: boolean;
  rejectReason?: ArticleRejectReason;
  reasons: string[];
  isClickbait: boolean;
  clickbaitSignals: string[];
  normalizedTitle: string;
  normalizedContent: string;
  hostname: string | null;
}

export interface EditorialRefinerySchemaProperty {
  type: string;
  format?: string;
  required?: string[];
  properties?: Record<string, { type: string }>;
}

export interface EditorialJsonSchema {
  type: 'object';
  required: string[];
  properties: {
    image: { type: 'string' };
    is_valid: { type: 'boolean' };
    title: {
      type: 'object';
      required: ['en', 'vi'];
      properties: {
        en: { type: 'string' };
        vi: { type: 'string' };
      };
    };
    author: { type: 'string' };
    published_date: { type: 'string'; format: 'date' };
    main_content: {
      type: 'object';
      required: ['en', 'vi'];
      properties: {
        en: { type: 'string' };
        vi: { type: 'string' };
      };
    };
    category: {
      type: 'object';
      required: ['en', 'vi'];
      properties: {
        en: { type: 'string' };
        vi: { type: 'string' };
      };
    };
    tags: { type: 'string' };
  };
}

export interface EditorialRefinerySpec {
  type: 'json';
  schema: EditorialJsonSchema;
  prompt: string;
}

export const DEFAULT_BANNED_NEWS_DOMAINS: readonly string[] = [
  'youtube.com',
  'youtu.be',
  'zacks.com',
  'seekingalpha.com',
  'financial modeling prep',
  'financialmodelingprep.com',
];

const XML_ENTITY_MAP: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};

/**
 * Unwraps `<![CDATA[...]]>` blocks and decodes basic XML/numeric entities.
 */
export function cleanXmlNodeText(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== 'string') {
    return null;
  }

  let text = raw.trim();
  if (text.length === 0) {
    return null;
  }

  // Unwrap one or more CDATA sections
  text = text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1');

  // Decode standard named entities
  text = text.replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/gi, (match) => {
    const lower = match.toLowerCase();
    return XML_ENTITY_MAP[lower] ?? match;
  });

  // Decode numeric decimal entities (e.g. &#8217;) and hex entities (e.g. &#x2019;)
  text = text.replace(/&#(\d+);/g, (_, dec: string) => {
    const code = Number.parseInt(dec, 10);
    return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : _;
  });
  text = text.replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => {
    const code = Number.parseInt(hex, 16);
    return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : _;
  });

  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Extracts normalized hostname without leading `www.`.
 * Falls back to `'rss-source'` when URL is invalid.
 */
export function extractFeedHostname(
  url?: string | null,
  fallbackUrl?: string | null,
): string {
  for (const candidate of [url, fallbackUrl]) {
    if (!candidate || typeof candidate !== 'string') continue;
    try {
      const hostname = new URL(candidate.trim()).hostname
        .toLowerCase()
        .replace(/^www\./, '');
      if (hostname) {
        return hostname;
      }
    } catch {
      // Ignore invalid URL and try next candidate
    }
  }
  return 'rss-source';
}

/**
 * Safely parses an RSS/Atom publication date string with a fallback Date.
 */
export function parseFeedPublishedDate(
  pubDate: string | null | undefined,
  fallbackDate: Date = new Date(),
): Date {
  if (!pubDate || typeof pubDate !== 'string') {
    return fallbackDate;
  }

  const parsed = new Date(pubDate.trim());
  if (Number.isNaN(parsed.getTime())) {
    return fallbackDate;
  }

  return parsed;
}

/**
 * Extracts the first matching tag body `<tagName ...>...</tagName>` (case-insensitive).
 */
function extractTagValue(block: string, tagNames: string[]): string | null {
  for (const tag of tagNames) {
    const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(
      `<${escapedTag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escapedTag}>`,
      'i',
    );
    const match = regex.exec(block);
    if (match && match[1] !== undefined) {
      const cleaned = cleanXmlNodeText(match[1]);
      if (cleaned) {
        return cleaned;
      }
    }
  }
  return null;
}

/**
 * Extracts feed item link from `<link>...</link>`, `<link href="..." />`, or `<url>...</url>`.
 */
function extractItemLink(block: string): string | null {
  // 1. Check Atom / self-closing or attributed `<link ... href="..." ...>` tags
  const linkTagRegex = /<link\b([^>]*?)(?:\/>|>([\s\S]*?)<\/link>)/gi;
  let match: RegExpExecArray | null;
  let fallbackHref: string | null = null;
  let textLink: string | null = null;

  while ((match = linkTagRegex.exec(block)) !== null) {
    const attrs = match[1] ?? '';
    const innerText = match[2];

    const hrefMatch = /\bhref\s*=\s*(?:"([^"]+)"|'([^']+)')/i.exec(attrs);
    const href = cleanXmlNodeText(hrefMatch?.[1] ?? hrefMatch?.[2] ?? null);

    if (href) {
      const relMatch = /\brel\s*=\s*(?:"([^"]+)"|'([^']+)')/i.exec(attrs);
      const rel = (relMatch?.[1] ?? relMatch?.[2] ?? '').toLowerCase();
      if (!rel || rel === 'alternate') {
        return href;
      }
      if (!fallbackHref) {
        fallbackHref = href;
      }
    }

    if (innerText !== undefined && !textLink) {
      // Check if innerText contains nested `<url>...</url>` or plain string/CDATA
      const nestedUrl = extractTagValue(innerText, ['url']);
      const cleanedInner = nestedUrl ?? cleanXmlNodeText(innerText);
      if (cleanedInner) {
        textLink = cleanedInner;
      }
    }
  }

  if (textLink) {
    return textLink;
  }
  if (fallbackHref) {
    return fallbackHref;
  }

  // 2. Fallback to `<url>...</url>` or `<guid isPermaLink="true">https://...</guid>`
  const directUrl = extractTagValue(block, ['url']);
  if (directUrl) {
    return directUrl;
  }

  const guidMatch = /<guid(?:\s+[^>]*isPermaLink\s*=\s*["']true["'][^>]*)?>([\s\S]*?)<\/guid>/i.exec(
    block,
  );
  if (guidMatch?.[1]) {
    const guidText = cleanXmlNodeText(guidMatch[1]);
    if (guidText && /^https?:\/\//i.test(guidText)) {
      return guidText;
    }
  }

  return null;
}

/**
 * Lightweight, zero-dependency RSS 2.0 (`<item>`), RDF (`<item>`), and Atom (`<entry>`) XML parser.
 * Handles `<![CDATA[...]]>`, attribute links (`<link href="...">`), and multiple date tags.
 */
export function parseRssOrAtomXml(
  xml: string,
  sourceUrl?: string,
): NormalizedFeedItem[] {
  if (!xml || typeof xml !== 'string') {
    return [];
  }

  const trimmed = xml.trim();
  if (trimmed.length === 0) {
    return [];
  }

  const entryBlocks: string[] = [];
  const itemRegex = /<(?:item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/(?:item|entry)>/gi;
  let match: RegExpExecArray | null;

  while ((match = itemRegex.exec(trimmed)) !== null) {
    if (match[1]) {
      entryBlocks.push(match[1]);
    }
  }

  return entryBlocks.map((block) => {
    const title = extractTagValue(block, ['title']);
    const link = extractItemLink(block);
    const pubDate = extractTagValue(block, [
      'pubDate',
      'pubdate',
      'published',
      'updated',
      'dc:date',
    ]);
    const publishedAt = parseFeedPublishedDate(pubDate);
    const hostname = extractFeedHostname(link, sourceUrl);

    const item: NormalizedFeedItem = {
      title,
      link,
      pubDate,
      publishedAt,
      hostname,
    };

    if (sourceUrl !== undefined) {
      item.sourceUrl = sourceUrl;
    }

    return item;
  });
}

const BOT_WALL_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /attention required!\s*\|\s*cloudflare/i, label: 'cloudflare_attention_wall' },
  { pattern: /just a moment\.{3}/i, label: 'cloudflare_interstitial' },
  { pattern: /enable javascript and cookies to continue/i, label: 'cloudflare_js_challenge' },
  { pattern: /checking your browser before accessing/i, label: 'browser_verification' },
  { pattern: /verify you are human|are you a robot/i, label: 'human_verification_captcha' },
  { pattern: /please complete the security check to access/i, label: 'security_checkpoint' },
  { pattern: /cloudflare ray id/i, label: 'cloudflare_block_page' },
  { pattern: /cf-browser-verification|cf_chl_opt/i, label: 'cloudflare_challenge_token' },
];

const PAYWALL_OR_COOKIE_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /subscribe to continue reading|subscription required to read/i, label: 'subscription_paywall' },
  { pattern: /this article is for subscribers only|exclusively for subscribers/i, label: 'subscriber_only_wall' },
  { pattern: /sign in to read the full article|please log in to continue reading/i, label: 'login_wall' },
  {
    pattern: /we value your privacy[\s\S]{0,120}(?:accept all cookies|manage cookie preferences)/i,
    label: 'cookie_consent_banner',
  },
  {
    pattern: /use cookies to personalize content and ads[\s\S]{0,120}accept all/i,
    label: 'cookie_consent_wall',
  },
];

const CLICKBAIT_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\b(?:you won't believe|shocks the market|guaranteed profit|get rich quick|to the moon|100x gem)\b/i, label: 'hype_phrase_en' },
  { pattern: /\b(?:cực sốc|không thể tin nổi|làm giàu không khó|chắc chắn thắng|x100 tài khoản|bật mí bí mật)\b/i, label: 'hype_phrase_vi' },
  { pattern: /[!?]{2,}/, label: 'excessive_punctuation' },
  { pattern: /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, label: 'emoji_in_headline' },
  { pattern: /\b(?:BREAKING|SHOCKING|URGENT|MUST READ|INSANE|EXPLODES)\b/, label: 'all_caps_sensationalism' },
];

/**
 * Normalizes headline whitespace, strips emojis, and collapses sensational punctuation.
 */
export function normalizeEditorialHeadline(title: string): string {
  if (!title || typeof title !== 'string') {
    return '';
  }

  let cleaned = title.normalize('NFC');
  // Remove emojis and dingbats
  cleaned = cleaned.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '');
  // Replace repeated exclamation/question marks
  cleaned = cleaned.replace(/[!?]{2,}/g, '');
  // Strip trailing standalone exclamation mark in news headlines
  cleaned = cleaned.replace(/!+$/g, '');
  // Strip sensational bracket prefixes like [BREAKING], [SỐC], [HOT]
  cleaned = cleaned.replace(
    /^\s*\[(?:BREAKING|SHOCKING|URGENT|HOT|SỐC|KHẨN|TIN NÓNG)\]\s*:?\s*/i,
    '',
  );
  // Collapse whitespace and trim punctuation spacing
  cleaned = cleaned
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:?])/g, '$1')
    .trim();

  return cleaned;
}

/**
 * Normalizes article body whitespace and line breaks.
 */
export function normalizeEditorialContent(content: string): string {
  if (!content || typeof content !== 'string') {
    return '';
  }

  return content
    .normalize('NFC')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * Checks if text is predominantly repetitive filler or boilerplate.
 */
function hasRepetitiveFillerText(content: string): boolean {
  if (/lorem ipsum dolor sit amet/i.test(content)) {
    return true;
  }

  const words = content
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2);

  if (words.length >= 20) {
    const uniqueWords = new Set(words);
    if (uniqueWords.size / words.length < 0.2) {
      return true;
    }
  }

  return false;
}

/**
 * Evaluates scraped article quality, detecting banned domains, Cloudflare/captcha walls,
 * cookie/paywall prompts, short/repetitive filler text, and headline clickbait patterns.
 */
export function evaluateScrapedArticleQuality(
  input: EvaluateArticleQualityInput,
): ArticleRefineryResult {
  const rawTitle = input.title ?? '';
  const rawContent = input.content ?? '';
  const minContentLength = input.minContentLength ?? 80;
  const bannedList = [
    ...DEFAULT_BANNED_NEWS_DOMAINS,
    ...(input.bannedDomains ?? []),
  ].map((d) => d.trim().toLowerCase().replace(/^www\./, ''));

  const normalizedTitle = normalizeEditorialHeadline(rawTitle);
  const normalizedContent = normalizeEditorialContent(rawContent);

  let resolvedHostname: string | null = null;
  if (input.site && input.site.trim().length > 0) {
    const siteCandidate = input.site.trim();
    if (/^https?:\/\//i.test(siteCandidate)) {
      resolvedHostname = extractFeedHostname(siteCandidate);
    } else {
      resolvedHostname = siteCandidate.toLowerCase().replace(/^www\./, '');
    }
  } else if (input.url) {
    const host = extractFeedHostname(input.url);
    resolvedHostname = host === 'rss-source' ? null : host;
  }

  const reasons: string[] = [];
  let rejectReason: ArticleRejectReason | undefined;

  // 1. Check banned domain/site
  if (resolvedHostname) {
    const isBanned = bannedList.some(
      (banned) =>
        banned.length > 0 &&
        (resolvedHostname === banned ||
          resolvedHostname.endsWith(`.${banned}`)),
    );
    if (isBanned) {
      rejectReason = 'banned_domain';
      reasons.push(`Domain or publisher "${resolvedHostname}" is in banned list`);
    }
  }

  // 2. Check empty title
  if (!rejectReason && normalizedTitle.length === 0) {
    rejectReason = 'empty_title';
    reasons.push('Article title is missing or empty');
  }

  // 3. Check bot-detection / Cloudflare / captcha walls
  const combinedText = `${rawTitle}\n${rawContent}`;
  for (const { pattern, label } of BOT_WALL_PATTERNS) {
    if (pattern.test(combinedText)) {
      if (!rejectReason) {
        rejectReason = 'bot_detection_or_captcha';
      }
      reasons.push(`Detected bot/security challenge wall: ${label}`);
    }
  }

  // 4. Check cookie banners & paywall/login prompts
  for (const { pattern, label } of PAYWALL_OR_COOKIE_PATTERNS) {
    if (pattern.test(combinedText)) {
      if (!rejectReason) {
        rejectReason = 'cookie_or_paywall';
      }
      reasons.push(`Detected cookie or paywall prompt: ${label}`);
    }
  }

  // 5. Check repetitive filler text
  if (normalizedContent.length > 0 && hasRepetitiveFillerText(normalizedContent)) {
    if (!rejectReason) {
      rejectReason = 'repetitive_filler';
    }
    reasons.push('Content contains repetitive filler or boilerplate text');
  }

  // 6. Check minimum content length
  if (normalizedContent.length < minContentLength) {
    if (!rejectReason) {
      rejectReason = 'insufficient_content';
    }
    reasons.push(
      `Content length (${normalizedContent.length} chars) is below minimum threshold (${minContentLength} chars)`,
    );
  }

  // 7. Detect clickbait signals in original headline
  const clickbaitSignals: string[] = [];
  for (const { pattern, label } of CLICKBAIT_PATTERNS) {
    if (pattern.test(rawTitle)) {
      clickbaitSignals.push(label);
    }
  }

  return {
    isValid: rejectReason === undefined,
    rejectReason,
    reasons,
    isClickbait: clickbaitSignals.length > 0,
    clickbaitSignals,
    normalizedTitle,
    normalizedContent,
    hostname: resolvedHostname,
  };
}

/**
 * Generates the structured JSON schema + bilingual editorial prompt for Firecrawl / LLM extraction.
 */
export function buildEditorialRefinerySchema(
  categoriesEn: string[],
  categoriesVi: string[],
): EditorialRefinerySpec {
  const schema: EditorialJsonSchema = {
    type: 'object',
    required: [
      'is_valid',
      'title',
      'author',
      'published_date',
      'main_content',
      'category',
      'image',
    ],
    properties: {
      image: {
        type: 'string',
      },
      is_valid: {
        type: 'boolean',
      },
      title: {
        type: 'object',
        required: ['en', 'vi'],
        properties: {
          en: {
            type: 'string',
          },
          vi: {
            type: 'string',
          },
        },
      },
      author: {
        type: 'string',
      },
      published_date: {
        type: 'string',
        format: 'date',
      },
      main_content: {
        type: 'object',
        required: ['en', 'vi'],
        properties: {
          en: {
            type: 'string',
          },
          vi: {
            type: 'string',
          },
        },
      },
      category: {
        type: 'object',
        required: ['en', 'vi'],
        properties: {
          en: {
            type: 'string',
          },
          vi: {
            type: 'string',
          },
        },
      },
      tags: {
        type: 'string',
      },
    },
  };

  const enList = categoriesEn.join(', ');
  const viList = categoriesVi.join(', ');

  const prompt = `Extract image, is_valid, article title, author, publication date, category, main_content, and tags.

The image is the url of the main image.

The is_valid boolean field represents content awareness validation.
- Set is_valid to true if the page content is meaningful, coherent, and relevant to news.
- Set is_valid to false if the content mainly contains bot-detection messages, repeated filler text, cookie banners, login or subscription prompts, legal disclaimers.

The category must be provided in two language variants:  
- en: Select the single best match from the following list: ${enList}.  
- vi: Select the corresponding best match from the following list: ${viList}.

The title must follow below rules:
- The title must accurately reflect the core financial, economic, or investment subject of the article.
- The title must follow professional financial news and press editorial standards.
- Avoid clickbait, hype, emotional language, marketing terms, emojis, slang, or calls to action.
- If the original title contains promotional or exaggerated language, rewrite it into a neutral, factual, and analytical headline.
- Preserve the informational structure of the original title, including comparisons, cause–effect relationships, time references, and punctuation such as commas, colons, or dashes when they improve clarity.
- The final title must read naturally and be suitable for publication on professional financial news platforms and the title must be provided in two language variants:  
-- en: A normalized English title following the rules above.  
-- vi: A Vietnamese translation of the normalized English title. Use formal, neutral financial news language. Preserve meaning, structure, and punctuation. Capitalize only the first word and proper nouns or acronyms.

The main_content should be an extraction of the article’s main text, excluding any unrelated commentary, paraphrasing, navigation text, related links, comments, advertisements or added interpretation. Provide main_content in two language variants:  
- en: The original English content.  
- vi: A Vietnamese translation that uses finance - appropriate terminology and preserves the sentence -break structure of the original.
`;

  return {
    type: 'json',
    schema,
    prompt,
  };
}
