/**
 * @kido/ai-stream - LLM-as-a-Judge Calibrator & Multi-Trial Consistency Metrics
 *
 * Implements calibrated LLM-judge validation and stochastic agent eval reliability metrics:
 * 1. `calibrateJudgeAgreement`: exact agreement %, Cohen's kappa, precision/recall/FPR/FNR,
 *    and cross-family vs same-family judge bias warnings.
 * 2. `computeMultiTrialConsistency`: computes `pass@1`, `pass@k`, and `pass^k` (`passHatK`)
 *    consistency across repeated stochastic trials (`k >= 1`) and surfaces flaky cases.
 *
 * Invariant: 100% zero external runtime dependencies and zero imports from sibling slices.
 */

export interface JudgeCalibrationSample {
  caseId: string;
  humanPass: boolean;
  judgePass: boolean;
  humanScore?: number;
  judgeScore?: number;
  category?: string;
}

export interface CalibrateJudgeOptions {
  generatorModel?: string;
  judgeModel?: string;
  generatorFamily?: string;
  judgeFamily?: string;
  minAgreementPct?: number;
  minCohenKappa?: number;
  minSampleCount?: number;
}

export type KappaInterpretation = 'poor' | 'slight' | 'fair' | 'moderate' | 'substantial' | 'almost_perfect';

export interface JudgeCalibrationReport {
  sampleCount: number;
  confusionMatrix: { truePositive: number; falsePositive: number; falseNegative: number; trueNegative: number };
  exactAgreementPct: number;
  expectedChanceAgreement: number;
  cohenKappa: number;
  kappaInterpretation: KappaInterpretation;
  precision: number;
  recall: number;
  falsePositiveRate: number;
  falseNegativeRate: number;
  generatorFamily: string;
  judgeFamily: string;
  isSameFamilyJudge: boolean;
  sameFamilyWarning: string | null;
  warnings: string[];
  trusted: boolean;
}

export interface MultiTrialCaseInput {
  caseId: string;
  trials: readonly boolean[];
}

export interface MultiTrialCaseResult {
  caseId: string;
  trialCount: number;
  passCount: number;
  passAt1: number;
  passAtK: number;
  passHatK: number;
  flaky: boolean;
}

export interface MultiTrialConsistencyResult {
  k: number;
  totalCases: number;
  totalTrials: number;
  allPassedCount: number;
  flakyCaseCount: number;
  flakyCaseIds: string[];
  passAt1: number;
  passAt1Pct: number;
  passAtK: number;
  passAtKPct: number;
  passHatK: number;
  passHatKPct: number;
  perCase: MultiTrialCaseResult[];
}

const MODEL_FAMILY_MATCHERS: readonly { family: string; rx: RegExp }[] = [
  { family: 'openai', rx: /(?:^|[-_/])(?:gpt|o1|o3|o4|openai|chatgpt)(?:$|[-_/\d])/i },
  { family: 'anthropic', rx: /(?:^|[-_/])(?:claude|anthropic|sonnet|haiku|opus)(?:$|[-_/\d])/i },
  { family: 'google', rx: /(?:^|[-_/])(?:gemini|google|palm|gemma)(?:$|[-_/\d])/i },
  { family: 'meta', rx: /(?:^|[-_/])(?:llama|meta)(?:$|[-_/\d])/i },
  { family: 'mistral', rx: /(?:^|[-_/])(?:mistral|mixtral|codestral)(?:$|[-_/\d])/i },
  { family: 'deepseek', rx: /(?:^|[-_/])(?:deepseek)(?:$|[-_/\d])/i },
  { family: 'qwen', rx: /(?:^|[-_/])(?:qwen)(?:$|[-_/\d])/i },
];

function inferModelFamily(modelName?: string, explicitFamily?: string): string {
  if (explicitFamily && explicitFamily.trim()) return explicitFamily.trim().toLowerCase();
  const normalized = (modelName ?? '').trim();
  if (!normalized) return 'unknown';
  for (const matcher of MODEL_FAMILY_MATCHERS) {
    if (matcher.rx.test(normalized)) return matcher.family;
  }
  return normalized.toLowerCase();
}

