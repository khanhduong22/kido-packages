/**
 * @kido/ai-stream - Streaming Partial JSON Parser & Progressive Product Card Extractor
 *
 * Implements GonnaCrash World 3 Level 19 (`ai_feature_launch`) streaming structured output:
 * 1. `parsePartialJson<T>(rawBuffer)`: Lexer state machine stripping ```json fences, handling
 *    escaped quotes/unicode/Vietnamese, dropping incomplete trailing keys/colons/commas,
 *    and auto-closing strings and `{`/`[` containers in LIFO order.
 * 2. `StreamingProductCardExtractor<TCard>`: Emits each completed product card object as soon
 *    as its `{...}` closes inside the streamed array (Perplexity Product Cards pattern).
 *
 * Invariant: 100% zero external runtime dependencies and zero imports from sibling slices.
 */

export interface PartialJsonParseResult<T = unknown> {
  ok: boolean; value: T | undefined; isComplete: boolean; repairedJson: string;
  strippedMarkdownFence: boolean; autoClosedCount: number; droppedIncompleteTail: boolean; error?: string;
}

type LexFrame =
  | { kind: '{'; expect: 'key_or_end' | 'colon' | 'value' | 'comma_or_end'; safeEnd: number }
  | { kind: '['; expect: 'value_or_end' | 'comma_or_end'; safeEnd: number };

const isWs = (ch: string): boolean => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
const skipWs = (src: string, idx: number): number => { while (idx < src.length && isWs(src[idx])) idx++; return idx; };

function stripFence(raw: string): { src: string; stripped: boolean; fenceOnly: boolean } {
  const start = skipWs(raw, 0);
  if (!raw.startsWith('```', start)) return { src: raw, stripped: false, fenceOnly: false };
  const nlIdx = raw.indexOf('\n', start + 3);
  return nlIdx === -1 ? { src: '', stripped: true, fenceOnly: true } : { src: raw.slice(nlIdx + 1), stripped: true, fenceOnly: false };
}

function scanJsonString(src: string, openQuoteIdx: number): { closed: boolean; endIdx: number; safeCutIdx: number } {
  let escaped = false, escapeStart = -1, uHexNeed = 0;
  for (let i = openQuoteIdx + 1; i < src.length; i++) {
    const ch = src[i];
    if (uHexNeed > 0) {
      if (/[0-9a-fA-F]/.test(ch)) { uHexNeed--; if (uHexNeed === 0) escapeStart = -1; }
      else return { closed: false, endIdx: i, safeCutIdx: escapeStart };
      continue;
    }
    if (escaped) { if (ch === 'u') uHexNeed = 4; else escapeStart = -1; escaped = false; continue; }
    if (ch === '\\') { escaped = true; escapeStart = i; continue; }
    if (ch === '"') return { closed: true, endIdx: i + 1, safeCutIdx: i + 1 };
  }
  const incomplete = (escaped || uHexNeed > 0) && escapeStart !== -1;
  return { closed: false, endIdx: src.length, safeCutIdx: incomplete ? escapeStart : src.length };
}

function scanNumberToken(src: string, start: number): { endIdx: number; validPrefixEnd: number; hasDigits: boolean; incompleteAtEof: boolean } {
  const rest = src.slice(start);
  if (rest === '-') return { endIdx: src.length, validPrefixEnd: start, hasDigits: false, incompleteAtEof: true };
  const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest);
  if (!m) return { endIdx: start, validPrefixEnd: start, hasDigits: false, incompleteAtEof: false };
  const validPrefixEnd = start + m[0].length;
  const tail = src.slice(validPrefixEnd);
  if (tail.length > 0 && /^(?:\.|(?:\.\d+)?[eE][+-]?)$/.test(tail)) {
    return { endIdx: src.length, validPrefixEnd, hasDigits: true, incompleteAtEof: true };
  }
  return { endIdx: validPrefixEnd, validPrefixEnd, hasDigits: true, incompleteAtEof: false };
}

