export type TrafficChannel =
  | 'ai_agent'
  | 'search_engine'
  | 'social_network'
  | 'direct'
  | 'referral'
  | 'internal'
  | 'unknown';

export type TrafficCategory =
  | 'ai'
  | 'search'
  | 'social'
  | 'direct'
  | 'referral'
  | 'internal'
  | 'unknown';

export type AiPlatform =
  | 'chatgpt'
  | 'claude'
  | 'gemini'
  | 'perplexity'
  | 'copilot'
  | 'deepseek'
  | 'grok'
  | 'cohere'
  | 'other_ai';

export type SearchPlatform =
  | 'google'
  | 'bing'
  | 'coccoc'
  | 'yahoo'
  | 'duckduckgo'
  | 'baidu'
  | 'yandex'
  | 'other_search';

export type SocialPlatform =
  | 'zalo'
  | 'tiktok'
  | 'facebook'
  | 'telegram'
  | 'youtube'
  | 'instagram'
  | 'twitter'
  | 'threads'
  | 'linkedin'
  | 'other_social';

export interface TrafficSourceInfo {
  channel: TrafficChannel;
  platform: string;
  isAiAgent: boolean;
  isSearch: boolean;
  isSocial: boolean;
  isBot: boolean;
  category: TrafficCategory;
  rawReferer?: string;
  rawUserAgent?: string;
  details?: {
    clientApp?: string;
    botName?: string;
    searchQueryParam?: string;
  };
}

export type HeaderCollection =
  | Headers
  | Record<string, string | string[] | undefined>
  | Map<string, string>;

export interface DetectTrafficSourceOptions {
  referer?: string;
  userAgent?: string;
  currentUrl?: string;
  headers?: HeaderCollection;
  internalDomains?: string[];
}

export type RotationMode = 'sequential' | 'random';

export interface BitmaskRotationOptions {
  mode?: RotationMode;
}

export interface BitmaskRotationResult<T> {
  selectedItem: T;
  selectedIndex: number;
  currentBitmask: number;
  nextBitmask: number;
  isCycleCompleted: boolean;
  visitedCount: number;
  totalCount: number;
  unvisitedIndices: number[];
}

export interface UtmParams {
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_term?: string;
  utm_content?: string;
  utm_id?: string;
  [key: string]: string | undefined;
}

export interface ResolveUtmOptions {
  defaults?: Partial<UtmParams>;
  override?: Partial<UtmParams>;
  preserveExisting?: boolean;
  cleanTrackingParameters?: boolean;
}
