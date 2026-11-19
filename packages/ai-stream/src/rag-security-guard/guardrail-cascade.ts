/**
 * @kido/ai-stream/rag-security-guard - Dual-Layer Permissive Guardrail Cascade (Level 20)
 *
 * Orthogonal two-layer prompt injection defense:
 * - Layer 1 (`evaluateFastJevGuard`): NFKC normalization, zero-width stripping, Base64/Hex/URL
 *   decoding, and fast bilingual EN/VI lexical override/exfil scoring (`permissive` vs `strict`).
 * - Layer 2 (`evaluateSemanticJudgeGuard`): Orthogonal structural/semantic framing analyzer
 *   for roleplay (`DAN`, "đóng vai admin"), translation/summarization exfil traps, XML/Markdown
 *   system-tag spoofing, plus an optional async `customJudgeFn` hook.
 */

import { detectPromptOverrideAttempt, escapeBoundaryTags } from './prompt-boundary.js';

export type GuardrailPolicyMode = 'permissive' | 'strict';
export type GuardrailRiskCategory =
  | 'instruction_override' | 'system_prompt_exfil' | 'encoded_obfuscation'
  | 'roleplay_jailbreak' | 'cross_tenant_pii' | 'delimiter_spoofing';

export interface GuardrailLayerVerdict {
  layer: 'fast_jev' | 'semantic_judge';
  mode: GuardrailPolicyMode;
  blocked: boolean;
  score: number;
  threshold: number;
  categories: GuardrailRiskCategory[];
  matchedSignals: string[];
  normalizedInput: string;
  decodedPayloads: string[];
  zeroWidthStrippedCount: number;
  latencyMs: number;
  reason: string;
}

export interface GuardrailCascadeResult {
  allowed: boolean;
  blocked: boolean;
  blockedByLayer: 'none' | 'layer1_jev' | 'layer2_judge';
  mode: GuardrailPolicyMode;
  categories: GuardrailRiskCategory[];
  matchedSignals: string[];
  normalizedInput: string;
  layer1: GuardrailLayerVerdict;
  layer2: GuardrailLayerVerdict | null;
  totalLatencyMs: number;
  safeRefusalMessage: string | null;
}

export interface FastJevGuardOptions { mode?: GuardrailPolicyMode; blockThreshold?: number; maxDecodeDepth?: number; }
export type CustomSemanticJudgeFn = (
  normalizedInput: string,
  context: { rawInput: string; mode: GuardrailPolicyMode; localVerdict: GuardrailLayerVerdict }
) => Promise<Partial<GuardrailLayerVerdict> | boolean | null | undefined> | Partial<GuardrailLayerVerdict> | boolean | null | undefined;
export interface SemanticJudgeGuardOptions { mode?: GuardrailPolicyMode; blockThreshold?: number; customJudgeFn?: CustomSemanticJudgeFn; failClosedOnCustomJudgeError?: boolean; }
export interface DualLayerGuardrailCascadeOptions { mode?: GuardrailPolicyMode; layer1Threshold?: number; layer2Threshold?: number; customJudgeFn?: CustomSemanticJudgeFn; failClosedOnCustomJudgeError?: boolean; safeRefusalMessage?: string; }
export interface DualLayerGuardrailStats { checkedCount: number; blockedLayer1Count: number; blockedLayer2Count: number; allowedCount: number; }

type LexicalRuleTuple = readonly [string, GuardrailRiskCategory, number, RegExp, boolean?];
interface NormalizedSecurityText { normalizedInput: string; zeroWidthStrippedCount: number; decodedPayloads: string[]; }

export const DEFAULT_GUARDRAIL_REFUSAL_MESSAGE =
  'Your request was blocked by our safety policy. Please rephrase with product, order, or policy questions.';

const ZERO_WIDTH_RE = /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\u00AD]/g;

