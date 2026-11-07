import { describe, it, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import {
  generateDeployWorkflow,
  generateAtomicSwapBeScript,
  generateAtomicSwapFeScript,
  performHealthCheck,
  buildInodeSafeCaddyReloadCmd,
  detectSingleFileBindMountRisk,
  buildPgDumpSchemaSyncCmd,
  generateCaddyZeroDowntimeSnippet,
  generateCaddyNextJsActionGuardSnippet,
} from '../src/index';

describe('@kido/zero-downtime-deploy Unit Test Suite', () => {
  it('should generate valid GitHub Actions workflow yaml with Blue-Green Atomic Swap', () => {
    const yaml = generateDeployWorkflow({
      appSlug: 'flashbuy',
      healthUrl: 'https://app.example.com/health',
    });

    // Check key requirements
    expect(yaml).toContain('name: Zero-Downtime Deployment & CI/CD to Linux VPS');
    expect(yaml).toContain('setup-bun@v2');
    expect(yaml).toContain('bun test');
    expect(yaml).toContain('APP_SLUG="flashbuy"');
    expect(yaml).toContain('${APP_SLUG}-api_next');
    expect(yaml).toContain('docker rename');
    expect(yaml).toContain('docker exec caddy caddy reload');
    expect(yaml).toContain('flashbuy_next');
    expect(yaml).toContain('https://app.example.com/health');
  });

  it('should generate atomic backend swap script with rollback and drain', () => {
    const script = generateAtomicSwapBeScript({
      activeContainer: 'my-service-api',
      healthUrl: 'http://localhost:4000/health',
      timeoutSeconds: 30,
      drainSeconds: 5,
    });

    expect(script).toContain('ACTIVE_CONTAINER="my-service-api"');
    expect(script).toContain('CANDIDATE_CONTAINER="my-service-api_next"');
    expect(script).toContain('BACKUP_CONTAINER="my-service-api_old"');
    expect(script).toContain('TIMEOUT_SECONDS=30');
    expect(script).toContain('DRAIN_SECONDS=5');
    expect(script).toContain('docker rename "$ACTIVE_CONTAINER" "$BACKUP_CONTAINER"');
    expect(script).toContain('docker rename "$CANDIDATE_CONTAINER" "$ACTIVE_CONTAINER"');
    expect(script).toContain('docker rm -f "$CANDIDATE_CONTAINER"');
  });

  it('should generate atomic frontend swap script with inode directory swap', () => {
    const script = generateAtomicSwapFeScript({
      targetDir: '/opt/kido-infra/docker/portfolio/html/apps/myapp',
    });

    expect(script).toContain('TARGET_DIR="/opt/kido-infra/docker/portfolio/html/apps/myapp"');
    expect(script).toContain('STAGING_DIR="/opt/kido-infra/docker/portfolio/html/apps/myapp_next"');
    expect(script).toContain('mv "$TARGET_DIR" "$BACKUP_DIR"');
    expect(script).toContain('mv "$STAGING_DIR" "$TARGET_DIR"');
  });

  it('should verify packaged shell scripts exist and have execute permissions', () => {
    const baseDir = path.resolve(__dirname, '..');
    const beScript = path.join(baseDir, 'scripts', 'atomic-swap-be.sh');
    const feScript = path.join(baseDir, 'scripts', 'atomic-swap-fe.sh');
    const healthScript = path.join(baseDir, 'scripts', 'health-check.sh');
    const template = path.join(baseDir, 'workflows', 'deploy.yml.template');

    expect(fs.existsSync(beScript)).toBe(true);
    expect(fs.existsSync(feScript)).toBe(true);
    expect(fs.existsSync(healthScript)).toBe(true);
    expect(fs.existsSync(template)).toBe(true);

    const beStats = fs.statSync(beScript);
    expect(beStats.mode & 0o111).toBeTruthy(); // executable
  });

  it('should probe healthcheck and handle timeout gracefully', async () => {
    // Probing a non-existent port should fail gracefully within timeout
    const result = await performHealthCheck('http://127.0.0.1:59999/non-existent-probe', {
      timeoutMs: 300,
      intervalMs: 100,
    });
    expect(result.healthy).toBe(false);
    expect(result.status).toBe(0);
  });

  it('should build inode-safe Caddy reload command bypassing single-file bind mounts', () => {
    const cmd = buildInodeSafeCaddyReloadCmd({
      hostCaddyfilePath: '/opt/infra/caddy/Caddyfile',
      containerName: 'edge-caddy',
    });
    expect(cmd).toContain('docker cp "/opt/infra/caddy/Caddyfile" "edge-caddy:/tmp/Caddyfile"');
    expect(cmd).toContain('caddy validate --config "/tmp/Caddyfile"');
    expect(cmd).toContain('caddy reload --config "/tmp/Caddyfile"');
  });

  it('should detect single-file bind mount risks in docker-compose content', () => {
    const compose = `
services:
  caddy:
    image: caddy:2
    volumes:
      - ./caddy/Caddyfile:/etc/caddy/Caddyfile:ro
      - ./data:/data
`;
    const findings = detectSingleFileBindMountRisk(compose);
    expect(findings.length).toBe(1);
    expect(findings[0].hostPath).toBe('./caddy/Caddyfile');
    expect(findings[0].containerPath).toBe('/etc/caddy/Caddyfile');
  });

  it('should build idempotent pg_dump schema sync command for sandbox DBs', () => {
    const syncCmd = buildPgDumpSchemaSyncCmd({
      dbContainer: 'saas-postgres',
      dbUser: 'postgres',
      sourceDb: 'prod_db',
      targetDb: 'sandbox_db',
    });
    expect(syncCmd).toContain('pg_dump -U "postgres" -d "prod_db" --schema-only');
    expect(syncCmd).toContain('psql -U "postgres" -d "sandbox_db"');
  });

  it('should generate default Caddy zero-downtime proxy snippet (5s/150ms)', () => {
    const snippet = generateCaddyZeroDowntimeSnippet();
    expect(snippet).toContain('(zero_downtime_proxy) {');
    expect(snippet).toContain('lb_try_duration 5s');
    expect(snippet).toContain('lb_try_interval 150ms');
    expect(snippet).not.toContain('lb_policy first');
  });

  it('should generate custom Caddy zero-downtime proxy snippet with old fallback policy', () => {
    const snippet = generateCaddyZeroDowntimeSnippet({
      tryDuration: '10s',
      tryInterval: '250ms',
      includeOldFallback: true,
    });
    expect(snippet).toContain('(zero_downtime_proxy) {');
    expect(snippet).toContain('lb_try_duration 10s');
    expect(snippet).toContain('lb_try_interval 250ms');
    expect(snippet).toContain('lb_policy first');
  });

  it('should generate RE2-compatible Caddy Next.js action guard snippet with default 40-42 len and 403', () => {
    const snippet = generateCaddyNextJsActionGuardSnippet();
    expect(snippet).toContain('(nextjs_action_guard) {');
    expect(snippet).toContain('@invalid_next_action {');
    expect(snippet).toContain('header Next-Action *');
    expect(snippet).toContain('not header_regexp Next-Action ^[0-9a-fA-F]{40,42}$');
    expect(snippet).toContain('respond @invalid_next_action "Forbidden: Invalid Server Action" 403');
    // Ensure RE2 compatibility: Caddy Go regexp strictly forbids Perl lookaheads/lookbehinds
    expect(snippet).not.toContain('(?');
  });

  it('should generate Caddy Next.js action guard snippet with custom hash lengths and status code', () => {
    const snippet = generateCaddyNextJsActionGuardSnippet({
      actionHashMinLen: 32,
      actionHashMaxLen: 64,
      statusCode: 400,
    });
    expect(snippet).toContain('not header_regexp Next-Action ^[0-9a-fA-F]{32,64}$');
    expect(snippet).toContain('respond @invalid_next_action "Forbidden: Invalid Server Action" 400');
    expect(snippet).not.toContain('(?');
  });
});

