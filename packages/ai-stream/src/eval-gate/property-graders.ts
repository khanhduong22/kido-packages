/**
 * @kido/ai-stream - Property-Based Eval Graders & Deterministic Groundedness Checker
 *
 * Implements code-first evaluation graders inspired by GonnaCrash World 3 Level 18 (`eval_before_release`):
 * 1. Property-based assertions (`contains_all`, `contains_any`, `not_contains`, `regex_match`,
 *    `max_words`, `min_length`, `json_valid`, `citation_required`, `refusal_check`, `no_pii`,
 *    `exact_amount`, `grounded_in_context`, `custom`) — never brittle golden strings.
 * 2. Deterministic numeric, price, and SKU groundedness verification against retrieved chunks.
 *
 * Invariant: 100% zero external runtime dependencies and zero imports from sibling slices.
 */

export type EvalCaseProperty =
  | { type: 'contains_any'; values: readonly string[]; caseSensitive?: boolean; critical?: boolean; weight?: number; label?: string }
  | { type: 'contains_all'; values: readonly string[]; caseSensitive?: boolean; critical?: boolean; weight?: number; label?: string }
  | { type: 'not_contains'; values: readonly string[]; caseSensitive?: boolean; critical?: boolean; weight?: number; label?: string }
  | { type: 'regex_match'; pattern: string; flags?: string; critical?: boolean; weight?: number; label?: string }
  | { type: 'max_words'; maxWords: number; critical?: boolean; weight?: number; label?: string }
  | { type: 'min_length'; minChars: number; critical?: boolean; weight?: number; label?: string }
  | { type: 'json_valid'; requiredKeys?: readonly string[]; critical?: boolean; weight?: number; label?: string }
  | { type: 'citation_required'; minCount?: number; critical?: boolean; weight?: number; label?: string }
  | { type: 'refusal_check'; expectRefusal: boolean; critical?: boolean; weight?: number; label?: string }
  | { type: 'no_pii'; critical?: boolean; weight?: number; label?: string }
  | { type: 'exact_amount'; expectedValue: number; tolerance?: number; critical?: boolean; weight?: number; label?: string }
  | { type: 'grounded_in_context'; minScore?: number; strictNumbers?: boolean; strictSkus?: boolean; critical?: boolean; weight?: number; label?: string }
  | { type: 'custom'; id: string; check: (output: EvalCandidateOutput, goldenCase: EvalGoldenCase) => boolean | { passed: boolean; detail?: string }; critical?: boolean; weight?: number; label?: string };

export interface EvalGoldenCase {
  id: string;
  category: string;
  source?: 'real' | 'adversarial' | 'edge' | 'synthetic';
  critical?: boolean;
  prompt: string;
  contextChunks?: readonly string[];
  properties: readonly EvalCaseProperty[];
  maxLatencyMs?: number;
  maxCostUc?: number;
  metadata?: Record<string, unknown>;
}

export interface EvalCandidateOutput {
  caseId: string;
  answer: string;
  retrievedChunks?: readonly string[];
  latencyMs?: number;
  ttftMs?: number;
  costUc?: number;
  inputTokens?: number;
  outputTokens?: number;
  judgeScore?: number;
  judgePassThreshold?: number;
  judgeRationale?: string;
}

export interface EvalPropertyCheckOutcome {
  propertyType: EvalCaseProperty['type'];
  label: string;
  passed: boolean;
  critical: boolean;
  weight: number;
  detail: string;
}

export interface GroundednessOptions {
  minScore?: number;
  strictNumbers?: boolean;
  strictSkus?: boolean;
}

export interface GroundednessResult {
  score: number;
  passed: boolean;
  totalClaims: number;
  groundedClaims: number;
  ungroundedNumbers: string[];
  ungroundedSkus: string[];
  ungroundedPrices: string[];
  detail: string;
}