const JEV_LEXICAL_RULES: readonly LexicalRuleTuple[] = [
  ['en_forget_or_override_rules', 'instruction_override', 0.85, /\b(?:forget|ignore|disregard|skip|abandon|bypass|override)\s+(?:all\s+|any\s+|your\s+|the\s+)?(?:previous|prior|above|earlier|original|initial|system|safety)\s+(?:instructions?|prompts?|rules?|guidelines?|directives?|constraints?)\b/i],
  ['en_new_system_directive', 'instruction_override', 0.8, /\b(?:from\s+now\s+on|new\s+system\s+(?:instruction|directive|rule)|highest\s+priority\s+(?:instruction|command))\b[\s\S]{0,60}\b(?:obey|follow|ignore|output|reveal|print)\b/i],
  ['vi_override_rules', 'instruction_override', 0.85, /(?:bỏ\s*qua|phớt\s*lờ|quên\s*hết|vô\s*hiệu\s*hóa)\s+(?:mọi\s+|tất\s*cả\s+|các\s+)?(?:(?:hướng\s*dẫn\s+(?:trước|ở\s*trên|phía\s*trên|ban\s*đầu|hệ\s*thống|gốc|bảo\s*mật))|(?:(?:quy\s*tắc|chỉ\s*thị|lệnh\s*hệ\s*thống|ràng\s*buộc)(?:\s+(?:trước|ở\s*trên|phía\s*trên|ban\s*đầu|hệ\s*thống|gốc))?))/iu],
  ['en_exfil_system_prompt', 'system_prompt_exfil', 0.85, /\b(?:reveal|show|print|display|output|echo|repeat|leak|disclose|expose|dump)\s+(?:me\s+)?(?:your\s+|the\s+)?(?:exact\s+|full\s+|raw\s+)?(?:system\s*prompt|system\s*instructions?|hidden\s*(?:prompt|rules?|instructions?)|developer\s*(?:prompt|message)|initial\s*(?:prompt|instructions?)|canary(?:\s*token)?)\b/i],
  ['vi_exfil_system_prompt', 'system_prompt_exfil', 0.85, /(?:tiết\s*lộ|cho\s*(?:tôi\s+|mình\s+)?xem|hiển\s*thị|in\s*(?:ra|nguyên\s*văn)|xuất\s*ra|nhắc\s*lại|đọc\s*lại)\s+(?:toàn\s*bộ\s+|nguyên\s*văn\s+)?(?:system\s*prompt|chỉ\s*thị\s*hệ\s*thống|hướng\s*dẫn\s*gốc|lệnh\s*hệ\s*thống|quy\s*tắc\s*ẩn|mật\s*khẩu|api\s*key|canary)/iu],
  ['cross_tenant_exfil_probe', 'cross_tenant_pii', 0.8, /\b(?:dump|export|list|show|extract|select\s+\*\s+from)\s+(?:all\s+)?(?:other\s+)?(?:customers?|users?|tenants?|orders?|emails?|phone\s*numbers?)\b|(?:xem|lấy|xuất|liệt\s*kê)\s+(?:toàn\s*bộ\s+)?(?:đơn\s*hàng|email|số\s*điện\s*thoại|dữ\s*liệu)\s+(?:của\s+)?(?:khách\s*hàng\s*khác|người\s*dùng\s*khác|tất\s*cả\s*khách)/iu],
  ['strict_suspicious_keyword', 'instruction_override', 0.35, /(?:\b(?:ignore|bypass|override|secret|token|admin|system\s*prompt|jailbreak|translate|summarize)\b|bỏ\s*qua|hướng\s*dẫn|tóm\s*tắt|chỉ\s*thị|đóng\s*vai|dịch\s+(?:tên|sang))/iu, true],
];

