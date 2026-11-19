/**
 * @kido/ai-stream/voice-pipeline - Concurrent Ordered Full-Duplex Voice Stream Pipeline
 *
 * Chains Streaming STT -> Streaming LLM -> `VoiceSentenceChunker` -> Concurrent Ordered TTS
 * Synthesis (harvesting `deepgram-js-sdk` endpointing, `pipecat` sentence aggregation +
 * interruption frames, and `elevenlabs-js` chunked streaming TTS flushing).
 *
 * Guarantees:
 * - Overlaps LLM generation of clause `k + 1` with TTS synthesis of clause `k`.
 * - Strict FIFO audio playback ordering (`clauseIndex: 0, 1, 2, ...`) even when a later
 *   clause resolves TTS synthesis faster than an earlier clause.
 * - Instant `AbortController` barge-in cancellation with zero stale audio emitted after abort.
 *
 * Invariant: 100% zero external runtime dependencies and zero sibling-slice imports.
 */

import {
  VoiceSentenceChunker,
  type VoiceSentenceChunk,
  type VoiceSentenceChunkerOptions,
} from './sentence-chunker.js';
import {
  VoiceLatencyBudgetTracker,
  VoiceTurnController,
  isVoiceBargeInError,
  type SttTranscriptEvent,
  type VoiceLatencyBudgetReport,
} from './turn-controller.js';
import {
  OrderedTtsDispatcher,
  waitForSignalOrWake,
  type TtsAudioSynthesisOutput,
  type TtsSynthesizerFn,
} from './ordered-tts-dispatcher.js';

export type { TtsAudioSynthesisOutput, TtsSynthesizerFn };

export interface VoicePipelineSummary {
  turnId: number;
  transcript: string;
  fullResponseText: string;
  clausesEmitted: number;
  audioFramesEmitted: number;
  interrupted: boolean;
  interruptionReason?: string;
  latency: VoiceLatencyBudgetReport;
}

export type VoicePipelineEvent =
  | { type: 'stt_interim'; text: string; elapsedMs: number }
  | { type: 'stt_final'; text: string; turnId: number; elapsedMs: number }
  | { type: 'llm_token'; token: string; elapsedMs: number }
  | { type: 'voice_clause'; clause: VoiceSentenceChunk; elapsedMs: number }
  | {
      type: 'tts_audio';
      clauseIndex: number;
      chunkIndex: number;
      clause: VoiceSentenceChunk;
      bytes: Uint8Array;
      mimeType: string;
      durationMs?: number;
      isFirstAudio: boolean;
      isFinalChunkOfClause: boolean;
      elapsedMs: number;
    }
  | { type: 'interrupted'; turnId: number; reason: string; elapsedMs: number }
  | { type: 'turn_complete'; summary: VoicePipelineSummary; elapsedMs: number };

export interface VoiceStreamPipelineOptions {
  sttStream?: AsyncIterable<SttTranscriptEvent>;
  transcript?: string;
  llmStream: (transcript: string, signal: AbortSignal) => AsyncIterable<string>;
  ttsSynthesize: TtsSynthesizerFn;
  chunkerOptions?: VoiceSentenceChunkerOptions;
  turnController?: VoiceTurnController;
  budgetMs?: number;
  maxConcurrentTts?: number;
  signal?: AbortSignal;
  now?: () => number;
}

function getAbortReason(signal: AbortSignal): string {
  const r = signal.reason;
  if (isVoiceBargeInError(r)) return r.reason;
  if (r instanceof Error) return r.message;
  return typeof r === 'string' && r ? r : 'user_barge_in';
}

/**
 * Full-duplex async generator chaining streaming STT -> streaming LLM ->
 * sentence-boundary chunking -> concurrent FIFO-ordered TTS synthesis with
 * instant barge-in abort propagation.
 */