export interface EvalPropertyGradeResult {
  caseId: string;
  category: string;
  critical: boolean;
  passed: boolean;
  score: number;
  checks: EvalPropertyCheckOutcome[];
  groundedness?: GroundednessResult;
  failedReasons: string[];
  latencyMs?: number;
  ttftMs?: number;
  costUc?: number;
}

const REFUSAL_PATTERNS: readonly RegExp[] = [
  /\b(?:i\s+(?:don't|do\s+not|cannot|can't)\s+(?:know|answer|help|verify|find|confirm|provide|access)|i\s+am\s+not\s+sure|i'm\s+not\s+sure|not\s+enough\s+information|unable\s+to\s+(?:determine|assist|verify|confirm)|no\s+information\s+available|outside\s+(?:my|our)\s+scope)\b/i,
  /(?:t[oô]i|m[iì]nh|em)\s*(?:kh[oô]ng\s*(?:bi[eế]t|ch[aắ]c|r[oõ]|th[eể]\s*(?:x[aá]c\s*nh[aậ]n|tr[aả]\s*l[oờ]i|ki[eể]m\s*tra|h[oỗ]\s*tr[oợ]))|ch[uư]a\s*(?:c[oó]\s*th[oô]ng\s*tin|r[oõ]))|kh[oô]ng\s+t[iì]m\s+th[aấ]y\s+th[oô]ng\s+tin|xin\s+l[oỗ]i.*kh[oô]ng\s+th[eể]/iu,
];

const PII_PATTERNS: readonly { name: string; rx: RegExp }[] = [
  { name: 'email', rx: /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/i },
  { name: 'phone', rx: /(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{3,4}\)?[\s.-]?)\d{3}[\s.-]?\d{3,4}/ },
  { name: 'api_secret', rx: /\b(?:sk_live_|sk_test_|whsec_|xox[bap]-|AIza[0-9A-Za-z_-]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/ },
];

const CITATION_RE = /(?:\[(?:Doc|Source|Nguồn|Ref)\s*\d+\]|\[[^\]]+\]\([^)]+\)|https?:\/\/\S+)/giu;
const PRICE_TOKEN_RE = /(?:\$\s?\d[\d,]*(?:\.\d+)?|\b\d+(?:[.,]\d{3})*(?:[.,]\d+)?\s*(?:k|ngh[iì]n|nghin|tr|tri[eệ]u|trieu|vn[dđ]|[dđ]|usd|cents?|¢)(?![\p{L}\p{N}_]))/giu;
const SKU_TOKEN_RE = /\b[A-Z]{2,}[A-Z0-9]*(?:[-_][A-Z0-9]+)+\b|\b[A-Z]{2,}\d{2,}[A-Z0-9]*\b/g;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const foldText = (input: string, caseSensitive = false): string =>
  caseSensitive ? input.normalize('NFC') : input.normalize('NFC').toLowerCase();

function parseNormalizedNumber(raw: string): number | null {
  const cleaned = raw.toLowerCase().replace(/\s+/g, '').replace(/[$,¢]/g, '');
  let multiplier = 1;
  let numericPart = cleaned;
  if (/(?:tri[eệ]u|trieu|tr)$/.test(cleaned)) {
    multiplier = 1_000_000;
    numericPart = cleaned.replace(/(?:tri[eệ]u|trieu|tr)$/, '');
  } else if (/(?:ngh[iì]n|nghin|k)$/.test(cleaned)) {
    multiplier = 1_000;
    numericPart = cleaned.replace(/(?:ngh[iì]n|nghin|k)$/, '');
  } else {
    numericPart = cleaned.replace(/(?:vn[dđ]|[dđ]|usd|cents?)$/, '');
  }
  if (!numericPart || !/\d/.test(numericPart)) return null;
  numericPart = /^\d{1,3}(?:[.,]\d{3})+$/.test(numericPart)
    ? numericPart.replace(/[.,]/g, '')
    : numericPart.replace(/,/g, '');
  const value = Number(numericPart) * multiplier;
  return Number.isFinite(value) ? value : null;
}

