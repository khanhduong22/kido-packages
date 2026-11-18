/**
 * @kido/ai-stream - Commerce Entity Extractor & Semantic Vectorizer
 *
 * Implements GonnaCrash World 3 Level 14 (`same_question_new_words`) entity-aware
 * fingerprinting and lightweight zero-dependency Vietnamese/English trigram hashing.
 */

import { removeDiacritics } from '../rag-pipeline/index.js';

export interface ExtractedCommerceEntities {
  sizes: string[];
  weightsOrVolumes: string[];
  quantitiesOrSets: string[];
  colorsOrFinishes: string[];
  priceBounds: string[];
  brandsOrSkus: string[];
}

const ENTITY_CATEGORIES: Array<keyof ExtractedCommerceEntities> = [
  'brandsOrSkus', 'colorsOrFinishes', 'priceBounds', 'quantitiesOrSets', 'sizes', 'weightsOrVolumes',
];

const APPAREL_CONTEXT_RE =
  /(?<![\p{L}\p{N}_])(?:áo|ao|quần|quan|váy|vay|đầm|dam|shirt|tee|hoodie|jacket|sweater|coat|dress|pants|jeans|skirt|form|mặc|mac)(?![\p{L}\p{N}_])/u;

const QUANTITY_UNIT_MAP: Record<string, string> = {
  màu: 'colors', mau: 'colors', color: 'colors', colors: 'colors', colour: 'colors', colours: 'colors',
  tuýp: 'colors', tuyp: 'colors', tube: 'colors', tubes: 'colors', pan: 'colors', pans: 'colors',
  tờ: 'sheets', to: 'sheets', sheet: 'sheets', sheets: 'sheets', page: 'sheets', pages: 'sheets',
  cái: 'pcs', cai: 'pcs', chiếc: 'pcs', chiec: 'pcs', pcs: 'pcs', piece: 'pcs', pieces: 'pcs', viên: 'pcs', vien: 'pcs',
  bộ: 'sets', bo: 'sets', set: 'sets', sets: 'sets',
  hộp: 'boxes', hop: 'boxes', box: 'boxes', boxes: 'boxes',
  cây: 'pens', cay: 'pens', pen: 'pens', pens: 'pens',
  cuốn: 'pads', cuon: 'pads', quyển: 'pads', quyen: 'pads', tập: 'pads', tap: 'pads', tệp: 'pads', tep: 'pads', pad: 'pads', pads: 'pads', book: 'pads', books: 'pads',
  pack: 'packs', packs: 'packs', gói: 'packs', goi: 'packs',
};

const MULTI_WORD_FILLER_RE =
  /(?<![\p{L}\p{N}_])(?:cho mình hỏi|cho em hỏi|cho hỏi|còn hàng không|còn hàng hông|còn không|còn hông|còn hàng|shop ơi|do you have|in stock)(?![\p{L}\p{N}_])/gu;

const SINGLE_WORD_FILLERS = new Set([
  'shop', 'ơi', 'oi', 'hông', 'không', 'khong', 'ko', 'còn', 'con', 'hàng', 'hang',
  'ạ', 'nha', 'nhé', 'nhe', 'vậy', 'vay', 'please', 'is', 'available',
  'tệp', 'tep', 'cái', 'cai', 'bộ', 'bo', 'dạ', 'nhỉ', 'nhi', 'hả', 'ha', 'mình', 'minh', 'em',
]);

const TOKEN_SYNONYMS: Record<string, string> = {
  áo: 'shirt', ao: 'shirt', cỡ: 'size', size: 'size', giấy: 'paper', giay: 'paper', vẽ: 'draw', ve: 'draw',
  đen: 'black', den: 'black', trắng: 'white', đỏ: 'red', vàng: 'yellow', vang: 'yellow', hồng: 'pink', nhũ: 'metallic',
  tờ: 'sheets', sheet: 'sheets', sheets: 'sheets',
  màu: 'colors', mau: 'colors', color: 'colors', colors: 'colors', colour: 'colors', colours: 'colors',
  tuýp: 'colors', tuyp: 'colors', tube: 'colors', tubes: 'colors',
  dưới: 'max_price', duoi: 'max_price', under: 'max_price', below: 'max_price',
  trên: 'min_price', tren: 'min_price', over: 'min_price', above: 'min_price',
};