function scanLiteralToken(src: string, start: number): { kind: 'complete' | 'partial_eof' | 'invalid'; endIdx: number } {
  for (const lit of ['true', 'false', 'null']) {
    if (src.startsWith(lit, start)) return { kind: 'complete', endIdx: start + lit.length };
    const rem = src.slice(start);
    if (rem.length > 0 && rem.length < lit.length && lit.startsWith(rem)) return { kind: 'partial_eof', endIdx: src.length };
  }
  return { kind: 'invalid', endIdx: start };
}

function failResult<T>(error: string, strippedMarkdownFence: boolean, repairedJson = ''): PartialJsonParseResult<T> {
  return { ok: false, value: undefined, isComplete: false, repairedJson, strippedMarkdownFence, autoClosedCount: 0, droppedIncompleteTail: false, error };
}

/**
 * Parses streamed/truncated JSON buffers by stripping markdown fences, dropping incomplete
 * trailing keys/colons/commas, and closing open strings and `{`/`[` containers in LIFO order.
 */
export function parsePartialJson<T = unknown>(rawBuffer: string): PartialJsonParseResult<T> {
  const { src, stripped, fenceOnly } = stripFence(rawBuffer ?? '');
  if (fenceOnly) return failResult<T>('empty_markdown_fence', stripped);
  let pos = skipWs(src, 0);
  if (pos >= src.length) return failResult<T>('empty_buffer', stripped);

  const rootStart = pos;
  const stack: LexFrame[] = [];
  let cutIndex = src.length;
  let closeOpenString = false;
  let droppedIncompleteTail = false;
  let rootClosed = false;

  const markParentCompleted = (endPos: number): void => {
    if (stack.length > 0) {
      const parent = stack[stack.length - 1];
      parent.safeEnd = endPos;
      parent.expect = 'comma_or_end';
    }
  };

  const closeTopContainer = (): boolean => {
    stack.pop();
    pos++;
    if (stack.length === 0) { rootClosed = true; cutIndex = pos; return true; }
    markParentCompleted(pos);
    return false;
  };

  const dropToSafeTail = (safeEnd: number): void => { cutIndex = safeEnd; droppedIncompleteTail = true; };

  const enterValueAt = (idx: number): boolean => {
    const ch = src[idx];
    if (ch === '{') { stack.push({ kind: '{', expect: 'key_or_end', safeEnd: idx + 1 }); pos = idx + 1; return true; }
    if (ch === '[') { stack.push({ kind: '[', expect: 'value_or_end', safeEnd: idx + 1 }); pos = idx + 1; return true; }
    if (ch === '"') {
      const str = scanJsonString(src, idx);
      if (str.closed) { pos = str.endIdx; markParentCompleted(str.endIdx); return true; }
      cutIndex = str.safeCutIdx;
      closeOpenString = true;
      if (str.safeCutIdx < src.length) droppedIncompleteTail = true;
      return false;
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      const num = scanNumberToken(src, idx);
      if (!num.hasDigits) { if (num.incompleteAtEof && stack.length > 0) dropToSafeTail(stack[stack.length - 1].safeEnd); return false; }
      if (num.incompleteAtEof) { cutIndex = num.validPrefixEnd; droppedIncompleteTail = num.validPrefixEnd < src.length; return false; }
      pos = num.endIdx;
      markParentCompleted(num.endIdx);
      return true;
    }
    const lit = scanLiteralToken(src, idx);
    if (lit.kind === 'complete') { pos = lit.endIdx; markParentCompleted(lit.endIdx); return true; }
    if (lit.kind === 'partial_eof' && stack.length > 0) dropToSafeTail(stack[stack.length - 1].safeEnd);
    return false;
  };

  const rootOpened = enterValueAt(pos);
  if (!rootOpened && !closeOpenString && cutIndex === src.length) return failResult<T>('invalid_json_root', stripped);
  if (rootOpened && stack.length === 0) { rootClosed = true; cutIndex = pos; }

  while (stack.length > 0 && pos < src.length) {
    pos = skipWs(src, pos);
    if (pos >= src.length) break;
    const top = stack[stack.length - 1];
    const ch = src[pos];
    if (top.expect === 'comma_or_end') {
      const closeCh = top.kind === '{' ? '}' : ']';
      if (ch === ',') { pos++; top.expect = top.kind === '{' ? 'key_or_end' : 'value_or_end'; continue; }
      if (ch === closeCh) { if (closeTopContainer()) break; continue; }
      return failResult<T>(`unexpected_token:${ch}`, stripped);
    }

    if (top.kind === '{') {
      if (top.expect === 'key_or_end') {
        if (ch === '}') { if (closeTopContainer()) break; continue; }
        if (ch !== '"') { dropToSafeTail(top.safeEnd); break; }
        const keyScan = scanJsonString(src, pos);
        if (!keyScan.closed) { dropToSafeTail(top.safeEnd); break; }
        pos = keyScan.endIdx;
        top.expect = 'colon';
        continue;
      }
      if (top.expect === 'colon') {
        if (ch === ':') { pos++; top.expect = 'value'; continue; }
        dropToSafeTail(top.safeEnd);
        break;
      }
      if (!enterValueAt(pos)) break;
      continue;
    }

    if (ch === ']') { if (closeTopContainer()) break; continue; }
    if (!enterValueAt(pos)) break;
  }

  if (stack.length > 0 && pos >= src.length && cutIndex === src.length) {
    const top = stack[stack.length - 1];
    if (top.expect !== 'comma_or_end') {
      cutIndex = top.safeEnd;
      if (src.slice(top.safeEnd).trim().length > 0) droppedIncompleteTail = true;
    }
  }

  let repairedJson = src.slice(rootStart, cutIndex);
  let autoClosedCount = 0;
  if (closeOpenString) { repairedJson += '"'; autoClosedCount++; }
  for (let i = stack.length - 1; i >= 0; i--) { repairedJson += stack[i].kind === '{' ? '}' : ']'; autoClosedCount++; }

  try {
    const value = JSON.parse(repairedJson) as T;
    return { ok: true, value, isComplete: rootClosed && autoClosedCount === 0 && !droppedIncompleteTail, repairedJson, strippedMarkdownFence: stripped, autoClosedCount, droppedIncompleteTail };
  } catch (err) {
    return failResult<T>(err instanceof Error ? err.message : String(err), stripped, repairedJson);
  }
}

