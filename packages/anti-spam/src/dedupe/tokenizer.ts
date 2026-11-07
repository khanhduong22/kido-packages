import type { DedupeOptions, DedupeLanguage, TokenizeMode } from './types';

/**
 * Built-in Vietnamese stopwords for content deduplication.
 */
export const VIETNAMESE_STOPWORDS = new Set<string>([
  'và', 'hoặc', 'hay', 'của', 'là', 'có', 'cho', 'với', 'trong', 'được',
  'này', 'đó', 'kia', 'những', 'các', 'khi', 'để', 'tại', 'về', 'như',
  'đã', 'sẽ', 'đang', 'thì', 'mà', 'ra', 'vào', 'lại', 'nên', 'từ',
  'lên', 'xuống', 'rất', 'quá', 'bị', 'bởi', 'cũng', 'chỉ', 'một', 'hai',
  'ở', 'vì', 'do', 'nếu', 'thế', 'rồi', 'qua', 'theo', 'trên', 'dưới',
  'trước', 'sau', 'giữa', 'ai', 'gì', 'nào', 'đâu', 'sao', 'tôi', 'bạn',
  'anh', 'chị', 'em', 'họ', 'chúng_ta', 'chúng_tôi', 'hơn', 'nhất', 'cùng',
  'nhau', 'đều', 'luôn', 'ngay', 'tự', 'chính', 'việc', 'người', 'cái',
  'chiếc', 'điều', 'loại', 'thực_sự', 'hầu_như', 'tuy_nhiên', 'do_đó'
]);

/**
 * Built-in English stopwords for content deduplication.
 */
export const ENGLISH_STOPWORDS = new Set<string>([
  'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and',
  'any', 'are', 'aren\'t', 'as', 'at', 'be', 'because', 'been', 'before', 'being',
  'below', 'between', 'both', 'but', 'by', 'can', 'cannot', 'could', 'couldn\'t',
  'did', 'didn\'t', 'do', 'does', 'doesn\'t', 'doing', 'don\'t', 'down', 'during',
  'each', 'few', 'for', 'from', 'further', 'had', 'hadn\'t', 'has', 'hasn\'t',
  'have', 'haven\'t', 'having', 'he', 'her', 'here', 'hers', 'herself', 'him',
  'himself', 'his', 'how', 'i', 'if', 'in', 'into', 'is', 'isn\'t', 'it', 'its',
  'itself', 'just', 'me', 'more', 'most', 'my', 'myself', 'no', 'nor', 'not',
  'of', 'off', 'on', 'once', 'only', 'or', 'other', 'ought', 'our', 'ours',
  'ourselves', 'out', 'over', 'own', 'same', 'she', 'should', 'so', 'some',
  'such', 'than', 'that', 'the', 'their', 'theirs', 'them', 'themselves', 'then',
  'there', 'these', 'they', 'this', 'those', 'through', 'to', 'too', 'under',
  'until', 'up', 'very', 'was', 'wasn\'t', 'we', 'were', 'weren\'t', 'what',
  'when', 'where', 'which', 'while', 'who', 'whom', 'why', 'with', 'won\'t',
  'would', 'you', 'your', 'yours', 'yourself', 'yourselves'
]);

/**
 * Regex for stripping invisible and zero-width characters.
 */
const ZERO_WIDTH_REGEX = /[\u200B-\u200D\uFEFF\u202A-\u202E]/g;

/**
 * Regex for normalizing non-standard spaces (non-breaking spaces, em spaces, etc.).
 */
const NON_BREAKING_SPACE_REGEX = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g;

/**
 * Regex matching trailing salt numbers/hashtags commonly appended by spammers
 * (e.g. "vay tiền nhanh 01", "vay tiền nhanh 02", "alo 123", "#99").
 */