const COLOR_RULES: Array<[RegExp, string]> = [
  [/(?<![\p{L}\p{N}_])(?:cold[\s_-]*press|vân[\s_-]*cold|van[\s_-]*cold|vân lạnh|van lanh)(?![\p{L}\p{N}_])/gu, 'cold_press'],
  [/(?<![\p{L}\p{N}_])(?:hot[\s_-]*press|vân[\s_-]*hot|van[\s_-]*hot|vân nóng|van nong)(?![\p{L}\p{N}_])/gu, 'hot_press'],
  [/(?<![\p{L}\p{N}_])(?:rough|vân nhám|van nham|vân sần|van san)(?![\p{L}\p{N}_])/gu, 'rough'],
  [/(?<![\p{L}\p{N}_])(?:xanh[\s_-]*(?:dương|duong|biển|bien|nước biển|nuoc bien)|blue|navy|cobalt)(?![\p{L}\p{N}_])/gu, 'blue'],
  [/(?<![\p{L}\p{N}_])(?:xanh[\s_-]*(?:lá|la|rêu|reu)|green)(?![\p{L}\p{N}_])/gu, 'green'],
  [/(?<![\p{L}\p{N}_])(?:đen|den|black)(?![\p{L}\p{N}_])/gu, 'black'],
  [/(?<![\p{L}\p{N}_])(?:trắng|white)(?![\p{L}\p{N}_])/gu, 'white'],
  [/(?<![\p{L}\p{N}_])(?:màu|mau|áo|ao|quần|quan|váy|vay|giấy|giay|bút|but|vỏ|vo|sơn|son|nền|nen)\s+trang(?![\p{L}\p{N}_])/gu, 'white'],
  [/(?<![\p{L}\p{N}_])(?:đỏ|red)(?![\p{L}\p{N}_])/gu, 'red'],
  [/(?<![\p{L}\p{N}_])(?:màu|mau|áo|ao|quần|quan|váy|vay|giấy|giay|bút|but|sơn|son|color|colour)\s+do(?![\p{L}\p{N}_])/gu, 'red'],
  [/(?<![\p{L}\p{N}_])(?:vàng|vang|yellow)(?![\p{L}\p{N}_])/gu, 'yellow'],
  [/(?<![\p{L}\p{N}_])(?:hồng|pink)(?![\p{L}\p{N}_])/gu, 'pink'],
  [/(?<![\p{L}\p{N}_])(?:màu|mau|áo|ao|quần|quan|váy|vay|bút|but|giấy|giay|color|colour)\s+hong(?![\p{L}\p{N}_])/gu, 'pink'],
  [/(?<![\p{L}\p{N}_])pastel(?![\p{L}\p{N}_])/gu, 'pastel'],
  [/(?<![\p{L}\p{N}_])(?:metallic|nhũ|ánh kim|anh kim)(?![\p{L}\p{N}_])/gu, 'metallic'],
  [/(?<![\p{L}\p{N}_])(?:màu|mau|bút|but|mực|muc)\s+nhu(?![\p{L}\p{N}_])/gu, 'metallic'],
  [/(?<![\p{L}\p{N}_])(?:tím|purple|violet)(?![\p{L}\p{N}_])/gu, 'purple'],
  [/(?<![\p{L}\p{N}_])(?:nâu|brown)(?![\p{L}\p{N}_])/gu, 'brown'],
  [/(?<![\p{L}\p{N}_])(?:xám|gray|grey)(?![\p{L}\p{N}_])/gu, 'gray'],
  [/(?<![\p{L}\p{N}_])(?:orange|(?:màu|mau)\s+cam)(?![\p{L}\p{N}_])/gu, 'orange'],
];

const BRAND_RULES: Array<[RegExp, string]> = [
  [/(?<![\p{L}\p{N}_])holbein(?![\p{L}\p{N}_])/gu, 'holbein'],
  [/(?<![\p{L}\p{N}_])(?:baohong|bao\s+hong|bảo\s+hồng)(?![\p{L}\p{N}_])/gu, 'baohong'],
  [/(?<![\p{L}\p{N}_])mont[\s_-]*marte(?![\p{L}\p{N}_])/gu, 'mont_marte'],
  [/(?<![\p{L}\p{N}_])touch[\s_-]*cool(?![\p{L}\p{N}_])/gu, 'touch_cool'],
  [/(?<![\p{L}\p{N}_])canson(?![\p{L}\p{N}_])/gu, 'canson'],
  [/(?<![\p{L}\p{N}_])sakura(?![\p{L}\p{N}_])/gu, 'sakura'],
  [/(?<![\p{L}\p{N}_])winsor\s*(?:&|and|[\s_-]+)\s*newton(?![\p{L}\p{N}_])/gu, 'winsor_newton'],
  [/(?<![\p{L}\p{N}_])faber[\s_-]*castell(?![\p{L}\p{N}_])/gu, 'faber_castell'],
];