function extractNormalizedNumbers(text: string): Array<{ raw: string; value: number }> {
  let remaining = text.replace(/\[(?:Doc|Source|Nguồn|Ref)\s*\d+\]/giu, ' ');
  const results: Array<{ raw: string; value: number }> = [];
  remaining = remaining.replace(PRICE_TOKEN_RE, (match) => {
    const val = parseNormalizedNumber(match);
    if (val !== null) results.push({ raw: match.trim(), value: val });
    return ' ';
  });
  for (const m of remaining.matchAll(/\b\d+(?:[.,]\d{3})*(?:[.,]\d+)?/g)) {
    const val = parseNormalizedNumber(m[0]);
    if (val !== null && (m[0].length >= 2 || val >= 10)) results.push({ raw: m[0], value: val });
  }
  return results;
}

const extractSkus = (text: string): string[] =>
  [...new Set((text.match(SKU_TOKEN_RE) ?? []).filter((token) => !ISO_DATE_RE.test(token)))];

/** Deterministic numeric, price, and SKU groundedness checker against retrieved context chunks. */
export function evaluateGroundednessScore(
  answer: string,
  contextChunks: readonly string[],
  options: GroundednessOptions = {}
): GroundednessResult {
  const minScore = options.minScore ?? 0.8;
  const strictNumbers = options.strictNumbers ?? true;
  const strictSkus = options.strictSkus ?? true;
  const trimmed = (answer ?? '').normalize('NFC').trim();
  if (!trimmed) {
    return { score: 0, passed: false, totalClaims: 0, groundedClaims: 0, ungroundedNumbers: [], ungroundedSkus: [], ungroundedPrices: [], detail: 'Empty answer cannot be grounded' };
  }

  const contextJoined = (contextChunks ?? []).join('\n').normalize('NFC');
  const contextNums = new Set(extractNormalizedNumbers(contextJoined).map((n) => n.value));
  const contextSkus = new Set(extractSkus(contextJoined).map((s) => s.toUpperCase()));
  const answerSkus = extractSkus(trimmed);
  const ungroundedSkus = answerSkus.filter((sku) => !contextSkus.has(sku.toUpperCase()));

  const strippedAnswer = trimmed.replace(/\[(?:Doc|Source|Nguồn|Ref)\s*\d+\]/giu, ' ');
  const priceTokens = [...new Set((strippedAnswer.match(PRICE_TOKEN_RE) ?? []).map((p) => p.trim()))];
  const ungroundedPrices = priceTokens.filter((rawPrice) => {
    const val = parseNormalizedNumber(rawPrice);
    return val === null || !contextNums.has(val);
  });

  const allNums = extractNormalizedNumbers(trimmed);
  const ungroundedNumbers: string[] = [];
  const seenNumRaw = new Set<string>();
  for (const item of allNums) {
    if (!contextNums.has(item.value) && !seenNumRaw.has(item.raw)) {
      seenNumRaw.add(item.raw);
      ungroundedNumbers.push(item.raw);
    }
  }

  const totalClaims = answerSkus.length + priceTokens.length + new Set(allNums.map((n) => n.value)).size;
  const ungroundedUniqueNums = new Set(ungroundedNumbers.map((r) => parseNormalizedNumber(r)).filter((v): v is number => v !== null)).size;
  const groundedClaims = Math.max(0, totalClaims - (ungroundedSkus.length + ungroundedPrices.length + ungroundedUniqueNums));
  const score = totalClaims === 0 ? 1 : Number((groundedClaims / totalClaims).toFixed(4));
  const passed = score >= minScore && !(strictSkus && ungroundedSkus.length > 0) && !(strictNumbers && (ungroundedPrices.length > 0 || ungroundedNumbers.length > 0));

  const issues: string[] = [];
  if (ungroundedPrices.length > 0) issues.push(`ungroundedPrices=[${ungroundedPrices.join(', ')}]`);
  if (ungroundedSkus.length > 0) issues.push(`ungroundedSkus=[${ungroundedSkus.join(', ')}]`);
  if (ungroundedNumbers.length > 0) issues.push(`ungroundedNumbers=[${ungroundedNumbers.join(', ')}]`);

  return { score, passed, totalClaims, groundedClaims, ungroundedNumbers, ungroundedSkus, ungroundedPrices, detail: passed ? `Grounded (${groundedClaims}/${totalClaims} claims verified)` : `Hallucination detected: ${issues.join('; ')}` };
}