export async function* runVoiceStreamPipeline(
  options: VoiceStreamPipelineOptions
): AsyncGenerator<VoicePipelineEvent, VoicePipelineSummary, void> {
  const now = options.now ?? (() => Date.now());
  const controller = options.turnController ?? new VoiceTurnController({ now });
  const chunker = new VoiceSentenceChunker(options.chunkerOptions);
  const tracker = new VoiceLatencyBudgetTracker({ budgetMs: options.budgetMs ?? 1_200, now });

  const startedAtMs = now();
  const elapsed = (): number => Math.max(0, now() - startedAtMs);
  tracker.markSpeechEnd(startedAtMs);

  let transcript = '';
  let turnId = controller.getSnapshot().turnId;
  let turnSignal: AbortSignal | null = null;

  const onExternalAbort = (): void => {
    controller.triggerBargeIn('external_abort');
  };
  if (options.signal) {
    if (options.signal.aborted) {
      yield { type: 'interrupted', turnId, reason: 'external_abort', elapsedMs: elapsed() };
      return {
        turnId,
        transcript: '',
        fullResponseText: '',
        clausesEmitted: 0,
        audioFramesEmitted: 0,
        interrupted: true,
        interruptionReason: 'external_abort',
        latency: tracker.getReport(),
      };
    }
    options.signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  try {
    // Stage 1: Streaming STT endpointing (or direct pre-finalized transcript)
    if (options.sttStream) {
      controller.startListening();
      for await (const sttEvent of options.sttStream) {
        if (options.signal?.aborted) break;
        const commit = controller.ingestSttEvent(sttEvent);
        if (!commit.committed) {
          if (sttEvent.text.trim()) {
            yield { type: 'stt_interim', text: sttEvent.text.trim(), elapsedMs: elapsed() };
          }
          continue;
        }
        transcript = commit.transcript;
        turnId = commit.turnId;
        turnSignal = commit.signal;
        break;
      }
      if (!turnSignal && !options.signal?.aborted) {
        const fallback = (options.transcript ?? controller.getSnapshot().interimTranscript).trim();
        if (fallback) {
          const started = controller.beginProcessing(fallback);
          transcript = started.transcript;
          turnId = started.turnId;
          turnSignal = started.signal;
        }
      }
    } else if (options.transcript !== undefined) {
      const started = controller.beginProcessing(options.transcript);
      transcript = started.transcript;
      turnId = started.turnId;
      turnSignal = started.signal;
    }

    if (!turnSignal || options.signal?.aborted) {
      const aborted = Boolean(options.signal?.aborted);
      const summary: VoicePipelineSummary = {
        turnId,
        transcript,
        fullResponseText: '',
        clausesEmitted: 0,
        audioFramesEmitted: 0,
        interrupted: aborted,
        interruptionReason: aborted ? 'external_abort' : undefined,
        latency: tracker.getReport(),
      };
      yield aborted
        ? { type: 'interrupted', turnId, reason: 'external_abort', elapsedMs: elapsed() }
        : { type: 'turn_complete', summary, elapsedMs: elapsed() };
      return summary;
    }

    tracker.markSttFinal(now());
    yield { type: 'stt_final', text: transcript, turnId, elapsedMs: elapsed() };

    // Stage 2 & 3: Concurrent LLM -> Sentence Chunker -> Ordered FIFO TTS Synthesis
    const activeSignal = turnSignal;
    const dispatcher = new OrderedTtsDispatcher(
      options.ttsSynthesize,
      activeSignal,
      options.maxConcurrentTts ?? 3
    );
    const eventQueue: VoicePipelineEvent[] = [];

    let fullResponseText = '';
    let clausesEmitted = 0;
    let audioFramesEmitted = 0;
    let llmFinished = false;
    let ttsDrainFinished = false;
    let pipelineError: unknown = null;
    let eventWakeup: (() => void) | undefined;

    const wakeEvents = (): void => {
      const wake = eventWakeup;
      eventWakeup = undefined;
      wake?.();
    };
    const pushEvent = (event: VoicePipelineEvent): void => {
      eventQueue.push(event);
      wakeEvents();
    };
    const emitClause = (clause: VoiceSentenceChunk): void => {
      if (clausesEmitted === 0) tracker.markFirstClauseReady(now());
      clausesEmitted += 1;
      pushEvent({ type: 'voice_clause', clause, elapsedMs: elapsed() });
      dispatcher.enqueue(clause);
    };

    const producerTask = (async () => {
      let sawFirstToken = false;
      try {
        for await (const token of options.llmStream(transcript, activeSignal)) {
          if (activeSignal.aborted) break;
          if (!token) continue;
          if (!sawFirstToken) {
            sawFirstToken = true;
            tracker.markLlmFirstToken(now());
          }
          fullResponseText += token;
          pushEvent({ type: 'llm_token', token, elapsedMs: elapsed() });
          for (const clause of chunker.push(token)) {
            if (activeSignal.aborted) break;
            emitClause(clause);
          }
        }
        if (!activeSignal.aborted) {
          for (const tail of chunker.flush()) emitClause(tail);
        }
      } catch (err) {
        if (!activeSignal.aborted && !isVoiceBargeInError(err)) {
          pipelineError = err;
          controller.triggerBargeIn('llm_stream_error');
        }
      } finally {
        llmFinished = true;
        dispatcher.markInputEnded();
        wakeEvents();
      }
    })();

    const drainerTask = (async () => {
      try {
        const ttsError = await dispatcher.drain(({ clause, chunkIndex, audio, isFinalChunkOfClause }) => {
          const isFirstAudio = audioFramesEmitted === 0;
          if (isFirstAudio) {
            tracker.markTtsFirstAudio(now());
            if (!controller.beginSpeaking()) return false;
          }
          audioFramesEmitted += 1;
          pushEvent({
            type: 'tts_audio',
            clauseIndex: clause.index,
            chunkIndex,
            clause,
            bytes: audio.bytes,
            mimeType: audio.mimeType,
            durationMs: audio.durationMs,
            isFirstAudio,
            isFinalChunkOfClause,
            elapsedMs: elapsed(),
          });
          return true;
        });
        if (ttsError && !activeSignal.aborted) {
          pipelineError = ttsError;
          controller.triggerBargeIn('tts_synthesis_error');
        }
      } finally {
        ttsDrainFinished = true;
        wakeEvents();
      }
    })();

    while (true) {
      if (eventQueue.length > 0) {
        const next = eventQueue.shift()!;
        if (activeSignal.aborted && !pipelineError && next.type === 'tts_audio') continue;
        yield next;
        continue;
      }
      if (activeSignal.aborted || (llmFinished && ttsDrainFinished)) break;
      await waitForSignalOrWake(activeSignal, (w) => {
        eventWakeup = w;
      });
    }

    await Promise.allSettled([producerTask, drainerTask]);
    if (pipelineError) throw pipelineError;

    if (activeSignal.aborted) {
      const reason = getAbortReason(activeSignal);
      const summary: VoicePipelineSummary = {
        turnId,
        transcript,
        fullResponseText,
        clausesEmitted,
        audioFramesEmitted,
        interrupted: true,
        interruptionReason: reason,
        latency: tracker.getReport(),
      };
      yield { type: 'interrupted', turnId, reason, elapsedMs: elapsed() };
      return summary;
    }

    controller.completeTurn();
    const summary: VoicePipelineSummary = {
      turnId,
      transcript,
      fullResponseText,
      clausesEmitted,
      audioFramesEmitted,
      interrupted: false,
      latency: tracker.getReport(),
    };
    yield { type: 'turn_complete', summary, elapsedMs: elapsed() };
    return summary;
  } finally {
    if (options.signal) options.signal.removeEventListener('abort', onExternalAbort);
    if (turnSignal && !turnSignal.aborted && controller.getState() !== 'idle') {
      controller.triggerBargeIn('pipeline_closed_early');
    }
  }
}
