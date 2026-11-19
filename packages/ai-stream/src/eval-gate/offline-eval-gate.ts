/**
 * @kido/ai-stream - Out-of-Band Offline Eval Gate & Paired Per-Case Comparison
 *
 * Implements GonnaCrash World 3 Level 18 (`eval_before_release`) quality gate:
 * - Zero live hot-path overhead (`0ms` live latency: active prompt lookup is O(1) in-memory).
 * - Paired per-case diff (`improved`, `regressed`, `samePass`, `sameFail`) + category slices.
 * - Release blocking (`BLOCK_RELEASE`, leaving active prompt version untouched) on critical
 *   regressions, pass rate < 90% or net drop, cost/delta ceiling, TTFT SLA breach, or untrusted judge.
 * - `verifyGateWithSeededRegression`: self-tests blocking behavior against a seeded regression.
 *
 * Invariant: 100% zero external runtime dependencies and zero imports from sibling slices.
 */

import {
  gradeEvalCaseProperties,
  type EvalCandidateOutput,
  type EvalGoldenCase,
  type EvalPropertyGradeResult,
} from './property-graders.js';
import type { JudgeCalibrationReport } from './judge-calibrator.js';

export type OfflineEvalGateDecisionType = 'ALLOW_RELEASE' | 'BLOCK_RELEASE';
export type EvalCaseDiffStatus = 'improved' | 'regressed' | 'samePass' | 'sameFail';

export interface EvalPerCaseDiff {
  caseId: string;
  category: string;
  critical: boolean;
  status: EvalCaseDiffStatus;
  baselinePassed: boolean;
  candidatePassed: boolean;
  baselineScore: number;
  candidateScore: number;
  failedReasons: string[];
}

export interface EvalCategorySlice {
  category: string;
  total: number;
  baselinePassed: number;
  candidatePassed: number;
  baselinePassRatePct: number;
  candidatePassRatePct: number;
  improved: number;
  regressed: number;
  samePass: number;
  sameFail: number;
}

export interface EvalRunSummary {
  totalCount: number;
  passedCount: number;
  failedCount: number;
  passRatePct: number;
  avgCostUc: number;
  p50TtftMs: number;
  p95TtftMs: number;
}

export interface CompareEvalRunsOptions {
  baselineCostPerTaskUcOverride?: number;
  candidateCostPerTaskUcOverride?: number;
  candidateP95TtftMsOverride?: number;
}

export interface EvalRunComparisonResult {
  totalCases: number;
  improvedCount: number;
  regressedCount: number;
  samePassCount: number;
  sameFailCount: number;
  criticalRegressionIds: string[];
  regressedCaseIds: string[];
  improvedCaseIds: string[];
  netPassRateDeltaPct: number;
  costDeltaUc: number;
  costDeltaPct: number;
  baseline: EvalRunSummary;
  candidate: EvalRunSummary;
  slices: Record<string, EvalCategorySlice>;
  perCaseDiffs: EvalPerCaseDiff[];
}

export interface OfflineEvalGateOptions {
  initialPromptVersion?: string;
  initialSystemPrompt?: string;
  minPassRatePct?: number;
  maxPassRateDropPct?: number;
  blockOnCriticalRegression?: boolean;
  budgetUc?: number;
  maxCostIncreasePct?: number;
  maxTtftMs?: number;
  requireCalibrationTrust?: boolean;
}

export interface EvaluateReleaseInput extends CompareEvalRunsOptions {
  candidateVersion: string;
  candidateSystemPrompt?: string;
  goldenCases: readonly EvalGoldenCase[];
  baselineOutputs: readonly EvalCandidateOutput[] | ReadonlyMap<string, EvalCandidateOutput>;
  candidateOutputs: readonly EvalCandidateOutput[] | ReadonlyMap<string, EvalCandidateOutput>;
  calibrationReport?: JudgeCalibrationReport;
}

export interface EvalGateDecision {
  decision: OfflineEvalGateDecisionType;
  released: boolean;
  candidateVersion: string;
  previousActiveVersion: string;
  activePromptVersion: string;
  liveHotPathLatencyMs: 0;
  blockReasons: string[];
  comparison: EvalRunComparisonResult;
  calibrationReport?: JudgeCalibrationReport;
  decidedAtIso: string;
}

export interface SeededRegressionVerificationResult {
  verified: boolean;
  cleanDecision: EvalGateDecision;
  seededRegressionDecision: EvalGateDecision;
  activeVersionPreserved: boolean;
  reasonsDetected: string[];
}

