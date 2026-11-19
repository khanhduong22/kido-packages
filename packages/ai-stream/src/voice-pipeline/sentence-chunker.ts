/**
 * @kido/ai-stream/voice-pipeline - Streaming Sentence Chunker & Speech Sanitizer
 *
 * Harvests incremental sentence aggregation patterns from `livekit/agents`
 * (sentence tokenizer) and `pipecat-ai/pipecat` (SentenceAggregator) for low-TTFA
 * full-duplex voice assistants (GonnaCrash World 3 Level 25 `voice_assistant_latency`).
 *
 * Features:
 * - Bilingual Vietnamese + English sentence-boundary splitting.
 * - Zero false splits on abbreviations (`Mr.`, `Dr.`, `TP.`, `v.v.`, `e.g.`),
 *   decimals/currency (`1.2s`, `150.000đ`, `1,200 ms`), URLs/emails, and numbered lists.
 * - Optional `firstClauseCommaFlush` to dispatch the very first speakable clause
 *   on `,` / `;` / `—` for sub-800ms Time-to-First-Audio (TTFA).
 * - `sanitizeForSpeech(text)` stripping markdown syntax for natural TTS prosody.
 *
 * Invariant: 100% zero external runtime dependencies and zero sibling-slice imports.
 */

export type VoiceChunkBoundaryReason =
  | 'sentence_boundary'
  | 'first_clause_comma'
  | 'newline_boundary'
  | 'max_buffer'
  | 'flush';

export interface VoiceSentenceChunk {
  index: number;
  text: string;
  speakableText: string;
  reason: VoiceChunkBoundaryReason;
  isFirstClause: boolean;
  isFinal: boolean;
}

export interface VoiceSentenceChunkerOptions {
  /** Minimum character count before splitting on a mid-stream sentence boundary (default: 16). */
  minChunkChars?: number;
  /** Flush the first chunk early on `,`, `;`, `:`, `—`, `–` for low TTFA (default: true). */
  firstClauseCommaFlush?: boolean;
  /** Minimum characters required before early first-clause comma flush (default: 16). */
  firstClauseMinChars?: number;
  /** Maximum buffered characters before forcing a safe clause/word boundary split (default: 220). */
  maxBufferChars?: number;
  /** Whether to sanitize markdown out of `speakableText` (default: true). */
  sanitize?: boolean;
  /** Additional lowercase abbreviation stems (without trailing dot) to protect from splits. */
  customAbbreviations?: readonly string[];
}

export const DEFAULT_VOICE_ABBREVIATIONS: readonly string[] = Object.freeze([
  // English titles, units, dates & scholarly stems
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc',
  'eg', 'ie', 'e.g', 'i.e', 'fig', 'no', 'vol', 'inc', 'ltd', 'co',
  'corp', 'dept', 'est', 'approx', 'jan', 'feb', 'mar', 'apr', 'jun',
  'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec', 'u.s', 'u.k',
  'a.m', 'p.m', 'ph.d', 'm.d', 'b.s', 'm.s',
  // Vietnamese administrative, academic, business & everyday stems
  'tp', 'q', 'p', 'tx', 'tt', 'h', 'x', 'ths', 'ts', 'pgs', 'gs',
  'bs', 'ks', 'cn', 'vv', 'v.v', 'vd', 'tr', 'sđt', 'tnhh', 'cp',
  'vnđ', 'vnd', 'usd', 'kv', 'số',
]);

interface TextSpan {
  start: number;
  end: number;
}

const PROTECTED_SPAN_REGEX =
  /(?:https?:\/\/[^\s<>()]+|www\.[^\s<>()]+|[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}|\b[a-zA-Z0-9-]+\.(?:com|io|vn|ai|dev|org|net|edu|gov|app)\b)/gi;

const CLOSING_PUNCTUATION = new Set(['"', "'", '”', '’', ')', ']', '}']);
const STRONG_TERMINATORS = new Set(['.', '!', '?', '…']);
const SOFT_CLAUSE_BREAKS = new Set([',', ';', ':', '—', '–']);

