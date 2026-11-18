/**
 * @kido/ai-stream - Prompt Complexity Classifier & RouteLLM Threshold Calibrator
 *
 * Implements sub-millisecond bilingual (English + Vietnamese) query routing inspired by
 * GonnaCrash World 3 Level 15 (`cheap_model_first`), RouteLLM, and Portkey Semantic Router:
 * 1. Zero-cost local intent detection (greetings, banter, acknowledgments, capability probes)
 * 2. Structural & lexical complexity signals (stack traces, code/JSON, webhook debug, multi-constraint combos)
 * 3. Router-local trigram cosine centroid scoring (`RouteUtteranceCentroid[]`)
 * 4. RouteLLM-style threshold calibration (`calibrateRouteThreshold`) solving for optimal `tau`
 *
 * Invariant: 100% zero external runtime dependencies and zero imports from sibling slices.
 */

export type ComplexityTier = 'zero_cost' | 'easy' | 'medium' | 'hard';
export type RoutePort = 'easy' | 'hard';

export interface RouteUtteranceCentroid {
  id: string;
  tier: Exclude<ComplexityTier, 'zero_cost'>;
  port: RoutePort;
  utterances: readonly string[];
  weight?: number;
}

export interface ComplexitySignals {
  charLength: number;
  estimatedTokens: number;
  hasCodeBlock: boolean;
  hasStackTrace: boolean;
  hasJsonOrPayload: boolean;
  hasWebhookOrInfraDebug: boolean;
  hasComparisonOrTradeoff: boolean;
  hasMultiConstraintBudget: boolean;
  hasMultiStepReasoning: boolean;
  questionMarkCount: number;
  historyTurns: number;
  semanticEasySimilarity: number;
  semanticHardSimilarity: number;
  semanticMediumSimilarity: number;
  matchedCentroidId: string | null;
}

export interface ClassificationResult {
  tier: ComplexityTier;
  routePort: RoutePort;
  score: number;
  threshold: number;
  reasons: string[];
  signals: ComplexitySignals;
  durationMs: number;
}

export interface PromptComplexityClassifierOptions {
  threshold?: number;
  mediumFloor?: number;
  hardFloor?: number;
  centroids?: readonly RouteUtteranceCentroid[];
  zeroCostMaxChars?: number;
  extraZeroCostPatterns?: readonly RegExp[];
  vectorDimensions?: number;
}

export interface ClassifyPromptOptions {
  historyTurns?: number;
}

export interface RouteCalibrationSample {
  prompt: string;
  expectedPort?: RoutePort;
  score?: number;
  historyTurns?: number;
}

export interface CalibrateThresholdOptions {
  targetHardShare?: number;
  maxCostPerTaskCents?: number;
  smallCostCents?: number;
  largeCostCents?: number;
  minThreshold?: number;
  maxThreshold?: number;
  classifier?: PromptComplexityClassifier;
}

export interface RouteThresholdCalibrationResult {
  optimalTau: number;
  achievedHardShare: number;
  targetHardShare: number;
  estimatedCostPerTaskCents: number;
  estimatedAccuracyPct?: number;
  sampleCount: number;
  hardCount: number;
  easyCount: number;
  zeroCostCount: number;
}