function toOutputMap(outputs: readonly EvalCandidateOutput[] | ReadonlyMap<string, EvalCandidateOutput>): ReadonlyMap<string, EvalCandidateOutput> {
  if (outputs instanceof Map) return outputs;
  const map = new Map<string, EvalCandidateOutput>();
  for (const out of outputs as readonly EvalCandidateOutput[]) map.set(out.caseId, out);
  return map;
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))].toFixed(2));
}

function summarizeRun(grades: readonly EvalPropertyGradeResult[], outputs: readonly EvalCandidateOutput[], costOverride?: number, p95Override?: number): EvalRunSummary {
  const totalCount = grades.length;
  const passedCount = grades.filter((g) => g.passed).length;
  const costs = outputs.map((o) => o.costUc).filter((c): c is number => typeof c === 'number' && Number.isFinite(c));
  const avgCostUc = costOverride !== undefined
    ? Number(costOverride.toFixed(2))
    : (costs.length > 0 ? Number((costs.reduce((a, b) => a + b, 0) / costs.length).toFixed(2)) : 0);
  const ttfts = outputs.map((o) => o.ttftMs ?? o.latencyMs).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  return {
    totalCount,
    passedCount,
    failedCount: totalCount - passedCount,
    passRatePct: totalCount > 0 ? Number(((passedCount / totalCount) * 100).toFixed(2)) : 0,
    avgCostUc,
    p50TtftMs: percentile(ttfts, 0.5),
    p95TtftMs: p95Override !== undefined ? Number(p95Override.toFixed(2)) : percentile(ttfts, 0.95),
  };
}

/** Compares baseline vs candidate eval runs per golden case, by category slice, and across cost/TTFT. */
export function compareEvalRunsPerCase(
  goldenCases: readonly EvalGoldenCase[],
  baselineOutputs: readonly EvalCandidateOutput[] | ReadonlyMap<string, EvalCandidateOutput>,
  candidateOutputs: readonly EvalCandidateOutput[] | ReadonlyMap<string, EvalCandidateOutput>,
  options: CompareEvalRunsOptions = {}
): EvalRunComparisonResult {
  const baseMap = toOutputMap(baselineOutputs);
  const candMap = toOutputMap(candidateOutputs);
  const baseGrades: EvalPropertyGradeResult[] = [];
  const candGrades: EvalPropertyGradeResult[] = [];
  const baseUsed: EvalCandidateOutput[] = [];
  const candUsed: EvalCandidateOutput[] = [];
  const perCaseDiffs: EvalPerCaseDiff[] = [];
  const sliceAccum = new Map<string, EvalCategorySlice>();
  const criticalRegressionIds: string[] = [];
  const regressedCaseIds: string[] = [];
  const improvedCaseIds: string[] = [];
  let improvedCount = 0, regressedCount = 0, samePassCount = 0, sameFailCount = 0;

  for (const gc of goldenCases) {
    const baseOut = baseMap.get(gc.id) ?? { caseId: gc.id, answer: '' };
    const candOut = candMap.get(gc.id) ?? { caseId: gc.id, answer: '' };
    baseUsed.push(baseOut);
    candUsed.push(candOut);
    const bGrade = gradeEvalCaseProperties(gc, baseOut);
    const cGrade = gradeEvalCaseProperties(gc, candOut);
    baseGrades.push(bGrade);
    candGrades.push(cGrade);

    let status: EvalCaseDiffStatus = 'sameFail';
    if (bGrade.passed && cGrade.passed) { status = 'samePass'; samePassCount++; }
    else if (!bGrade.passed && cGrade.passed) { status = 'improved'; improvedCount++; improvedCaseIds.push(gc.id); }
    else if (bGrade.passed && !cGrade.passed) { status = 'regressed'; regressedCount++; regressedCaseIds.push(gc.id); if (gc.critical) criticalRegressionIds.push(gc.id); }
    else { sameFailCount++; }

    perCaseDiffs.push({ caseId: gc.id, category: gc.category, critical: Boolean(gc.critical), status, baselinePassed: bGrade.passed, candidatePassed: cGrade.passed, baselineScore: bGrade.score, candidateScore: cGrade.score, failedReasons: cGrade.failedReasons });
    const slice = sliceAccum.get(gc.category) ?? { category: gc.category, total: 0, baselinePassed: 0, candidatePassed: 0, baselinePassRatePct: 0, candidatePassRatePct: 0, improved: 0, regressed: 0, samePass: 0, sameFail: 0 };
    slice.total++;
    if (bGrade.passed) slice.baselinePassed++;
    if (cGrade.passed) slice.candidatePassed++;
    slice[status]++;
    sliceAccum.set(gc.category, slice);
  }

  const slices: Record<string, EvalCategorySlice> = {};
  for (const [cat, s] of sliceAccum.entries()) {
    s.baselinePassRatePct = s.total > 0 ? Number(((s.baselinePassed / s.total) * 100).toFixed(2)) : 0;
    s.candidatePassRatePct = s.total > 0 ? Number(((s.candidatePassed / s.total) * 100).toFixed(2)) : 0;
    slices[cat] = s;
  }

  const baseline = summarizeRun(baseGrades, baseUsed, options.baselineCostPerTaskUcOverride);
  const candidate = summarizeRun(candGrades, candUsed, options.candidateCostPerTaskUcOverride, options.candidateP95TtftMsOverride);
  const netPassRateDeltaPct = Number((candidate.passRatePct - baseline.passRatePct).toFixed(2));
  const costDeltaUc = Number((candidate.avgCostUc - baseline.avgCostUc).toFixed(2));
  const costDeltaPct = baseline.avgCostUc > 0 ? Number((((candidate.avgCostUc - baseline.avgCostUc) / baseline.avgCostUc) * 100).toFixed(2)) : (candidate.avgCostUc > 0 ? 100 : 0);

  return { totalCases: goldenCases.length, improvedCount, regressedCount, samePassCount, sameFailCount, criticalRegressionIds, regressedCaseIds, improvedCaseIds, netPassRateDeltaPct, costDeltaUc, costDeltaPct, baseline, candidate, slices, perCaseDiffs };
}