export interface StreamingProductCardExtractorOptions<TCard> {
  arrayKeys?: readonly string[];
  onCard?: (card: TCard, index: number) => void;
  validateCard?: (candidate: unknown) => candidate is TCard;
}

/**
 * Incrementally scans streamed JSON tokens and emits each product card object as soon
 * as its `{...}` closes inside the target card array, without waiting for full response EOF.
 */
export class StreamingProductCardExtractor<TCard = Record<string, unknown>> {
  private readonly arrayKeys?: ReadonlySet<string>;
  private readonly onCard?: (card: TCard, index: number) => void;
  private readonly validateCard?: (candidate: unknown) => candidate is TCard;
  private readonly cards: TCard[] = [];
  private s = StreamingProductCardExtractor.freshState();

  private static freshState() {
    return {
      rawBuffer: '', scanPos: 0, fenceResolved: false, depth: 0, inString: false, escaped: false,
      stringStart: -1, lastClosedKey: null as string | null, awaitingColon: false,
      pendingArrayKey: null as string | null, targetArrayDepth: null as number | null,
      sawObjectInArray: false, arrayFinished: false, itemStart: -1,
    };
  }

  constructor(options: StreamingProductCardExtractorOptions<TCard> = {}) {
    this.arrayKeys = options.arrayKeys ? new Set(options.arrayKeys) : undefined;
    this.onCard = options.onCard;
    this.validateCard = options.validateCard;
  }

  private tryEmitItem(rawItem: string, out: TCard[]): void {
    try {
      const parsed = JSON.parse(rawItem) as unknown;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return;
      if (this.validateCard && !this.validateCard(parsed)) return;
      const idx = this.cards.length;
      this.cards.push(parsed as TCard);
      out.push(parsed as TCard);
      this.onCard?.(parsed as TCard, idx);
    } catch {
      // Skip malformed item slice cleanly
    }
  }