export const DEFAULT_ROUTE_CENTROIDS: readonly RouteUtteranceCentroid[] = [
  {
    id: 'easy_account_and_faq',
    tier: 'easy',
    port: 'easy',
    utterances: [
      'forgot password how do i reset my password',
      'quên mật khẩu thì làm sao để đặt lại',
      'where can i download my monthly vat invoice',
      'lấy hóa đơn vat ở đâu vậy shop',
      'what are your business opening hours and shipping fee',
      'giờ mở cửa và phí ship nội thành bao nhiêu',
      'how do i track my order status or return policy',
      'kiểm tra tình trạng đơn hàng và chính sách đổi trả',
      'giấy vẽ màu nước baohong 300gsm giá bao nhiêu còn hàng không',
      'how much is the watercolor paper 300gsm in stock',
      'how to cancel or pause my subscription plan',
      'cách hủy gói hoặc đổi mật khẩu tài khoản',
    ],
  },
  {
    id: 'medium_workflow_troubleshoot',
    tier: 'medium',
    port: 'easy',
    utterances: [
      'customer paid via bank transfer two hours ago but order status is still pending what steps should i check',
      'khách đã chuyển khoản hơn 2 tiếng mà đơn hàng vẫn chờ xác nhận cần kiểm tra bước nào',
      'how do i configure order notifications and export weekly revenue reports',
      'hướng dẫn cấu hình thông báo đơn hàng mới và xuất báo cáo doanh thu hàng tuần',
      'can i combine a store voucher with wholesale tier pricing on the same checkout',
      'có thể áp dụng đồng thời mã giảm giá và bảng giá sỉ trong cùng một đơn không',
    ],
  },
  {
    id: 'hard_code_and_webhook_debug',
    tier: 'hard',
    port: 'hard',
    utterances: [
      'debug webhook hmac sha256 signature verification failing with 401 on raw json payload',
      'sửa lỗi xác thực chữ ký hmac sha256 của webhook bị trả về 401 với payload json',
      'typeerror cannot read properties of undefined reading stack trace in async handler',
      'postgresql deadlock query explain analyze index optimization for high concurrency writes',
      'tại sao service bị timeout 502 gateway và memory leak khi stream sse qua nginx',
      'fix react hydration mismatch and cors preflight failure across edge proxy',
    ],
  },
  {
    id: 'hard_multi_constraint_comparison',
    tier: 'hard',
    port: 'hard',
    utterances: [
      'compare pros and cons architecture tradeoffs under strict latency and budget constraints',
      'so sánh chi tiết ưu nhược điểm và tư vấn combo họa cụ tối ưu dưới 500k cho người mới bắt đầu',
      'recommend a complete multi item watercolor starter bundle under 400k with paper brushes and palette',
      'phân tích nên chọn giải pháp nào giữa hai phương án dựa trên chi phí tải cao và độ trễ',
      'design a resilient rate limited queue migration strategy with zero downtime',
    ],
  },
];

const ZERO_COST_EXACT_PATTERNS: readonly RegExp[] = [
  /^(?:hi|hello|hey|yo|sup|ping|test|alo|a\s*l[oô]|ch[aà]o(?:\s+(?:shop|b[aạ]n|em|anh|ch[iị]|ad|admin|bot))?|xin\s*ch[aà]o(?:\s+(?:shop|b[aạ]n|qu[yý]\s*kh[aá]ch))?|good\s+(?:morning|afternoon|evening)|ch[aà]o\s+bu[oổ]i\s+(?:s[aá]ng|tr[uư]a|t[oố]i))[!?.…~\s]*$/iu,
  /^(?:thanks?(?:\s+you)?(?:\s+(?:so|very)\s+much)?|ty|tks|thx|c[aả]m\s*[oơ]n(?:\s+(?:shop|b[aạ]n|ad|admin|em|anh|ch[iị]|bot))?(?:\s+(?:r[aấ]t\s+)?nhi[eề]u)?(?:\s+(?:nh[eé]|nha|[aạ]))?|c[aá]m\s*[oơ]n(?:\s+(?:shop|b[aạ]n|ad|admin|em|anh|ch[iị]|bot))?(?:\s+(?:r[aấ]t\s+)?nhi[eề]u)?(?:\s+(?:nh[eé]|nha|[aạ]))?)[!?.…~\s]*$/iu,
  /^(?:ok|oke|okie|oki|okay|got\s+it|noted|cool|great|nice|bye|goodbye|t[aạ]m\s*bi[eệ]t|h[eẹ]n\s*g[aặ]p\s*l[aạ]i|d[aạ]\s*v[aâ]ng|v[aâ]ng\s*[aạ]|r[oõ]\s*r[oồ]i)[!?.…~\s]*$/iu,
  /^(?:help|what\s+can\s+you\s+do|who\s+are\s+you|b[aạ]n\s+l[aà]\s+ai|bot\s+l[aà]m\s+[dđ][uư][oợ]c\s+g[iì]|h[uư][oớ]ng\s+d[aẫ]n\s+s[uử]\s+d[uụ]ng)[!?.…~\s]*$/iu,
];