/** Stateful out-of-band offline release gate preserving active prompt state (`0ms` live latency) on block. */
export class OfflineEvalGate {
  private activePromptVersion: string;
  private activeSystemPrompt?: string;
  private readonly minPassRatePct: number;
  private readonly maxPassRateDropPct: number;
  private readonly blockOnCriticalRegression: boolean;
  private readonly budgetUc: number;
  private readonly maxCostIncreasePct: number;
  private readonly maxTtftMs: number;
  private readonly requireCalibrationTrust: boolean;
  private readonly history: EvalGateDecision[] = [];

  constructor(options: OfflineEvalGateOptions = {}) {
    this.activePromptVersion = options.initialPromptVersion ?? 'v1.0.0';
    this.activeSystemPrompt = options.initialSystemPrompt;
    this.minPassRatePct = options.minPassRatePct ?? 90;
    this.maxPassRateDropPct = options.maxPassRateDropPct ?? 0;
    this.blockOnCriticalRegression = options.blockOnCriticalRegression ?? true;
    this.budgetUc = options.budgetUc ?? 630_000;
    this.maxCostIncreasePct = options.maxCostIncreasePct ?? 10;
    this.maxTtftMs = options.maxTtftMs ?? 2_000;
    this.requireCalibrationTrust = options.requireCalibrationTrust ?? false;
  }

  getActivePrompt(): { version: string; systemPrompt?: string; liveHotPathLatencyMs: 0 } {
    return { version: this.activePromptVersion, systemPrompt: this.activeSystemPrompt, liveHotPathLatencyMs: 0 };
  }

  getDecisionHistory(): readonly EvalGateDecision[] {
    return [...this.history];
  }