const SEMANTIC_JUDGE_RULES: readonly LexicalRuleTuple[] = [
  ['en_dan_uppercase_jailbreak', 'roleplay_jailbreak', 0.9, /\bDAN\b/],
  ['en_dan_or_dev_mode_jailbreak', 'roleplay_jailbreak', 0.9, /(?:(?:jailbreak|roleplay|mode|persona|act\s+as|you\s+are)\s+dan\b|\b(?:do\s+anything\s+now|developer\s+mode|god\s+mode|unfiltered\s+(?:ai|mode)|jailbreak(?:ed)?)\b)/i],
  ['en_roleplay_unrestricted', 'roleplay_jailbreak', 0.82, /\b(?:pretend|act\s+as\s+if|imagine|roleplay|hypothetical(?:ly)?)\b[\s\S]{0,80}\b(?:no\s+(?:rules?|restrictions?|limits?|filters?|safety|guardrails?)|unrestricted|unfiltered|system\s+admin(?:istrator)?|root\s+access|evil\s+bot)\b/i],
  ['vi_roleplay_admin_jailbreak', 'roleplay_jailbreak', 0.85, /(?:đóng\s*vai|nhập\s*vai|giả\s*vờ|hãy\s+là)\s+(?:admin|quản\s*trị\s*viên|root|hacker|hệ\s*thống|ai\s+không\s+giới\s*hạn|ai\s+không\s+kiểm\s*duyệt)|chế\s*độ\s+(?:nhà\s+phát\s+triển|không\s+giới\s*hạn|bất\s+tử)/iu],
  ['en_translation_or_summary_exfil', 'system_prompt_exfil', 0.84, /\b(?:translate|summarize|paraphrase|rewrite|convert|encode|format|repeat)\b[\s\S]{0,50}\b(?:above|preceding|previous|initial|system|hidden|original)\b[\s\S]{0,40}\b(?:instructions?|prompt|rules?|text|guidelines?|directives?|messages?)\b/i],
  ['vi_translation_or_summary_exfil', 'system_prompt_exfil', 0.85, /(?:tóm\s*tắt|dịch|diễn\s*giải|viết\s*lại|chuyển\s*thể|mã\s*hóa|lặp\s*lại)\s+(?:[\s\S]{0,40}\s+)?(?:chỉ\s*thị|hướng\s*dẫn|quy\s*tắc|lệnh|prompt|văn\s*bản)\s+(?:[\s\S]{0,30}\s+)?(?:hệ\s*thống|phía\s*trên|ở\s*trên|ban\s*đầu|gốc|ẩn)/iu],
  ['en_verbatim_above_trap', 'system_prompt_exfil', 0.8, /\b(?:everything|all\s+text|words|lines)\s+(?:above|before)\s+(?:this|my)\s+(?:line|message|prompt)\b/i],
  ['xml_or_markdown_system_spoofing', 'delimiter_spoofing', 0.84, /(?:<\/?(?:system|system_instruction|system_prompt|developer_prompt|rag_context|user_query)\b[^>]*>|\[(?:SYSTEM|DEVELOPER|ADMIN|INST|\/INST)\]|<<SYS>>|<\|(?:im_start|im_end|system)\|>|(?:^|\n)\s*(?:#{1,4}|---|\*\*\*|```)\s*(?:system(?:\s+prompt|\s+override|\s+update)?|developer\s+instructions?|admin\s+override)\b)/im],
  ['indirect_authority_or_audit_framing', 'cross_tenant_pii', 0.78, /(?:\b(?:note\s+to\s+(?:ai|assistant|model)|urgent\s+system\s+update|priority\s+override)|lưu\s*ý\s+cho\s+ai|cập\s*nhật\s+khẩn\s+từ\s+hệ\s*thống)\s*:|\b(?:for\s+(?:audit|compliance|verification)|để\s+(?:kiểm\s*tra|đối\s*soát))\b[\s\S]{0,60}\b(?:other\s+(?:users?|customers?)|emails?|phone\s*numbers?|khách\s*hàng\s*khác|số\s*điện\s*thoại)/iu],
  ['strict_semantic_framing_keyword', 'roleplay_jailbreak', 0.35, /(?:\b(?:act\s+as|translate|summarize|admin)\b|tóm\s*tắt|dịch|hướng\s*dẫn|bỏ\s*qua)/iu, true],
];

function isPrintableDecodedText(decoded: string): boolean {
  if (decoded.length < 6) return false;
  let printable = 0;
  let hasLetter = false;
  for (let i = 0; i < decoded.length; i++) {
    const c = decoded.charCodeAt(i);
    if ((c >= 32 && c <= 126) || c === 9 || c === 10 || c === 13 || (c >= 0x00c0 && c <= 0x024f) || (c >= 0x1e00 && c <= 0x1eff)) {
      printable++;
      if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c >= 0x00c0) hasLetter = true;
    }
  }
  return hasLetter && printable / decoded.length >= 0.8;
}

function decodeEncodedBytes(bytes: Uint8Array): string | null {
  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  return isPrintableDecodedText(decoded) ? decoded : null;
}

function decodeHexString(hex: string): string | null {
  const clean = hex.replace(/^0x/i, '').replace(/\s+/g, '');
  if (clean.length < 16 || clean.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(clean)) return null;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) bytes[i / 2] = Number.parseInt(clean.slice(i, i + 2), 16);
  return decodeEncodedBytes(bytes);
}

function decodeBase64Token(token: string): string | null {
  try {
    const std = token.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(std + '='.repeat((4 - (std.length % 4)) % 4));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return decodeEncodedBytes(bytes);
  } catch {
    return null;
  }
}

function extractDecodedStrings(text: string, maxDepth: number): string[] {
  const seen = new Set<string>();
  const queue: Array<{ value: string; depth: number }> = [{ value: text, depth: 0 }];
  const decoded: string[] = [];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur.depth >= maxDepth) continue;
    const candidates: string[] = [];
    if (/(?:%[0-9A-Fa-f]{2}){3,}/.test(cur.value)) {
      try { const u = decodeURIComponent(cur.value); if (u !== cur.value) candidates.push(u); } catch { /* ignore */ }
    }
    for (const m of cur.value.matchAll(/\b(?:0x)?([0-9a-fA-F]{16,})\b|\b(?:[0-9a-fA-F]{2}\s+){7,}[0-9a-fA-F]{2}\b/g)) {
      const hexOut = decodeHexString(m[0]); if (hexOut) candidates.push(hexOut);
    }
    for (const m of cur.value.matchAll(/\b[A-Za-z0-9+/_-]{12,}={0,2}\b/g)) {
      const b64Out = decodeBase64Token(m[0]); if (b64Out) candidates.push(b64Out);
    }
    for (const cand of candidates) {
      const clean = cand.normalize('NFKC').replace(ZERO_WIDTH_RE, '').replace(/[ \t]+/g, ' ').trim();
      if (clean && !seen.has(clean)) { seen.add(clean); decoded.push(clean); queue.push({ value: clean, depth: cur.depth + 1 }); }
    }
  }
  return decoded;
}

