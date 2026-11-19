/**
 * @kido/ai-stream - Full-Duplex Voice Streaming & Sentence-Level Chunking Suite
 * (GonnaCrash World 3 Level 25 `voice_assistant_latency`)
 *
 * Implements:
 * - Bilingual VI/EN `VoiceSentenceChunker` + `sanitizeForSpeech` (abbreviations, decimals/VND,
 *   URLs, numbered lists, early first-clause comma flush, markdown stripping)
 * - Full-duplex `VoiceTurnController` (`idle -> listening -> processing -> speaking -> interrupted`,
 *   STT interim/final endpointing, instant `AbortController` barge-in)
 * - `VoiceLatencyBudgetTracker` (`<= 1,200ms` first-audio SLA + bottleneck attribution)
 * - `runVoiceStreamPipeline` (concurrent streaming STT -> LLM -> Chunker -> strict FIFO TTS)
 * - Deterministic `simulateLevel25VoiceAssistantLatency()` (`663,289 UC`, `750ms`, ★★★ record)
 */

export * from './sentence-chunker.js';
export * from './turn-controller.js';
export * from './voice-stream-pipeline.js';
export * from './simulator.js';
