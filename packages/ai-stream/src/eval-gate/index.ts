/**
 * @kido/ai-stream - Out-of-Band Offline Eval Gate & LLM-as-a-Judge Suite (GonnaCrash Level 18)
 *
 * Implements GonnaCrash World 3 Level 18 (`eval_before_release`) with:
 * - Property-based code-first graders & deterministic price/SKU/number groundedness checks
 * - Calibrated LLM-as-a-Judge agreement (Cohen's kappa, cross-family vs same-family warning) & `pass^k`
 * - Out-of-band `OfflineEvalGate` (`0ms` live hot-path latency) blocking regressions before release
 * - Deterministic Level 18 3-Star SLA & Best Cost verifier (`0.5422¢/task` / `542,218 UC`)
 */

export * from './property-graders.js';
export * from './judge-calibrator.js';
export * from './offline-eval-gate.js';
export * from './level18-simulator.js';
