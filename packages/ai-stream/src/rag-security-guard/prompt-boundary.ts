/**
 * @kido/ai-stream/rag-security-guard - Prompt Boundary Hardening & Throttled Streaming Edits
 *
 * Provides XML delimiter escaping, prompt-override detection, safe message boundary
 * clamping, fail-closed upstream unavailable messaging, and progressive chat edit throttling.
 */

import { redactCredentialsDlp, StreamingDlpRedactor } from './dlp-redactor.js';

export const SAFE_UPSTREAM_UNAVAILABLE_MESSAGE =
  'AI synthesis is temporarily unavailable due to upstream demand. Please try again shortly.';

const DEFAULT_BOUNDARY_TAGS = [
  'user_query',
  'slack_context',
  'rag_context',
  'context',
  'system_instruction',
  'instructions',
] as const;

const PROMPT_OVERRIDE_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['ignore_previous_instructions', /\bignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions\b/i],
  ['disregard_system_prompt', /\b(?:disregard|override|bypass)\s+(?:the\s+)?system\s*(?:prompt|instructions|rules)\b/i],
  ['reveal_system_prompt', /\b(?:reveal|print|dump|repeat)\s+(?:your\s+)?(?:system\s*prompt|raw\s*context|verbatim)\b/i],
  ['dump_secrets_or_env', /\b(?:dump|print|extract|show)\s+(?:all\s+)?(?:\.env|passwords?|secrets?|api[_\s]?keys?|tokens?)\b/i],
  ['vi_ignore_instructions', /\bbỏ\s*qua\s*(?:mọi\s*)?(?:hướng\s*dẫn|quy\s*tắc|chỉ\s*thị)\s*(?:trước|ở\s*trên)\b/i],
  ['vi_dump_verbatim', /\bin\s+nguyên\s+văn\s+(?:ngữ\s*cảnh|context|system\s*prompt|mật\s*khẩu)\b/i],
];

/**
 * Escapes closing and opening delimiter tags inside untrusted inputs to prevent XML breakout.
 */
export function escapeBoundaryTags(
  input: string,
  tagNames: readonly string[] = DEFAULT_BOUNDARY_TAGS
): string {
  if (!input) return '';
  const escapedTags = tagNames.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  if (!escapedTags) return input;
  const rx = new RegExp(`<(\\/?\\s*(?:${escapedTags})(?:\\s[^>]*)?)>`, 'gi');
  return input.replace(rx, '&lt;$1&gt;');
}

export interface UntrustedRagContextOptions {
  userQuery: string;
  contextBlocks: readonly string[] | string;
  queryTag?: string;
  contextTag?: string;
  extraTags?: readonly string[];
}

/**
 * Wraps untrusted query and retrieved RAG context in escaped XML delimiter blocks.
 */
export function wrapUntrustedRagContext(options: UntrustedRagContextOptions): string {
  const queryTag = options.queryTag ?? 'user_query';
  const contextTag = options.contextTag ?? 'slack_context';
  const tagList = Array.from(
    new Set([...DEFAULT_BOUNDARY_TAGS, queryTag, contextTag, ...(options.extraTags ?? [])])
  );

  const safeQuery = escapeBoundaryTags(options.userQuery ?? '', tagList);
  const rawContext =
    typeof options.contextBlocks === 'string'
      ? options.contextBlocks
      : options.contextBlocks.join('\n\n');
  const safeContext = escapeBoundaryTags(rawContext, tagList);

  return [
    `<${queryTag}>`,
    safeQuery,
    `</${queryTag}>`,
    '',
    `<${contextTag}>`,
    safeContext,
    `</${contextTag}>`,
  ].join('\n');
}

export interface PromptOverrideDetectionResult {
  flagged: boolean;
  matchedPatterns: string[];
}

/**
 * Detects heuristic prompt-override or raw-secret-exfiltration attempts for audit logging.
 */
export function detectPromptOverrideAttempt(query: string): PromptOverrideDetectionResult {
  if (!query) return { flagged: false, matchedPatterns: [] };
  const matchedPatterns: string[] = [];
  for (const [label, rx] of PROMPT_OVERRIDE_PATTERNS) {
    if (rx.test(query)) matchedPatterns.push(label);
  }
  return { flagged: matchedPatterns.length > 0, matchedPatterns };
}

/**
 * Clamps text strictly at or below maxChars while preferring bullet or paragraph breaks.
 */
