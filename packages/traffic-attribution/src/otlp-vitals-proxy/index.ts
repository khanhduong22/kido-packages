/**
 * Best-Effort OpenTelemetry (OTLP) Web Vitals Proxy Forwarder Slice
 *
 * Designed for Next.js / Edge / Hono `/api/vitals` proxy routes so browser beacons
 * (`navigator.sendBeacon` / `fetch(..., { keepalive: true })`) never trigger client-side
 * HTTP 500 console noise when the upstream OTLP collector is unreachable or slow.
 */

export type OtlpSignalType = 'traces' | 'metrics' | 'logs';

export interface ForwardOtlpTelemetryInput {
  /** Base OTLP collector URL (e.g. process.env.OTEL_EXPORTER_OTLP_ENDPOINT) */
  endpoint?: string | null;
  /** Signal type ("traces" | "metrics" | "logs", default: "traces") */
  signalType?: string | null;
  /** Raw request body payload (ArrayBuffer, Uint8Array, or JSON string) */
  body: ArrayBuffer | Uint8Array | string;
  /** Incoming request Content-Type header (default: "application/json") */
  contentType?: string | null;
  /** Optional comma-separated key=value string from OTEL_EXPORTER_OTLP_HEADERS */
  rawOtlpHeaders?: string | null;
  /** Optional bearer token for collector authentication */
  bearerToken?: string | null;
  /** Timeout in milliseconds before aborting upstream OTLP request (default: 3000ms) */
  timeoutMs?: number;
  /** Skip forwarding in local development mode (default: false) */
  isDevelopment?: boolean;
  /** Custom fetch implementation for testing or custom runtimes */
  fetchImpl?: typeof fetch;
}

export interface ForwardOtlpTelemetryResult {
  /** Always true from the client beacon perspective (200 OK safe response) */
  clientAckOk: true;
  /** Whether the payload was actually delivered to the upstream OTLP collector */
  forwarded: boolean;
  /** Reason when skipped or degraded */
  status: 'delivered' | 'skipped_dev' | 'skipped_no_endpoint' | 'collector_error' | 'network_timeout_or_error';
  /** Upstream HTTP status code if a response was received */
  upstreamStatus?: number;
  /** Warning message suitable for server-side structured logging */
  warning?: string;
}

/**
 * Parses a W3C/OpenTelemetry `OTEL_EXPORTER_OTLP_HEADERS` comma-separated string
 * (`key1=val1,key2=val2=with=equals`) into a clean header dictionary.
 */
export function parseOtlpHeaders(rawHeaders?: string | null): Record<string, string> {
  const result: Record<string, string> = {};
  if (!rawHeaders || !rawHeaders.trim()) {
    return result;
  }

  const pairs = rawHeaders.split(',');
  for (const pair of pairs) {
    const eqIndex = pair.indexOf('=');
    if (eqIndex <= 0) continue;
    const key = pair.slice(0, eqIndex).trim();
    const value = pair.slice(eqIndex + 1).trim();
    if (key && value) {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Resolves the full OTLP HTTP path (`/v1/traces`, `/v1/metrics`, or `/v1/logs`)
 * from a base collector endpoint URL.
 */
export function resolveOtlpEndpoint(
  baseEndpoint: string,
  signalType?: string | null
): string {
  const normalizedBase = baseEndpoint.trim().replace(/\/+$/, '');
  if (normalizedBase.endsWith('/v1/traces') || normalizedBase.endsWith('/v1/metrics') || normalizedBase.endsWith('/v1/logs')) {
    return normalizedBase;
  }

  const normalizedSignal: OtlpSignalType =
    signalType === 'metrics' ? 'metrics' : signalType === 'logs' ? 'logs' : 'traces';

  return `${normalizedBase}/v1/${normalizedSignal}`;
}

/**
 * Forwards Web Vitals / RUM telemetry to an OTLP HTTP collector using a strict
 * timeout and best-effort error boundary so client requests always receive 200 OK.
 */
export async function forwardOtlpTelemetry(
  input: ForwardOtlpTelemetryInput
): Promise<ForwardOtlpTelemetryResult> {
  if (input.isDevelopment) {
    return {
      clientAckOk: true,
      forwarded: false,
      status: 'skipped_dev',
    };
  }

  const endpoint = input.endpoint?.trim();
  if (!endpoint) {
    return {
      clientAckOk: true,
      forwarded: false,
      status: 'skipped_no_endpoint',
    };
  }

  const targetUrl = resolveOtlpEndpoint(endpoint, input.signalType);
  const headers: Record<string, string> = {
    'Content-Type': input.contentType?.trim() || 'application/json',
    ...parseOtlpHeaders(input.rawOtlpHeaders),
  };

  if (input.bearerToken?.trim() && !headers.Authorization && !headers.authorization) {
    headers.Authorization = `Bearer ${input.bearerToken.trim()}`;
  }

  const timeoutMs = input.timeoutMs ?? 3000;
  const fetcher = input.fetchImpl ?? fetch;

  try {
    const response = await fetcher(targetUrl, {
      method: 'POST',
      headers,
      body: input.body as BodyInit,
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      return {
        clientAckOk: true,
        forwarded: false,
        status: 'collector_error',
        upstreamStatus: response.status,
        warning: `OTLP collector responded with HTTP ${response.status}`,
      };
    }

    return {
      clientAckOk: true,
      forwarded: true,
      status: 'delivered',
      upstreamStatus: response.status,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      clientAckOk: true,
      forwarded: false,
      status: 'network_timeout_or_error',
      warning: `Unable to forward telemetry to OTLP collector: ${msg}`,
    };
  }
}
