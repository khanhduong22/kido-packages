/**
 * @kido/ai-stream/voice-pipeline - Full-Duplex Turn Controller
 *
 * Implements `VoiceTurnController` (`idle -> listening -> processing -> speaking -> interrupted`),
 * Deepgram/LiveKit-style streaming interim/final STT endpointing, and instant `AbortController`
 * barge-in propagation across LLM and TTS stages. Re-exports `VoiceLatencyBudgetTracker`.
 *
 * Invariant: 100% zero external runtime dependencies and zero sibling-slice imports.
 */

export * from './latency-budget.js';

export type VoiceTurnState = 'idle' | 'listening' | 'processing' | 'speaking' | 'interrupted';

export interface SttTranscriptEvent {
  text: string;
  isFinal: boolean;
  /** True when the STT provider detects end-of-utterance (e.g. Deepgram `speech_final`). */
  speechFinal?: boolean;
  /** Optional VAD speech onset signal used to trigger instant barge-in while speaking. */
  vadSpeechDetected?: boolean;
  confidence?: number;
  timestampMs?: number;
}

export interface VoiceBargeInEvent {
  turnId: number;
  previousState: VoiceTurnState;
  reason: string;
  timestampMs: number;
}

export interface VoiceTurnStateChangeEvent {
  turnId: number;
  from: VoiceTurnState;
  to: VoiceTurnState;
  timestampMs: number;
}

export interface VoiceTurnControllerOptions {
  /** Allow user speech/VAD during `processing`/`speaking` to abort current turn (default: true). */
  bargeInEnabled?: boolean;
  /** Minimum trimmed transcript chars to trigger barge-in when VAD flag is omitted (default: 2). */
  bargeInMinChars?: number;
  /** Silence duration (ms) before `checkEndpointing()` commits buffered transcripts (default: 350). */
  endpointSilenceMs?: number;
  /** Auto-commit when `isFinal: true` arrives with `speechFinal === undefined` (default: true). */
  autoCommitOnFinal?: boolean;
  /** Deterministic clock hook for unit tests (default: `Date.now`). */
  now?: () => number;
  onStateChange?: (event: VoiceTurnStateChangeEvent) => void;
  onBargeIn?: (event: VoiceBargeInEvent) => void;
}

export interface VoiceTurnCommitResult {
  committed: boolean;
  bargedIn: boolean;
  transcript: string;
  turnId: number;
  state: VoiceTurnState;
  signal: AbortSignal | null;
}

export interface VoiceTurnBargeInResult {
  interrupted: boolean;
  turnId: number;
  previousState: VoiceTurnState;
  reason: string;
}

export interface VoiceTurnSnapshot {
  state: VoiceTurnState;
  turnId: number;
  bargeInCount: number;
  completedTurns: number;
  activeTranscript: string;
  interimTranscript: string;
  aborted: boolean;
}

/** Typed cancellation error injected into `AbortController.abort()` on barge-in. */
export class VoiceBargeInError extends Error {
  readonly code = 'VOICE_BARGE_IN' as const;
  readonly turnId: number;
  readonly reason: string;

  constructor(turnId: number, reason = 'user_barge_in') {
    super(`Voice turn #${turnId} interrupted by barge-in (${reason})`);
    this.name = 'VoiceBargeInError';
    this.turnId = turnId;
    this.reason = reason;
  }
}

export function isVoiceBargeInError(error: unknown): error is VoiceBargeInError {
  return (
    error instanceof VoiceBargeInError ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { code?: string }).code === 'VOICE_BARGE_IN')
  );
}

/**
 * Full-duplex voice turn state machine managing STT interim/final endpointing
 * and `AbortController` barge-in propagation across LLM and TTS stages.
 */
export class VoiceTurnController {
  private readonly bargeInEnabled: boolean;
  private readonly bargeInMinChars: number;
  private readonly endpointSilenceMs: number;
  private readonly autoCommitOnFinal: boolean;
  private readonly now: () => number;
  private readonly onStateChange?: (event: VoiceTurnStateChangeEvent) => void;
  private readonly onBargeIn?: (event: VoiceBargeInEvent) => void;