const TRAILING_SALT_REGEX = /(?:[\s#._-]+\d+)+$/u;

/**
 * Normalizes a text string for deduplication:
 * - NFC Unicode normalization.
 * - Strips zero-width and invisible control characters.
 * - Converts to lowercase.
 * - Collapses redundant whitespace.
 * - Optionally removes trailing random numbers/salt.
 */
export function normalizeText(text: string, options: DedupeOptions = {}): string {
  const {
    normalizeUnicode = true,
    stripTrailingNumbers = true,
    stripNumbers = false,
  } = options;

  if (!text) return '';

  let normalized = text;

  if (normalizeUnicode) {
    normalized = normalized.normalize('NFC');
  }

  // Remove invisible and zero-width characters without introducing spaces
  normalized = normalized.replace(ZERO_WIDTH_REGEX, '');

  // Normalize non-breaking and special spaces to standard space
  normalized = normalized.replace(NON_BREAKING_SPACE_REGEX, ' ');

  // Lowercase
  normalized = normalized.toLowerCase();

  // Strip trailing salt numbers if enabled
  if (stripTrailingNumbers) {
    normalized = normalized.replace(TRAILING_SALT_REGEX, '');
  }

  // Strip all numbers if enabled
  if (stripNumbers) {
    normalized = normalized.replace(/\b\d+\b/gu, ' ');
  }

  // Collapse multiple whitespaces
  normalized = normalized.replace(/\s+/g, ' ').trim();

  return normalized;
}

/**
 * Checks whether a word is in the stopword list according to chosen language.
 */
export function isStopword(word: string, language: DedupeLanguage = 'all'): boolean {
  const lower = word.toLowerCase();
  if (language === 'vi' || language === 'all') {
    if (VIETNAMESE_STOPWORDS.has(lower)) return true;
  }
  if (language === 'en' || language === 'all') {
    if (ENGLISH_STOPWORDS.has(lower)) return true;
  }
  return false;
}

/**
 * Generates word N-grams from a list of tokens.
 * If token count < n, falls back to n-1 down to unigram to avoid empty tokens.
 */
export function generateWordNgrams(words: string[], n = 2): string[] {
  if (words.length === 0) return [];
  if (n <= 1) return [...words];

  // If words length is less than n, generate up to word length
  const effectiveN = Math.min(n, words.length);
  const ngrams: string[] = [];

  for (let i = 0; i <= words.length - effectiveN; i++) {
    ngrams.push(words.slice(i, i + effectiveN).join(' '));
  }

  return ngrams;
}

/**
 * Generates character N-grams (e.g. 3-grams, 4-grams) from normalized text.
 * Especially effective for Vietnamese text and anti-spam fuzzy matching.
 */
export function generateCharNgrams(text: string, n = 3): string[] {
  if (!text) return [];
  if (text.length <= n) {
    return [text];
  }

  const ngrams: string[] = [];
  for (let i = 0; i <= text.length - n; i++) {
    ngrams.push(text.slice(i, i + n));
  }
  return ngrams;
}

/**
 * Tokenizes text and returns a Map of token -> accumulated weight.
 */
export function tokenize(text: string, options: DedupeOptions = {}): Map<string, number> {
  const {
    ngramSize = 2,
    charNgramSize = 3,
    mode = 'word',
    useStopwords = false,
    language = 'all',
    weights,
  } = options;

  const normalized = normalizeText(text, options);
  const tokenWeights = new Map<string, number>();

  if (!normalized) {
    return tokenWeights;
  }

  const addToken = (token: string, baseWeight: number) => {
    let customWeight = 1.0;
    if (typeof weights === 'function') {
      customWeight = weights(token);
    } else if (weights && typeof weights[token] === 'number') {
      customWeight = weights[token];
    }
    const finalWeight = baseWeight * customWeight;
    const current = tokenWeights.get(token) || 0;
    tokenWeights.set(token, current + finalWeight);
  };

  // 1. Word tokenization (for 'word' and 'mixed' modes)
  if (mode === 'word' || mode === 'mixed') {
    // Extract unicode words (supports Vietnamese diacritics and alphanumeric characters)
    const rawWords = normalized.match(/[\p{L}\p{N}]+/gu) || [];
    const filteredWords = useStopwords
      ? rawWords.filter(w => !isStopword(w, language))
      : rawWords;

    if (filteredWords.length > 0) {
      // Unigrams (weight: 1.0)
      for (const w of filteredWords) {
        addToken(`w1:${w}`, 1.0);
      }

      // Word N-grams (weight: 1.0 to balance evenly with unigrams)
      if (ngramSize > 1) {
        const wordNgrams = generateWordNgrams(filteredWords, ngramSize);
        for (const gram of wordNgrams) {
          addToken(`wn:${gram}`, 1.0);
        }
      }
    }
  }

  // 2. Character N-grams (for 'char' and 'mixed' modes)
  if (mode === 'char' || mode === 'mixed') {
    // Generate character n-grams across normalized text
    const charGrams = generateCharNgrams(normalized, charNgramSize);
    for (const cGram of charGrams) {
      addToken(`c:${cGram}`, 1.0);
    }
  }

  return tokenWeights;
}