function addMatches(target: Set<string>, text: string, regex: RegExp, mapFn?: (m: RegExpExecArray) => string): void {
  regex.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const val = mapFn ? mapFn(match) : match[1] ?? match[0];
    if (val) target.add(val);
  }
}

function parsePriceAmount(rawNum: string, rawUnit?: string): number | null {
  const normalizedNum = /^\d{1,3}(?:[.,]\d{3})+$/.test(rawNum)
    ? rawNum.replace(/[.,]/g, '')
    : rawNum.replace(/,/g, '.');
  const num = Number.parseFloat(normalizedNum);
  if (!Number.isFinite(num) || num <= 0) return null;

  const unit = (rawUnit ?? '').toLowerCase();
  if (unit === 'k' || unit === 'nghìn' || unit === 'nghin' || unit === 'ngàn' || unit === 'ngan') return Math.round(num * 1_000);
  if (unit === 'tr' || unit === 'triệu' || unit === 'trieu' || unit === 'm') return Math.round(num * 1_000_000);
  if (!unit && num < 1_000) return null;
  return Math.round(num);
}

function maskSpan(chars: string[], start: number, length: number): void {
  for (let i = start; i < start + length && i < chars.length; i++) chars[i] = ' ';
}

function extractPriceBounds(text: string): string[] {
  const bounds = new Set<string>();
  const workChars = Array.from(text);

  const rangeRe = /(?<![\p{L}\p{N}_])(?:từ|tu|from)?\s*(\d+(?:[.,]\d+)*)\s*(k|tr|triệu|trieu|m|vnđ|vnd|đ)?\s*(?:-|đến|den|to|~)\s*(\d+(?:[.,]\d+)*)\s*(k|tr|triệu|trieu|m|vnđ|vnd|đ)(?![\p{L}\p{N}_])/gu;
  for (const m of text.matchAll(rangeRe)) {
    const low = parsePriceAmount(m[1], m[2] ?? m[4]);
    const high = parsePriceAmount(m[3], m[4]);
    if (low !== null && high !== null) {
      bounds.add(`min:${low}`);
      bounds.add(`max:${high}`);
      maskSpan(workChars, m.index ?? 0, m[0].length);
    }
  }

  const boundSpecs: Array<[RegExp, 'max' | 'min']> = [
    [/(?<![\p{L}\p{N}_])(?:dưới|duoi|tối đa|toi da|không quá|khong qua|under|below|max|<=|<|ít hơn|it hon)\s*[:=]?\s*(\d+(?:[.,]\d+)*)\s*(k|nghìn|nghin|ngàn|ngan|tr|triệu|trieu|m|vnđ|vnd|đ|d)?(?![\p{L}\p{N}_])/gu, 'max'],
    [/(?<![\p{L}\p{N}_])(?:trên|tren|từ|tu|tối thiểu|toi thieu|over|above|min|>=|>|hơn|hon)\s*[:=]?\s*(\d+(?:[.,]\d+)*)\s*(k|nghìn|nghin|ngàn|ngan|tr|triệu|trieu|m|vnđ|vnd|đ|d)?(?![\p{L}\p{N}_])/gu, 'min'],
  ];
  for (const [re, prefix] of boundSpecs) {
    for (const m of workChars.join('').matchAll(re)) {
      const val = parsePriceAmount(m[1], m[2]);
      if (val !== null) {
        bounds.add(`${prefix}:${val}`);
        maskSpan(workChars, m.index ?? 0, m[0].length);
      }
    }
  }

  const valRe = /(?<![\p{L}\p{N}_])(?:(?:tầm|tam|khoảng|khoang|giá|gia|around|about|~)\s*)?(\d+(?:[.,]\d+)*)\s*(k|nghìn|nghin|ngàn|ngan|tr|triệu|trieu|m|vnđ|vnd|đ)(?![\p{L}\p{N}_])/gu;
  for (const m of workChars.join('').matchAll(valRe)) {
    const val = parsePriceAmount(m[1], m[2]);
    if (val !== null) bounds.add(`val:${val}`);
  }
  return Array.from(bounds).sort();
}

/**
 * Extracts normalized commerce entities (sizes, weights, sets, colors/finishes, price bounds, brands/SKUs)
 * from Vietnamese and English shopping queries.
 */
