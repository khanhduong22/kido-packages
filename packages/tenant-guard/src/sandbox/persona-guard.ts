import { buildCorporateAvatarSvg } from './deep-sanitizer';
import {
  BlockedEndpointRule,
  DemoPersona,
  DemoPersonaProfile,
  DemoSandboxBlockResult,
} from './types';

export const DEFAULT_DEMO_PERSONA_PROFILES: Readonly<
  Record<DemoPersona, DemoPersonaProfile>
> = {
  ADMIN: {
    id: 'demo-admin-owner',
    name: 'Nguyễn Minh Khôi (Chủ Shop Demo)',
    email: 'owner@demomart.vn',
    persona: 'ADMIN',
    role: 'ADMIN',
    image: buildCorporateAvatarSvg('Nguyễn Minh Khôi', 'ADMIN'),
    label: 'Chủ Cửa Hàng (Admin)',
    employmentType: 'FULL_TIME',
    hourlyRate: 0,
    monthlySalary: 15000000,
  },
  STAFF: {
    id: 'demo-staff-01',
    name: 'Lê Hoàng Nam',
    email: 'staff01@demomart.vn',
    persona: 'STAFF',
    role: 'STAFF',
    image: buildCorporateAvatarSvg('Lê Hoàng Nam', 'USER'),
    label: 'Nhân Viên (Staff)',
    employmentType: 'PART_TIME',
    hourlyRate: 25000,
    monthlySalary: 0,
  },
  GUEST: {
    id: 'demo-guest-viewer',
    name: 'Khách Tham Quan (Guest)',
    email: 'guest@demomart.vn',
    persona: 'GUEST',
    role: 'GUEST',
    image: buildCorporateAvatarSvg('Khách Tham Quan', 'USER'),
    label: 'Khách Trải Nghiệm (Guest)',
    employmentType: 'PART_TIME',
    hourlyRate: 0,
    monthlySalary: 0,
  },
};

export const DEFAULT_BLOCKED_ENDPOINT_RULES: readonly BlockedEndpointRule[] = [
  // Whitelist interactive sandbox control endpoints first
  {
    method: '*',
    pattern: /^\/api\/demo\/(status|switch-role|modules|reset|seed)(\/|$)/i,
    allowInSandbox: true,
  },
  // Block tenant backup / restore / export / drop / wipe
  {
    method: '*',
    pattern: /\/api\/(tenants?|system|admin|db)\/(backup|restore|export-raw|wipe|drop|truncate|purge)(\/|$)/i,
    reason: 'Backup, restore, and destructive tenant/database operations are disabled in Demo Sandbox.',
  },
  // Block password, OAuth token, API key, and secret mutations
  {
    method: ['POST', 'PUT', 'PATCH', 'DELETE'],
    pattern: /\/api\/(auth|users|account|settings)\/(password|change-password|reset-password|oauth-tokens?|api-keys?|secrets?|mfa|2fa|revoke-all)(\/|$)/i,
    reason: 'Credential, password, and OAuth token mutations are disabled in Demo Sandbox.',
  },
  // Block billing / subscription / payment gateway mutations
  {
    method: ['POST', 'PUT', 'PATCH', 'DELETE'],
    pattern: /\/api\/(billing|subscriptions?|webhooks\/stripe|payment-methods)(\/|$)/i,
    reason: 'Billing and subscription mutations are disabled in Demo Sandbox.',
  },
  // Block deleting entire tenant or organization accounts
  {
    method: 'DELETE',
    pattern: /\/api\/(tenants?|organizations?|workspaces?|system)(\/[^/]+)?$/i,
    reason: 'Deleting tenants or workspaces is disabled in Demo Sandbox.',
  },
] as const;

export function isDemoSandboxEnabled(
  env: Record<string, string | undefined> = typeof process !== 'undefined' ? process.env : {}
): boolean {
  return env?.DEMO_SANDBOX_MODE === 'true';
}

/**
 * Safety lock ensuring demo seeders/sanitizers refuse to execute against a production database URL.
 */
export function assertSafeDemoDatabaseUrl(
  databaseUrl: string | null | undefined,
  nodeEnv: string = typeof process !== 'undefined' ? process.env.NODE_ENV || 'production' : 'production',
  allowedSubstrings: readonly string[] = ['demo', 'sandbox', 'localhost', '127.0.0.1']
): void {
  if (nodeEnv === 'test') return;
  const url = String(databaseUrl || '').toLowerCase();
  if (!url) {
    throw new Error('SAFETY LOCK: DATABASE_URL is empty; refusing to run demo sanitizer.');
  }
  const isSafe = allowedSubstrings.some((marker) => url.includes(marker.toLowerCase()));
  if (!isSafe) {
    throw new Error(
      'SAFETY LOCK: Refusing to run demo sanitizer on non-demo database!'
    );
  }
}