function evaluateSingleProperty(
  prop: EvalCaseProperty,
  output: EvalCandidateOutput,
  goldenCase: EvalGoldenCase
): { outcome: EvalPropertyCheckOutcome; groundedness?: GroundednessResult } {
  const answer = (output.answer ?? '').normalize('NFC').trim();
  const weight = Math.max(0.01, prop.weight ?? 1);
  const critical = Boolean(prop.critical);
  const label = prop.label ?? prop.type;
  let passed = false;
  let detail = '';
  let groundedness: GroundednessResult | undefined;

  switch (prop.type) {
    case 'contains_any': {
      const hay = foldText(answer, prop.caseSensitive);
      const hit = prop.values.find((v) => hay.includes(foldText(v, prop.caseSensitive)));
      passed = Boolean(hit);
      detail = passed ? `Matched "${hit}"` : `Missing any of [${prop.values.join(', ')}]`;
      break;
    }
    case 'contains_all': {
      const hay = foldText(answer, prop.caseSensitive);
      const missing = prop.values.filter((v) => !hay.includes(foldText(v, prop.caseSensitive)));
      passed = missing.length === 0;
      detail = passed ? `Matched all ${prop.values.length} substrings` : `Missing [${missing.join(', ')}]`;
      break;
    }
    case 'not_contains': {
      const hay = foldText(answer, prop.caseSensitive);
      const hit = prop.values.find((v) => hay.includes(foldText(v, prop.caseSensitive)));
      passed = !hit;
      detail = passed ? 'No forbidden tokens found' : `Found forbidden token "${hit}"`;
      break;
    }
    case 'regex_match':
      passed = new RegExp(prop.pattern, prop.flags ?? 'iu').test(answer);
      detail = passed ? `Matched /${prop.pattern}/` : `Did not match /${prop.pattern}/`;
      break;
    case 'max_words': {
      const words = answer ? answer.split(/\s+/).filter(Boolean).length : 0;
      passed = words > 0 && words <= prop.maxWords;
      detail = `${words} words (max ${prop.maxWords})`;
      break;
    }
    case 'min_length':
      passed = answer.length >= prop.minChars;
      detail = `${answer.length} chars (min ${prop.minChars})`;
      break;
    case 'json_valid': {
      const fenced = answer.match(/```(?:json)?\s*([\s\S]*?)```/i);
      try {
        const parsed = JSON.parse(fenced ? fenced[1].trim() : answer) as Record<string, unknown>;
        const missingKeys = (prop.requiredKeys ?? []).filter((k) => typeof parsed !== 'object' || parsed === null || !(k in parsed));
        passed = missingKeys.length === 0;
        detail = passed ? 'Valid JSON payload' : `Missing JSON keys [${missingKeys.join(', ')}]`;
      } catch {
        passed = false;
        detail = 'Invalid JSON syntax';
      }
      break;
    }
    case 'citation_required': {
      const minCount = prop.minCount ?? 1;
      const matches = answer.match(CITATION_RE) ?? [];
      passed = matches.length >= minCount;
      detail = `Found ${matches.length} citation(s) (min ${minCount})`;
      break;
    }
    case 'refusal_check': {
      const hasRefusal = REFUSAL_PATTERNS.some((rx) => rx.test(answer));
      passed = prop.expectRefusal ? hasRefusal : !hasRefusal && answer.length > 0;
      detail = prop.expectRefusal
        ? (hasRefusal ? 'Expected refusal detected' : 'Failed to refuse out-of-scope request')
        : (hasRefusal ? 'Unexpected refusal/hedging' : 'Direct answer without hedging');
      break;
    }
    case 'no_pii': {
      const hit = PII_PATTERNS.find((p) => p.rx.test(answer));
      passed = !hit;
      detail = passed ? 'No PII or secrets leaked' : `Detected ${hit?.name} pattern`;
      break;
    }
    case 'exact_amount': {
      const tol = prop.tolerance ?? 0;
      const match = extractNormalizedNumbers(answer).find((n) => Math.abs(n.value - prop.expectedValue) <= tol);
      passed = Boolean(match);
      detail = passed ? `Matched expected amount ${prop.expectedValue} via "${match?.raw}"` : `Expected amount ${prop.expectedValue} not found`;
      break;
    }
    case 'grounded_in_context': {
      const chunks = output.retrievedChunks ?? goldenCase.contextChunks ?? [];
      groundedness = evaluateGroundednessScore(answer, chunks, { minScore: prop.minScore, strictNumbers: prop.strictNumbers, strictSkus: prop.strictSkus });
      passed = groundedness.passed;
      detail = groundedness.detail;
      break;
    }
    case 'custom': {
      const res = prop.check(output, goldenCase);
      passed = typeof res === 'boolean' ? res : res.passed;
      detail = typeof res === 'boolean' ? `Custom check ${prop.id} ${passed ? 'passed' : 'failed'}` : (res.detail ?? `Custom check ${prop.id} ${passed ? 'passed' : 'failed'}`);
      break;
    }
  }
  return { outcome: { propertyType: prop.type, label, passed, critical, weight, detail }, groundedness };
}