/**
 * Strips markdown formatting, code fences, links, bare URLs, and noisy symbols
 * so TTS engines synthesize clean, natural Vietnamese and English speech.
 */
export function sanitizeForSpeech(text: string): string {
  if (!text) return '';

  let cleaned = text;
  // 1. Strip fenced code blocks completely so TTS never reads raw syntax braces
  cleaned = cleaned.replace(/```[\s\S]*?```/g, ' ');
  cleaned = cleaned.replace(/```[^\n]*/g, ' ');
  // 2. Convert markdown images ![alt](url) and links [label](url) to spoken text
  cleaned = cleaned.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  cleaned = cleaned.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  // 3. Strip bare URLs while preserving trailing sentence punctuation if attached
  cleaned = cleaned.replace(
    /(?:https?:\/\/|www\.)[^\s<>()]+/gi,
    (match) => {
      const trailing = match.match(/[.,!?;:]+$/);
      return trailing ? trailing[0] : '';
    }
  );
  // 4. Strip inline code backticks while preserving inner technical tokens
  cleaned = cleaned.replace(/`([^`]+)`/g, '$1');
  // 5. Strip markdown headings, blockquotes, horizontal rules, and list bullets
  cleaned = cleaned.replace(/(^|\n)[ \t]*#{1,6}[ \t]+/g, '$1');
  cleaned = cleaned.replace(/(^|\n)[ \t]*>[ \t]?/g, '$1');
  cleaned = cleaned.replace(/(^|\n)[ \t]*(?:[-*_]{3,})[ \t]*(?=\n|$)/g, '$1');
  cleaned = cleaned.replace(/(^|\n)[ \t]*[-*+•][ \t]+/g, '$1');
  // 6. Strip bold / italic / strikethrough markers without touching snake_case identifiers
  cleaned = cleaned.replace(/\*\*([^*]+)\*\*/g, '$1');
  cleaned = cleaned.replace(/__([^_]+)__/g, '$1');
  cleaned = cleaned.replace(/~~([^~]+)~~/g, '$1');
  cleaned = cleaned.replace(/(^|[\s([{"'“‘])\*([^*\n]+)\*(?=$|[\s.,!?;:)\]}"'”’])/g, '$1$2');
  cleaned = cleaned.replace(/(^|[\s([{"'“‘])_([^_\n]+)_(?=$|[\s.,!?;:)\]}"'”’])/g, '$1$2');
  // 7. Remove stray markdown table pipes, lingering emphasis/hash characters
  cleaned = cleaned.replace(/[|#*~`]/g, ' ');
  // 8. Collapse whitespace and tighten spaces before terminal punctuation
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  cleaned = cleaned.replace(/\s+([.,!?;:])/g, '$1');

  return cleaned;
}

function findProtectedSpans(buffer: string): TextSpan[] {
  const spans: TextSpan[] = [];
  PROTECTED_SPAN_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PROTECTED_SPAN_REGEX.exec(buffer)) !== null) {
    let end = match.index + match[0].length;
    // Do not absorb trailing sentence punctuation after a URL/domain
    while (end > match.index && /[.,!?;:)\]]/.test(buffer[end - 1]!)) {
      end -= 1;
    }
    if (end > match.index) {
      spans.push({ start: match.index, end });
    }
  }
  return spans;
}

function isInsideSpan(idx: number, spans: readonly TextSpan[]): boolean {
  for (const span of spans) {
    if (idx >= span.start && idx < span.end) return true;
  }
  return false;
}

function extractStemBeforeDot(buffer: string, dotIdx: number): { stem: string; startIdx: number } {
  let start = dotIdx - 1;
  while (start >= 0 && /[\p{L}\p{N}.]/u.test(buffer[start]!)) {
    start -= 1;
  }
  const stemStart = start + 1;
  return { stem: buffer.slice(stemStart, dotIdx), startIdx: stemStart };
}

function isNumberedListMarker(buffer: string, stem: string, stemStart: number): boolean {
  if (!/^\d{1,3}$/.test(stem)) return false;
  const prefix = buffer.slice(0, stemStart);
  return /(?:^|[\n:;•\-]\s*|\*\*\s*)$/.test(prefix);
}

function isAbbreviationDot(
  buffer: string,
  dotIdx: number,
  abbreviations: ReadonlySet<string>
): boolean {
  const { stem, startIdx } = extractStemBeforeDot(buffer, dotIdx);
  if (!stem) return false;
  const normalized = stem.toLowerCase();
  if (abbreviations.has(normalized)) return true;
  // Multi-dot initialisms like "e.g", "i.e", "v.v", "u.s", "a.m", "p.m"
  if (/^(?:[\p{L}]\.){1,3}[\p{L}]$/u.test(normalized)) return true;
  if (isNumberedListMarker(buffer, stem, startIdx)) return true;
  return false;
}

function isDecimalOrThousandsPunctuation(buffer: string, idx: number): boolean {
  const ch = buffer[idx];
  if (ch !== '.' && ch !== ',') return false;
  const next = buffer[idx + 1];
  const prev = idx > 0 ? buffer[idx - 1] : '';
  // e.g. 1.2s, 150.000đ, 1,200 ms, .5s
  if (next !== undefined && /\d/.test(next)) {
    if (ch === '.' || (prev !== undefined && /\d/.test(prev))) {
      return true;
    }
  }
  return false;
}

/**
 * Stateful streaming sentence-boundary chunker for full-duplex voice pipelines.
 * Feed LLM deltas via `push(delta)` and call `flush()` at stream end.
 */
export class VoiceSentenceChunker {
  private readonly minChunkChars: number;
  private readonly firstClauseCommaFlush: boolean;
  private readonly firstClauseMinChars: number;
  private readonly maxBufferChars: number;
  private readonly sanitize: boolean;
  private readonly abbreviations: ReadonlySet<string>;

  private buffer = '';
  private emittedCount = 0;

  constructor(options: VoiceSentenceChunkerOptions = {}) {
    this.minChunkChars = Math.max(1, options.minChunkChars ?? 16);
    this.firstClauseCommaFlush = options.firstClauseCommaFlush ?? true;
    this.firstClauseMinChars = Math.max(1, options.firstClauseMinChars ?? 16);
    this.maxBufferChars = Math.max(32, options.maxBufferChars ?? 220);
    this.sanitize = options.sanitize ?? true;

    const abbrevSet = new Set<string>(DEFAULT_VOICE_ABBREVIATIONS);
    if (options.customAbbreviations) {
      for (const item of options.customAbbreviations) {
        const clean = item.trim().replace(/\.$/, '').toLowerCase();
        if (clean) abbrevSet.add(clean);
      }
    }
    this.abbreviations = abbrevSet;
  }

  /** Appends an incoming LLM token delta and returns any ready speakable chunks. */
  push(delta: string): VoiceSentenceChunk[] {
    if (!delta) return [];
    this.buffer += delta;

    const emitted: VoiceSentenceChunk[] = [];
    while (this.buffer.length > 0) {
      const split = this.findNextBoundary();
      if (!split) break;

      const rawSlice = this.buffer.slice(0, split.cutIdx);
      this.buffer = this.buffer.slice(split.cutIdx).replace(/^[ \t]+/, '');

      const chunk = this.buildChunk(rawSlice, split.reason, false);
      if (chunk) emitted.push(chunk);
    }

    return emitted;
  }

  /** Flushes any remaining buffered text at the end of an LLM turn. */
  flush(): VoiceSentenceChunk[] {
    const remaining = this.buffer;
    this.buffer = '';
    const chunk = this.buildChunk(remaining, 'flush', true);
    return chunk ? [chunk] : [];
  }

  /** Resets internal state for a new conversation turn or after barge-in. */
  reset(): void {
    this.buffer = '';
    this.emittedCount = 0;
  }

  getPendingBuffer(): string {
    return this.buffer;
  }

  getEmittedCount(): number {
    return this.emittedCount;
  }

  private buildChunk(
    rawSlice: string,
    reason: VoiceChunkBoundaryReason,
    isFinal: boolean
  ): VoiceSentenceChunk | null {
    const text = rawSlice.trim();
    if (!text) return null;

    const speakableText = this.sanitize ? sanitizeForSpeech(text) : text;
    if (!speakableText) return null;

    const index = this.emittedCount;
    this.emittedCount += 1;

    return {
      index,
      text,
      speakableText,
      reason,
      isFirstClause: index === 0,
      isFinal,
    };
  }

  private findNextBoundary(): { cutIdx: number; reason: VoiceChunkBoundaryReason } | null {
    const buf = this.buffer;
    const spans = findProtectedSpans(buf);
    const allowCommaFlush = this.emittedCount === 0 && this.firstClauseCommaFlush;

    for (let i = 0; i < buf.length; i += 1) {
      const ch = buf[i]!;

      // 1. Newline boundary (paragraph or bullet completion)
      if (ch === '\n') {
        const candidate = buf.slice(0, i).trim();
        if (candidate.length >= this.minChunkChars) {
          return { cutIdx: i + 1, reason: 'newline_boundary' };
        }
        continue;
      }

      if (isInsideSpan(i, spans)) continue;

      // 2. Strong sentence boundary (. ! ? …) followed by lookahead whitespace/newline
      if (STRONG_TERMINATORS.has(ch)) {
        // Wait if ellipsis or repeated punctuation is still streaming ("...", "?!")
        if (i + 1 < buf.length && STRONG_TERMINATORS.has(buf[i + 1]!)) continue;
        if (isDecimalOrThousandsPunctuation(buf, i)) continue;
        if (ch === '.' && isAbbreviationDot(buf, i, this.abbreviations)) continue;

        let endIdx = i + 1;
        while (endIdx < buf.length && CLOSING_PUNCTUATION.has(buf[endIdx]!)) {
          endIdx += 1;
        }
        // Require trailing whitespace so split-chunk decimals ("1." + "2s") never false-split
        if (endIdx >= buf.length || !/\s/.test(buf[endIdx]!)) continue;

        const candidate = buf.slice(0, endIdx).trim();
        if (candidate.length >= this.minChunkChars) {
          return { cutIdx: endIdx, reason: 'sentence_boundary' };
        }
        continue;
      }

      // 3. First-clause early comma / em-dash flush for low TTFA
      if (allowCommaFlush && SOFT_CLAUSE_BREAKS.has(ch)) {
        if (isDecimalOrThousandsPunctuation(buf, i)) continue;
        const endIdx = i + 1;
        if (endIdx >= buf.length || !/\s/.test(buf[endIdx]!)) continue;

        const candidate = buf.slice(0, endIdx).trim();
        if (candidate.length >= this.firstClauseMinChars) {
          return { cutIdx: endIdx, reason: 'first_clause_comma' };
        }
      }
    }

    // 4. Max-buffer backpressure safeguard for run-on text without punctuation
    if (buf.length >= this.maxBufferChars) {
      const minSafe = Math.floor(this.maxBufferChars * 0.4);
      // Prefer a soft clause boundary within [minSafe, maxBufferChars]
      for (let i = this.maxBufferChars - 1; i >= minSafe; i -= 1) {
        if (
          SOFT_CLAUSE_BREAKS.has(buf[i]!) &&
          !isInsideSpan(i, spans) &&
          !isDecimalOrThousandsPunctuation(buf, i) &&
          i + 1 < buf.length &&
          /\s/.test(buf[i + 1]!)
        ) {
          return { cutIdx: i + 1, reason: 'max_buffer' };
        }
      }
      // Fallback to last whitespace boundary
      for (let i = this.maxBufferChars - 1; i >= minSafe; i -= 1) {
        if (/\s/.test(buf[i]!) && !isInsideSpan(i, spans)) {
          return { cutIdx: i + 1, reason: 'max_buffer' };
        }
      }
      return { cutIdx: this.maxBufferChars, reason: 'max_buffer' };
    }

    return null;
  }
}

export const createVoiceSentenceChunker = (
  options: VoiceSentenceChunkerOptions = {}
): VoiceSentenceChunker => new VoiceSentenceChunker(options);