function normalizePersonaValue(raw: unknown): DemoPersona | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.trim().toUpperCase();
  if (!cleaned) return null;

  if (cleaned === 'ADMIN' || cleaned === 'OWNER' || cleaned === 'MANAGER' || cleaned === 'PARTNER') {
    return 'ADMIN';
  }
  if (cleaned === 'STAFF' || cleaned === 'USER' || cleaned === 'EMPLOYEE' || cleaned === 'MEMBER') {
    return 'STAFF';
  }
  if (cleaned === 'GUEST' || cleaned === 'VIEWER' || cleaned === 'ANONYMOUS' || cleaned === 'PUBLIC') {
    return 'GUEST';
  }
  return null;
}

function extractHeaderValue(
  headers: Record<string, unknown> | Headers | null | undefined,
  key: string
): string | null {
  if (!headers) return null;
  const lowerKey = key.toLowerCase();

  if (typeof (headers as Headers).get === 'function') {
    const val = (headers as Headers).get(key) || (headers as Headers).get(lowerKey);
    return val ? String(val) : null;
  }

  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
    if (k.toLowerCase() === lowerKey) {
      if (Array.isArray(v)) return v[0] != null ? String(v[0]) : null;
      if (typeof v === 'string') return v;
    }
  }
  return null;
}

function extractQueryValue(
  query: Record<string, unknown> | URLSearchParams | string | null | undefined,
  keys: readonly string[]
): string | null {
  if (!query) return null;

  if (typeof query === 'string') {
    const search = query.startsWith('?') ? query.slice(1) : query;
    const params = new URLSearchParams(search);
    for (const k of keys) {
      const val = params.get(k);
      if (val) return val;
    }
    return null;
  }

  if (typeof (query as URLSearchParams).get === 'function') {
    for (const k of keys) {
      const val = (query as URLSearchParams).get(k);
      if (val) return val;
    }
    return null;
  }

  for (const k of keys) {
    const val = (query as Record<string, unknown>)[k];
    if (Array.isArray(val) && val.length > 0 && typeof val[0] === 'string') {
      return val[0];
    }
    if (typeof val === 'string') {
      return val;
    }
  }
  return null;
}

function extractCookieValue(
  cookieInput: Record<string, unknown> | string | null | undefined,
  keys: readonly string[]
): string | null {
  if (!cookieInput) return null;

  if (typeof cookieInput === 'string') {
    const pairs = cookieInput.split(';');
    for (const pair of pairs) {
      const eqIdx = pair.indexOf('=');
      if (eqIdx === -1) continue;
      const k = pair.slice(0, eqIdx).trim();
      const v = pair.slice(eqIdx + 1).trim();
      if (keys.includes(k) && v) {
        try {
          return decodeURIComponent(v);
        } catch {
          return v;
        }
      }
    }
    return null;
  }

  if (typeof cookieInput === 'object') {
    for (const k of keys) {
      const v = (cookieInput as Record<string, unknown>)[k];
      if (typeof v === 'string' && v.trim()) {
        return v.trim();
      }
    }
  }
  return null;
}

/**
 * Resolves the active zero-login demo persona (`ADMIN` | `STAFF` | `GUEST`) from request
 * headers (`x-demo-persona`, `x-demo-role`), query parameters (`persona`, `role`, `demo_role`),
 * or cookies (`demo_persona`, `demo_role`), falling back to `defaultPersona` (`ADMIN`).
 */
export function resolveDemoPersona(
  headers?: Record<string, unknown> | Headers | null,
  query?: Record<string, unknown> | URLSearchParams | string | null,
  cookie?: Record<string, unknown> | string | null,
  defaultPersona: DemoPersona = 'ADMIN'
): DemoPersona {
  // 1. Check explicit demo headers first
  const headerRaw =
    extractHeaderValue(headers, 'x-demo-persona') ??
    extractHeaderValue(headers, 'x-demo-role');
  const fromHeader = normalizePersonaValue(headerRaw);
  if (fromHeader) return fromHeader;

  // 2. Check query string parameters
  const queryRaw = extractQueryValue(query, ['persona', 'demo_persona', 'role', 'demo_role']);
  const fromQuery = normalizePersonaValue(queryRaw);
  if (fromQuery) return fromQuery;

  // 3. Check explicit cookie argument or Cookie header
  const cookieRaw =
    extractCookieValue(cookie, ['demo_persona', 'demo_role', 'persona']) ??
    extractCookieValue(extractHeaderValue(headers, 'cookie'), [
      'demo_persona',
      'demo_role',
      'persona',
    ]);
  const fromCookie = normalizePersonaValue(cookieRaw);
  if (fromCookie) return fromCookie;

  return normalizePersonaValue(defaultPersona) || 'ADMIN';
}

