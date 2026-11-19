/**
 * @kido/ai-stream - Backoff-to-Client SSE Waiting Feedback Bridge (GonnaCrash Level 19)
 *
 * Bridges upstream retry hooks (`onRetry(attempt, delayMs, reason)`) straight into
 * `event: waiting\ndata: {...}\n\n` SSE frames so clients show smooth loading feedback
 * during HTTP 429 livestream bursts (Vercel AI SDK / Stripe pattern).
 *
 * Invariant: Does NOT duplicate exponential backoff math (`rpm-rate-guard` owns backoff/jitter).
 * Invariant: Zero external runtime dependencies and zero imports from sibling slices.
 */

export interface WaitingFeedbackEvent {
  status: 'waiting';
  attempt: number;
  delayMs: number;
  reason: string;
  message: string;
  timestampMs: number;
  id?: string;
}

export interface WaitingFeedbackFrameInput {
  attempt: number;
  delayMs: number;
  reason: string;
  message?: string;
  timestampMs?: number;
  id?: string;
}

export interface WaitingBridgeContext {
  onRetry: (attempt: number, delayMs: number, reason?: string) => void;
  emitData: (data: unknown) => void;
  emitEvent: (event: string, data: unknown, id?: string) => void;
  emitRaw: (rawSseText: string) => void;
  signal: AbortSignal;
}

export interface StreamWithWaitingFeedbackOptions {
  execute: (
    ctx: WaitingBridgeContext
  ) => Promise<AsyncIterable<unknown> | Iterable<unknown> | void> | AsyncIterable<unknown> | Iterable<unknown> | void;
  emitPrelude?: boolean;
  emitDoneFrame?: boolean;
  formatWaitMessage?: (attempt: number, delayMs: number, reason: string) => string;
  onError?: (error: unknown, ctx: WaitingBridgeContext) => void;
  signal?: AbortSignal;
}

function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

/**
 * Formats an SSE `event: waiting\ndata: {...}\n\n` frame from an upstream retry signal.
 */
