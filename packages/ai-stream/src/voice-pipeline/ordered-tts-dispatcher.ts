/**
 * @kido/ai-stream/voice-pipeline - Concurrent FIFO-Ordered TTS Dispatcher (Internal Helper)
 *
 * Schedules sentence clauses onto a concurrency-bounded TTS synthesizer pool while draining
 * audio frames strictly in FIFO clause order (`0, 1, 2, ...`) with instant barge-in abort.
 */

import type { VoiceSentenceChunk } from './sentence-chunker.js';
import { isVoiceBargeInError } from './turn-controller.js';

export type TtsAudioSynthesisOutput =
  | Uint8Array
  | { bytes: Uint8Array; mimeType?: string; durationMs?: number };

export type TtsSynthesizerFn = (
  clause: VoiceSentenceChunk,
  signal: AbortSignal
) => Promise<TtsAudioSynthesisOutput> | AsyncIterable<TtsAudioSynthesisOutput>;

export interface NormalizedTtsChunk {
  bytes: Uint8Array;
  mimeType: string;
  durationMs?: number;
}

export interface OrderedTtsEmission {
  clause: VoiceSentenceChunk;
  chunkIndex: number;
  audio: NormalizedTtsChunk;
  isFinalChunkOfClause: boolean;
}

interface OrderedTtsSlot {
  clause: VoiceSentenceChunk;
  buffered: NormalizedTtsChunk[];
  done: boolean;
  error?: unknown;
  wakeup?: () => void;
}

const normalizeTtsChunk = (out: TtsAudioSynthesisOutput): NormalizedTtsChunk =>
  out instanceof Uint8Array
    ? { bytes: out, mimeType: 'audio/pcm' }
    : { bytes: out.bytes, mimeType: out.mimeType ?? 'audio/pcm', durationMs: out.durationMs };

const isAsyncIterable = <T>(val: unknown): val is AsyncIterable<T> =>
  typeof val === 'object' &&
  val !== null &&
  typeof (val as AsyncIterable<T>)[Symbol.asyncIterator] === 'function';

export function waitForSignalOrWake(
  signal: AbortSignal,
  registerWake: (wake: () => void) => void
): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', finish);
      resolve();
    };
    signal.addEventListener('abort', finish, { once: true });
    registerWake(finish);
  });
}

class AsyncSemaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(limit: number) {
    this.available = Math.max(1, limit);
  }

  acquire(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    if (this.available > 0) {
      this.available -= 1;
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      const onWake = () => {
        signal.removeEventListener('abort', onAbort);
        resolve(true);
      };
      const onAbort = () => {
        const idx = this.waiters.indexOf(onWake);
        if (idx >= 0) this.waiters.splice(idx, 1);
        resolve(false);
      };
      this.waiters.push(onWake);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.available += 1;
  }
}

export class OrderedTtsDispatcher {
  private readonly semaphore: AsyncSemaphore;
  private readonly queue: OrderedTtsSlot[] = [];
  private inputEnded = false;
  private queueWakeup?: () => void;

  constructor(
    private readonly synthesize: TtsSynthesizerFn,
    private readonly signal: AbortSignal,
    maxConcurrent: number
  ) {
    this.semaphore = new AsyncSemaphore(maxConcurrent);
  }

  enqueue(clause: VoiceSentenceChunk): void {
    const slot: OrderedTtsSlot = { clause, buffered: [], done: false };
    this.queue.push(slot);
    this.wakeQueue();

    void (async () => {
      const acquired = await this.semaphore.acquire(this.signal);
      if (!acquired || this.signal.aborted) {
        slot.done = true;
        slot.wakeup?.();
        return;
      }
      try {
        const out = this.synthesize(clause, this.signal);
        if (isAsyncIterable<TtsAudioSynthesisOutput>(out)) {
          for await (const raw of out) {
            if (this.signal.aborted) break;
            slot.buffered.push(normalizeTtsChunk(raw));
            const wake = slot.wakeup;
            slot.wakeup = undefined;
            wake?.();
          }
        } else {
          const resolved = await out;
          if (!this.signal.aborted) slot.buffered.push(normalizeTtsChunk(resolved));
        }
      } catch (err) {
        if (!this.signal.aborted && !isVoiceBargeInError(err)) slot.error = err;
      } finally {
        slot.done = true;
        const wake = slot.wakeup;
        slot.wakeup = undefined;
        wake?.();
        this.semaphore.release();
      }
    })();
  }

  markInputEnded(): void {
    this.inputEnded = true;
    this.wakeQueue();
  }

  async drain(onEmit: (item: OrderedTtsEmission) => boolean): Promise<unknown> {
    while (!this.signal.aborted) {
      const head = this.queue[0];
      if (!head) {
        if (this.inputEnded) break;
        await waitForSignalOrWake(this.signal, (w) => {
          this.queueWakeup = w;
        });
        continue;
      }

      let chunkIndex = 0;
      while (!this.signal.aborted && (!head.done || head.buffered.length > 0)) {
        if (head.buffered.length === 0) {
          await waitForSignalOrWake(this.signal, (w) => {
            head.wakeup = w;
          });
          continue;
        }
        const audio = head.buffered.shift()!;
        if (this.signal.aborted) break;
        const keepGoing = onEmit({
          clause: head.clause,
          chunkIndex,
          audio,
          isFinalChunkOfClause: head.done && head.buffered.length === 0,
        });
        if (!keepGoing) return null;
        chunkIndex += 1;
      }

      if (head.error && !this.signal.aborted) return head.error;
      this.queue.shift();
    }
    return null;
  }

  private wakeQueue(): void {
    const wake = this.queueWakeup;
    this.queueWakeup = undefined;
    wake?.();
  }
}