export function clampMessageAtBoundary(
  text: string,
  maxChars: number = 2800,
  suffix: string = ''
): string {
  if (!text) return '';
  if (text.length <= maxChars) return text;

  const budget = Math.max(0, maxChars - suffix.length);
  const slice = text.slice(0, budget);
  const minBoundary = Math.floor(budget * 0.45);
  const candidates = [
    slice.lastIndexOf('\n• '),
    slice.lastIndexOf('\n- '),
    slice.lastIndexOf('\n\n'),
    slice.lastIndexOf('\n'),
  ];
  const bestCut = candidates.find((idx) => idx > minBoundary) ?? -1;
  const cleanCut = bestCut > 0 ? slice.slice(0, bestCut).trimEnd() : slice.trimEnd();
  return suffix ? `${cleanCut}${suffix}` : cleanCut;
}

export interface StreamToEditableMessageOptions {
  postInitial: (initialText: string) => Promise<unknown>;
  editMessage: (updatedText: string) => Promise<unknown>;
  tokenSource: AsyncIterable<string> | Iterable<string> | string;
  initialStatusText?: string;
  minEditIntervalMs?: number;
  maxChars?: number;
  useStreamingDlp?: boolean;
  formatText?: (text: string) => string;
  errorFallbackText?: string;
  nowFn?: () => number;
}

export interface StreamToEditableMessageResult {
  text: string;
  ttftMs: number;
  totalDurationMs: number;
  editCount: number;
  usedFallback: boolean;
  error?: Error;
}

/**
 * Progressively streams tokens into an editable chat message (e.g. Slack/Discord/Teams)
 * with throttled intermediate edits, inline streaming DLP redaction, guaranteed final
 * flush/edit, and fail-closed fallback text on upstream errors.
 */
export class ProgressiveMessageEditThrottler {
  public async streamToEditableMessage(
    options: StreamToEditableMessageOptions
  ): Promise<StreamToEditableMessageResult> {
    const nowFn = options.nowFn ?? (() => Date.now());
    const startMs = nowFn();
    const minEditIntervalMs = Math.max(0, options.minEditIntervalMs ?? 900);
    const maxChars = Math.max(50, options.maxChars ?? 2800);
    const useStreamingDlp = options.useStreamingDlp ?? true;
    const formatText = options.formatText ?? ((t: string) => t);
    const fallbackText = options.errorFallbackText ?? SAFE_UPSTREAM_UNAVAILABLE_MESSAGE;

    const initialText = options.initialStatusText ?? '⏳ Processing your request...';
    await options.postInitial(initialText);

    const redactor = useStreamingDlp ? new StreamingDlpRedactor() : null;
    let accumulated = '';
    let lastSentText = initialText;
    let lastEditMs = nowFn();
    let firstTokenMs: number | null = null;
    let editCount = 0;

    const render = (raw: string): string => {
      const scrubbed = redactCredentialsDlp(raw);
      return clampMessageAtBoundary(formatText(scrubbed), maxChars);
    };

    try {
      const iterable: AsyncIterable<string> | Iterable<string> =
        typeof options.tokenSource === 'string'
          ? [options.tokenSource]
          : options.tokenSource;

      for await (const chunk of iterable) {
        if (!chunk) continue;
        const delta = redactor ? redactor.push(chunk) : chunk;
        if (!delta) continue;
        accumulated += delta;
        if (firstTokenMs === null && accumulated.trim().length > 0) {
          firstTokenMs = nowFn();
        }
        const now = nowFn();
        if (now - lastEditMs >= minEditIntervalMs && accumulated.trim().length > 0) {
          const preview = render(accumulated);
          if (preview && preview !== lastSentText) {
            await options.editMessage(preview);
            lastSentText = preview;
            lastEditMs = now;
            editCount++;
          }
        }
      }

      if (redactor) {
        accumulated += redactor.flush();
      }
      if (firstTokenMs === null && accumulated.trim().length > 0) {
        firstTokenMs = nowFn();
      }

      const finalText = accumulated.trim() ? render(accumulated) : fallbackText;
      if (finalText !== lastSentText || editCount === 0) {
        await options.editMessage(finalText);
        lastSentText = finalText;
        editCount++;
      }

      const endMs = nowFn();
      return {
        text: finalText,
        ttftMs: Math.max(0, (firstTokenMs ?? endMs) - startMs),
        totalDurationMs: Math.max(0, endMs - startMs),
        editCount,
        usedFallback: !accumulated.trim(),
      };
    } catch (err) {
      const safeErrorText = clampMessageAtBoundary(fallbackText, maxChars);
      await options.editMessage(safeErrorText);
      const endMs = nowFn();
      return {
        text: safeErrorText,
        ttftMs: Math.max(0, (firstTokenMs ?? endMs) - startMs),
        totalDurationMs: Math.max(0, endMs - startMs),
        editCount: editCount + 1,
        usedFallback: true,
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
  }
}

export function streamToEditableMessage(
  options: StreamToEditableMessageOptions
): Promise<StreamToEditableMessageResult> {
  return new ProgressiveMessageEditThrottler().streamToEditableMessage(options);
}