/**
 * Returns the full pre-configured DemoPersonaProfile for a resolved `DemoPersona`.
 */
export function getDemoPersonaProfile(persona: DemoPersona): DemoPersonaProfile {
  return { ...(DEFAULT_DEMO_PERSONA_PROFILES[persona] || DEFAULT_DEMO_PERSONA_PROFILES.ADMIN) };
}

function methodMatches(ruleMethod: string | readonly string[] | undefined, actualMethod: string): boolean {
  if (!ruleMethod || ruleMethod === '*') return true;
  const upperActual = actualMethod.toUpperCase();
  if (typeof ruleMethod === 'string') {
    return ruleMethod.toUpperCase() === upperActual || ruleMethod === '*';
  }
  return ruleMethod.some((m) => m.toUpperCase() === upperActual || m === '*');
}

function patternMatches(pattern: string | RegExp, pathname: string): boolean {
  if (pattern instanceof RegExp) {
    return pattern.test(pathname);
  }
  return pathname.toLowerCase().includes(pattern.toLowerCase());
}

/**
 * Evaluates whether an HTTP `(method, pathname)` request should be blocked in Demo Sandbox mode,
 * returning structured metadata (`blocked`, `status`, `code`, `reason`).
 */
export function evaluateDemoEndpointGuard(
  method: string,
  pathname: string,
  customRules?: readonly BlockedEndpointRule[]
): DemoSandboxBlockResult {
  const normalizedMethod = String(method || 'GET').trim().toUpperCase();
  const normalizedPath = String(pathname || '/').split('?')[0].trim() || '/';

  // Safe read-only methods (GET, HEAD, OPTIONS) are allowed unless explicitly matched by a custom/default rule
  const allRules: readonly BlockedEndpointRule[] = customRules
    ? [...customRules, ...DEFAULT_BLOCKED_ENDPOINT_RULES]
    : DEFAULT_BLOCKED_ENDPOINT_RULES;

  for (const rule of allRules) {
    if (!methodMatches(rule.method, normalizedMethod)) continue;
    if (!patternMatches(rule.pattern, normalizedPath)) continue;

    if (rule.allowInSandbox) {
      return {
        blocked: false,
        status: 200,
      };
    }

    return {
      blocked: true,
      status: 403,
      code: 'DEMO_SANDBOX_RESTRICTED',
      reason:
        rule.reason ||
        `Action [${normalizedMethod} ${normalizedPath}] is restricted in Public Demo Sandbox mode.`,
      matchedRule: String(rule.pattern),
    };
  }

  return {
    blocked: false,
    status: 200,
  };
}

/**
 * Returns `true` if the given `(method, pathname)` is destructive or sensitive and must be
 * blocked in Public Demo Sandbox mode, or `false` if allowed.
 */
export function isBlockedInDemoSandbox(
  method: string,
  pathname: string,
  customRules?: readonly BlockedEndpointRule[]
): boolean {
  return evaluateDemoEndpointGuard(method, pathname, customRules).blocked;
}

/**
 * Stateful helper combining Zero-Login Persona resolution and Destructive Endpoint Guarding.
 */
export class ZeroLoginPersonaGuard {
  private readonly defaultPersona: DemoPersona;
  private readonly customRules: readonly BlockedEndpointRule[];

  constructor(options?: {
    defaultPersona?: DemoPersona;
    customRules?: readonly BlockedEndpointRule[];
  }) {
    this.defaultPersona = options?.defaultPersona || 'ADMIN';
    this.customRules = options?.customRules || [];
  }

  resolvePersona(req: {
    headers?: Record<string, unknown> | Headers | null;
    query?: Record<string, unknown> | URLSearchParams | string | null;
    cookies?: Record<string, unknown> | string | null;
  }): DemoPersonaProfile {
    const persona = resolveDemoPersona(
      req.headers,
      req.query,
      req.cookies,
      this.defaultPersona
    );
    return getDemoPersonaProfile(persona);
  }

  checkEndpoint(method: string, pathname: string): DemoSandboxBlockResult {
    return evaluateDemoEndpointGuard(method, pathname, this.customRules);
  }

  isBlocked(method: string, pathname: string): boolean {
    return isBlockedInDemoSandbox(method, pathname, this.customRules);
  }
}
