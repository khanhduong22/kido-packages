/**
 * @kido/ai-stream - FrugalGPT Confidence Scorer & Intelligent Model Router
 *
 * Implements GonnaCrash World 3 Level 15 (`cheap_model_first`) & Stanford FrugalGPT cascade:
 * 1. `evaluateAnswerConfidence`: <1ms deterministic response quality scorer in [0, 1]
 * 2. `IntelligentModelRouter`: zero-cost local bypass + complexity routing + large-tier RPM shield
 * 3. `FrugalModelCascade`: try-small-first cascade escalating to `large` only when confidence < threshold
 * 4. Graceful large-tier degradation (never cascades 429 failures) + rolling cost/savings telemetry
 *
 * Invariant: 100% zero external runtime dependencies and zero imports from sibling slices.
 */

import {
  PromptComplexityClassifier,
  type ClassificationResult,
  type ComplexityTier,
  type PromptComplexityClassifierOptions,
  type RoutePort,
} from './complexity-classifier.js';

export interface AnswerConfidenceOptions {
  minLengthChars?: number;
  requiredEntities?: readonly string[];
  requirePriceGrounding?: boolean;
  requireCitations?: boolean;
  expectedFormat?: 'text' | 'json' | 'code';
  minConfidence?: number;
}

export interface AnswerConfidenceResult {
  score: number;
  passed: boolean;
  reasons: string[];
  checks: {
    nonEmptyAndSufficientLength: boolean;
    noRefusalOrHedging: boolean;
    entityGrounded: boolean;
    priceGrounded: boolean;
    citationGrounded: boolean;
    structurallyComplete: boolean;
  };
}

export type ModelTierSelection = 'zero_cost' | 'small' | 'large';
export type LargeCeilingFallbackMode = 'small_fallback' | 'static_fallback' | 'throw';

export interface ModelInvocationResult {
  answer: string;
  model?: string;
  ttftMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  costCents?: number;
}

export interface RouteHandlerContext {
  prompt: string;
  classification: ClassificationResult;
  targetTier: ModelTierSelection;
  isEscalation: boolean;
  isDegradedFallback: boolean;
}

export type ModelHandler = (
  ctx: RouteHandlerContext
) => Promise<string | ModelInvocationResult> | string | ModelInvocationResult;

export interface ModelRouterHandlers {
  zeroCostHandler?: ModelHandler;
  smallModelHandler: ModelHandler;
  largeModelHandler: ModelHandler;
}

export interface ModelRouterCostConfig {
  zeroCostCents?: number;
  smallCostCents?: number;
  largeCostCents?: number;
}

export interface IntelligentModelRouterOptions {
  handlers: ModelRouterHandlers;
  classifier?: PromptComplexityClassifier;
  classifierOptions?: PromptComplexityClassifierOptions;
  enableCascade?: boolean;
  trySmallFirstOnHard?: boolean;
  minConfidence?: number;
  confidenceOptions?: Omit<AnswerConfidenceOptions, 'minConfidence'>;
  costs?: ModelRouterCostConfig;
  smallModelName?: string;
  largeModelName?: string;
  zeroCostModelName?: string;
  largeTierMaxRpm?: number;
  largeTierWindowMs?: number;
  largeCeilingFallbackMode?: LargeCeilingFallbackMode;
  staticFallbackAnswer?: string;
  now?: () => number;
}

export interface FrugalModelCascadeOptions extends Omit<IntelligentModelRouterOptions, 'enableCascade'> {
  minConfidence?: number;
}

export interface RouteRequest {
  prompt: string;
  historyTurns?: number;
  confidenceOptions?: AnswerConfidenceOptions;
  nowMs?: number;
}

export interface RouteClassificationPreview {
  classification: ClassificationResult;
  targetModelTier: ModelTierSelection;
  largeTierHasCapacity: boolean;
}

export interface RouteExecutionResult {
  answer: string;
  tier: ComplexityTier;
  routePort: RoutePort;
  selectedModelTier: ModelTierSelection;
  modelName: string;
  escalated: boolean;
  degradedFromLarge: boolean;
  degradationReason?: 'large_rpm_ceiling' | 'large_upstream_429';
  classification: ClassificationResult;
  confidence?: AnswerConfidenceResult;
  costCents: number;
  baselineAllLargeCostCents: number;
  savedCents: number;
  latencyMs: number;
  headers: Record<string, string>;
}