const NON_WORD_EMOJI_ONLY_RE = /^[\p{Emoji}\p{P}\p{S}\s]+$/u;

const STACK_TRACE_RE =
  /(?:\b(?:TypeError|ReferenceError|SyntaxError|RangeError|EvalError|AggregateError|UnhandledPromiseRejection|AssertionError|PrismaClientKnownRequestError|SQLSTATE)\b|Traceback\s+\(most recent call last\)|at\s+[\w.$<>]+\s+\([^)\n]+:\d+:\d+\)|^\s*at\s+\S+:\d+:\d+|\b(?:ECONNREFUSED|ETIMEDOUT|ENOTFOUND|ERR_SSL|SIGKILL|OOMKilled)\b|\bHTTP\s*(?:401|403|429|500|502|503|504)\b)/im;

const CODE_BLOCK_RE =
  /```[\s\S]*?```|`[^`\n]{12,}`|\b(?:async\s+function|const\s+\w+\s*=|let\s+\w+\s*=|import\s+\{[^}]+\}\s+from|export\s+(?:async\s+)?function|SELECT\s+[\s\S]{1,80}\s+FROM|CREATE\s+(?:TABLE|INDEX)|ALTER\s+TABLE|crypto\.createHmac)\b|=>\s*\{/i;

const JSON_PAYLOAD_RE =
  /\{\s*"[^"\n]{1,48}"\s*:\s*(?:"[^"\n]*"|\d+|true|false|null|\{|\[)[\s\S]*\}|\[\s*\{\s*"[^"\n]{1,48}"\s*:/;

const WEBHOOK_INFRA_DEBUG_RE =
  /(?<![\p{L}\p{N}_])(?:webhook|hmac|sha256|sha-256|signature\s+verification|verify\s+signature|chữ\s+ký|chu\s+ky|stack\s*trace|stacktrace|debug(?:ging)?|deadlock|race\s+condition|memory\s+leak|explain\s+analyze|pgvector|hnsw|ivfflat|cors\s+preflight|hydration\s+mismatch|connection\s+pool|oauth2?\s+(?:callback|pkce|token)|jwt\s+verify|ssl\s+handshake|tls\s+error|reverse\s+proxy|rate\s+limit\s+429|timeout\s+50[24]|lỗi\s+(?:401|403|429|500|502|504|chữ\s+ký|xác\s+thực|timeout|kết\s+nối)|sửa\s+lỗi\s+(?:code|api|webhook|database|query|docker))(?![\p{L}\p{N}_])/iu;

const COMPARISON_TRADEOFF_RE =
  /(?<![\p{L}\p{N}_])(?:compare|comparison|versus|\bvs\.?\b|trade-?offs?|pros\s+and\s+cons|difference\s+between|which\s+(?:one\s+)?is\s+better|benchmark|architecture\s+review|so\s+sánh|so\s+sanh|ưu\s+nhược\s+điểm|uu\s+nhuoc\s+diem|khác\s+nhau(?:\s+như\s+thế\s+nào)?|cái\s+nào\s+tốt\s+hơn|nên\s+chọn\s+(?:cái\s+nào|phương\s+án)|phân\s+tích\s+chi\s+tiết)(?![\p{L}\p{N}_])/iu;

const COMBO_ADVISORY_RE =
  /(?<![\p{L}\p{N}_])(?:combo|bundle|starter\s+kit|set\s+đầy\s+đủ|bộ\s+đầy\s+đủ|tư\s+vấn|tu\s+van|gợi\s+ý\s+bộ|recommend\s+(?:a\s+)?(?:complete|full|starter)|thiết\s+kế\s+hệ\s+thống|design\s+(?:a\s+)?(?:scalable|distributed|system))(?![\p{L}\p{N}_])/iu;

const BUDGET_CONSTRAINT_RE =
  /(?<![\p{L}\p{N}_])(?:dưới\s+\d+(?:[.,]\d+)?\s*(?:k|tr|triệu|nghìn|đ|vnđ)?|duoi\s+\d+(?:[.,]\d+)?\s*(?:k|tr)|từ\s+\d+.*(?:đến|-)\s*\d+|ngân\s+sách|ngan\s+sach|budget|under\s+\$?\d+|within\s+\$?\d+|tối\s+đa\s+\d+|max\s+\$?\d+)(?![\p{L}\p{N}_])/iu;

const SECONDARY_CONSTRAINT_RE =
  /(?<![\p{L}\p{N}_])(?:cho\s+người\s+mới|nguoi\s+moi|beginner|intermediate|advanced|vừa\s+.+\s+vừa|kèm\s+(?:theo)?|phù\s+hợp\s+với|requirements?|constraints?|multi-?tenant|high\s+availability|zero\s+downtime|low\s+latency|sla|compliance|gdpr)(?![\p{L}\p{N}_])/iu;

const MULTI_STEP_RE =
  /(?:^\s*(?:1\.|2\.|3\.)\s+|\b(?:step\s+by\s+step|end-to-end|root\s+cause|migration\s+plan|từng\s+bước|nguyên\s+nhân\s+gốc\s+rễ|kế\s+hoạch\s+chuyển\s+đổi)\b)/im;

function stripRouterDiacritics(input: string): string {
  if (!input) return '';
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
}

function normalizeRouterText(input: string): string {
  if (!input) return '';
  return stripRouterDiacritics(input.normalize('NFC').toLowerCase())
    .replace(/[?!.,;:"'()[\]{}`~@#$%^&*+=<>\\/|_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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