function normalizeSecurityInput(raw: string, maxDecodeDepth = 2): NormalizedSecurityText {
  const nfkc = (raw ?? '').normalize('NFKC');
  const zeroWidthStrippedCount = nfkc.match(ZERO_WIDTH_RE)?.length ?? 0;
  const normalizedInput = nfkc.replace(ZERO_WIDTH_RE, '').replace(/[ \t]+/g, ' ').trim();
  return { normalizedInput, zeroWidthStrippedCount, decodedPayloads: extractDecodedStrings(normalizedInput, Math.max(1, maxDecodeDepth)) };
}

function evaluateLexicalCorpus(
  norm: NormalizedSecurityText,
  rules: readonly LexicalRuleTuple[],
  mode: GuardrailPolicyMode,
  includeBoundaryCheck: boolean
): { score: number; categories: GuardrailRiskCategory[]; matchedSignals: string[] } {
  const categories = new Set<GuardrailRiskCategory>();
  const matchedSignals = new Set<string>();
  let score = 0;
  const segments = [{ text: norm.normalizedInput, fromDecoded: false }, ...norm.decodedPayloads.map((text) => ({ text, fromDecoded: true }))];

  for (const seg of segments) {
    let segHit = false;
    if (includeBoundaryCheck) {
      const override = detectPromptOverrideAttempt(seg.text);
      if (override.flagged) {
        segHit = true;
        score = Math.max(score, 0.85);
        for (const p of override.matchedPatterns) {
          matchedSignals.add(p);
          categories.add(p.includes('reveal') || p.includes('dump') ? 'system_prompt_exfil' : 'instruction_override');
        }
      }
      if (escapeBoundaryTags(seg.text) !== seg.text) {
        segHit = true;
        score = Math.max(score, 0.82);
        categories.add('delimiter_spoofing');
        matchedSignals.add('escaped_xml_boundary_tag');
      }
    }
    for (const [id, category, weight, pattern, strictOnly] of rules) {
      if (strictOnly && mode !== 'strict') continue;
      if (pattern.test(seg.text)) { segHit = true; score = Math.max(score, weight); categories.add(category); matchedSignals.add(id); }
    }
    if (seg.fromDecoded && segHit) { score = Math.max(score, 0.92); categories.add('encoded_obfuscation'); matchedSignals.add('decoded_obfuscated_payload'); }
  }
  if (norm.zeroWidthStrippedCount >= 2 && score >= 0.65) {
    score = Math.max(score, 0.9); categories.add('encoded_obfuscation'); matchedSignals.add('zero_width_char_obfuscation');
  }
  return { score, categories: Array.from(categories), matchedSignals: Array.from(matchedSignals) };
}