  private state: VoiceTurnState = 'idle';
  private turnId = 0;
  private bargeInCount = 0;
  private completedTurns = 0;
  private activeAbortController: AbortController | null = null;
  private finalSegments: string[] = [];
  private interimTranscript = '';
  private activeTranscript = '';
  private lastSpeechAtMs: number | null = null;

  constructor(options: VoiceTurnControllerOptions = {}) {
    this.bargeInEnabled = options.bargeInEnabled ?? true;
    this.bargeInMinChars = Math.max(1, options.bargeInMinChars ?? 2);
    this.endpointSilenceMs = Math.max(0, options.endpointSilenceMs ?? 350);
    this.autoCommitOnFinal = options.autoCommitOnFinal ?? true;
    this.now = options.now ?? (() => Date.now());
    this.onStateChange = options.onStateChange;
    this.onBargeIn = options.onBargeIn;
  }

  /** Transitions into `listening`, triggering barge-in first if currently speaking/processing. */
  startListening(): void {
    if ((this.state === 'processing' || this.state === 'speaking') && this.bargeInEnabled) {
      this.triggerBargeIn('start_listening_barge_in');
    }
    this.finalSegments = [];
    this.interimTranscript = '';
    this.lastSpeechAtMs = null;
    this.transition('listening');
  }

  /**
   * Ingests a streaming STT interim/final event (Deepgram/LiveKit protocol).
   * Automatically triggers barge-in if user speech arrives while `processing` or `speaking`.
   */
  ingestSttEvent(event: SttTranscriptEvent): VoiceTurnCommitResult {
    const trimmed = event.text.trim();
    const eventTime = event.timestampMs ?? this.now();
    let bargedIn = false;

    if (this.state === 'processing' || this.state === 'speaking') {
      const shouldBargeIn =
        this.bargeInEnabled &&
        (event.vadSpeechDetected === true ||
          event.isFinal ||
          trimmed.length >= this.bargeInMinChars);

      if (!shouldBargeIn) {
        return {
          committed: false,
          bargedIn: false,
          transcript: this.activeTranscript,
          turnId: this.turnId,
          state: this.state,
          signal: this.activeAbortController?.signal ?? null,
        };
      }

      this.triggerBargeIn('user_speech_barge_in');
      bargedIn = true;
      this.transition('listening');
    } else if (this.state === 'idle' || this.state === 'interrupted') {
      this.transition('listening');
    }

    if (trimmed || event.vadSpeechDetected) {
      this.lastSpeechAtMs = eventTime;
    }

    if (event.isFinal) {
      if (trimmed) this.finalSegments.push(trimmed);
      this.interimTranscript = '';
    } else if (trimmed) {
      this.interimTranscript = trimmed;
    }

    const combined = this.combineBufferedTranscript();
    const shouldCommit =
      combined.length > 0 &&
      (event.speechFinal === true ||
        (event.isFinal && event.speechFinal === undefined && this.autoCommitOnFinal));

    if (shouldCommit) {
      const started = this.beginProcessing(combined);
      return {
        committed: true,
        bargedIn,
        transcript: started.transcript,
        turnId: started.turnId,
        state: this.state,
        signal: started.signal,
      };
    }

    return {
      committed: false,
      bargedIn,
      transcript: combined,
      turnId: this.turnId,
      state: this.state,
      signal: this.activeAbortController?.signal ?? null,
    };
  }