function normalizeL2(vec: number[]): number[] {
  let normSq = 0;
  for (let i = 0; i < vec.length; i++) normSq += vec[i] * vec[i];
  const norm = Math.sqrt(normSq);
  if (norm === 0) return vec;
  for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  return vec;
}

/**
 * Router-local character-trigram + word-unigram/bigram signed hash vectorizer.
 * Produces an L2-normalized dense vector in <0.05ms with zero sibling dependencies.
 */
export function computeRouterTrigramVector(text: string, dimensions = 128): number[] {
  const dims = Math.max(8, Math.floor(dimensions));
  const vec = new Array<number>(dims).fill(0);
  const normalized = normalizeRouterText(text);
  if (!normalized) return vec;

  const tokens = normalized.split(' ').filter(Boolean);
  if (tokens.length === 0) return vec;

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    addHashedFeature(vec, `u:${tok}`, 2.5);
    const padded = `^${tok}$`;
    for (let j = 0; j <= padded.length - 3; j++) {
      addHashedFeature(vec, `c:${padded.slice(j, j + 3)}`, 1.0);
    }
    if (i + 1 < tokens.length) {
      addHashedFeature(vec, `b:${tok}_${tokens[i + 1]}`, 0.75);
    }
  }

  return normalizeL2(vec);
}

/**
 * Computes cosine similarity between two equal-length vectors in [-1, 1].
 */
