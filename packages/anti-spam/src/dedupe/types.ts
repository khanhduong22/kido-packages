/**
 * 64-bit SimHash representation.
 * Can be a 16-character hexadecimal string (e.g. "a1b2c3d4e5f60718") or a 64-bit BigInt.
 */
export type SimHash64 = string;

/**
 * Union type allowing either a hex string (16 characters) or a 64-bit BigInt
 * wherever a SimHash fingerprint is accepted.
 */
export type SimHashInput = string | bigint;

/**
 * Tokenization and feature extraction mode:
 * - 'word': splits text into words and generates word n-grams.
 * - 'char': generates character n-grams (e.g., 3-grams) across text.
 * - 'mixed': combines word n-grams and character n-grams for maximum robustness
 *            against word reordering, misspellings, and salt digits.
 */
export type TokenizeMode = 'word' | 'char' | 'mixed';

/**
 * Supported language for built-in stopwords.
 */
export type DedupeLanguage = 'vi' | 'en' | 'all';

/**
 * Options to configure text normalization, tokenization, and SimHash calculation.
 */
export interface DedupeOptions {
  /**
   * Word n-gram size.
   * Default: 2 (bigrams) for word/mixed modes.
   */
  ngramSize?: number;

  /**
   * Character n-gram size for character/mixed modes.
   * Default: 3 (trigrams) for char/mixed modes.
   */
  charNgramSize?: number;

  /**
   * Tokenization strategy: 'word' | 'char' | 'mixed'.
   * Default: 'word' (word unigrams + bigrams for document deduplication).
   */
  mode?: TokenizeMode;

  /**
   * Whether to filter out common stopwords.
   * Default: false (preserves natural sentence structure).
   */
  useStopwords?: boolean;

  /**
   * Language selector for built-in stopwords.
   * Default: 'all' (both Vietnamese and English).
   */
  language?: DedupeLanguage;

  /**
   * Custom token weighting:
   * - A dictionary mapping token strings to positive weights.
   * - Or a function `(token: string) => number` returning a weight.
   */
  weights?: Record<string, number> | ((token: string) => number);

  /**
   * Whether to normalize Unicode to NFC format and strip control/zero-width chars.
   * Default: true.
   */
  normalizeUnicode?: boolean;

  /**
   * Whether to strip punctuation and non-alphanumeric symbols.
   * Default: true.
   */
  stripPunctuation?: boolean;

  /**
   * Whether to completely strip all numeric digits.
   * Default: false.
   */
  stripNumbers?: boolean;

  /**
   * Whether to strip trailing salt numbers (e.g. "vay tiền nhanh 01" -> "vay tiền nhanh").
   * Default: true.
   */
  stripTrailingNumbers?: boolean;
}

/**
 * Match result when querying near-duplicate documents.
 */
export interface NearDuplicateMatch {
  /** Document unique identifier */
  id: string;

  /**
   * Similarity coefficient between 0.0 and 1.0.
   * Computed as: 1 - (hammingDistance / 64).
   */
  similarity: number;

  /**
   * Bitwise Hamming distance between 0 and 64.
   * Number of differing bits between the two 64-bit fingerprints.
   */
  hammingDistance: number;

  /**
   * The 16-character hexadecimal fingerprint of the matched document.
   */
  fingerprint: string;

  /**
   * Optional user-defined metadata associated with the stored document.
   */
  metadata?: Record<string, unknown>;
}

/**
 * Search options for the NearDuplicateIndex table.
 */
export interface IndexSearchOptions {
  /**
   * Maximum allowed Hamming distance.
   * Default: 3 (which corresponds to ~95.3% similarity).
   * Range: 0 to 64.
   */
  maxHammingDistance?: number;

  /**
   * Minimum required similarity between 0.0 and 1.0.
   * If specified, takes precedence or sets maxHammingDistance = floor((1 - minSimilarity) * 64).
   */
  minSimilarity?: number;

  /**
   * Maximum number of matches to return.
   * Default: 50.
   */
  limit?: number;

  /**
   * If true, performs an exhaustive linear scan across all documents.
   * Useful when maxHammingDistance > 3 and absolute 100% recall is desired.
   * Default: false (uses the O(1) multi-block Pigeonhole index).
   */
  exhaustive?: boolean;
}

/**
 * Options to initialize NearDuplicateIndex.
 */
export interface NearDuplicateIndexOptions {
  /**
   * Number of 16-bit blocks for Pigeonhole indexing.
   * Default: 4 (64 bits = 4 * 16 bits).
   */
  blocksCount?: number;

  /**
   * Default DedupeOptions applied when inserting or querying raw text.
   */
  defaultDedupeOptions?: DedupeOptions;

  /**
   * Default max Hamming distance for queries if not explicitly passed.
   * Default: 3.
   */
  defaultMaxHammingDistance?: number;
}

/**
 * Internal record for an indexed document.
 */
export interface IndexedDocument {
  id: string;
  fingerprint: string;
  fingerprintBigInt: bigint;
  metadata?: Record<string, unknown>;
}
