/**
 * @kido/ai-stream - Full-Stack AI Production Delivery Suite (GonnaCrash World 3 Level 19 Boss Fight)
 *
 * Implements GonnaCrash World 3 Level 19 (`ai_feature_launch`) with:
 * - Streaming Partial JSON parser & progressive `StreamingProductCardExtractor`
 * - Strict Schema-Validated Semantic Cache Gate (`writeBlockedInvalidJson`, `readEvictedInvalidJson`, size M/L isolation)
 * - Backoff-to-Client SSE `event: waiting` feedback bridge (`onRetry` -> SSE frame without duplicating backoff math)
 * - Deterministic Level 19 Boss-Fight 3-Star verifier (`0.3558¢/task` / `355,785 UC`)
 */

export * from './partial-json-stream.js';
export * from './validated-semantic-cache.js';
export * from './waiting-feedback-sse.js';
export * from './level19-simulator.js';