export function computeRouterCosineSimilarity(vecA: readonly number[], vecB: readonly number[]): number {
  if (!vecA || !vecB || vecA.length === 0 || vecA.length !== vecB.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dot += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function clamp01(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

interface CompiledCentroid {
  id: string;
  tier: Exclude<ComplexityTier, 'zero_cost'>;
  port: RoutePort;
  weight: number;
  vector: number[];
}

/**
 * Sub-millisecond bilingual prompt complexity classifier combining:
 * 1. Deterministic zero-cost short-circuit checks (0c)
 * 2. Structural & lexical difficulty heuristics (stack traces, code/JSON, webhook debug, multi-constraint combos)
 * 3. Semantic cosine centroid similarity (`RouteUtteranceCentroid[]`)
 */
export class PromptComplexityClassifier {
  private threshold: number;
  private readonly mediumFloor: number;
  private readonly hardFloor: number;
  private readonly zeroCostMaxChars: number;
  private readonly extraZeroCostPatterns: readonly RegExp[];
  private readonly vectorDimensions: number;
  private readonly compiledCentroids: CompiledCentroid[];

  constructor(options: PromptComplexityClassifierOptions = {}) {
    this.threshold = clamp01(options.threshold ?? 0.52);
    this.mediumFloor = clamp01(options.mediumFloor ?? 0.34);
    this.hardFloor = clamp01(options.hardFloor ?? 0.58);
    this.zeroCostMaxChars = Math.max(1, options.zeroCostMaxChars ?? 48);
    this.extraZeroCostPatterns = options.extraZeroCostPatterns ?? [];
    this.vectorDimensions = Math.max(8, options.vectorDimensions ?? 128);

    const centroids = options.centroids ?? DEFAULT_ROUTE_CENTROIDS;
    this.compiledCentroids = centroids.map((c) => {
      const avg = new Array<number>(this.vectorDimensions).fill(0);
      for (const utt of c.utterances) {
        const uv = computeRouterTrigramVector(utt, this.vectorDimensions);
        for (let i = 0; i < this.vectorDimensions; i++) avg[i] += uv[i];
      }
      return {
        id: c.id,
        tier: c.tier,
        port: c.port,
        weight: c.weight ?? 1.0,
        vector: normalizeL2(avg),
      };
    });
  }

  public getThreshold(): number {
    return this.threshold;
  }

  public setThreshold(tau: number): void {
    this.threshold = clamp01(tau);
  }

  private isZeroCostPrompt(trimmed: string): string | null {
    if (!trimmed) return 'empty_prompt';
    if (trimmed.length <= this.zeroCostMaxChars && NON_WORD_EMOJI_ONLY_RE.test(trimmed)) {
      return 'emoji_or_punctuation_only';
    }
    if (trimmed.length <= this.zeroCostMaxChars) {
      for (const rx of ZERO_COST_EXACT_PATTERNS) {
        if (rx.test(trimmed)) return 'zero_cost_greeting_or_ack';
      }
      for (const rx of this.extraZeroCostPatterns) {
        if (rx.test(trimmed)) return 'zero_cost_custom_pattern';
      }
    }
    return null;
  }

  public classify(prompt: string, options: ClassifyPromptOptions = {}): ClassificationResult {
    const startMs = performance.now();
    const raw = (prompt ?? '').normalize('NFC').trim();
    const historyTurns = Math.max(0, options.historyTurns ?? 0);
    const charLength = raw.length;
    const estimatedTokens = charLength > 0 ? Math.max(1, Math.ceil(charLength / 3.5)) : 0;
    const questionMarkCount = (raw.match(/\?/g) ?? []).length;

    const zeroCostReason = this.isZeroCostPrompt(raw);
    if (zeroCostReason) {
      return {
        tier: 'zero_cost',
        routePort: 'easy',
        score: 0,
        threshold: this.threshold,
        reasons: [zeroCostReason],
        signals: {
          charLength,
          estimatedTokens,
          hasCodeBlock: false,
          hasStackTrace: false,
          hasJsonOrPayload: false,
          hasWebhookOrInfraDebug: false,
          hasComparisonOrTradeoff: false,
          hasMultiConstraintBudget: false,
          hasMultiStepReasoning: false,
          questionMarkCount,
          historyTurns,
          semanticEasySimilarity: 0,
          semanticHardSimilarity: 0,
          semanticMediumSimilarity: 0,
          matchedCentroidId: null,
        },
        durationMs: Number((performance.now() - startMs).toFixed(4)),
      };
    }

    const hasStackTrace = STACK_TRACE_RE.test(raw);
    const hasCodeBlock = CODE_BLOCK_RE.test(raw);
    const hasJsonOrPayload = JSON_PAYLOAD_RE.test(raw);
    const hasWebhookOrInfraDebug = WEBHOOK_INFRA_DEBUG_RE.test(raw);
    const hasComparisonOrTradeoff = COMPARISON_TRADEOFF_RE.test(raw);
    const hasCombo = COMBO_ADVISORY_RE.test(raw);
    const hasBudget = BUDGET_CONSTRAINT_RE.test(raw);
    const hasSecondaryConstraint = SECONDARY_CONSTRAINT_RE.test(raw);
    const hasMultiConstraintBudget =
      (hasCombo && (hasBudget || hasSecondaryConstraint)) ||
      (hasBudget && hasSecondaryConstraint) ||
      (hasCombo && estimatedTokens >= 24);
    const hasMultiStepReasoning = MULTI_STEP_RE.test(raw);

    const queryVec = computeRouterTrigramVector(raw, this.vectorDimensions);
    let semanticEasySimilarity = 0;
    let semanticHardSimilarity = 0;
    let semanticMediumSimilarity = 0;
    let bestSim = -1;
    let matchedCentroidId: string | null = null;
    let bestCentroidPort: RoutePort | null = null;

    for (const centroid of this.compiledCentroids) {
      const sim = computeRouterCosineSimilarity(queryVec, centroid.vector) * centroid.weight;
      if (centroid.tier === 'easy' && sim > semanticEasySimilarity) semanticEasySimilarity = sim;
      if (centroid.tier === 'hard' && sim > semanticHardSimilarity) semanticHardSimilarity = sim;
      if (centroid.tier === 'medium' && sim > semanticMediumSimilarity) semanticMediumSimilarity = sim;
      if (sim > bestSim) {
        bestSim = sim;
        matchedCentroidId = centroid.id;
        bestCentroidPort = centroid.port;
      }
    }

    const reasons: string[] = [];
    let score = 0.08;

    if (hasStackTrace) {
      score += 0.56;
      reasons.push('stack_trace_detected');
    }
    if (hasCodeBlock) {
      score += 0.48;
      reasons.push('code_snippet_detected');
    }
    if (hasJsonOrPayload) {
      score += 0.42;
      reasons.push('json_payload_detected');
    }
    if (hasWebhookOrInfraDebug) {
      score += 0.48;
      reasons.push('webhook_or_infra_debug');
    }
    if (hasComparisonOrTradeoff) {
      score += 0.46;
      reasons.push('comparison_or_tradeoff');
    }
    if (hasMultiConstraintBudget) {
      score += 0.48;
      reasons.push('multi_constraint_budget_combo');
    }
    if (hasMultiStepReasoning) {
      score += 0.24;
      reasons.push('multi_step_reasoning');
    }
    if (questionMarkCount >= 2) {
      score += 0.14;
      reasons.push('multiple_questions');
    }
    if (estimatedTokens >= 75) {
      score += 0.16;
      reasons.push('long_context_prompt');
    } else if (estimatedTokens >= 40) {
      score += 0.08;
      reasons.push('moderate_length_prompt');
    }
    if (historyTurns >= 6) {
      score += 0.16;
      reasons.push('deep_conversation_history');
    } else if (historyTurns >= 3) {
      score += 0.08;
    }

    const semanticDelta = semanticHardSimilarity - semanticEasySimilarity;
    if (semanticDelta > 0.08) {
      const boost = Math.min(0.28, semanticDelta * 0.65);
      score += boost;
      reasons.push(`semantic_hard_centroid:${matchedCentroidId ?? 'unknown'}`);
    } else if (semanticDelta < -0.08) {
      score -= Math.min(0.14, Math.abs(semanticDelta) * 0.35);
      reasons.push(`semantic_easy_centroid:${matchedCentroidId ?? 'unknown'}`);
    } else if (semanticMediumSimilarity > semanticEasySimilarity && semanticMediumSimilarity > 0.22) {
      score += 0.14;
      reasons.push(`semantic_medium_centroid:${matchedCentroidId ?? 'unknown'}`);
    }

    // If custom hard centroids strongly match unseen wording without triggering regexes, honor semantic port
    if (bestCentroidPort === 'hard' && bestSim >= 0.48 && score < this.threshold) {
      score = Math.max(score, this.threshold + 0.08);
      reasons.push(`strong_custom_hard_centroid:${matchedCentroidId}`);
    }

    score = Number(clamp01(score).toFixed(4));
    const routePort: RoutePort = score >= this.threshold ? 'hard' : 'easy';

    let tier: ComplexityTier;
    if (score >= this.hardFloor || (routePort === 'hard' && score >= this.threshold)) {
      tier = score >= this.hardFloor ? 'hard' : 'medium';
    } else if (score >= this.mediumFloor) {
      tier = 'medium';
    } else {
      tier = 'easy';
    }

    if (reasons.length === 0) reasons.push('simple_faq_baseline');

    return {
      tier,
      routePort,
      score,
      threshold: this.threshold,
      reasons,
      signals: {
        charLength,
        estimatedTokens,
        hasCodeBlock,
        hasStackTrace,
        hasJsonOrPayload,
        hasWebhookOrInfraDebug,
        hasComparisonOrTradeoff,
        hasMultiConstraintBudget,
        hasMultiStepReasoning,
        questionMarkCount,
        historyTurns,
        semanticEasySimilarity: Number(semanticEasySimilarity.toFixed(4)),
        semanticHardSimilarity: Number(semanticHardSimilarity.toFixed(4)),
        semanticMediumSimilarity: Number(semanticMediumSimilarity.toFixed(4)),
        matchedCentroidId,
      },
      durationMs: Number((performance.now() - startMs).toFixed(4)),
    };
  }
}

/**
 * RouteLLM-style threshold calibrator (`tau` in [minThreshold, maxThreshold]).
 * Accepts either a numeric `targetHardShare` (e.g. `0.20` for 80/20 routing) or an options object
 * with `targetHardShare` and/or `maxCostPerTaskCents` budget cap.
 */
export function calibrateRouteThreshold(
  samples: readonly RouteCalibrationSample[],
  targetHardShareOrBudget: number | CalibrateThresholdOptions = 0.2
): RouteThresholdCalibrationResult {
  const opts: CalibrateThresholdOptions =
    typeof targetHardShareOrBudget === 'number'
      ? { targetHardShare: targetHardShareOrBudget }
      : targetHardShareOrBudget ?? {};

  const smallCost = opts.smallCostCents ?? 0.0273;
  const largeCost = opts.largeCostCents ?? 3.19;
  const minTau = clamp01(opts.minThreshold ?? 0.15);
  const maxTau = Math.max(minTau, clamp01(opts.maxThreshold ?? 0.92));
  const classifier = opts.classifier ?? new PromptComplexityClassifier();

  let targetHardShare = opts.targetHardShare ?? 0.2;
  if (typeof opts.maxCostPerTaskCents === 'number' && largeCost > smallCost) {
    const maxAffordableShare = clamp01((opts.maxCostPerTaskCents - smallCost) / (largeCost - smallCost));
    targetHardShare =
      opts.targetHardShare !== undefined ? Math.min(targetHardShare, maxAffordableShare) : maxAffordableShare;
  }
  targetHardShare = clamp01(targetHardShare);

  if (!samples || samples.length === 0) {
    return {
      optimalTau: Number(classifier.getThreshold().toFixed(4)),
      achievedHardShare: 0,
      targetHardShare: Number(targetHardShare.toFixed(4)),
      estimatedCostPerTaskCents: 0,
      sampleCount: 0,
      hardCount: 0,
      easyCount: 0,
      zeroCostCount: 0,
    };
  }

  let zeroCostCount = 0;
  const scored: Array<{ score: number; expectedPort?: RoutePort; isZeroCost: boolean }> = [];
  for (const s of samples) {
    const res = classifier.classify(s.prompt, { historyTurns: s.historyTurns });
    const isZero = res.tier === 'zero_cost' && s.score === undefined;
    if (isZero) zeroCostCount++;
    scored.push({
      score: s.score !== undefined ? clamp01(s.score) : res.score,
      expectedPort: s.expectedPort,
      isZeroCost: isZero,
    });
  }

  const nonZeroScores = Array.from(
    new Set(scored.filter((s) => !s.isZeroCost).map((s) => Number(s.score.toFixed(4))))
  ).sort((a, b) => a - b);

  // Build max-margin midpoint candidates between sorted sample scores so ties prefer the widest separation margin
  const candidateTaus = new Set<number>([minTau, maxTau, Math.min(maxTau, Math.max(minTau, classifier.getThreshold()))]);
  for (let i = 0; i < nonZeroScores.length; i++) {
    const cur = nonZeroScores[i];
    if (i + 1 < nonZeroScores.length) {
      const mid = (cur + nonZeroScores[i + 1]) / 2;
      candidateTaus.add(Number(Math.min(maxTau, Math.max(minTau, mid)).toFixed(4)));
    }
    const clampedCur = Math.min(maxTau, Math.max(minTau, cur));
    candidateTaus.add(Number(clampedCur.toFixed(4)));
  }

  const defaultTau = classifier.getThreshold();
  const hasLabels = scored.some((s) => s.expectedPort !== undefined);
  let bestTau = minTau;
  let bestDiff = Infinity;
  let bestAccuracy = -1;
  let bestMarginDist = Infinity;
  let bestMetrics = { hardCount: 0, easyCount: 0, achievedHardShare: 0, cost: smallCost };

  for (const tau of Array.from(candidateTaus).sort((a, b) => a - b)) {
    let hardCount = 0;
    let easyCount = 0;
    let correct = 0;
    let labeled = 0;

    for (const item of scored) {
      if (item.isZeroCost) {
        if (item.expectedPort === 'easy') {
          correct++;
          labeled++;
        } else if (item.expectedPort === 'hard') {
          labeled++;
        }
        continue;
      }
      const pred: RoutePort = item.score >= tau ? 'hard' : 'easy';
      if (pred === 'hard') hardCount++;
      else easyCount++;

      if (item.expectedPort) {
        labeled++;
        if (pred === item.expectedPort) correct++;
      }
    }

    const activeTotal = scored.length;
    const hardShare = activeTotal > 0 ? hardCount / activeTotal : 0;
    const nonZeroEasyShare = activeTotal > 0 ? easyCount / activeTotal : 0;
    const estCost = nonZeroEasyShare * smallCost + hardShare * largeCost;
    const budgetOk = opts.maxCostPerTaskCents === undefined || estCost <= opts.maxCostPerTaskCents + 1e-6;
    const diff = Math.abs(hardShare - targetHardShare) + (budgetOk ? 0 : 10);
    const acc = labeled > 0 ? correct / labeled : -1;
    const distToDefault = Math.abs(tau - defaultTau);

    const betterShare = diff < bestDiff - 1e-6;
    const tiedShareBetterAcc = Math.abs(diff - bestDiff) <= 1e-6 && acc > bestAccuracy + 1e-6;
    const tiedAllCloserToMargin =
      Math.abs(diff - bestDiff) <= 1e-6 &&
      Math.abs(acc - bestAccuracy) <= 1e-6 &&
      distToDefault < bestMarginDist;

    if (betterShare || tiedShareBetterAcc || tiedAllCloserToMargin) {
      bestTau = tau;
      bestDiff = diff;
      bestAccuracy = acc;
      bestMarginDist = distToDefault;
      bestMetrics = { hardCount, easyCount, achievedHardShare: hardShare, cost: estCost };
    }
  }

  return {
    optimalTau: Number(bestTau.toFixed(4)),
    achievedHardShare: Number(bestMetrics.achievedHardShare.toFixed(4)),
    targetHardShare: Number(targetHardShare.toFixed(4)),
    estimatedCostPerTaskCents: Number(bestMetrics.cost.toFixed(4)),
    estimatedAccuracyPct: hasLabels && bestAccuracy >= 0 ? Number((bestAccuracy * 100).toFixed(2)) : undefined,
    sampleCount: samples.length,
    hardCount: bestMetrics.hardCount,
    easyCount: bestMetrics.easyCount,
    zeroCostCount,
  };
}