function interpretCohenKappa(kappa: number): KappaInterpretation {
  if (kappa < 0) return 'poor';
  if (kappa <= 0.2) return 'slight';
  if (kappa <= 0.4) return 'fair';
  if (kappa <= 0.6) return 'moderate';
  if (kappa <= 0.8) return 'substantial';
  return 'almost_perfect';
}

function combinations(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  if (k === 0 || k === n) return 1;
  const r = Math.min(k, n - k);
  let num = 1;
  let den = 1;
  for (let i = 1; i <= r; i++) {
    num *= n - r + i;
    den *= i;
  }
  return num / den;
}

/**
 * Calibrates an LLM-as-a-Judge against human-labeled verdicts using exact agreement,
 * Cohen's kappa, error rates, and cross-family vs same-family self-preference warnings.
 */
export function calibrateJudgeAgreement(
  samples: readonly JudgeCalibrationSample[],
  options: CalibrateJudgeOptions = {}
): JudgeCalibrationReport {
  const minAgreementPct = options.minAgreementPct ?? 85;
  const minCohenKappa = options.minCohenKappa ?? 0.7;
  const minSampleCount = options.minSampleCount ?? 20;

  const generatorFamily = inferModelFamily(options.generatorModel, options.generatorFamily);
  const judgeFamily = inferModelFamily(options.judgeModel, options.judgeFamily);
  const isSameFamilyJudge = generatorFamily !== 'unknown' && judgeFamily !== 'unknown' && generatorFamily === judgeFamily;
  const sameFamilyWarning = isSameFamilyJudge
    ? `Same-family judge detected (${generatorFamily} judging ${judgeFamily}): self-enhancement and shared blind-spot bias risk. Prefer cross-family calibration.`
    : null;

  const warnings: string[] = sameFamilyWarning ? [sameFamilyWarning] : [];
  const n = samples.length;
  if (n === 0) {
    warnings.push('No calibration samples provided.');
    return {
      sampleCount: 0,
      confusionMatrix: { truePositive: 0, falsePositive: 0, falseNegative: 0, trueNegative: 0 },
      exactAgreementPct: 0,
      expectedChanceAgreement: 0,
      cohenKappa: 0,
      kappaInterpretation: 'poor',
      precision: 0,
      recall: 0,
      falsePositiveRate: 0,
      falseNegativeRate: 0,
      generatorFamily,
      judgeFamily,
      isSameFamilyJudge,
      sameFamilyWarning,
      warnings,
      trusted: false,
    };
  }

  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (const s of samples) {
    if (s.humanPass && s.judgePass) tp++;
    else if (!s.humanPass && s.judgePass) fp++;
    else if (s.humanPass && !s.judgePass) fn++;
    else tn++;
  }

  const po = (tp + tn) / n;
  const pe = ((tp + fp) / n) * ((tp + fn) / n) + ((fn + tn) / n) * ((fp + tn) / n);
  const rawKappa = Math.abs(1 - pe) < 1e-12 ? (po === 1 ? 1 : 0) : (po - pe) / (1 - pe);
  const cohenKappa = Number(Math.max(-1, Math.min(1, rawKappa)).toFixed(4));
  const exactAgreementPct = Number((po * 100).toFixed(2));
  const precision = tp + fp > 0 ? Number((tp / (tp + fp)).toFixed(4)) : 1;
  const recall = tp + fn > 0 ? Number((tp / (tp + fn)).toFixed(4)) : 1;
  const falsePositiveRate = fp + tn > 0 ? Number((fp / (fp + tn)).toFixed(4)) : 0;
  const falseNegativeRate = tp + fn > 0 ? Number((fn / (tp + fn)).toFixed(4)) : 0;

  if (n < minSampleCount) warnings.push(`Small calibration sample size (${n} < ${minSampleCount}); kappa variance may be elevated.`);
  if (exactAgreementPct < minAgreementPct) warnings.push(`Judge exact agreement ${exactAgreementPct}% is below minimum ${minAgreementPct}%.`);
  if (cohenKappa < minCohenKappa) warnings.push(`Cohen's kappa ${cohenKappa} is below minimum ${minCohenKappa}.`);

  return {
    sampleCount: n,
    confusionMatrix: { truePositive: tp, falsePositive: fp, falseNegative: fn, trueNegative: tn },
    exactAgreementPct,
    expectedChanceAgreement: Number(pe.toFixed(4)),
    cohenKappa,
    kappaInterpretation: interpretCohenKappa(cohenKappa),
    precision,
    recall,
    falsePositiveRate,
    falseNegativeRate,
    generatorFamily,
    judgeFamily,
    isSameFamilyJudge,
    sameFamilyWarning,
    warnings,
    trusted: exactAgreementPct >= minAgreementPct && cohenKappa >= minCohenKappa,
  };
}