  /** Checks silence-based endpointing while in `listening` and commits buffered speech if elapsed. */
  checkEndpointing(nowMs?: number): VoiceTurnCommitResult {
    const currentNow = nowMs ?? this.now();
    const combined = this.combineBufferedTranscript();

    if (
      this.state === 'listening' &&
      combined.length > 0 &&
      this.lastSpeechAtMs !== null &&
      currentNow - this.lastSpeechAtMs >= this.endpointSilenceMs
    ) {
      const started = this.beginProcessing(combined);
      return {
        committed: true,
        bargedIn: false,
        transcript: started.transcript,
        turnId: started.turnId,
        state: this.state,
        signal: started.signal,
      };
    }

    return {
      committed: false,
      bargedIn: false,
      transcript: combined,
      turnId: this.turnId,
      state: this.state,
      signal: this.activeAbortController?.signal ?? null,
    };
  }

  /** Commits a finalized transcript into `processing` with a fresh turn `AbortController`. */
  beginProcessing(transcript?: string): { turnId: number; signal: AbortSignal; transcript: string } {
    const resolved = (transcript ?? this.combineBufferedTranscript()).trim();
    this.finalSegments = [];
    this.interimTranscript = '';
    this.lastSpeechAtMs = null;
    this.turnId += 1;
    this.activeTranscript = resolved;
    this.activeAbortController = new AbortController();
    this.transition('processing');

    return { turnId: this.turnId, signal: this.activeAbortController.signal, transcript: resolved };
  }

  /** Transitions `processing -> speaking` on first synthesized audio frame. */
  beginSpeaking(): boolean {
    if (this.state === 'speaking') return true;
    if (this.state !== 'processing' || this.activeAbortController?.signal.aborted) return false;
    this.transition('speaking');
    return true;
  }

  /** Immediately cancels in-flight LLM and TTS work via `AbortController.abort()`. */
  triggerBargeIn(reason = 'user_barge_in'): VoiceTurnBargeInResult {
    const previousState = this.state;
    if (previousState !== 'processing' && previousState !== 'speaking') {
      return { interrupted: false, turnId: this.turnId, previousState, reason };
    }

    this.bargeInCount += 1;
    const controller = this.activeAbortController;
    if (controller && !controller.signal.aborted) {
      controller.abort(new VoiceBargeInError(this.turnId, reason));
    }

    this.finalSegments = [];
    this.interimTranscript = '';
    this.transition('interrupted');
    this.onBargeIn?.({ turnId: this.turnId, previousState, reason, timestampMs: this.now() });

    return { interrupted: true, turnId: this.turnId, previousState, reason };
  }

  /** Marks an uninterrupted turn as cleanly finished and returns to `idle`. */
  completeTurn(): void {
    if (this.state === 'processing' || this.state === 'speaking') this.completedTurns += 1;
    this.activeAbortController = null;
    this.finalSegments = [];
    this.interimTranscript = '';
    this.lastSpeechAtMs = null;
    this.transition('idle');
  }

  reset(): void {
    this.activeAbortController = null;
    this.finalSegments = [];
    this.interimTranscript = '';
    this.activeTranscript = '';
    this.lastSpeechAtMs = null;
    this.transition('idle');
  }

  getState(): VoiceTurnState {
    return this.state;
  }

  getActiveSignal(): AbortSignal | null {
    return this.activeAbortController?.signal ?? null;
  }

  getSnapshot(): VoiceTurnSnapshot {
    return {
      state: this.state,
      turnId: this.turnId,
      bargeInCount: this.bargeInCount,
      completedTurns: this.completedTurns,
      activeTranscript: this.activeTranscript,
      interimTranscript: this.interimTranscript,
      aborted: this.activeAbortController?.signal.aborted ?? false,
    };
  }

  private combineBufferedTranscript(): string {
    const parts = [...this.finalSegments];
    if (this.interimTranscript) parts.push(this.interimTranscript);
    return parts.join(' ').trim();
  }

  private transition(to: VoiceTurnState): void {
    const from = this.state;
    if (from === to) return;
    this.state = to;
    this.onStateChange?.({ turnId: this.turnId, from, to, timestampMs: this.now() });
  }
}

export const createVoiceTurnController = (
  options: VoiceTurnControllerOptions = {}
): VoiceTurnController => new VoiceTurnController(options);
