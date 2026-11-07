import { BlacklistAction, BlacklistRule } from '../types';

export const PRESET_CATEGORIES = {
  PROFANITY: 'PROFANITY',
  GAMBLING: 'GAMBLING',
  SCAM: 'SCAM',
  SEXUAL: 'SEXUAL',
} as const;

export type PresetCategory =
  (typeof PRESET_CATEGORIES)[keyof typeof PRESET_CATEGORIES];

export interface PresetRuleOptions {
  language?: 'vi' | 'en' | 'all';
  categories?: PresetCategory[];
  action?: BlacklistAction;
}

const VIETNAMESE_WORDS: Record<PresetCategory, string[]> = {
  PROFANITY: [
    'đm',
    'đcm',
    'vcl',
    'vl',
    'lồn',
    'buồi',
    'cặc',
    'dkm',
    'clmm',
    'đĩ',
    'chó đẻ',
    'thằng chó',
    'mẹ mày',
    'bố mày',
    'óc chó',
    'ngu lol',
    'mặt lồn',
    'cút mẹ',
    'đụ',
    'đụ má',
    'dcm',
    'vcc',
    'đéo',
    'đbrr',
    'ranh con',
    'chết tiệt',
  ],
  GAMBLING: [
    'lô đề',
    'đánh lô',
    'soi cầu',
    'cá độ bóng đá',
    'tài xỉu',
    'nổ hũ',
    'kubet',
    'thabet',
    'sunwin',
    'go88',
    'đá gà thomo',
    'bắn cá đổi thưởng',
    'xóc đĩa online',
    'baccarat online',
    'quay hũ',
    'soi cầu xsmb',
    'soi cầu xsmn',
    'lô xiên',
    'đề 3 càng',
    'nhà cái uy tín',
    'kèo nhà cái',
    'cá cược thể thao',
  ],
  SCAM: [
    'kéo tài khoản',
    'ủy thác đầu tư',
    'cam kết lợi nhuận',
    'bao lỗ 100%',
    'lãi ngày 5%',
    'lãi ngày 10%',
    'đầu tư sinh lời khủng',
    'app vay tiền nóng',
    'vay tiền icloud',
    'tín dụng đen',
    'việc nhẹ lương cao',
    'kéo 1-1 về bờ',
    'đầu tư nhận hoa hồng',
    'tiền ảo đa cấp',
    'phí giải ngân trước',
    'thu hồi nợ xấu lừa đảo',
    'nạp tiền nhận thưởng',
  ],
  SEXUAL: [
    'gái gọi',
    'bán dâm',
    'massage kích dục',
    'sextour',
    'tình một đêm',
    'clip sex',
    'chat sex',
    'sugar baby',
    'tìm fwb',
    'gạ tình',
    'gái ngành',
    'khiêu dâm',
    'show cam 18+',
    'gái bao',
    'massage a đến z',
  ],
};

const ENGLISH_WORDS: Record<PresetCategory, string[]> = {
  PROFANITY: [
    'fuck',
    'shit',
    'bitch',
    'asshole',
    'cunt',
    'motherfucker',
    'bastard',
    'dickhead',
    'pussy',
    'whore',
    'slut',
    'bullshit',
    'douchebag',
  ],
  GAMBLING: [
    'online casino',
    'sports betting',
    'slot machine',
    'bet365',
    'poker online',
    'roulette online',
    'crypto casino',
    'stake casino',
    'free spins',
    'jackpot slot',
    'live dealer casino',
  ],
  SCAM: [
    'guaranteed return',
    'investment scam',
    'account recovery scam',
    'forex signals vip',
    'crypto doubling',
    'fast money loan',
    'earn $1000 daily',
    'ponzi scheme',
    'pump and dump',
    'send btc double',
    'guaranteed profit',
    'no risk investment',
  ],
  SEXUAL: [
    'escort service',
    'sex chat',
    'webcam model',
    'adult dating',
    'nude pics',
    'free porn',
    'sugar daddy',
    'onlyfans leak',
    'hookup tonight',
    'cam girls',
  ],
};

function buildRules(
  dict: Record<PresetCategory, string[]>,
  prefix: string,
  categories?: PresetCategory[],
  defaultAction: BlacklistAction = 'BLOCK',
): BlacklistRule[] {
  const selectedCategories =
    categories && categories.length > 0
      ? categories
      : (Object.keys(dict) as PresetCategory[]);

  const rules: BlacklistRule[] = [];
  let counter = 1;

  for (const cat of selectedCategories) {
    const words = dict[cat] || [];
    for (const word of words) {
      rules.push({
        id: `${prefix}-${cat.toLowerCase()}-${counter++}`,
        word,
        action: defaultAction,
        category: cat,
        isWholeWord: true,
        isCaseSensitive: false,
      });
    }
  }

  return rules;
}

/**
 * Returns curated Vietnamese anti-spam and moderation blacklist rules.
 */
export function getVietnamesePresets(
  categories?: PresetCategory[],
  defaultAction: BlacklistAction = 'BLOCK',
): BlacklistRule[] {
  return buildRules(VIETNAMESE_WORDS, 'vi', categories, defaultAction);
}

/**
 * Returns curated English anti-spam and moderation blacklist rules.
 */
export function getEnglishPresets(
  categories?: PresetCategory[],
  defaultAction: BlacklistAction = 'BLOCK',
): BlacklistRule[] {
  return buildRules(ENGLISH_WORDS, 'en', categories, defaultAction);
}

/**
 * Returns complete combined Vietnamese and English presets.
 */
export function getAllPresets(
  categories?: PresetCategory[],
  defaultAction: BlacklistAction = 'BLOCK',
): BlacklistRule[] {
  return [
    ...getVietnamesePresets(categories, defaultAction),
    ...getEnglishPresets(categories, defaultAction),
  ];
}

/**
 * Helper to get presets by specific category and language.
 */
export function getPresetsByCategory(
  category: PresetCategory,
  lang: 'vi' | 'en' | 'all' = 'all',
  defaultAction: BlacklistAction = 'BLOCK',
): BlacklistRule[] {
  if (lang === 'vi') return getVietnamesePresets([category], defaultAction);
  if (lang === 'en') return getEnglishPresets([category], defaultAction);
  return getAllPresets([category], defaultAction);
}

/**
 * Dynamic presets rule generator with flexible options.
 */
export function createPresetRules(options?: PresetRuleOptions): BlacklistRule[] {
  const lang = options?.language ?? 'all';
  const categories = options?.categories;
  const action = options?.action ?? 'BLOCK';

  if (lang === 'vi') return getVietnamesePresets(categories, action);
  if (lang === 'en') return getEnglishPresets(categories, action);
  return getAllPresets(categories, action);
}

export { VIETNAMESE_WORDS, ENGLISH_WORDS };