/**
 * Computes multi-trial reliability metrics (`pass@1`, `pass@k`, and strict `pass^k` consistency)
 * across repeated trials of one or more test cases.
 */
export function computeMultiTrialConsistency(
  input: readonly MultiTrialCaseInput[] | readonly (readonly boolean[])[] | readonly boolean[],
  k: number = 3
): MultiTrialConsistencyResult {
  const effectiveK = Math.max(1, Math.floor(k));
  const normalizedCases: MultiTrialCaseInput[] = [];

  if (input.length > 0) {
    const first = input[0];
    if (typeof first === 'boolean') {
      normalizedCases.push({ caseId: 'case-1', trials: input as readonly boolean[] });
    } else if (Array.isArray(first)) {
      (input as readonly (readonly boolean[])[]).forEach((trials, idx) => {
        normalizedCases.push({ caseId: `case-${idx + 1}`, trials });
      });
    } else {
      normalizedCases.push(...(input as readonly MultiTrialCaseInput[]));
    }
  }

  if (normalizedCases.length === 0) {
    return { k: effectiveK, totalCases: 0, totalTrials: 0, allPassedCount: 0, flakyCaseCount: 0, flakyCaseIds: [], passAt1: 0, passAt1Pct: 0, passAtK: 0, passAtKPct: 0, passHatK: 0, passHatKPct: 0, perCase: [] };
  }

  const perCase: MultiTrialCaseResult[] = [];
  const flakyCaseIds: string[] = [];
  let totalTrials = 0;
  let allPassedCount = 0;
  let sumPassAt1 = 0;
  let sumPassAtK = 0;
  let sumPassHatK = 0;

  for (const entry of normalizedCases) {
    const n = entry.trials.length;
    const c = entry.trials.filter(Boolean).length;
    totalTrials += n;
    const passAt1 = n > 0 ? c / n : 0;
    const passAtK = n === 0 ? 0 : (n >= effectiveK ? 1 - combinations(n - c, effectiveK) / combinations(n, effectiveK) : 1 - Math.pow(1 - passAt1, effectiveK));
    const passHatK = n === 0 ? 0 : (n >= effectiveK ? combinations(c, effectiveK) / combinations(n, effectiveK) : Math.pow(passAt1, effectiveK));

    const flaky = c > 0 && c < n;
    if (flaky) flakyCaseIds.push(entry.caseId);
    if (n > 0 && c === n) allPassedCount++;
    sumPassAt1 += passAt1;
    sumPassAtK += passAtK;
    sumPassHatK += passHatK;

    perCase.push({ caseId: entry.caseId, trialCount: n, passCount: c, passAt1: Number(passAt1.toFixed(4)), passAtK: Number(passAtK.toFixed(4)), passHatK: Number(passHatK.toFixed(4)), flaky });
  }

  const count = normalizedCases.length;
  const passAt1 = Number((sumPassAt1 / count).toFixed(4));
  const passAtK = Number((sumPassAtK / count).toFixed(4));
  const passHatK = Number((sumPassHatK / count).toFixed(4));

  return {
    k: effectiveK,
    totalCases: count,
    totalTrials,
    allPassedCount,
    flakyCaseCount: flakyCaseIds.length,
    flakyCaseIds,
    passAt1,
    passAt1Pct: Number((passAt1 * 100).toFixed(2)),
    passAtK,
    passAtKPct: Number((passAtK * 100).toFixed(2)),
    passHatK,
    passHatKPct: Number((passHatK * 100).toFixed(2)),
    perCase,
  };
}
