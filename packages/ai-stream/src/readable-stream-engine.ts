/**
 * @kido/ai-stream - ReadableStream Engine & Fetch SSE Consumer
 *
 * Provides smooth token stream synthesis, sub-10ms initial frame flushing,
 * and high-performance client-side consumption with fallback to JSON.
 */

import {
  formatOpenAiDeltaFrame,
  formatSseDoneFrame,
  formatSseEventFrame,
  SseStreamParser,
} from './sse-protocol.js';

export interface StreamTtftMetrics {
  ttftMs: number;
  totalDurationMs: number;
  chunkCount: number;
  totalChars: number;
  mode: 'sse' | 'json-fallback';
}

export interface CreateSseTokenStreamOptions {
  meta?: Record<string, unknown>;
  tokenSource: AsyncIterable<string> | Iterable<string> | string;
  chunkDelayMs?: number;
  model?: string;
  onComplete?: (fullText: string) => void | Promise<void>;
}

export interface SseConsumerHandlers {
  onMeta?: (meta: any) => void;
  onToken?: (token: string, accumulated: string) => void;
  onDone?: (finalText: string, metrics: StreamTtftMetrics) => void;
  onError?: (err: Error) => void;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Splits response into natural word clusters while preserving markdown, emojis, and newlines.
 * Guarantees chunks.join('') === text.
 */
export function tokenizeForSmoothStream(text: string, wordsPerChunk: number = 2): string[] {
  if (!text) return [];
  const effectiveWordsPerChunk = Math.max(1, wordsPerChunk);
  const rawSegments = text.match(/\S+\s*|\s+/gu) ?? [text];
  if (effectiveWordsPerChunk === 1 || rawSegments.length <= 1) return rawSegments;

  const chunks: string[] = [];
  let currentGroup = '';
  let count = 0;

  for (const seg of rawSegments) {
    currentGroup += seg;
    if (/\S/u.test(seg)) count++;
    if (count >= effectiveWordsPerChunk) {
      chunks.push(currentGroup);
      currentGroup = '';
      count = 0;
    }
  }
  if (currentGroup.length > 0) chunks.push(currentGroup);
  return chunks;
}

/**
 * Creates WHATWG ReadableStream<Uint8Array> that:
 * 1. Flushes ': stream-open\n\n' and optional 'event: meta' (< 10ms TTFT).
 * 2. Streams each token as an OpenAI-compatible delta frame.
 * 3. Emits 'event: done' and 'data: [DONE]'.
 */
export function createSseTokenReadableStream(
  options: CreateSseTokenStreamOptions
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(encoder.encode(': stream-open\n\n'));
        if (options.meta !== undefined) {
          controller.enqueue(encoder.encode(formatSseEventFrame('meta', options.meta)));
        }

        let fullText = '';
        const delay = options.chunkDelayMs ?? 0;
        const tokens: AsyncIterable<string> | Iterable<string> =
          typeof options.tokenSource === 'string'
            ? tokenizeForSmoothStream(options.tokenSource, 2)
            : options.tokenSource;

        for await (const token of tokens) {
          if (delay > 0) await sleep(delay);
          fullText += token;
          const frame = formatOpenAiDeltaFrame(token, { model: options.model });
          controller.enqueue(encoder.encode(frame));
        }

        controller.enqueue(encoder.encode(formatSseEventFrame('done', { fullText })));
        controller.enqueue(encoder.encode(formatSseDoneFrame()));
        controller.close();

        if (options.onComplete) await options.onComplete(fullText);
      } catch (err) {
        controller.error(err);
      }
    },
  });
}

/**
 * Consumes a fetch Response stream using SseStreamParser for text/event-stream,
 * or gracefully falls back to await response.json() for application/json.
 */
export async function consumeSseReadableStream(
  response: Response,
  handlers: SseConsumerHandlers = {}
): Promise<{ text: string; meta: any; metrics: StreamTtftMetrics }> {
  const startTime = performance.now();
  let firstTokenTime: number | null = null;
  let accumulatedText = '';
  let extractedMeta: any = undefined;
  let chunkCount = 0;

  const contentType = (response.headers.get('content-type') || '').toLowerCase();

  try {
    if (contentType.includes('text/event-stream')) {
      const parser = new SseStreamParser();

      const processEvent = (ev: {
        event: string;
        data: string;
        parsedJson?: any;
        isDone: boolean;
      }) => {
        if (ev.event === 'meta') {
          extractedMeta = ev.parsedJson ?? ev.data;
          if (firstTokenTime === null) firstTokenTime = performance.now();
          handlers.onMeta?.(extractedMeta);
          return;
        }
        if (ev.isDone) return;

        const deltaContent = ev.parsedJson?.choices?.[0]?.delta?.content;
        const altContent = ev.parsedJson?.content || ev.parsedJson?.answer || ev.parsedJson?.text;
        const incomingText =
          typeof deltaContent === 'string'
            ? deltaContent
            : typeof altContent === 'string'
              ? altContent
              : !ev.parsedJson && ev.data && ev.data !== '[DONE]'
                ? ev.data
                : null;

        if (incomingText !== null) {
          if (firstTokenTime === null) firstTokenTime = performance.now();
          accumulatedText += incomingText;
          chunkCount++;
          handlers.onToken?.(incomingText, accumulatedText);
        }
      };

      if (response.body) {
        const reader = response.body.getReader();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) {
            for (const ev of parser.push(value)) processEvent(ev);
          }
        }
      }

      for (const ev of parser.flush()) processEvent(ev);

      const endTime = performance.now();
      const totalDurationMs = Math.round(endTime - startTime);
      const ttftMs = firstTokenTime !== null ? Math.round(firstTokenTime - startTime) : totalDurationMs;

      const metrics: StreamTtftMetrics = {
        ttftMs,
        totalDurationMs,
        chunkCount,
        totalChars: accumulatedText.length,
        mode: 'sse',
      };

      handlers.onDone?.(accumulatedText, metrics);
      return { text: accumulatedText, meta: extractedMeta, metrics };
    }

    // Fallback: application/json or non-SSE response
    const json = await response.json();
    const endTime = performance.now();
    const totalDurationMs = Math.round(endTime - startTime);

    extractedMeta = json.meta ?? json.metadata ?? undefined;
    if (extractedMeta !== undefined) handlers.onMeta?.(extractedMeta);

    const text =
      json.answer ??
      json.reply ??
      json.content ??
      json.advice ??
      json.text ??
      (typeof json === 'string' ? json : JSON.stringify(json));

    accumulatedText = String(text);
    chunkCount = 1;
    handlers.onToken?.(accumulatedText, accumulatedText);

    const metrics: StreamTtftMetrics = {
      ttftMs: totalDurationMs,
      totalDurationMs,
      chunkCount,
      totalChars: accumulatedText.length,
      mode: 'json-fallback',
    };

    handlers.onDone?.(accumulatedText, metrics);
    return { text: accumulatedText, meta: extractedMeta, metrics };
  } catch (err) {
    handlers.onError?.(err as Error);
    throw err;
  }
}