  private resolveFence(): boolean {
    const s = this.s;
    const start = skipWs(s.rawBuffer, 0);
    if (start >= s.rawBuffer.length) return false;
    if (s.rawBuffer.startsWith('```', start)) {
      const nlIdx = s.rawBuffer.indexOf('\n', start + 3);
      if (nlIdx === -1) return false;
      s.scanPos = nlIdx + 1;
    } else {
      s.scanPos = start;
    }
    s.fenceResolved = true;
    return true;
  }

  public pushChunk(delta: string): TCard[] {
    if (!delta) return [];
    const s = this.s;
    s.rawBuffer += delta;
    const emitted: TCard[] = [];
    if (!s.fenceResolved && !this.resolveFence()) return [];

    while (s.scanPos < s.rawBuffer.length) {
      const ch = s.rawBuffer[s.scanPos];
      if (s.inString) {
        if (s.escaped) s.escaped = false;
        else if (ch === '\\') s.escaped = true;
        else if (ch === '"') {
          s.inString = false;
          if (s.depth === 1 && s.targetArrayDepth === null) {
            try { s.lastClosedKey = JSON.parse(s.rawBuffer.slice(s.stringStart, s.scanPos + 1)) as string; s.awaitingColon = true; }
            catch { s.lastClosedKey = null; }
          }
        }
        s.scanPos++;
        continue;
      }
      if (ch === '"') { s.inString = true; s.stringStart = s.scanPos; s.scanPos++; continue; }
      if (ch === ':' && s.awaitingColon && s.depth === 1) { s.pendingArrayKey = s.lastClosedKey; s.awaitingColon = false; s.scanPos++; continue; }
      if (!isWs(ch) && ch !== ':') s.awaitingColon = false;

      if (ch === '[') {
        s.depth++;
        if (!s.arrayFinished && s.targetArrayDepth === null && s.depth <= 2 &&
            (s.depth === 1 || !this.arrayKeys || (s.pendingArrayKey !== null && this.arrayKeys.has(s.pendingArrayKey)))) {
          s.targetArrayDepth = s.depth;
        }
        s.pendingArrayKey = null;
      } else if (ch === ']') {
        if (s.targetArrayDepth !== null && s.depth === s.targetArrayDepth) {
          s.targetArrayDepth = null;
          if (s.sawObjectInArray || Boolean(this.arrayKeys)) s.arrayFinished = true;
          s.sawObjectInArray = false;
        }
        s.depth = Math.max(0, s.depth - 1);
      } else if (ch === '{') {
        s.depth++;
        if (s.targetArrayDepth !== null && s.depth === s.targetArrayDepth + 1) { s.itemStart = s.scanPos; s.sawObjectInArray = true; }
        s.pendingArrayKey = null;
      } else if (ch === '}') {
        if (s.targetArrayDepth !== null && s.depth === s.targetArrayDepth + 1 && s.itemStart !== -1) {
          this.tryEmitItem(s.rawBuffer.slice(s.itemStart, s.scanPos + 1), emitted);
          s.itemStart = -1;
        }
        s.depth = Math.max(0, s.depth - 1);
      }
      s.scanPos++;
    }
    return emitted;
  }

  public getCards(): TCard[] { return [...this.cards]; }
  public getPartialSnapshot<TContainer = unknown>(): PartialJsonParseResult<TContainer> { return parsePartialJson<TContainer>(this.s.rawBuffer); }
  public getRawBuffer(): string { return this.s.rawBuffer; }
  public reset(): void { this.s = StreamingProductCardExtractor.freshState(); this.cards.length = 0; }
}

export const createStreamingProductCardExtractor = <TCard = Record<string, unknown>>(
  options: StreamingProductCardExtractorOptions<TCard> = {}
): StreamingProductCardExtractor<TCard> => new StreamingProductCardExtractor<TCard>(options);