export interface ModelRouterStats {
  totalRequests: number;
  zeroCostCount: number;
  smallCount: number;
  largeCount: number;
  easyTierCount: number;
  mediumTierCount: number;
  hardTierCount: number;
  escalatedCount: number;
  degradedFromLargeCount: number;
  largeRpmBlockedCount: number;
  easySharePct: number;
  hardSharePct: number;
  zeroCostSharePct: number;
  totalCostCents: number;
  totalBaselineCostCents: number;
  totalSavedCents: number;
  savingsPct: number;
  avgCostPerTaskCents: number;
  largeTierMaxRpm: number;
  largeTierRemainingRpm: number;
}

const REFUSAL_OR_HEDGING_PATTERNS: readonly RegExp[] = [
  /\b(?:i\s+(?:don't|do\s+not|cannot|can't)\s+(?:know|answer|help|verify|find|confirm|access)|i\s+am\s+not\s+sure|i'm\s+not\s+sure|not\s+enough\s+information|unable\s+to\s+(?:determine|assist|verify|confirm)|no\s+information\s+available|as\s+an\s+ai(?:\s+language\s+model)?|please\s+contact\s+support\s+for\s+more)\b/i,
  /(?:t[oô]i|m[iì]nh|em)\s*(?:kh[oô]ng\s*(?:bi[eế]t|ch[aắ]c|r[oõ]|th[eể]\s*(?:x[aá]c\s*nh[aậ]n|tr[aả]\s*l[oờ]i|ki[eể]m\s*tra|h[oỗ]\s*tr[oợ]))|ch[uư]a\s*(?:c[oó]\s*th[oô]ng\s*tin|r[oõ]))|kh[oô]ng\s+t[iì]m\s+th[aấ]y\s+th[oô]ng\s+tin|xin\s+l[oỗ]i.*kh[oô]ng\s+th[eể]/iu,
];

const PRICE_GROUNDING_RE =
  /(?:\d+(?:[.,]\d+)?\s*(?:k|nghìn|nghin|tr|triệu|trieu|vnđ|vnd|đ|usd|cents?|¢)|\$[\d,]+(?:\.\d+)?|\bmiễn\s+phí\b|\bfree\b)/iu;

const CITATION_GROUNDING_RE =
  /(?:\[(?:Doc|Source|Nguồn|Ref)\s*\d+\]|\[[^\]]+\]\([^)]+\)|https?:\/\/\S+)/iu;

const REPETITIVE_LINE_RE = /(.{8,})\n(?:\1\n){3,}/;

function stripDiacriticsFold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
}

function tryParseJsonPayload(answer: string): boolean {
  const trimmed = answer.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  try {
    JSON.parse(candidate);
    return true;
  } catch {
    return false;
  }
}

/**
 * Deterministic <1ms FrugalGPT answer confidence evaluator in [0, 1].
 * Validates non-empty length, absence of refusal/uncertainty hedging, entity/price/citation grounding,
 * and structural completeness (balanced fences, valid JSON when expected, no truncated objects).
 */
