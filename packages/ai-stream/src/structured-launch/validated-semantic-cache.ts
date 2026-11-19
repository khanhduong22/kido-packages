/**
 * @kido/ai-stream - Strict Schema-Validated Semantic Cache Gate (GonnaCrash Level 19)
 *
 * Implements Shopify Storefront AI / Amazon Q edge semantic caching with strict JSON schema
 * enforcement (`writeBlockedInvalidJson`, `readEvictedInvalidJson`) and strict commerce entity
 * fingerprint isolation so `"size M"` never hits `"size L"`.
 *
 * Invariant: 100% zero external runtime dependencies and zero imports from sibling slices.
 */

export type StrictJsonFieldType = 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';

export interface StrictJsonFieldRule {
  type: StrictJsonFieldType;
  required?: boolean; nullable?: boolean; nonEmpty?: boolean;
  minLength?: number; maxLength?: number; pattern?: RegExp;
  min?: number; max?: number; enum?: readonly unknown[];
  minItems?: number; maxItems?: number;
  itemRule?: StrictJsonFieldRule;
  itemSchema?: StrictJsonSchemaSpec<Record<string, unknown>>;
  nestedSchema?: StrictJsonSchemaSpec<Record<string, unknown>>;
  refine?: (value: unknown) => boolean | string;
}

export interface StrictJsonSchemaSpec<T = Record<string, unknown>> {
  name?: string;
  fields: Record<string, StrictJsonFieldRule>;
  allowAdditionalProperties?: boolean;
  refine?: (value: T) => boolean | string;
}

export interface StrictJsonValidationResult<T> {
  valid: boolean; data?: T; errors: string[]; rawWasString: boolean;
}

function validateValueWithRule(path: string, value: unknown, rule: StrictJsonFieldRule, errors: string[]): void {
  if (value === null) { if (!rule.nullable) errors.push(`${path}: must not be null`); return; }
  if (rule.enum && !rule.enum.includes(value)) errors.push(`${path}: value not in allowed enum`);

  if (rule.type === 'string') {
    if (typeof value !== 'string') { errors.push(`${path}: expected string`); return; }
    if (rule.nonEmpty && value.trim().length === 0) errors.push(`${path}: must be non-empty string`);
    if (rule.minLength !== undefined && value.length < rule.minLength) errors.push(`${path}: length < ${rule.minLength}`);
    if (rule.maxLength !== undefined && value.length > rule.maxLength) errors.push(`${path}: length > ${rule.maxLength}`);
    if (rule.pattern && !rule.pattern.test(value)) errors.push(`${path}: failed pattern match`);
  } else if (rule.type === 'number' || rule.type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value)) { errors.push(`${path}: expected finite number`); return; }
    if (rule.type === 'integer' && !Number.isInteger(value)) errors.push(`${path}: expected integer`);
    if (rule.min !== undefined && value < rule.min) errors.push(`${path}: value < ${rule.min}`);
    if (rule.max !== undefined && value > rule.max) errors.push(`${path}: value > ${rule.max}`);
  } else if (rule.type === 'boolean') {
    if (typeof value !== 'boolean') { errors.push(`${path}: expected boolean`); return; }
  } else if (rule.type === 'array') {
    if (!Array.isArray(value)) { errors.push(`${path}: expected array`); return; }
    if (rule.nonEmpty && value.length === 0) errors.push(`${path}: must be non-empty array`);
    if (rule.minItems !== undefined && value.length < rule.minItems) errors.push(`${path}: items < ${rule.minItems}`);
    if (rule.maxItems !== undefined && value.length > rule.maxItems) errors.push(`${path}: items > ${rule.maxItems}`);
    for (let i = 0; i < value.length; i++) {
      if (rule.itemRule) validateValueWithRule(`${path}[${i}]`, value[i], rule.itemRule, errors);
      if (rule.itemSchema) validateObjectAgainstSchema(`${path}[${i}]`, value[i], rule.itemSchema, errors);
    }
  } else if (rule.type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) { errors.push(`${path}: expected object`); return; }
    if (rule.nestedSchema) validateObjectAgainstSchema(path, value, rule.nestedSchema, errors);
  }
  if (rule.refine) {
    const refined = rule.refine(value);
    if (refined !== true) errors.push(typeof refined === 'string' ? `${path}: ${refined}` : `${path}: failed custom refine`);
  }
}

