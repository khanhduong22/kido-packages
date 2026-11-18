/**
 * @kido/ai-stream/rag-security-guard - Credential DLP Redactor
 *
 * 18-rule secret and credential scrubber for RAG ingestion, query responses,
 * and streaming LLM token chunks without corrupting standard HTTPS links.
 */

type Replacement = string | ((match: string, ...groups: string[]) => string);

const ENV_KEY_PATTERN =
  '(?:[A-Z0-9_]*(?:PASSWORD|SECRET[A-Z0-9_]*|API_KEY|ACCESS_KEY[A-Z0-9_]*|PRIVATE_KEY|TOKEN[A-Z0-9_]*|SALT)|ENCRYPTION_KEY|APP_KEYS?)';

const ENV_ASSIGN_RE = new RegExp(
  `^([ \\t]*(?:export[ \\t]+)?[\`"']?${ENV_KEY_PATTERN}[\`"']?[ \\t]*=[ \\t]*)(?!(?:process\\.env\\.|\\$\\{|<|\\[REDACTED|""[ \\t]*$|''[ \\t]*$))([^\\r\\n\`]+?)([ \\t]*\`{1,3}[ \\t]*)?$`,
  'gm'
);

const DLP_RULES: ReadonlyArray<readonly [RegExp, Replacement]> = [
  [
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    '[REDACTED_PRIVATE_KEY]',
  ],
  [/\bxox[baprs]-[A-Za-z0-9-]{6,}/g, '[REDACTED_SLACK_TOKEN]'],
  [
    /\b(?:whsec|sk_live|rk_live|sk_test|rk_test)_[A-Za-z0-9]{8,}\b/g,
    '[REDACTED_STRIPE_SECRET]',
  ],
  [/\bya29\.[A-Za-z0-9._-]{10,}/g, '[REDACTED_GOOGLE_OAUTH]'],
  [/\bAIza[0-9A-Za-z_-]{20,}/g, '[REDACTED_GOOGLE_API_KEY]'],
  [
    /\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/g,
    '[REDACTED_GITHUB_TOKEN]',
  ],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED_AWS_KEY]'],
  [
    /\beyJ[A-Za-z0-9_-]{6,}\.eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g,
    '[REDACTED_JWT]',
  ],
  [
    /(\bAuthorization[ \t]*:[ \t]*Bearer[ \t]+)(?!\[REDACTED)([^\s'"`<>\\]{8,})/gi,
    '$1[REDACTED_TOKEN]',
  ],
  [
    /(\bAuthorization[ \t]*:[ \t]*Basic[ \t]+)(?!\[REDACTED)([^\s'"`<>\\]{8,})/gi,
    '$1[REDACTED_TOKEN]',
  ],
  [
    /(\b(?:jwtToken|jwt|access_token|refresh_token|id_token|client_secret)=)(?!\[REDACTED)([^\s;&'"`<>]{8,})/gi,
    '$1[REDACTED_TOKEN]',
  ],
  [
    ENV_ASSIGN_RE,
    (_m: string, prefix: string, _val: string, suffix?: string) =>
      `${prefix}[REDACTED]${suffix ?? ''}`,
  ],
  [
    /(["'](?:secret|password|access_token|refresh_token|private_key|client_secret|api_key|apiKey)["'][ \t]*:[ \t]*["'])(?!\[REDACTED)([^"'\r\n]+)(["'])/gi,
    '$1[REDACTED]$3',
  ],
  [
    /(\\"(?:secret|password|access_token|refresh_token|private_key|client_secret|api_key|apiKey)\\"[ \t]*:[ \t]*\\")(?!\[REDACTED)([^"'\r\n\\]+)(\\")/gi,
    '$1[REDACTED]$3',
  ],
  [
    /(--password(?:[ \t]*=[ \t]*|[ \t]+))(['"]?)(?!\[REDACTED)([^\s'"`]+)\2/gi,
    '$1$2[REDACTED]$2',
  ],
  [
    /(\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqp|amqps|mssql):\/\/[^:\s/@"'<>]+:)(?!\[REDACTED\])([^@\s"'<>`]+)(@)/gi,
    '$1[REDACTED]$3',
  ],
  [/(<mailto:[^>\r\n]+>[ \t]*\/[ \t]*)(?!\[REDACTED)([^\s`'"<>]+)/g, '$1[REDACTED]'],
  [
    /(\buser[ \t]*\/[ \t]*pass[ \t]*:[ \t]*)(?!\[REDACTED)(\S+[ \t]*\/[ \t]*\S+)/gi,
    '$1[REDACTED]',
  ],
  [
    /^([ \t]*(?:[-*•][ \t]*)?pass(?:word)?[ \t]*[:=][ \t]*)(?!\[REDACTED)([^\s`'"<>]+)/gim,
    '$1[REDACTED]',
  ],
];

const MULTIWORD_CREDENTIAL_LINE_RE =
  /(?:authorization[ \t]*:|--password|bearer\b|basic\b|<mailto:|user[ \t]*\/[ \t]*pass|pass(?:word)?[ \t]*[:=]|(?:secret|password|access_token|refresh_token|private_key|client_secret|api_key|apiKey)["']?[ \t]*:|^[ \t]*(?:export[ \t]+)?[`"']?[A-Z0-9_]+=)/i;

const TOKEN_PREFIX_RE =
  /^(?:xox|whsec|sk_|rk_|pk_|ya29|AIza|gh|github_pat|AKIA|eyJ|postgres|mysql|mariadb|mongodb|redis|amqp|mssql|jwt|access_token|refresh_token|id_token|client_secret)/i;

/**
 * Scrubs 18+ credential, token, password, and DB URI classes while preserving archive URLs.
 */
export function redactCredentialsDlp(text: string): string {
  if (!text) return text;
  let cleaned = String(text);
  for (const [pattern, replacement] of DLP_RULES) {
    cleaned =
      typeof replacement === 'string'
        ? cleaned.replace(pattern, replacement)
        : cleaned.replace(pattern, replacement);
  }
  return cleaned;
}

export interface StreamingDlpOptions {
  tailHoldbackChars?: number;
  maxPemBufferChars?: number;
  maxLineHoldbackChars?: number;
}

/**
 * Stateful streaming DLP redactor using a sliding holdback buffer so secrets
 * split across arbitrary 1-byte or subword SSE chunks are redacted prior to emission.
 */
export class StreamingDlpRedactor {
  private buffer = '';
  private readonly tailHoldbackChars: number;
  private readonly maxPemBufferChars: number;
  private readonly maxLineHoldbackChars: number;

  constructor(options: StreamingDlpOptions = {}) {
    this.tailHoldbackChars = Math.max(16, options.tailHoldbackChars ?? 64);
    this.maxPemBufferChars = Math.max(512, options.maxPemBufferChars ?? 8192);
    this.maxLineHoldbackChars = Math.max(256, options.maxLineHoldbackChars ?? 1024);
  }

  public push(chunk: string): string {
    if (!chunk) return '';
    this.buffer += chunk;

    const beginIdx = this.buffer.indexOf('-----BEGIN ');
    if (beginIdx !== -1) {
      const endMatch = /-----END [A-Z0-9 ]*PRIVATE KEY-----/.exec(
        this.buffer.slice(beginIdx)
      );
      if (!endMatch && this.buffer.length - beginIdx < this.maxPemBufferChars) {
        if (beginIdx > 0) {
          const safe = this.buffer.slice(0, beginIdx);
          this.buffer = this.buffer.slice(beginIdx);
          return redactCredentialsDlp(safe);
        }
        return '';
      }
    }

    const lastNewline = this.buffer.lastIndexOf('\n');
    let emitted = '';

    if (lastNewline !== -1) {
      const completedLines = this.buffer.slice(0, lastNewline + 1);
      this.buffer = this.buffer.slice(lastNewline + 1);
      emitted += redactCredentialsDlp(completedLines);
    }

    if (this.buffer.length <= this.tailHoldbackChars) {
      return emitted;
    }

    if (
      MULTIWORD_CREDENTIAL_LINE_RE.test(this.buffer) &&
      this.buffer.length < this.maxLineHoldbackChars
    ) {
      return emitted;
    }

    const maxCandidate = this.buffer.length - this.tailHoldbackChars;
    let cutIdx = -1;
    for (let i = maxCandidate; i > 0; i--) {
      if (this.buffer[i - 1] === ' ' || this.buffer[i - 1] === '\t') {
        const trailingStart = this.buffer.slice(i);
        const firstToken = trailingStart.split(/\s/, 1)[0] ?? '';
        if (TOKEN_PREFIX_RE.test(firstToken) && trailingStart.indexOf(' ') === -1) {
          continue;
        }
        cutIdx = i;
        break;
      }
    }

    if (cutIdx > 0) {
      const safePrefix = this.buffer.slice(0, cutIdx);
      this.buffer = this.buffer.slice(cutIdx);
      emitted += redactCredentialsDlp(safePrefix);
    }

    return emitted;
  }

  public flush(): string {
    if (!this.buffer) return '';
    const remaining = this.buffer;
    this.buffer = '';
    return redactCredentialsDlp(remaining);
  }
}
