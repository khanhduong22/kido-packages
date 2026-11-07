import { TextCanonicalization } from './types';

/**
 * Common Cyrillic and Greek lookalike homoglyphs mapped to their Latin equivalents.
 */
export const HOMOGLYPH_MAP: Record<string, string> = {
  // Cyrillic lowercase
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'j',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'p',
  с: 'c',
  т: 't',
  у: 'y',
  ф: 'f',
  х: 'x',
  ц: 'c',
  ч: 'ch',
  ш: 'sh',
  щ: 'sh',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
  і: 'i',
  ї: 'i',
  ј: 'j',

  // Cyrillic uppercase
  А: 'A',
  В: 'B',
  Е: 'E',
  К: 'K',
  М: 'M',
  Н: 'H',
  О: 'O',
  Р: 'P',
  С: 'C',
  Т: 'T',
  У: 'Y',
  Х: 'X',

  // Greek lowercase
  α: 'a',
  β: 'b',
  γ: 'g',
  δ: 'd',
  ε: 'e',
  ζ: 'z',
  η: 'n',
  θ: 'th',
  ι: 'i',
  κ: 'k',
  λ: 'l',
  μ: 'm',
  ν: 'v',
  ξ: 'x',
  ο: 'o',
  π: 'p',
  ρ: 'p',
  σ: 's',
  τ: 't',
  υ: 'u',
  φ: 'f',
  χ: 'x',
  ψ: 'ps',
  ω: 'w',

  // Greek uppercase
  Α: 'A',
  Β: 'B',
  Ε: 'E',
  Ζ: 'Z',
  Η: 'H',
  Ι: 'I',
  Κ: 'K',
  Μ: 'M',
  Ν: 'N',
  Ο: 'O',
  Ρ: 'P',
  Τ: 'T',
  Υ: 'Y',
  Χ: 'X',
};

// Regex matching zero-width, invisible formatting, and non-printable spaces
const ZERO_WIDTH_REGEX =
  /[\u200B-\u200D\uFEFF\u00AD\u2060\u180E\u2000-\u200A\u202F\u205F\u3164\uFFA0]/g;

// Regex matching characters that can be homoglyphs
const HOMOGLYPH_REGEX = /[а-яА-ЯёЁіїјα-ωΑ-Ω]/g;

export class TextNormalizer {
  /**
   * Strip zero-width, invisible, and format-only characters.
   */
  stripZeroWidth(text: string): string {
    if (!text) return '';
    return text.replace(ZERO_WIDTH_REGEX, '');
  }

  /**
   * Standardize Unicode into composed (NFC) form for consistent Vietnamese diacritics.
   * Converts decomposed NFD diacritics into precomposed NFC characters.
   */
  normalizeUnicode(text: string): string {
    if (!text) return '';
    return text.normalize('NFC');
  }

  /**
   * Replace visually confusable Cyrillic and Greek homoglyphs with standard Latin equivalents.
   */
  foldHomoglyphs(text: string): string {
    if (!text) return '';
    return text.replace(HOMOGLYPH_REGEX, (char) => HOMOGLYPH_MAP[char] || char);
  }

  /**
   * Collapse 3 or more repeated identical characters into 2 (e.g. "aaaaaa" -> "aa", "!!!!!!" -> "!").
   */
  collapseRepeated(text: string): string {
    if (!text) return '';
    return text.replace(/(.)\1{2,}/gu, '$1$1');
  }

  /**
   * Normalize common leetspeak substitutions and inter-letter punctuation/spaces
   * (e.g. "b.á.n", "b-á-n", "z a l o", "@" -> "a", "$" -> "s").
   */
  normalizeLeetspeak(text: string): string {
    if (!text) return '';

    // Standard character substitutions: @ -> a, $ -> s
    let result = text.replace(/@/g, 'a').replace(/\$/g, 's');

    // 1. Collapse punctuation-separated single letters (e.g., "b.á.n", "b-á-n", "d.m", "đ.á.n.h")
    // Matches single letters separated by punctuation characters: . - _ ~ *
    result = result.replace(
      /(?<!\p{L})(\p{L}(?:[.\-_~*]+\p{L})+)(?!\p{L})/gu,
      (match) => match.replace(/[.\-_~*]+/g, ''),
    );

    // 2. Collapse space-separated single letters (e.g., "z a l o" -> "zalo", "b á n" -> "bán", "t e l e" -> "tele")
    // Matches 3 to 8 single characters separated by spaces
    result = result.replace(
      /(?<!\p{L})(\p{L}(?:[ ]+\p{L}){2,7})(?!\p{L})/gu,
      (match) => match.replace(/[ ]+/g, ''),
    );

    return result;
  }

  /**
   * Full canonicalization pipeline:
   * Returns:
   * - original: raw unmodified text
   * - normalized: text with zero-width stripped, homoglyphs folded, unicode NFC, repeated chars collapsed
   * - leetNormalized: text with leetspeak decoded and separated letters joined
   * - compact: normalized text with all whitespace and punctuation removed (for continuous pattern matching)
   */
  canonicalize(text: string): TextCanonicalization {
    if (!text) {
      return {
        original: '',
        normalized: '',
        leetNormalized: '',
        compact: '',
      };
    }

    const zeroStripped = this.stripZeroWidth(text);
    const unicodeNorm = this.normalizeUnicode(zeroStripped);
    const homoglyphFolded = this.foldHomoglyphs(unicodeNorm);
    const collapsed = this.collapseRepeated(homoglyphFolded);
    const leetNormalized = this.normalizeLeetspeak(collapsed);
    const compact = leetNormalized
      .toLowerCase()
      .replace(/[\s\p{P}\p{S}]/gu, '');

    return {
      original: text,
      normalized: collapsed,
      leetNormalized,
      compact,
    };
  }
}