function validateObjectAgainstSchema(
  prefix: string, candidate: unknown, schema: StrictJsonSchemaSpec<Record<string, unknown>>, errors: string[]
): void {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) { errors.push(`${prefix}: expected JSON object`); return; }
  const obj = candidate as Record<string, unknown>;
  for (const [key, rule] of Object.entries(schema.fields)) {
    const fieldPath = prefix === '$' ? key : `${prefix}.${key}`;
    if (!Object.prototype.hasOwnProperty.call(obj, key) || obj[key] === undefined) {
      if (rule.required !== false) errors.push(`${fieldPath}: missing required field`);
      continue;
    }
    validateValueWithRule(fieldPath, obj[key], rule, errors);
  }
  if (schema.allowAdditionalProperties === false) {
    for (const key of Object.keys(obj)) if (!Object.prototype.hasOwnProperty.call(schema.fields, key)) errors.push(`${prefix}.${key}: unexpected property`);
  }
}

/** Validates a raw JSON string or object against a `StrictJsonSchemaSpec`, rejecting malformed JSON and non-finite numbers. */
export function validateStrictJsonPayload<T = Record<string, unknown>>(payload: unknown, schema: StrictJsonSchemaSpec<T>): StrictJsonValidationResult<T> {
  let parsed: unknown = payload;
  const rawWasString = typeof payload === 'string';
  if (rawWasString) {
    const trimmed = (payload as string).trim();
    if (!trimmed) return { valid: false, errors: ['invalid_json: empty string'], rawWasString: true };
    try { parsed = JSON.parse(trimmed); }
    catch (err) { return { valid: false, errors: [`invalid_json: ${err instanceof Error ? err.message : String(err)}`], rawWasString: true }; }
  }
  const errors: string[] = [];
  validateObjectAgainstSchema('$', parsed, schema as unknown as StrictJsonSchemaSpec<Record<string, unknown>>, errors);
  if (errors.length === 0 && schema.refine) {
    const res = schema.refine(parsed as T);
    if (res !== true) errors.push(typeof res === 'string' ? res : 'schema_refine_failed');
  }
  return errors.length === 0 ? { valid: true, data: parsed as T, errors: [], rawWasString } : { valid: false, errors, rawWasString };
}

export interface StrictCacheExtractedEntities {
  sizes: string[]; weightsOrVolumes: string[]; quantitiesOrSets: string[];
  colorsOrFinishes: string[]; priceBounds: string[]; brandsOrSkus: string[];
}

const FILLER_MULTI_RE = /(?<![\p{L}\p{N}_])(?:cho mình hỏi|cho em hỏi|cho hỏi|còn hàng không|còn hàng hông|còn không|còn hông|còn hàng|shop ơi|do you have|in stock)(?![\p{L}\p{N}_])/gu;
const FILLER_WORDS = new Set(['shop', 'ơi', 'oi', 'hông', 'không', 'khong', 'ko', 'còn', 'con', 'hàng', 'hang', 'ạ', 'nha', 'nhé', 'nhe', 'vậy', 'vay', 'please', 'is', 'available', 'mình', 'minh', 'em', 'dạ']);
const SYNONYM_MAP: Record<string, string> = { cỡ: 'size', co: 'size', áo: 'shirt', ao: 'shirt', giấy: 'paper', giay: 'paper', vẽ: 'draw', ve: 'draw', đen: 'black', den: 'black', trắng: 'white', đỏ: 'red', vàng: 'yellow', hồng: 'pink', màu: 'color', mau: 'color' };

const stripDiacritics = (s: string): string => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, (m) => (m === 'đ' ? 'd' : 'D'));

