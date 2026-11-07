/**
 * Inode-Safe Reverse Proxy Reload & Schema Sync Slice
 *
 * Solves the Linux VFS single-file bind-mount inode trap where `git reset --hard`,
 * `sed -i`, or atomic editor saves create a new host inode while a running Docker
 * container (`caddy` / `nginx`) remains attached to the unlinked stale inode.
 */

export interface InodeSafeCaddyReloadOptions {
  /** Host path to the updated Caddyfile (e.g. "/opt/infra/caddy/Caddyfile") */
  hostCaddyfilePath: string;
  /** Running Caddy container name (default: "caddy") */
  containerName?: string;
  /** Temporary path inside container used to bypass stale bind-mount inode (default: "/tmp/Caddyfile") */
  tmpContainerPath?: string;
  /** Whether to validate the config before reloading (default: true) */
  validateFirst?: boolean;
}

export interface SingleFileBindMountFinding {
  line: number;
  rawMount: string;
  hostPath: string;
  containerPath: string;
  recommendation: string;
}

export interface PgDumpSchemaSyncOptions {
  /** Docker container running PostgreSQL */
  dbContainer: string;
  /** Postgres username (default: "postgres") */
  dbUser?: string;
  /** Source database name (e.g. "production_db") */
  sourceDb: string;
  /** Target sandbox/demo database name (e.g. "sandbox_db") */
  targetDb: string;
}

export interface CaddyZeroDowntimeProxyOptions {
  /** Duration to keep trying upstream connections during container swap (default: "5s") */
  tryDuration?: string;
  /** Interval between connection retry attempts (default: "150ms") */
  tryInterval?: string;
  /** Whether to include lb_policy first for active + _old fallback routing (default: false) */
  includeOldFallback?: boolean;
}

export interface NextJsActionGuardOptions {
  /** Minimum length of the action SHA hash in hex (default: 40) */
  actionHashMinLen?: number;
  /** Maximum length of the action SHA hash in hex (default: 42) */
  actionHashMaxLen?: number;
  /** HTTP status code returned to probes (default: 403) */
  statusCode?: number;
}

/**
 * Builds a zero-downtime Caddy reload shell command that copies the fresh host
 * Caddyfile into `/tmp/Caddyfile` inside the container before invoking `caddy reload`,
 * completely bypassing stale single-file bind-mount inodes without dropping TCP connections.
 */
export function buildInodeSafeCaddyReloadCmd(options: InodeSafeCaddyReloadOptions): string {
  const hostPath = options.hostCaddyfilePath.trim();
  if (!hostPath) {
    throw new Error('hostCaddyfilePath must not be empty');
  }
  const container = (options.containerName || 'caddy').trim();
  const tmpPath = (options.tmpContainerPath || '/tmp/Caddyfile').trim();
  const validate = options.validateFirst ?? true;

  const copyStep = `docker cp "${hostPath}" "${container}:${tmpPath}"`;
  const validateStep = validate
    ? ` && docker exec "${container}" caddy validate --config "${tmpPath}" --adapter caddyfile`
    : '';
  const reloadStep = ` && docker exec "${container}" caddy reload --config "${tmpPath}" --adapter caddyfile`;

  return `${copyStep}${validateStep}${reloadStep}`;
}

/**
 * Inspects a docker-compose YAML string and detects single-file bind mounts
 * (such as `Caddyfile`, `nginx.conf`, or `.json`/`.yml` config files) that are
 * susceptible to stale inode detachment after `git reset --hard` or `sed -i`.
 */
export function detectSingleFileBindMountRisk(
  composeContent: string
): SingleFileBindMountFinding[] {
  const lines = composeContent.split(/\r?\n/);
  const findings: SingleFileBindMountFinding[] = [];
  const singleFilePattern =
    /(?:^|\/)(?:Caddyfile|nginx\.conf|[^\s/:]+\.(?:conf|json|ya?ml|toml|ini))$/i;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed.startsWith('-')) continue;

    const rawMount = trimmed.replace(/^-\s*['"]?|['"]?\s*$/g, '');
    const parts = rawMount.split(':');
    if (parts.length < 2) continue;

    const hostPath = parts[0].trim();
    const containerPath = parts[1].trim();
    if (!hostPath.startsWith('.') && !hostPath.startsWith('/')) continue;

    if (singleFilePattern.test(hostPath) || singleFilePattern.test(containerPath)) {
      findings.push({
        line: i + 1,
        rawMount,
        hostPath,
        containerPath,
        recommendation:
          'Mount the parent directory instead of a single file, or use buildInodeSafeCaddyReloadCmd() (`docker cp` to `/tmp`) before reloading.',
      });
    }
  }

  return findings;
}

/**
 * Builds an idempotent schema synchronization command that pipes `pg_dump --schema-only`
 * from a source database into a sandbox/demo database inside the same PostgreSQL container.
 */
export function buildPgDumpSchemaSyncCmd(options: PgDumpSchemaSyncOptions): string {
  const container = options.dbContainer.trim();
  const user = (options.dbUser || 'postgres').trim();
  const sourceDb = options.sourceDb.trim();
  const targetDb = options.targetDb.trim();

  if (!container || !sourceDb || !targetDb) {
    throw new Error('dbContainer, sourceDb, and targetDb are required');
  }
  if (sourceDb === targetDb) {
    throw new Error('sourceDb and targetDb must be different databases');
  }

  return `docker exec "${container}" pg_dump -U "${user}" -d "${sourceDb}" --schema-only --no-owner --no-acl | docker exec -i "${container}" psql -U "${user}" -d "${targetDb}" -v ON_ERROR_STOP=0`;
}

/**
 * Generates a Caddy configuration snippet for true zero-downtime reverse proxying.
 * Buffers and retries in-flight TCP requests during the 10-50ms container rename
 * cutover window, eliminating ephemeral HTTP 502 connection refused errors.
 */
export function generateCaddyZeroDowntimeSnippet(
  options?: CaddyZeroDowntimeProxyOptions
): string {
  const tryDuration = options?.tryDuration?.trim() || '5s';
  const tryInterval = options?.tryInterval?.trim() || '150ms';

  const lines = [
    '(zero_downtime_proxy) {',
    `\tlb_try_duration ${tryDuration}`,
    `\tlb_try_interval ${tryInterval}`,
  ];

  if (options?.includeOldFallback) {
    lines.push('\tlb_policy first');
  }

  lines.push('}');
  return lines.join('\n');
}

/**
 * Generates an RE2-safe Caddy matcher snippet that blocks malformed Next.js
 * `Next-Action` scanner probes (`r2s`, `cachefn`, CVE-2024-34351 SSRF) at the
 * edge with HTTP 403 before requests reach Node/Bun runtimes.
 *
 * Uses native Caddy inverted regex matchers without unsupported negative lookaheads.
 */
export function generateCaddyNextJsActionGuardSnippet(
  options?: NextJsActionGuardOptions
): string {
  const minLen = options?.actionHashMinLen ?? 40;
  const maxLen = options?.actionHashMaxLen ?? 42;
  const statusCode = options?.statusCode ?? 403;

  return [
    '(nextjs_action_guard) {',
    '\t@invalid_next_action {',
    '\t\theader Next-Action *',
    `\t\tnot header_regexp Next-Action ^[0-9a-fA-F]{${minLen},${maxLen}}$`,
    '\t}',
    `\trespond @invalid_next_action "Forbidden: Invalid Server Action" ${statusCode}`,
    '}',
  ].join('\n');
}