function buildLayerVerdict(
  layer: 'fast_jev' | 'semantic_judge',
  mode: GuardrailPolicyMode,
  threshold: number,
  norm: NormalizedSecurityText,
  evalRes: { score: number; categories: GuardrailRiskCategory[]; matchedSignals: string[] },
  startMs: number
): GuardrailLayerVerdict {
  const blocked = evalRes.score >= threshold;
  const prefix = layer === 'fast_jev' ? 'layer1' : 'layer2';
  return {
    layer, mode, blocked, score: Number(evalRes.score.toFixed(3)), threshold,
    categories: evalRes.categories, matchedSignals: evalRes.matchedSignals,
    normalizedInput: norm.normalizedInput, decodedPayloads: norm.decodedPayloads,
    zeroWidthStrippedCount: norm.zeroWidthStrippedCount,
    latencyMs: Number((performance.now() - startMs).toFixed(3)),
    reason: blocked ? `${prefix}_blocked:${evalRes.matchedSignals.join(',')}` : `${prefix}_allowed`,
  };
}

/** Layer 1 Fast Jev Guard (`permissive` by default to preserve >= 99% answered recall). */
export function evaluateFastJevGuard(input: string, options: FastJevGuardOptions = {}): GuardrailLayerVerdict {
  const start = performance.now();
  const mode: GuardrailPolicyMode = options.mode ?? 'permissive';
  const threshold = options.blockThreshold ?? (mode === 'permissive' ? 0.65 : 0.3);
  const norm = normalizeSecurityInput(input, options.maxDecodeDepth ?? 2);
  return buildLayerVerdict('fast_jev', mode, threshold, norm, evaluateLexicalCorpus(norm, JEV_LEXICAL_RULES, mode, true), start);
}

/** Layer 2 Orthogonal Semantic Judge Guard catching roleplay, translation traps & tag spoofing. */
export async function evaluateSemanticJudgeGuard(
  input: string,
  options: SemanticJudgeGuardOptions = {}
): Promise<GuardrailLayerVerdict> {
  const start = performance.now();
  const mode: GuardrailPolicyMode = options.mode ?? 'permissive';
  const threshold = options.blockThreshold ?? (mode === 'permissive' ? 0.65 : 0.3);
  const norm = normalizeSecurityInput(input, 2);
  const evalRes = evaluateLexicalCorpus(norm, SEMANTIC_JUDGE_RULES, mode, false);
  const localVerdict = buildLayerVerdict('semantic_judge', mode, threshold, norm, evalRes, start);
  if (localVerdict.blocked || !options.customJudgeFn) return localVerdict;

  const categories = new Set<GuardrailRiskCategory>(localVerdict.categories);
  const signals = new Set<string>(localVerdict.matchedSignals);
  let score = evalRes.score;
  let blocked = false;
  try {
    const custom = await options.customJudgeFn(norm.normalizedInput, { rawInput: input, mode, localVerdict });
    if (typeof custom === 'boolean' ? custom : Boolean(custom?.blocked)) {
      blocked = true;
      score = Math.max(score, typeof custom === 'object' && custom?.score !== undefined ? custom.score : 0.9);
      if (typeof custom === 'object' && custom?.categories) custom.categories.forEach((c) => categories.add(c));
      if (typeof custom === 'object' && custom?.matchedSignals) custom.matchedSignals.forEach((s) => signals.add(s));
      signals.add('custom_semantic_judge');
    }
  } catch {
    if (options.failClosedOnCustomJudgeError ?? mode === 'strict') { blocked = true; score = Math.max(score, threshold); signals.add('custom_judge_error_fail_closed'); }
  }
  return buildLayerVerdict('semantic_judge', mode, threshold, norm, { score: blocked ? Math.max(score, threshold) : score, categories: Array.from(categories), matchedSignals: Array.from(signals) }, start);
}