  evaluateCandidate(input: EvaluateReleaseInput): EvalGateDecision {
    const previousActiveVersion = this.activePromptVersion;
    const comparison = compareEvalRunsPerCase(input.goldenCases, input.baselineOutputs, input.candidateOutputs, input);
    const blockReasons: string[] = [];

    if (input.goldenCases.length === 0) blockReasons.push('empty_golden_dataset');
    if (this.blockOnCriticalRegression && comparison.criticalRegressionIds.length > 0) blockReasons.push(`critical_case_regression:${comparison.criticalRegressionIds.join(',')}`);
    if (comparison.candidate.passRatePct < this.minPassRatePct) blockReasons.push(`below_min_pass_rate:${comparison.candidate.passRatePct}%<${this.minPassRatePct}%`);
    if (comparison.netPassRateDeltaPct < -this.maxPassRateDropPct) blockReasons.push(`pass_rate_regression:${comparison.netPassRateDeltaPct}%<-${this.maxPassRateDropPct}%`);
    if (comparison.candidate.avgCostUc > this.budgetUc) blockReasons.push(`cost_exceeds_budget:${comparison.candidate.avgCostUc}UC>${this.budgetUc}UC`);
    if (comparison.costDeltaPct > this.maxCostIncreasePct) blockReasons.push(`cost_delta_exceeds_limit:+${comparison.costDeltaPct}%>+${this.maxCostIncreasePct}%`);
    if (comparison.candidate.p95TtftMs > this.maxTtftMs) blockReasons.push(`ttft_exceeds_sla:${comparison.candidate.p95TtftMs}ms>${this.maxTtftMs}ms`);
    if (this.requireCalibrationTrust && input.calibrationReport && !input.calibrationReport.trusted) blockReasons.push('untrusted_judge_calibration');

    const blocked = blockReasons.length > 0;
    if (!blocked) {
      this.activePromptVersion = input.candidateVersion;
      if (input.candidateSystemPrompt !== undefined) this.activeSystemPrompt = input.candidateSystemPrompt;
    }

    const decision: EvalGateDecision = { decision: blocked ? 'BLOCK_RELEASE' : 'ALLOW_RELEASE', released: !blocked, candidateVersion: input.candidateVersion, previousActiveVersion, activePromptVersion: this.activePromptVersion, liveHotPathLatencyMs: 0, blockReasons, comparison, calibrationReport: input.calibrationReport, decidedAtIso: new Date().toISOString() };
    this.history.push(decision);
    return decision;
  }
}

export const createOfflineEvalGate = (options: OfflineEvalGateOptions = {}): OfflineEvalGate => new OfflineEvalGate(options);

/** Self-tests OfflineEvalGate against clean and seeded-regression runs to confirm blocking behavior. */
export function verifyGateWithSeededRegression(options: OfflineEvalGateOptions = {}): SeededRegressionVerificationResult {
  const goldenCases: EvalGoldenCase[] = [
    {
      id: 'price-sku-critical',
      category: 'product_pricing',
      critical: true,
      prompt: 'Baohong 300gsm Cold Press price and SKU?',
      contextChunks: ['Baohong 300gsm Cold Press A4 (SKU BH-300-A4): 145,000 VND, 45 in stock [Doc 1].'],
      properties: [{ type: 'grounded_in_context', minScore: 0.9, strictNumbers: true, strictSkus: true, critical: true }, { type: 'citation_required', minCount: 1 }],
    },
    {
      id: 'refund-policy',
      category: 'policy',
      prompt: 'Damaged watercolor pad refund window?',
      contextChunks: ['Damaged items receive 100% refund within 24 hours with photo proof [Doc 2].'],
      properties: [{ type: 'contains_all', values: ['100%', '24'], caseSensitive: false }, { type: 'refusal_check', expectRefusal: false }],
    },
  ];
  const baselineOutputs: EvalCandidateOutput[] = [
    { caseId: 'price-sku-critical', answer: 'Baohong 300gsm (SKU BH-300-A4) is 145,000 VND with 45 in stock [Doc 1].', ttftMs: 420, costUc: 540_000 },
    { caseId: 'refund-policy', answer: 'Damaged items qualify for a 100% refund within 24 hours [Doc 2].', ttftMs: 410, costUc: 540_000 },
  ];
  const regressedOutputs: EvalCandidateOutput[] = [
    { caseId: 'price-sku-critical', answer: 'Baohong 300gsm (SKU BH-999-FAKE) is on flash discount for 99,000 VND [Doc 1].', ttftMs: 420, costUc: 540_000 },
    { caseId: 'refund-policy', answer: 'Please check store policy later.', ttftMs: 410, costUc: 540_000 },
  ];

  const cleanDecision = createOfflineEvalGate({ initialPromptVersion: 'v1.0.0', ...options }).evaluateCandidate({ candidateVersion: 'v1.1.0-clean', goldenCases, baselineOutputs, candidateOutputs: baselineOutputs });
  const seededGate = createOfflineEvalGate({ initialPromptVersion: 'v1.0.0', ...options });
  const seededRegressionDecision = seededGate.evaluateCandidate({ candidateVersion: 'v1.2.0-regressed', goldenCases, baselineOutputs, candidateOutputs: regressedOutputs });
  const activeVersionPreserved = seededGate.getActivePrompt().version === (options.initialPromptVersion ?? 'v1.0.0');

  return { verified: cleanDecision.decision === 'ALLOW_RELEASE' && seededRegressionDecision.decision === 'BLOCK_RELEASE' && activeVersionPreserved, cleanDecision, seededRegressionDecision, activeVersionPreserved, reasonsDetected: seededRegressionDecision.blockReasons };
}