export function formatSseWaitingFrame(input: WaitingFeedbackFrameInput): string {
  const attempt = Math.max(0, Math.floor(input.attempt));
  const delayMs = Math.max(0, Math.round(input.delayMs));
  const reason = sanitizeHeaderValue(input.reason || 'upstream_rate_limit');
  const message =
    input.message ??
    `Upstream capacity busy (${reason}); retrying in ${delayMs}ms (attempt ${attempt})...`;

  const payload: Omit<WaitingFeedbackEvent, 'id'> = {
    status: 'waiting',
    attempt,
    delayMs,
    reason,
    message,
    timestampMs: input.timestampMs ?? Date.now(),
  };

  const idLine = input.id !== undefined ? `id: ${sanitizeHeaderValue(input.id)}\n` : '';
  return `event: waiting\n${idLine}data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * Parses a raw SSE frame block and returns a typed `WaitingFeedbackEvent` iff it is an `event: waiting` frame.
 */
export function parseSseWaitingFrame(rawFrame: string): WaitingFeedbackEvent | null {
  if (!rawFrame || typeof rawFrame !== 'string') return null;

  let eventName = 'message';
  let id: string | undefined;
  const dataLines: string[] = [];

  for (const rawLine of rawFrame.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith(':')) continue;
    const colonIdx = line.indexOf(':');
    const field = colonIdx === -1 ? line : line.slice(0, colonIdx);
    let value = colonIdx === -1 ? '' : line.slice(colonIdx + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'event') eventName = value;
    else if (field === 'id') id = value;
    else if (field === 'data') dataLines.push(value);
  }

  if (eventName !== 'waiting' || dataLines.length === 0) return null;

  try {
    const parsed = JSON.parse(dataLines.join('\n')) as Partial<WaitingFeedbackEvent>;
    if (
      parsed.status !== 'waiting' ||
      typeof parsed.attempt !== 'number' ||
      !Number.isFinite(parsed.attempt) ||
      typeof parsed.delayMs !== 'number' ||
      !Number.isFinite(parsed.delayMs) ||
      typeof parsed.reason !== 'string'
    ) {
      return null;
    }

    return {
      status: 'waiting',
      attempt: parsed.attempt,
      delayMs: parsed.delayMs,
      reason: parsed.reason,
      message: typeof parsed.message === 'string' ? parsed.message : '',
      timestampMs: typeof parsed.timestampMs === 'number' && Number.isFinite(parsed.timestampMs) ? parsed.timestampMs : 0,
      ...(id !== undefined ? { id } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Adapts `@kido/ai-stream/rpm-rate-guard`'s `onRetry({ attempt, delayMs, error })` callback
 * directly into `WaitingBridgeContext.onRetry(attempt, delayMs, reason)` without duplicating backoff math.
 */
export function createRateGuardWaitingBridge(
  onRetry: WaitingBridgeContext['onRetry']
): (info: { attempt: number; delayMs: number; error?: unknown; retryAfterMs?: number | null }) => void {
  return (info) => {
    const errMsg =
      info.error instanceof Error
        ? info.error.message
        : typeof info.error === 'string'
          ? info.error
          : (info.error as { message?: string } | undefined)?.message;
    onRetry(info.attempt, info.delayMs, errMsg || 'upstream_rate_limit_429');
  };
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value;
}

function isSyncIterable(value: unknown): value is Iterable<unknown> {
  return typeof value === 'object' && value !== null && Symbol.iterator in value;
}

/**
 * Creates a WHATWG `ReadableStream<Uint8Array>` that flushes `event: waiting\ndata: {...}\n\n`
 * frames immediately whenever upstream rate-guard retries fire before or during token streaming.
 */
export function streamWithWaitingFeedback(options: StreamWithWaitingFeedbackOptions): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const internalAbort = new AbortController();
  let closed = false;

  if (options.signal) {
    if (options.signal.aborted) internalAbort.abort(options.signal.reason);
    else options.signal.addEventListener('abort', () => internalAbort.abort(options.signal?.reason), { once: true });
  }

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const safeEnqueue = (text: string): void => {
        if (closed || internalAbort.signal.aborted) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          closed = true;
        }
      };

      const ctx: WaitingBridgeContext = {
        onRetry: (attempt, delayMs, reason = 'upstream_rate_limit_429') => {
          const message = options.formatWaitMessage?.(attempt, delayMs, reason);
          safeEnqueue(formatSseWaitingFrame({ attempt, delayMs, reason, message }));
        },
        emitData: (data) => {
          const payload = typeof data === 'string' ? data : JSON.stringify(data);
          safeEnqueue(`data: ${payload}\n\n`);
        },
        emitEvent: (event, data, id) => {
          const idLine = id !== undefined ? `id: ${sanitizeHeaderValue(id)}\n` : '';
          const payload = typeof data === 'string' ? data : JSON.stringify(data);
          safeEnqueue(`event: ${sanitizeHeaderValue(event)}\n${idLine}data: ${payload}\n\n`);
        },
        emitRaw: (rawSseText) => {
          safeEnqueue(rawSseText);
        },
        signal: internalAbort.signal,
      };

      if (options.emitPrelude !== false) {
        safeEnqueue(': stream-open\n\n');
      }

      try {
        const result = await options.execute(ctx);
        if (isAsyncIterable(result)) {
          for await (const item of result) {
            if (closed || internalAbort.signal.aborted) break;
            ctx.emitData(item);
          }
        } else if (isSyncIterable(result)) {
          for (const item of result) {
            if (closed || internalAbort.signal.aborted) break;
            ctx.emitData(item);
          }
        }
        if (options.emitDoneFrame !== false && !closed && !internalAbort.signal.aborted) {
          safeEnqueue('data: [DONE]\n\n');
        }
      } catch (err) {
        if (options.onError) {
          options.onError(err, ctx);
        } else {
          ctx.emitEvent('error', {
            error: 'stream_execution_failed',
            message: err instanceof Error ? err.message : String(err),
          });
        }
      } finally {
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {
            // Stream already closed or cancelled
          }
        }
      }
    },
    cancel() {
      closed = true;
      internalAbort.abort();
    },
  });
}