/** Serial Dual-Layer Guardrail Cascade running Fast Jev Guard -> Orthogonal Semantic Judge. */
export class DualLayerGuardrailCascade {
  private readonly mode: GuardrailPolicyMode;
  private readonly layer1Threshold?: number;
  private readonly layer2Threshold?: number;
  private readonly customJudgeFn?: CustomSemanticJudgeFn;
  private readonly failClosedOnCustomJudgeError?: boolean;
  private readonly safeRefusalMessage: string;
  public checkedCount = 0;
  public blockedLayer1Count = 0;
  public blockedLayer2Count = 0;
  public allowedCount = 0;

  constructor(options: DualLayerGuardrailCascadeOptions = {}) {
    this.mode = options.mode ?? 'permissive';
    this.layer1Threshold = options.layer1Threshold;
    this.layer2Threshold = options.layer2Threshold;
    this.customJudgeFn = options.customJudgeFn;
    this.failClosedOnCustomJudgeError = options.failClosedOnCustomJudgeError;
    this.safeRefusalMessage = options.safeRefusalMessage ?? DEFAULT_GUARDRAIL_REFUSAL_MESSAGE;
  }

  private buildResult(blockedByLayer: GuardrailCascadeResult['blockedByLayer'], layer1: GuardrailLayerVerdict, layer2: GuardrailLayerVerdict | null, startMs: number): GuardrailCascadeResult {
    const active = blockedByLayer === 'layer2_judge' ? layer2! : layer1;
    const blocked = blockedByLayer !== 'none';
    return {
      allowed: !blocked, blocked, blockedByLayer, mode: this.mode,
      categories: blocked ? active.categories : [], matchedSignals: blocked ? active.matchedSignals : [],
      normalizedInput: layer1.normalizedInput, layer1, layer2,
      totalLatencyMs: Number((performance.now() - startMs).toFixed(3)),
      safeRefusalMessage: blocked ? this.safeRefusalMessage : null,
    };
  }

  public async evaluate(input: string): Promise<GuardrailCascadeResult> {
    const start = performance.now();
    this.checkedCount++;
    const layer1 = evaluateFastJevGuard(input, { mode: this.mode, blockThreshold: this.layer1Threshold });
    if (layer1.blocked) { this.blockedLayer1Count++; return this.buildResult('layer1_jev', layer1, null, start); }
    const layer2 = await evaluateSemanticJudgeGuard(input, {
      mode: this.mode, blockThreshold: this.layer2Threshold,
      customJudgeFn: this.customJudgeFn, failClosedOnCustomJudgeError: this.failClosedOnCustomJudgeError,
    });
    if (layer2.blocked) { this.blockedLayer2Count++; return this.buildResult('layer2_judge', layer1, layer2, start); }
    this.allowedCount++;
    return this.buildResult('none', layer1, layer2, start);
  }

  public getStats(): DualLayerGuardrailStats {
    return { checkedCount: this.checkedCount, blockedLayer1Count: this.blockedLayer1Count, blockedLayer2Count: this.blockedLayer2Count, allowedCount: this.allowedCount };
  }

  public resetStats(): void {
    this.checkedCount = 0; this.blockedLayer1Count = 0; this.blockedLayer2Count = 0; this.allowedCount = 0;
  }
}

export function createDualLayerGuardrailCascade(options: DualLayerGuardrailCascadeOptions = {}): DualLayerGuardrailCascade {
  return new DualLayerGuardrailCascade(options);
}