function collectMatches(target: Set<string>, text: string, regex: RegExp, map?: (m: RegExpExecArray) => string): void {
  regex.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) { const v = map ? map(m) : m[1] ?? m[0]; if (v) target.add(v); }
}

export function extractStrictCacheEntities(query: string): StrictCacheExtractedEntities {
  const raw = (query ?? '').normalize('NFC').trim();
  const text = raw.toLowerCase();
  if (!text) return { sizes: [], weightsOrVolumes: [], quantitiesOrSets: [], colorsOrFinishes: [], priceBounds: [], brandsOrSkus: [] };

  const sizes = new Set<string>();
  collectMatches(sizes, text, /(?<![a-z0-9])(a2|a3|a4|a5|a6|b5|2b|3b|4b|5b|6b|7b|8b|hb)(?![a-z0-9])/gu);
  collectMatches(sizes, text, /(?<![\p{L}\p{N}_-])(xxxl|xxl|xl|xs)(?![\p{L}\p{N}_-])/gu);
  collectMatches(sizes, text, /(?<![\p{L}\p{N}_])(?:size|sz|cỡ|co)\s*[:#=-]?\s*(xxxl|xxl|xl|xs|s|m|l)(?![\p{L}\p{N}_-])/gu);
  if (/[a-z\p{Ll}]/u.test(raw) || raw.length <= 8) collectMatches(sizes, raw, /(?<![\p{L}\p{N}_\-'.])(S|M|L)(?![\p{L}\p{N}_\-'])/gu, (m) => m[1].toLowerCase());

  const weightsOrVolumes = new Set<string>();
  collectMatches(weightsOrVolumes, text, /(?<![\p{L}\p{N}.])(\d+(?:\.\d+)?)\s*(gsm|kg|mg|gr|g|ml|oz|lít|lit)(?![\p{L}\p{N}_])/gu, (m) => `${m[1]}${m[2] === 'gr' ? 'g' : m[2].startsWith('l') ? 'l' : m[2]}`);

  const quantitiesOrSets = new Set<string>();
  collectMatches(quantitiesOrSets, text, /(?<![\p{L}\p{N}.])(\d+)\s*(màu|mau|colors?|colours?|tuýp|tuyp|tubes?|tờ|sheets?|bộ|bo|sets?|hộp|hop|tệp|tep|pads?)(?![\p{L}\p{N}_])/gu, (m) => `${m[1]}_${m[2].startsWith('tờ') || m[2].startsWith('sheet') ? 'sheets' : m[2].startsWith('b') || m[2].startsWith('s') ? 'sets' : 'units'}`);

  const colorsOrFinishes = new Set<string>();
  for (const [re, label] of [
    [/(?<![\p{L}\p{N}_])(?:cold[\s_-]*press|hot[\s_-]*press)(?![\p{L}\p{N}_])/gu, 'finish_press'],
    [/(?<![\p{L}\p{N}_])(?:đen|den|black)(?![\p{L}\p{N}_])/gu, 'black'], [/(?<![\p{L}\p{N}_])(?:trắng|white)(?![\p{L}\p{N}_])/gu, 'white'],
    [/(?<![\p{L}\p{N}_])(?:đỏ|red)(?![\p{L}\p{N}_])/gu, 'red'], [/(?<![\p{L}\p{N}_])(?:xanh[\s_-]*(?:dương|duong)|blue|navy)(?![\p{L}\p{N}_])/gu, 'blue'],
    [/(?<![\p{L}\p{N}_])(?:hồng|pink)(?![\p{L}\p{N}_])/gu, 'pink'],
  ] as Array<[RegExp, string]>) collectMatches(colorsOrFinishes, text, re, () => label);

  const priceBounds = new Set<string>();
  collectMatches(priceBounds, text, /(?<![\p{L}\p{N}_])(?:(dưới|duoi|under|below|max)|(trên|tren|over|above|min))?\s*(\d+(?:[.,]\d+)?)\s*(k|tr|vnđ|vnd)(?![\p{L}\p{N}_])/gu, (m) => {
    const val = Math.round(Number.parseFloat(m[3].replace(/,/g, '.')) * (m[4] === 'k' ? 1_000 : m[4] === 'tr' ? 1_000_000 : 1));
    return `${m[1] ? 'max' : m[2] ? 'min' : 'val'}:${val}`;
  });

  const brandsOrSkus = new Set<string>();
  collectMatches(brandsOrSkus, text, /(?<![a-z0-9-])([a-z]{2,8}(?:[-_][a-z0-9]{1,8})+)(?![a-z0-9-])/gu, (m) => (/\d/.test(m[1]) ? m[1] : ''));
  return { sizes: [...sizes].sort(), weightsOrVolumes: [...weightsOrVolumes].sort(), quantitiesOrSets: [...quantitiesOrSets].sort(), colorsOrFinishes: [...colorsOrFinishes].sort(), priceBounds: [...priceBounds].sort(), brandsOrSkus: [...brandsOrSkus].sort() };
}

export function computeStrictEntityFingerprint(entities: StrictCacheExtractedEntities): string {
  const parts: string[] = [];
  for (const key of ['brandsOrSkus', 'colorsOrFinishes', 'priceBounds', 'quantitiesOrSets', 'sizes', 'weightsOrVolumes'] as const) {
    if (entities[key].length > 0) parts.push(`${key}:${entities[key].join(',')}`);
  }
  return parts.length > 0 ? parts.join('|') : '__general__';
}

function hashTrigramVector(query: string, dims = 128): number[] {
  const vec = new Array<number>(dims).fill(0);
  const cleaned = (query ?? '').normalize('NFC').toLowerCase().replace(FILLER_MULTI_RE, ' ').replace(/[?!.,;:"'()[\]{}]+/g, ' ').trim();
  const tokens = cleaned.split(/\s+/).filter((t) => t && !FILLER_WORDS.has(t)).map((t) => SYNONYM_MAP[t] ?? stripDiacritics(t));
  if (tokens.length === 0) return vec;
  const hash = (s: string, seed: number) => { let h = seed >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
  for (const tok of tokens) {
    const add = (f: string, w: number) => { vec[hash(f, 2166136261) % dims] += ((hash(f, 0x9e3779b9) & 1) === 0 ? 1 : -1) * w; };
    add(`u:${tok}`, 3);
    const pad = `^${tok}$`;
    for (let i = 0; i <= pad.length - 3; i++) add(`c:${pad.slice(i, i + 3)}`, 1);
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return norm === 0 ? vec : vec.map((v) => v / norm);
}

const vecCosine = (a: readonly number[], b: readonly number[]): number => { let d = 0; for (let i = 0; i < Math.min(a.length, b.length); i++) d += a[i] * b[i]; return d; };

export interface ValidatedSemanticCacheOptions<TPayload = Record<string, unknown>> {
  schema: StrictJsonSchemaSpec<TPayload>; similarityThreshold?: number; requireEntityMatch?: boolean;
  ttlMs?: number; maxEntries?: number; embedder?: (text: string) => Promise<number[]> | number[]; nowFn?: () => number;
}
export interface ValidatedCacheStoreInput<TPayload = Record<string, unknown>> {
  query: string; payload: TPayload | string; contextKey?: string; embedding?: number[]; ttlMs?: number;
}
export interface ValidatedCacheStoreResult<TPayload> {
  stored: boolean; entryId?: string; entityFingerprint: string; errors: string[]; data?: TPayload;
}
export interface ValidatedCacheLookupResult<TPayload> {
  hit: boolean; status: 'HIT_EXACT' | 'HIT_SEMANTIC' | 'MISS'; similarity: number; entityFingerprint: string;
  payload?: TPayload; entryId?: string; entityMismatchBlocked: boolean; readEvictedInvalidJson: boolean;
}
export interface ValidatedSemanticCacheStats {
  size: number; maxEntries: number; similarityThreshold: number; requireEntityMatch: boolean;
  lookups: number; exactHits: number; semanticHits: number; hits: number; misses: number; hitRatePct: number;
  writeBlockedInvalidJson: number; readEvictedInvalidJson: number; entityMismatchBlockedCount: number;
}
interface InternalEntry { id: string; normalizedQuery: string; contextKey: string; entityFingerprint: string; embedding: number[]; rawPayload: unknown; expiresAt: number; }

/** Schema-enforced semantic cache gate blocking malformed/invalid JSON writes, evicting corrupt reads, and isolating `"size M"` vs `"size L"`. */
export class ValidatedSemanticCacheGate<TPayload = Record<string, unknown>> {
  private readonly schema: StrictJsonSchemaSpec<TPayload>;
  private readonly threshold: number;
  private readonly requireEntityMatch: boolean;
  private readonly defaultTtlMs: number;
  private readonly maxEntries: number;
  private readonly embedder?: (text: string) => Promise<number[]> | number[];
  private readonly nowFn: () => number;
  private readonly entries = new Map<string, InternalEntry>();
  private readonly exactIndex = new Map<string, string>();
  private seq = 0;
  private stats = { lookups: 0, exactHits: 0, semanticHits: 0, misses: 0, writeBlockedInvalidJson: 0, readEvictedInvalidJson: 0, entityMismatchBlockedCount: 0 };

  constructor(options: ValidatedSemanticCacheOptions<TPayload>) {
    this.schema = options.schema; this.threshold = options.similarityThreshold ?? 0.95;
    this.requireEntityMatch = options.requireEntityMatch ?? true; this.defaultTtlMs = Math.max(1, options.ttlMs ?? 600_000);
    this.maxEntries = Math.max(1, options.maxEntries ?? 2_000); this.embedder = options.embedder; this.nowFn = options.nowFn ?? (() => Date.now());
  }

  private normalize = (q: string): string => (q ?? '').normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();

  private evict(id: string): void {
    const existing = this.entries.get(id);
    if (!existing) return;
    this.entries.delete(id);
    const key = `${existing.contextKey}::${existing.normalizedQuery}`;
    if (this.exactIndex.get(key) === id) this.exactIndex.delete(key);
  }

  private validateAndTouch(entry: InternalEntry, now: number): { status: 'valid'; data: TPayload } | { status: 'expired' } | { status: 'corrupt' } {
    if (now > entry.expiresAt) { this.evict(entry.id); return { status: 'expired' }; }
    const check = validateStrictJsonPayload(entry.rawPayload, this.schema);
    if (!check.valid || check.data === undefined) { this.evict(entry.id); this.stats.readEvictedInvalidJson++; return { status: 'corrupt' }; }
    this.entries.delete(entry.id);
    this.entries.set(entry.id, entry);
    return { status: 'valid', data: check.data };
  }

  public async store(input: ValidatedCacheStoreInput<TPayload>): Promise<ValidatedCacheStoreResult<TPayload>> {
    const entityFingerprint = computeStrictEntityFingerprint(extractStrictCacheEntities(input.query));
    const check = validateStrictJsonPayload(input.payload, this.schema);
    if (!check.valid || check.data === undefined) {
      this.stats.writeBlockedInvalidJson++;
      return { stored: false, entityFingerprint, errors: check.errors };
    }
    const id = await this.insertEntry(input.query, check.data, entityFingerprint, input.contextKey ?? '', input.embedding, input.ttlMs);
    return { stored: true, entryId: id, entityFingerprint, errors: [], data: check.data };
  }

  /** Models external/legacy L2 cache entries hydrated before schema-gate rollout to test read-time eviction. */
  public async importUnvalidatedEntry(input: { query: string; rawPayload: unknown; contextKey?: string; embedding?: number[]; ttlMs?: number }): Promise<string> {
    const fp = computeStrictEntityFingerprint(extractStrictCacheEntities(input.query));
    return this.insertEntry(input.query, input.rawPayload, fp, input.contextKey ?? '', input.embedding, input.ttlMs);
  }

  private async insertEntry(query: string, rawPayload: unknown, entityFingerprint: string, contextKey: string, embedding?: number[], ttlMs?: number): Promise<string> {
    const normalizedQuery = this.normalize(query);
    const exactKey = `${contextKey}::${normalizedQuery}`;
    const prevId = this.exactIndex.get(exactKey);
    if (prevId) this.evict(prevId);
    while (this.entries.size >= this.maxEntries) { const oldest = this.entries.keys().next().value; if (!oldest) break; this.evict(oldest); }
    const id = `vsc_${++this.seq}`;
    const vec = embedding ?? (this.embedder ? await this.embedder(query) : hashTrigramVector(query));
    this.entries.set(id, { id, normalizedQuery, contextKey, entityFingerprint, embedding: vec, rawPayload, expiresAt: this.nowFn() + Math.max(1, ttlMs ?? this.defaultTtlMs) });
    this.exactIndex.set(exactKey, id);
    return id;
  }

  public async lookup(query: string, contextKey = ''): Promise<ValidatedCacheLookupResult<TPayload>> {
    const now = this.nowFn();
    const entityFingerprint = computeStrictEntityFingerprint(extractStrictCacheEntities(query));
    this.stats.lookups++;
    let readEvicted = false;

    const exactId = this.exactIndex.get(`${contextKey}::${this.normalize(query)}`);
    const exactEntry = exactId ? this.entries.get(exactId) : undefined;
    if (exactEntry) {
      const verdict = this.validateAndTouch(exactEntry, now);
      if (verdict.status === 'valid') {
        this.stats.exactHits++;
        return { hit: true, status: 'HIT_EXACT', similarity: 1, entityFingerprint, payload: verdict.data, entryId: exactEntry.id, entityMismatchBlocked: false, readEvictedInvalidJson: false };
      }
      if (verdict.status === 'corrupt') readEvicted = true;
    }

    const qVec = this.embedder ? await this.embedder(query) : hashTrigramVector(query);
    const candidates: Array<{ entry: InternalEntry; sim: number }> = [];
    let bestSim = 0;
    let entityMismatchBlocked = false;

    for (const entry of [...this.entries.values()]) {
      if (now > entry.expiresAt) { this.evict(entry.id); continue; }
      if (entry.contextKey !== contextKey) continue;
      const sim = vecCosine(qVec, entry.embedding);
      if (this.requireEntityMatch && entry.entityFingerprint !== entityFingerprint) {
        if (sim >= Math.min(this.threshold, 0.75)) entityMismatchBlocked = true;
        continue;
      }
      if (sim > bestSim) bestSim = sim;
      if (sim >= this.threshold) candidates.push({ entry, sim });
    }

    candidates.sort((a, b) => b.sim - a.sim);
    for (const { entry, sim } of candidates) {
      const verdict = this.validateAndTouch(entry, now);
      if (verdict.status === 'corrupt') { readEvicted = true; continue; }
      if (verdict.status === 'valid') {
        this.stats.semanticHits++;
        return { hit: true, status: 'HIT_SEMANTIC', similarity: Number(sim.toFixed(6)), entityFingerprint, payload: verdict.data, entryId: entry.id, entityMismatchBlocked: false, readEvictedInvalidJson: readEvicted };
      }
    }

    if (entityMismatchBlocked) this.stats.entityMismatchBlockedCount++;
    this.stats.misses++;
    return { hit: false, status: 'MISS', similarity: Number(Math.max(0, bestSim).toFixed(6)), entityFingerprint, entityMismatchBlocked, readEvictedInvalidJson: readEvicted };
  }

  public getStats(): ValidatedSemanticCacheStats {
    const hits = this.stats.exactHits + this.stats.semanticHits;
    return { size: this.entries.size, maxEntries: this.maxEntries, similarityThreshold: this.threshold, requireEntityMatch: this.requireEntityMatch, ...this.stats, hits, hitRatePct: this.stats.lookups > 0 ? Number(((hits / this.stats.lookups) * 100).toFixed(2)) : 0 };
  }
}

export const createValidatedSemanticCacheGate = <TPayload = Record<string, unknown>>(
  options: ValidatedSemanticCacheOptions<TPayload>
): ValidatedSemanticCacheGate<TPayload> => new ValidatedSemanticCacheGate<TPayload>(options);