export function extractCommerceEntities(query: string): ExtractedCommerceEntities {
  const raw = (query ?? '').normalize('NFC').trim();
  const text = raw.toLowerCase();
  if (!text) {
    return { sizes: [], weightsOrVolumes: [], quantitiesOrSets: [], colorsOrFinishes: [], priceBounds: [], brandsOrSkus: [] };
  }

  const sizes = new Set<string>();
  addMatches(sizes, text, /(?<![a-z0-9])(a2|a3|a4|a5|a6|b5|2b|3b|4b|5b|6b|7b|8b|hb)(?![a-z0-9])/gu);
  addMatches(sizes, text, /(?<![\p{L}\p{N}_-])(xxxl|xxl|xl|xs)(?![\p{L}\p{N}_-])/gu);
  addMatches(sizes, text, /(?<![\p{L}\p{N}_])(?:size|sz|cỡ|co)\s*[:#=-]?\s*(xxxl|xxl|xl|xs|s|m|l)(?![\p{L}\p{N}_-])/gu);
  if (/[a-z\p{Ll}]/u.test(raw) || raw.length <= 8) {
    addMatches(sizes, raw, /(?<![\p{L}\p{N}_\-'.])(S|M|L)(?![\p{L}\p{N}_\-'])/gu, (m) => m[1].toLowerCase());
  }
  if (APPAREL_CONTEXT_RE.test(text)) {
    addMatches(sizes, text, /(?<![\p{L}\p{N}_\-'.])(s|m|l)(?![\p{L}\p{N}_\-'])/gu);
  }

  const weightsOrVolumes = new Set<string>();
  addMatches(weightsOrVolumes, text, /(?<![\p{L}\p{N}.])(\d+(?:\.\d+)?)\s*(gsm|kg|mg|gr|g|ml|oz|lít|lit)(?![\p{L}\p{N}_])/gu, (m) => {
    const unit = m[2] === 'gr' ? 'g' : m[2] === 'lít' || m[2] === 'lit' ? 'l' : m[2];
    return `${m[1]}${unit}`;
  });
  addMatches(weightsOrVolumes, text, /(?<![\p{L}\p{N}.])(\d+(?:\.\d+)?)(l)(?![\p{L}\p{N}_])/gu, (m) => `${m[1]}l`);

  const quantitiesOrSets = new Set<string>();
  const qtyPattern =
    /(?<![\p{L}\p{N}.])(\d+)\s*(màu|mau|colours?|colors?|tuýp|tuyp|tubes?|pans?|tờ|sheets?|pages?|cái|cai|chiếc|chiec|pcs|pieces?|viên|vien|bộ|bo|sets?|hộp|hop|box(?:es)?|cây|cay|pens?|cuốn|cuon|quyển|quyen|tập|tap|tệp|tep|pads?|books?|packs?|gói|goi)(?![\p{L}\p{N}_])/gu;
  addMatches(quantitiesOrSets, text, qtyPattern, (m) => `${m[1]}_${QUANTITY_UNIT_MAP[m[2]] ?? m[2]}`);
  addMatches(quantitiesOrSets, text, /(?<![\p{L}\p{N}.])(\d+)\s+to(?=\s*(?:giấy|giay|vẽ|ve|a[2-6]|b5|[?!.,]|$))/gu, (m) => `${m[1]}_sheets`);

  const colorsOrFinishes = new Set<string>();
  for (const [re, canonical] of COLOR_RULES) addMatches(colorsOrFinishes, text, re, () => canonical);

  const brandsOrSkus = new Set<string>();
  for (const [re, canonical] of BRAND_RULES) addMatches(brandsOrSkus, text, re, () => canonical);
  addMatches(brandsOrSkus, text, /(?<![a-z0-9-])([a-z]{2,8}(?:[-_][a-z0-9]{1,8})+)(?![a-z0-9-])/gu, (m) =>
    /\d/.test(m[1]) ? m[1] : ''
  );

  return {
    sizes: Array.from(sizes).sort(),
    weightsOrVolumes: Array.from(weightsOrVolumes).sort(),
    quantitiesOrSets: Array.from(quantitiesOrSets).sort(),
    colorsOrFinishes: Array.from(colorsOrFinishes).sort(),
    priceBounds: extractPriceBounds(text),
    brandsOrSkus: Array.from(brandsOrSkus).sort(),
  };
}

/** Builds a deterministic fingerprint `category:val1,val2|...` or `'__general__'` when empty. */
export function computeEntityFingerprint(entities: ExtractedCommerceEntities): string {
  const parts: string[] = [];
  for (const key of ENTITY_CATEGORIES) {
    const vals = entities[key];
    if (vals.length > 0) parts.push(`${key}:${Array.from(new Set(vals)).sort().join(',')}`);
  }
  return parts.length > 0 ? parts.join('|') : '__general__';
}

function fnv1a32(input: string, seed = 2166136261): number {
  let hash = seed >>> 0;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function addHashedFeature(vec: number[], feature: string, weight: number): void {
  const idx = fnv1a32(feature) % vec.length;
  const sign = (fnv1a32(feature, 0x9e3779b9) & 1) === 0 ? 1 : -1;
  vec[idx] += sign * weight;
}

/**
 * Strips conversational fillers, normalizes bilingual product synonyms, and hashes
 * word unigrams, word bigrams, and per-token char 3-grams into an L2-normalized vector.
 */
export function computeSemanticTrigramVector(query: string, dimensions = 128): number[] {
  const dims = Math.max(8, dimensions);
  const vec = new Array<number>(dims).fill(0);
  const raw = (query ?? '').normalize('NFC').toLowerCase().trim();
  if (!raw) return vec;

  const text = raw
    .replace(MULTI_WORD_FILLER_RE, ' ')
    .replace(/(?<![\p{L}\p{N}_])(?:màu nước|mau nuoc)(?![\p{L}\p{N}_])/gu, 'watercolor')
    .replace(/(?<![\p{L}\p{N}_])(?:xanh[\s_-]*(?:dương|duong))(?![\p{L}\p{N}_])/gu, 'blue')
    .replace(/(?<![\p{L}\p{N}_])(?:xanh[\s_-]*(?:lá|la))(?![\p{L}\p{N}_])/gu, 'green')
    .replace(/(?<![\p{L}\p{N}_])(?:cold[\s_-]*press|vân[\s_-]*cold|van[\s_-]*cold)(?![\p{L}\p{N}_])/gu, 'cold_press')
    .replace(/(?<![\p{L}\p{N}_])(?:hot[\s_-]*press|vân[\s_-]*hot|van[\s_-]*hot)(?![\p{L}\p{N}_])/gu, 'hot_press')
    .replace(/(?<![\p{L}\p{N}_])mont[\s_-]*marte(?![\p{L}\p{N}_])/gu, 'mont_marte')
    .replace(/(?<![\p{L}\p{N}_])touch[\s_-]*cool(?![\p{L}\p{N}_])/gu, 'touch_cool')
    .replace(/(?<![\p{L}\p{N}_])winsor\s*(?:&|and|[\s_-]+)\s*newton(?![\p{L}\p{N}_])/gu, 'winsor_newton')
    .replace(/(?<![\p{L}\p{N}_])faber[\s_-]*castell(?![\p{L}\p{N}_])/gu, 'faber_castell')
    .replace(/(?<![\p{L}\p{N}_])co\s+(xxxl|xxl|xl|xs|s|m|l)(?![\p{L}\p{N}_])/gu, 'size $1')
    .replace(/[?!.,;:"'()[\]{}`~@#$%^&*+=<>\\/|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const rawTokens = text ? text.split(' ').filter(Boolean) : [];
  const tokens: string[] = [];
  for (const tok of rawTokens) {
    if (SINGLE_WORD_FILLERS.has(tok)) continue;
    const mapped = TOKEN_SYNONYMS[tok] ?? removeDiacritics(tok);
    if (mapped) tokens.push(mapped);
  }

  const finalTokens = tokens.length > 0 ? tokens : rawTokens.map((t) => removeDiacritics(t)).filter(Boolean);
  if (finalTokens.length === 0) return vec;

  for (let i = 0; i < finalTokens.length; i++) {
    const tok = finalTokens[i];
    addHashedFeature(vec, `u:${tok}`, 3.0);
    const padded = `^${tok}$`;
    for (let j = 0; j <= padded.length - 3; j++) addHashedFeature(vec, `c:${padded.slice(j, j + 3)}`, 1.0);
    if (i + 1 < finalTokens.length) addHashedFeature(vec, `b:${tok}_${finalTokens[i + 1]}`, 0.35);
  }

  let normSq = 0;
  for (let i = 0; i < dims; i++) normSq += vec[i] * vec[i];
  const norm = Math.sqrt(normSq);
  if (norm === 0) return vec;
  for (let i = 0; i < dims; i++) vec[i] /= norm;
  return vec;
}