/** Grades a candidate output against all declared expected properties of a golden test case. */
export function gradeEvalCaseProperties(goldenCase: EvalGoldenCase, output: EvalCandidateOutput): EvalPropertyGradeResult {
  const checks: EvalPropertyCheckOutcome[] = [];
  const failedReasons: string[] = [];
  let groundedness: GroundednessResult | undefined;
  let earnedWeight = 0;
  let totalWeight = 0;

  for (const prop of goldenCase.properties) {
    const { outcome, groundedness: g } = evaluateSingleProperty(prop, output, goldenCase);
    checks.push(outcome);
    if (g) groundedness = g;
    totalWeight += outcome.weight;
    if (outcome.passed) earnedWeight += outcome.weight;
    else failedReasons.push(`${outcome.label}: ${outcome.detail}`);
  }

  if (goldenCase.maxLatencyMs !== undefined && output.latencyMs !== undefined && output.latencyMs > goldenCase.maxLatencyMs) {
    failedReasons.push(`latency_exceeded:${output.latencyMs}ms>${goldenCase.maxLatencyMs}ms`);
  }
  if (goldenCase.maxCostUc !== undefined && output.costUc !== undefined && output.costUc > goldenCase.maxCostUc) {
    failedReasons.push(`cost_exceeded:${output.costUc}UC>${goldenCase.maxCostUc}UC`);
  }
  if (output.judgeScore !== undefined && output.judgeScore < (output.judgePassThreshold ?? 0.7)) {
    failedReasons.push(`judge_score_below_threshold:${output.judgeScore}<${output.judgePassThreshold ?? 0.7}`);
  }

  const score = totalWeight > 0 ? Number((earnedWeight / totalWeight).toFixed(4)) : (failedReasons.length === 0 ? 1 : 0);
  const passed = checks.every((c) => c.passed) && failedReasons.length === 0;
  return { caseId: goldenCase.id, category: goldenCase.category, critical: Boolean(goldenCase.critical), passed, score, checks, groundedness, failedReasons, latencyMs: output.latencyMs, ttftMs: output.ttftMs, costUc: output.costUc };
}