export function evaluateAnswerConfidence(
  query: string,
  answer: string,
  options: AnswerConfidenceOptions = {}
): AnswerConfidenceResult {
  const minConfidence = options.minConfidence ?? 0.72;
  const minLengthChars = Math.max(1, options.minLengthChars ?? 8);
  const trimmed = (answer ?? '').normalize('NFC').trim();

  if (!trimmed) {
    return {
      score: 0,
      passed: false,
      reasons: ['empty_answer'],
      checks: {
        nonEmptyAndSufficientLength: false,
        noRefusalOrHedging: false,
        entityGrounded: false,
        priceGrounded: !options.requirePriceGrounding,
        citationGrounded: !options.requireCitations,
        structurallyComplete: false,
      },
    };
  }

  let score = 1.0;
  const reasons: string[] = [];

  const nonEmptyAndSufficientLength = trimmed.length >= minLengthChars;
  if (!nonEmptyAndSufficientLength) {
    score -= 0.45;
    reasons.push('answer_too_short');
  }

  const noRefusalOrHedging = !REFUSAL_OR_HEDGING_PATTERNS.some((rx) => rx.test(trimmed));
  if (!noRefusalOrHedging) {
    score -= 0.5;
    reasons.push('refusal_or_uncertainty_hedging');
  }

  let entityGrounded = true;
  if (options.requiredEntities && options.requiredEntities.length > 0) {
    const foldedAnswer = stripDiacriticsFold(trimmed);
    let matched = 0;
    for (const entity of options.requiredEntities) {
      if (entity && foldedAnswer.includes(stripDiacriticsFold(entity))) {
        matched++;
      }
    }
    const coverage = matched / options.requiredEntities.length;
    if (coverage < 1) {
      entityGrounded = false;
      score -= Math.max(0.2, 0.4 * (1 - coverage));
      reasons.push(`missing_required_entities:${matched}/${options.requiredEntities.length}`);
    }
  }

  let priceGrounded = true;
  if (options.requirePriceGrounding) {
    priceGrounded = PRICE_GROUNDING_RE.test(trimmed);
    if (!priceGrounded) {
      score -= 0.3;
      reasons.push('missing_price_grounding');
    }
  }

  let citationGrounded = true;
  if (options.requireCitations) {
    citationGrounded = CITATION_GROUNDING_RE.test(trimmed);
    if (!citationGrounded) {
      score -= 0.3;
      reasons.push('missing_source_citations');
    }
  }

  let structurallyComplete = true;
  const codeFenceCount = (trimmed.match(/```/g) ?? []).length;
  if (codeFenceCount % 2 !== 0) {
    structurallyComplete = false;
    score -= 0.35;
    reasons.push('unclosed_code_fence');
  }

  if (options.expectedFormat === 'json') {
    if (!tryParseJsonPayload(trimmed)) {
      structurallyComplete = false;
      score -= 0.45;
      reasons.push('invalid_json_format');
    }
  } else if (options.expectedFormat === 'code') {
    const looksLikeCode =
      codeFenceCount >= 2 || /\b(?:function|const|let|async|return|SELECT|CREATE|import)\b|=>/i.test(trimmed);
    if (!looksLikeCode) {
      structurallyComplete = false;
      score -= 0.3;
      reasons.push('missing_expected_code_block');
    }
  } else if (
    (trimmed.startsWith('{') && !trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && !trimmed.endsWith(']'))
  ) {
    structurallyComplete = false;
    score -= 0.35;
    reasons.push('truncated_json_structure');
  }

  if (REPETITIVE_LINE_RE.test(trimmed)) {
    structurallyComplete = false;
    score -= 0.4;
    reasons.push('repetitive_degeneration');
  }

  // If user explicitly requests code/JSON fix in prompt and answer doesn't provide actionable syntax or steps
  if (
    /\b(?:json|stack\s*trace|hmac|sha256)\b/i.test(query) &&
    trimmed.length < 24 &&
    !tryParseJsonPayload(trimmed)
  ) {
    structurallyComplete = false;
    score -= 0.25;
    reasons.push('insufficient_technical_depth');
  }

  const clampedScore = Number(Math.max(0, Math.min(1, score)).toFixed(4));
  return {
    score: clampedScore,
    passed: clampedScore >= minConfidence,
    reasons,
    checks: {
      nonEmptyAndSufficientLength,
      noRefusalOrHedging,
      entityGrounded,
      priceGrounded,
      citationGrounded,
      structurallyComplete,
    },
  };
}

class SlidingWindowRpmGuard {
  private readonly maxRpm: number;
  private readonly windowMs: number;
  private readonly timestamps: number[] = [];

  constructor(maxRpm: number, windowMs = 60_000) {
    this.maxRpm = Number.isFinite(maxRpm) ? Math.max(0, Math.floor(maxRpm)) : Infinity;
    this.windowMs = Math.max(100, windowMs);
  }

  private prune(nowMs: number): void {
    const cutoff = nowMs - this.windowMs;
    while (this.timestamps.length > 0 && this.timestamps[0] <= cutoff) {
      this.timestamps.shift();
    }
  }

  public getRemaining(nowMs: number): number {
    if (!Number.isFinite(this.maxRpm)) return Infinity;
    this.prune(nowMs);
    return Math.max(0, this.maxRpm - this.timestamps.length);
  }

  public canAcquire(nowMs: number): boolean {
    if (!Number.isFinite(this.maxRpm)) return true;
    this.prune(nowMs);
    return this.timestamps.length < this.maxRpm;
  }

  public tryAcquire(nowMs: number): boolean {
    if (!Number.isFinite(this.maxRpm)) return true;
    this.prune(nowMs);
    if (this.timestamps.length >= this.maxRpm) return false;
    this.timestamps.push(nowMs);
    return true;
  }

  public reset(): void {
    this.timestamps.length = 0;
  }
}

function isUpstreamRateLimitError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const status = (err as { status?: number }).status;
  if (status === 429 || status === 503) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /\b429\b|rate\s*limit|too\s+many\s+requests|quota/i.test(msg);
}

function normalizeInvocationResult(raw: string | ModelInvocationResult, fallbackModel: string): ModelInvocationResult {
  if (typeof raw === 'string') {
    return { answer: raw, model: fallbackModel };
  }
  return {
    answer: raw.answer,
    model: raw.model ?? fallbackModel,
    ttftMs: raw.ttftMs,
    inputTokens: raw.inputTokens,
    outputTokens: raw.outputTokens,
    costCents: raw.costCents,
  };
}

function defaultZeroCostResponse(ctx: RouteHandlerContext): string {
  const isVi = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]|(?:chào|cảm ơn|cám ơn|tạm biệt)/iu.test(
    ctx.prompt
  );
  if (isVi) {
    return 'Xin chào! Mình là trợ lý AI hỗ trợ tra cứu thông tin, chính sách và kỹ thuật. Bạn cần mình giúp nội dung gì hôm nay?';
  }
  return 'Hello! I am your AI support assistant. Ask me about account help, product questions, or technical troubleshooting.';
}

/**
 * Intelligent Model Router & FrugalGPT Cascade Orchestrator:
 * - `zero_cost` -> local zero-cost handler (`0c`)
 * - `easy` -> `small` model (`0.0273c` default), with optional FrugalGPT confidence escalation to `large`
 * - `hard` -> `large` model (`3.19c` default), shielded by `large`-tier RPM ceiling protection
 */
export class IntelligentModelRouter {
  private readonly handlers: ModelRouterHandlers;
  private readonly classifier: PromptComplexityClassifier;
  private readonly enableCascade: boolean;
  private readonly trySmallFirstOnHard: boolean;
  private readonly minConfidence: number;
  private readonly defaultConfidenceOptions: Omit<AnswerConfidenceOptions, 'minConfidence'>;
  private readonly zeroCostCents: number;
  private readonly smallCostCents: number;
  private readonly largeCostCents: number;
  private readonly zeroCostModelName: string;
  private readonly smallModelName: string;
  private readonly largeModelName: string;
  private readonly largeRpmGuard: SlidingWindowRpmGuard;
  private readonly largeTierMaxRpm: number;
  private readonly largeCeilingFallbackMode: LargeCeilingFallbackMode;
  private readonly staticFallbackAnswer: string;
  private readonly now: () => number;

  private stats = {
    totalRequests: 0,
    zeroCostCount: 0,
    smallCount: 0,
    largeCount: 0,
    easyTierCount: 0,
    mediumTierCount: 0,
    hardTierCount: 0,
    escalatedCount: 0,
    degradedFromLargeCount: 0,
    largeRpmBlockedCount: 0,
    totalCostCents: 0,
    totalBaselineCostCents: 0,
  };

  constructor(options: IntelligentModelRouterOptions) {
    this.handlers = options.handlers;
    this.classifier = options.classifier ?? new PromptComplexityClassifier(options.classifierOptions);
    this.enableCascade = options.enableCascade ?? false;
    this.trySmallFirstOnHard = options.trySmallFirstOnHard ?? false;
    this.minConfidence = options.minConfidence ?? 0.72;
    this.defaultConfidenceOptions = options.confidenceOptions ?? {};
    this.zeroCostCents = options.costs?.zeroCostCents ?? 0;
    this.smallCostCents = options.costs?.smallCostCents ?? 0.0273;
    this.largeCostCents = options.costs?.largeCostCents ?? 3.19;
    this.zeroCostModelName = options.zeroCostModelName ?? 'local_zero_cost';
    this.smallModelName = options.smallModelName ?? 'openai_small';
    this.largeModelName = options.largeModelName ?? 'openai_large';
    this.largeTierMaxRpm = options.largeTierMaxRpm ?? 600;
    this.largeRpmGuard = new SlidingWindowRpmGuard(this.largeTierMaxRpm, options.largeTierWindowMs ?? 60_000);
    this.largeCeilingFallbackMode = options.largeCeilingFallbackMode ?? 'small_fallback';
    this.staticFallbackAnswer =
      options.staticFallbackAnswer ??
      'High-reasoning capacity is temporarily saturated; please retry shortly or review our documentation.';
    this.now = options.now ?? (() => Date.now());
  }

  public getClassifier(): PromptComplexityClassifier {
    return this.classifier;
  }

  public classifyOnly(prompt: string, options: { historyTurns?: number; nowMs?: number } = {}): RouteClassificationPreview {
    const classification = this.classifier.classify(prompt, { historyTurns: options.historyTurns });
    const nowMs = options.nowMs ?? this.now();
    const targetModelTier: ModelTierSelection =
      classification.tier === 'zero_cost' ? 'zero_cost' : classification.routePort === 'hard' ? 'large' : 'small';
    return {
      classification,
      targetModelTier,
      largeTierHasCapacity: this.largeRpmGuard.canAcquire(nowMs),
    };
  }

  private buildHeaders(
    classification: ClassificationResult,
    selectedModelTier: ModelTierSelection,
    modelName: string,
    escalated: boolean,
    degradedFromLarge: boolean
  ): Record<string, string> {
    return {
      'X-Complexity-Tier': classification.tier,
      'X-Route-Port': classification.routePort,
      'X-Model-Tier': selectedModelTier,
      'X-Model-Name': modelName,
      'X-Frugal-Escalated': escalated ? '1' : '0',
      'X-Large-Degraded': degradedFromLarge ? '1' : '0',
    };
  }

  private recordComplexityCount(tier: ComplexityTier): void {
    if (tier === 'easy') this.stats.easyTierCount++;
    else if (tier === 'medium') this.stats.mediumTierCount++;
    else if (tier === 'hard') this.stats.hardTierCount++;
  }

  private async invokeSmall(
    prompt: string,
    classification: ClassificationResult,
    isDegradedFallback: boolean
  ): Promise<ModelInvocationResult> {
    const raw = await this.handlers.smallModelHandler({
      prompt,
      classification,
      targetTier: 'small',
      isEscalation: false,
      isDegradedFallback,
    });
    const res = normalizeInvocationResult(raw, this.smallModelName);
    return { ...res, costCents: res.costCents ?? this.smallCostCents };
  }

  private async invokeLarge(
    prompt: string,
    classification: ClassificationResult,
    isEscalation: boolean
  ): Promise<ModelInvocationResult> {
    const raw = await this.handlers.largeModelHandler({
      prompt,
      classification,
      targetTier: 'large',
      isEscalation,
      isDegradedFallback: false,
    });
    const res = normalizeInvocationResult(raw, this.largeModelName);
    return { ...res, costCents: res.costCents ?? this.largeCostCents };
  }

  public async route(request: RouteRequest): Promise<RouteExecutionResult> {
    const startMs = performance.now();
    const nowMs = request.nowMs ?? this.now();
    const classification = this.classifier.classify(request.prompt, {
      historyTurns: request.historyTurns,
    });
    const mergedConfOpts: AnswerConfidenceOptions = {
      ...this.defaultConfidenceOptions,
      ...request.confidenceOptions,
      minConfidence: request.confidenceOptions?.minConfidence ?? this.minConfidence,
    };

    this.stats.totalRequests++;
    this.recordComplexityCount(classification.tier);
    const baselineAllLargeCostCents = this.largeCostCents;
    this.stats.totalBaselineCostCents += baselineAllLargeCostCents;

    // 1. Zero-Cost Local Handler (0c)
    if (classification.tier === 'zero_cost') {
      const zeroHandler = this.handlers.zeroCostHandler ?? defaultZeroCostResponse;
      const zeroRes = normalizeInvocationResult(
        await zeroHandler({
          prompt: request.prompt,
          classification,
          targetTier: 'zero_cost',
          isEscalation: false,
          isDegradedFallback: false,
        }),
        this.zeroCostModelName
      );
      const costCents = zeroRes.costCents ?? this.zeroCostCents;
      const modelName = zeroRes.model ?? this.zeroCostModelName;
      this.stats.zeroCostCount++;
      this.stats.totalCostCents += costCents;

      return {
        answer: zeroRes.answer,
        tier: classification.tier,
        routePort: classification.routePort,
        selectedModelTier: 'zero_cost',
        modelName,
        escalated: false,
        degradedFromLarge: false,
        classification,
        costCents: Number(costCents.toFixed(6)),
        baselineAllLargeCostCents,
        savedCents: Number((baselineAllLargeCostCents - costCents).toFixed(6)),
        latencyMs: Number((performance.now() - startMs).toFixed(4)),
        headers: this.buildHeaders(classification, 'zero_cost', modelName, false, false),
      };
    }

    // 2. Easy / Low-Medium Port -> Small Model (with optional FrugalGPT cascade to Large)
    if (classification.routePort === 'easy') {
      const smallRes = await this.invokeSmall(request.prompt, classification, false);
      let totalCost = smallRes.costCents ?? this.smallCostCents;
      const confidence = evaluateAnswerConfidence(request.prompt, smallRes.answer, mergedConfOpts);

      if (this.enableCascade && !confidence.passed) {
        if (!this.largeRpmGuard.tryAcquire(nowMs)) {
          this.stats.largeRpmBlockedCount++;
          if (this.largeCeilingFallbackMode === 'throw') {
            throw new Error('Large tier RPM ceiling exceeded during cascade escalation');
          }
          this.stats.smallCount++;
          this.stats.degradedFromLargeCount++;
          this.stats.totalCostCents += totalCost;
          const modelName = smallRes.model ?? this.smallModelName;
          return {
            answer: smallRes.answer,
            tier: classification.tier,
            routePort: classification.routePort,
            selectedModelTier: 'small',
            modelName,
            escalated: false,
            degradedFromLarge: true,
            degradationReason: 'large_rpm_ceiling',
            classification,
            confidence,
            costCents: Number(totalCost.toFixed(6)),
            baselineAllLargeCostCents,
            savedCents: Number((baselineAllLargeCostCents - totalCost).toFixed(6)),
            latencyMs: Number((performance.now() - startMs).toFixed(4)),
            headers: this.buildHeaders(classification, 'small', modelName, false, true),
          };
        }

        try {
          const largeRes = await this.invokeLarge(request.prompt, classification, true);
          totalCost += largeRes.costCents ?? this.largeCostCents;
          const largeModel = largeRes.model ?? this.largeModelName;
          this.stats.largeCount++;
          this.stats.escalatedCount++;
          this.stats.totalCostCents += totalCost;

          return {
            answer: largeRes.answer,
            tier: classification.tier,
            routePort: classification.routePort,
            selectedModelTier: 'large',
            modelName: largeModel,
            escalated: true,
            degradedFromLarge: false,
            classification,
            confidence,
            costCents: Number(totalCost.toFixed(6)),
            baselineAllLargeCostCents,
            savedCents: Number((baselineAllLargeCostCents - totalCost).toFixed(6)),
            latencyMs: Number((performance.now() - startMs).toFixed(4)),
            headers: this.buildHeaders(classification, 'large', largeModel, true, false),
          };
        } catch (err) {
          if (!isUpstreamRateLimitError(err) || this.largeCeilingFallbackMode === 'throw') throw err;
          this.stats.largeRpmBlockedCount++;
          this.stats.smallCount++;
          this.stats.degradedFromLargeCount++;
          this.stats.totalCostCents += totalCost;
          const modelName = smallRes.model ?? this.smallModelName;
          return {
            answer: smallRes.answer,
            tier: classification.tier,
            routePort: classification.routePort,
            selectedModelTier: 'small',
            modelName,
            escalated: false,
            degradedFromLarge: true,
            degradationReason: 'large_upstream_429',
            classification,
            confidence,
            costCents: Number(totalCost.toFixed(6)),
            baselineAllLargeCostCents,
            savedCents: Number((baselineAllLargeCostCents - totalCost).toFixed(6)),
            latencyMs: Number((performance.now() - startMs).toFixed(4)),
            headers: this.buildHeaders(classification, 'small', modelName, false, true),
          };
        }
      }

      const modelName = smallRes.model ?? this.smallModelName;
      this.stats.smallCount++;
      this.stats.totalCostCents += totalCost;
      return {
        answer: smallRes.answer,
        tier: classification.tier,
        routePort: classification.routePort,
        selectedModelTier: 'small',
        modelName,
        escalated: false,
        degradedFromLarge: false,
        classification,
        confidence,
        costCents: Number(totalCost.toFixed(6)),
        baselineAllLargeCostCents,
        savedCents: Number((baselineAllLargeCostCents - totalCost).toFixed(6)),
        latencyMs: Number((performance.now() - startMs).toFixed(4)),
        headers: this.buildHeaders(classification, 'small', modelName, false, false),
      };
    }

    // 3. Hard Port -> Large Model (optional pure-FrugalGPT trySmallFirstOnHard, shielded by RPM ceiling)
    let accumulatedCost = 0;
    let cachedSmallAttempt: ModelInvocationResult | null = null;
    let smallConfidence: AnswerConfidenceResult | undefined;

    if (this.trySmallFirstOnHard && this.enableCascade) {
      cachedSmallAttempt = await this.invokeSmall(request.prompt, classification, false);
      accumulatedCost += cachedSmallAttempt.costCents ?? this.smallCostCents;
      smallConfidence = evaluateAnswerConfidence(request.prompt, cachedSmallAttempt.answer, mergedConfOpts);
      if (smallConfidence.passed) {
        const modelName = cachedSmallAttempt.model ?? this.smallModelName;
        this.stats.smallCount++;
        this.stats.totalCostCents += accumulatedCost;
        return {
          answer: cachedSmallAttempt.answer,
          tier: classification.tier,
          routePort: classification.routePort,
          selectedModelTier: 'small',
          modelName,
          escalated: false,
          degradedFromLarge: false,
          classification,
          confidence: smallConfidence,
          costCents: Number(accumulatedCost.toFixed(6)),
          baselineAllLargeCostCents,
          savedCents: Number((baselineAllLargeCostCents - accumulatedCost).toFixed(6)),
          latencyMs: Number((performance.now() - startMs).toFixed(4)),
          headers: this.buildHeaders(classification, 'small', modelName, false, false),
        };
      }
    }

    const degradeLarge = async (
      reason: 'large_rpm_ceiling' | 'large_upstream_429'
    ): Promise<RouteExecutionResult> => {
      if (this.largeCeilingFallbackMode === 'static_fallback') {
        this.stats.degradedFromLargeCount++;
        this.stats.totalCostCents += accumulatedCost;
        return {
          answer: this.staticFallbackAnswer,
          tier: classification.tier,
          routePort: classification.routePort,
          selectedModelTier: 'zero_cost',
          modelName: this.zeroCostModelName,
          escalated: false,
          degradedFromLarge: true,
          degradationReason: reason,
          classification,
          confidence: smallConfidence,
          costCents: Number(accumulatedCost.toFixed(6)),
          baselineAllLargeCostCents,
          savedCents: Number((baselineAllLargeCostCents - accumulatedCost).toFixed(6)),
          latencyMs: Number((performance.now() - startMs).toFixed(4)),
          headers: this.buildHeaders(classification, 'zero_cost', this.zeroCostModelName, false, true),
        };
      }

      const fallbackSmall = cachedSmallAttempt ?? (await this.invokeSmall(request.prompt, classification, true));
      if (!cachedSmallAttempt) {
        accumulatedCost += fallbackSmall.costCents ?? this.smallCostCents;
      }
      const modelName = fallbackSmall.model ?? this.smallModelName;
      this.stats.smallCount++;
      this.stats.degradedFromLargeCount++;
      this.stats.totalCostCents += accumulatedCost;
      return {
        answer: fallbackSmall.answer,
        tier: classification.tier,
        routePort: classification.routePort,
        selectedModelTier: 'small',
        modelName,
        escalated: false,
        degradedFromLarge: true,
        degradationReason: reason,
        classification,
        confidence: smallConfidence,
        costCents: Number(accumulatedCost.toFixed(6)),
        baselineAllLargeCostCents,
        savedCents: Number((baselineAllLargeCostCents - accumulatedCost).toFixed(6)),
        latencyMs: Number((performance.now() - startMs).toFixed(4)),
        headers: this.buildHeaders(classification, 'small', modelName, false, true),
      };
    };

    if (!this.largeRpmGuard.tryAcquire(nowMs)) {
      this.stats.largeRpmBlockedCount++;
      if (this.largeCeilingFallbackMode === 'throw') {
        throw new Error('Large tier RPM ceiling exceeded');
      }
      return degradeLarge('large_rpm_ceiling');
    }

    try {
      const largeRes = await this.invokeLarge(request.prompt, classification, Boolean(cachedSmallAttempt));
      accumulatedCost += largeRes.costCents ?? this.largeCostCents;
      const modelName = largeRes.model ?? this.largeModelName;
      this.stats.largeCount++;
      if (cachedSmallAttempt) this.stats.escalatedCount++;
      this.stats.totalCostCents += accumulatedCost;

      return {
        answer: largeRes.answer,
        tier: classification.tier,
        routePort: classification.routePort,
        selectedModelTier: 'large',
        modelName,
        escalated: Boolean(cachedSmallAttempt),
        degradedFromLarge: false,
        classification,
        confidence: smallConfidence,
        costCents: Number(accumulatedCost.toFixed(6)),
        baselineAllLargeCostCents,
        savedCents: Number((baselineAllLargeCostCents - accumulatedCost).toFixed(6)),
        latencyMs: Number((performance.now() - startMs).toFixed(4)),
        headers: this.buildHeaders(classification, 'large', modelName, Boolean(cachedSmallAttempt), false),
      };
    } catch (err) {
      if (!isUpstreamRateLimitError(err) || this.largeCeilingFallbackMode === 'throw') throw err;
      this.stats.largeRpmBlockedCount++;
      return degradeLarge('large_upstream_429');
    }
  }

  public getStats(nowMs?: number): ModelRouterStats {
    const total = this.stats.totalRequests;
    const totalSaved = Math.max(0, this.stats.totalBaselineCostCents - this.stats.totalCostCents);
    const pct = (n: number) => (total > 0 ? Number(((n / total) * 100).toFixed(2)) : 0);
    return {
      ...this.stats,
      totalCostCents: Number(this.stats.totalCostCents.toFixed(6)),
      totalBaselineCostCents: Number(this.stats.totalBaselineCostCents.toFixed(6)),
      totalSavedCents: Number(totalSaved.toFixed(6)),
      savingsPct:
        this.stats.totalBaselineCostCents > 0
          ? Number(((totalSaved / this.stats.totalBaselineCostCents) * 100).toFixed(2))
          : 0,
      avgCostPerTaskCents: total > 0 ? Number((this.stats.totalCostCents / total).toFixed(6)) : 0,
      easySharePct: pct(this.stats.smallCount + this.stats.zeroCostCount),
      hardSharePct: pct(this.stats.largeCount),
      zeroCostSharePct: pct(this.stats.zeroCostCount),
      largeTierMaxRpm: this.largeTierMaxRpm,
      largeTierRemainingRpm: this.largeRpmGuard.getRemaining(nowMs ?? this.now()),
    };
  }

  public resetStats(): void {
    this.stats = {
      totalRequests: 0,
      zeroCostCount: 0,
      smallCount: 0,
      largeCount: 0,
      easyTierCount: 0,
      mediumTierCount: 0,
      hardTierCount: 0,
      escalatedCount: 0,
      degradedFromLargeCount: 0,
      largeRpmBlockedCount: 0,
      totalCostCents: 0,
      totalBaselineCostCents: 0,
    };
    this.largeRpmGuard.reset();
  }
}

/**
 * FrugalGPT Cascade Router: specialization of `IntelligentModelRouter` with confidence-based
 * escalation (`enableCascade: true`) enabled by default.
 */
export class FrugalModelCascade extends IntelligentModelRouter {
  constructor(options: FrugalModelCascadeOptions) {
    super({ ...options, enableCascade: true });
  }

  public async cascade(request: RouteRequest): Promise<RouteExecutionResult> {
    return this.route(request);
  }
}

export function createIntelligentModelRouter(options: IntelligentModelRouterOptions): IntelligentModelRouter {
  return new IntelligentModelRouter(options);
}

export function createFrugalModelCascade(options: FrugalModelCascadeOptions): FrugalModelCascade {
  return new FrugalModelCascade(options);
}
