/**
 * @kido/ai-stream - Server-Sent Events (SSE) Protocol & Incremental Parser
 *
 * Implements standard SSE framing, OpenAI chat delta chunk formatting,
 * and a streaming UTF-8 safe incremental parser preserving multi-byte boundaries.
 */

export interface OpenAiDeltaChunk {
  id?: string;
  object: 'chat.completion.chunk';
  created: number;
  model?: string;
  choices: Array<{
    index: number;
    delta: {
      role?: 'assistant';
      content?: string;
    };
    finish_reason: string | null;
  }>;
}

export interface ParsedSseEvent {
  event: string;
  data: string;
  id?: string;
  parsedJson?: any;
  isDone: boolean;
}

/**
 * Formats a generic SSE data frame.
 */
export function formatSseDataFrame(data: unknown): string {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  return `data: ${payload}\n\n`;
}

/**
 * Formats an OpenAI chat completion chunk frame.
 */
export function formatOpenAiDeltaFrame(
  contentDelta: string,
  options?: {
    id?: string;
    model?: string;
    finishReason?: string | null;
    created?: number;
  }
): string {
  const chunk: OpenAiDeltaChunk = {
    id: options?.id ?? `chatcmpl-${Date.now()}`,
    object: 'chat.completion.chunk',
    created: options?.created ?? Math.floor(Date.now() / 1000),
    model: options?.model ?? 'gpt-4o-mini',
    choices: [
      {
        index: 0,
        delta: {
          content: contentDelta,
        },
        finish_reason: options?.finishReason ?? null,
      },
    ],
  };

  return `data: ${JSON.stringify(chunk)}\n\n`;
}

/**
 * Formats a named SSE event frame with optional ID.
 */
export function formatSseEventFrame(
  event: string,
  data: unknown,
  id?: string
): string {
  const idLine = id !== undefined ? `id: ${id}\n` : '';
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  return `event: ${event}\n${idLine}data: ${payload}\n\n`;
}

/**
 * Formats the terminal SSE [DONE] frame.
 */
export function formatSseDoneFrame(): string {
  return 'data: [DONE]\n\n';
}

/**
 * Incremental SSE Stream Parser that safely handles multi-byte UTF-8 characters
 * (Vietnamese accents like 'ệ', 'ư', and emojis like '🦫', '🎨') split across network packets.
 */
export class SseStreamParser {
  private decoder: TextDecoder;
  private buffer: string = '';
  private currentEvent: string = 'message';
  private currentDataLines: string[] = [];
  private currentId?: string;

  constructor() {
    this.decoder = new TextDecoder('utf-8');
  }

  /**
   * Pushes a Uint8Array or string chunk and returns any fully parsed SSE events.
   */
  public push(chunk: Uint8Array | string): ParsedSseEvent[] {
    if (typeof chunk === 'string') {
      this.buffer += chunk;
    } else {
      this.buffer += this.decoder.decode(chunk, { stream: true });
    }

    return this.drainBuffer();
  }

  /**
   * Alias for push().
   */
  public parse(chunk: Uint8Array | string): ParsedSseEvent[] {
    return this.push(chunk);
  }

  /**
   * Flushes any remaining bytes in the decoder and drains the buffer.
   */
  public flush(): ParsedSseEvent[] {
    const trailing = this.decoder.decode();
    if (trailing) {
      this.buffer += trailing;
    }

    // If buffer has an unfinished block that didn't terminate with \n\n, append \n\n
    if (this.buffer.length > 0 && !this.buffer.endsWith('\n\n')) {
      this.buffer += '\n\n';
    }

    return this.drainBuffer();
  }

  /**
   * Resets parser state and decoder.
   */
  public reset(): void {
    this.buffer = '';
    this.currentEvent = 'message';
    this.currentDataLines = [];
    this.currentId = undefined;
    this.decoder = new TextDecoder('utf-8');
  }

  private drainBuffer(): ParsedSseEvent[] {
    const events: ParsedSseEvent[] = [];

    while (true) {
      const newlineIndex = this.buffer.indexOf('\n');
      if (newlineIndex === -1) {
        break;
      }

      let line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (line.endsWith('\r')) {
        line = line.slice(0, -1);
      }

      // Empty line signals dispatch of current event block
      if (line === '') {
        const hasContent =
          this.currentDataLines.length > 0 ||
          this.currentEvent !== 'message' ||
          this.currentId !== undefined;

        if (hasContent) {
          const data = this.currentDataLines.join('\n');
          const trimmed = data.trim();
          const isDone = trimmed === '[DONE]' || this.currentEvent === 'done';

          let parsedJson: any = undefined;
          if (trimmed && trimmed !== '[DONE]') {
            try {
              parsedJson = JSON.parse(data);
            } catch {
              // Plaintext payload or non-JSON data
            }
          }

          events.push({
            event: this.currentEvent,
            data,
            id: this.currentId,
            parsedJson,
            isDone,
          });

          // Reset block accumulator
          this.currentEvent = 'message';
          this.currentDataLines = [];
          this.currentId = undefined;
        }
        continue;
      }

      // Ignore comments (keepalive ping or stream-open frames starting with ':')
      if (line.startsWith(':')) {
        continue;
      }

      // Parse field: value
      const colonIndex = line.indexOf(':');
      let field = line;
      let value = '';

      if (colonIndex !== -1) {
        field = line.slice(0, colonIndex);
        value = line.slice(colonIndex + 1);
        if (value.startsWith(' ')) {
          value = value.slice(1);
        }
      }

      if (field === 'event') {
        this.currentEvent = value;
      } else if (field === 'data') {
        this.currentDataLines.push(value);
      } else if (field === 'id') {
        this.currentId = value;
      }
    }

    return events;
  }
}
