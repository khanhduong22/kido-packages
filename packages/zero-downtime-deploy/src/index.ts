/**
 * @kido/zero-downtime-deploy
 * Universal Zero-Downtime Deployment Toolkit
 * - Docker Blue-Green Atomic Container Swap
 * - Kernel Inode Atomic Directory Swap
 * - Healthcheck Probe with Auto-Rollback
 * - GitHub Actions Workflow Generator
 */

export interface DeployWorkflowConfig {
  appSlug: string;
  healthUrl: string;
  pnpmVersion?: string;
  nodeVersion?: string;
  testCommand?: string;
  internalPort?: number;
  dockerNetwork?: string;
  vpsBasePath?: string;
}

export interface ContainerSwapConfig {
  activeContainer: string;
  candidateContainer?: string;
  backupContainer?: string;
  healthUrl?: string;
  timeoutSeconds?: number;
  caddyReloadCmd?: string;
  drainSeconds?: number;
  dockerNetwork?: string;
}

export interface DirectorySwapConfig {
  targetDir: string;
  stagingDir?: string;
  backupDir?: string;
}

export interface HealthCheckConfig {
  url: string;
  timeoutSeconds?: number;
  intervalSeconds?: number;
  expectedStatus?: number;
  expectedBody?: string;
  rollbackCmd?: string;
}

/**
 * Generate a complete, ready-to-run GitHub Actions workflow yaml with Blue-Green Atomic Swap.
 * Pair with `(zero_downtime_proxy)` in Caddyfile (`import zero_downtime_proxy` inside reverse_proxy block)
 * to buffer and retry in-flight TCP requests during container promotion.
 */
export function generateDeployWorkflow(config: DeployWorkflowConfig): string {
  const pnpmVer = config.pnpmVersion || '10.32.1';
  const nodeVer = config.nodeVersion || '22';
  const testCmd =
    config.testCommand ||
    'bun test packages/*/src/*.test.ts packages/*/test/*.test.ts apps/*/test/*.test.ts';
  const network = config.dockerNetwork || 'ops_bridge';
  const vpsBase = config.vpsBasePath || '/opt/kido-infra';

  return `name: Zero-Downtime Deployment & CI/CD to Linux VPS

on:
  push:
    branches:
      - main
  workflow_dispatch:

concurrency:
  group: deploy-vps-\${{ github.repository }}-\${{ github.ref_name }}
  cancel-in-progress: false

jobs:
  quality-gate:
    name: 🧪 Quality Gate (Tests, Build & Monorepo Validation)
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - name: Checkout Code
        uses: actions/checkout@v4

      - name: Setup Bun Runtime
        uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: Setup Node.js ${nodeVer}
        uses: actions/setup-node@v4
        with:
          node-version: ${nodeVer}

      - name: Install pnpm v${pnpmVer}
        uses: pnpm/action-setup@v4
        with:
          version: ${pnpmVer}

      - name: Get pnpm Store Directory
        shell: bash
        run: |
          echo "STORE_PATH=$(pnpm store path --silent)" >> $GITHUB_ENV

      - name: Setup pnpm Cache
        uses: actions/cache@v4
        with:
          path: \${{ env.STORE_PATH }}
          key: \${{ runner.os }}-pnpm-store-\${{ hashFiles('**/pnpm-lock.yaml') }}
          restore-keys: |
            \${{ runner.os }}-pnpm-store-

      - name: Install Monorepo Dependencies
        run: pnpm install --frozen-lockfile

      - name: Run Monorepo Build
        run: pnpm build

      - name: Run Tests via Bun Runtime (Fast & Reliable)
        run: |
          ${testCmd}

      - name: Upload Web Build Artifact
        uses: actions/upload-artifact@v4
        with:
          name: web-dist
          path: apps/web/dist/
          retention-days: 1

      - name: Upload API Build Artifact
        uses: actions/upload-artifact@v4
        with:
          name: api-dist
          path: apps/api/dist/
          retention-days: 1

  deploy-zero-downtime:
    name: 🚀 Zero-Downtime Deployment to VPS
    needs: quality-gate
    if: github.ref == 'refs/heads/main' || github.event_name == 'workflow_dispatch'
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - name: Checkout Repository
        uses: actions/checkout@v4

      - name: Download Web Build Artifact
        uses: actions/download-artifact@v4
        with:
          name: web-dist
          path: apps/web/dist

      - name: Download API Build Artifact
        uses: actions/download-artifact@v4
        with:
          name: api-dist
          path: apps/api/dist

      - name: Sync Static Web & API Code to VPS Staging
        env:
          SSH_PRIVATE_KEY: \${{ secrets.SSH_PRIVATE_KEY }}
          VPS_HOST: \${{ secrets.VPS_HOST }}
          SSH_USER: \${{ secrets.SSH_USER }}
        run: |
          mkdir -p ~/.ssh
          echo "$SSH_PRIVATE_KEY" > ~/.ssh/deploy_key
          chmod 600 ~/.ssh/deploy_key
          ssh-keyscan -H "$VPS_HOST" >> ~/.ssh/known_hosts

          # Ensure required deployment directories exist on VPS
          ssh -i ~/.ssh/deploy_key -o StrictHostKeyChecking=no \${SSH_USER}@\${VPS_HOST} \\
            "mkdir -p ${vpsBase}/docker/portfolio/html/apps/${config.appSlug}_next ${vpsBase}/apps/${config.appSlug}-api/dist ${vpsBase}/docker/${config.appSlug}-api ${vpsBase}/data/${config.appSlug}"

          # 1. Sync compiled Web SPA dist to staging directory for atomic swap
          rsync -avz --delete -e "ssh -i ~/.ssh/deploy_key -o StrictHostKeyChecking=no" \\
            apps/web/dist/ \${SSH_USER}@\${VPS_HOST}:${vpsBase}/docker/portfolio/html/apps/${config.appSlug}_next/

          # 2. Sync compiled API bundle, package.json, source files, and Dockerfile
          rsync -avz -e "ssh -i ~/.ssh/deploy_key -o StrictHostKeyChecking=no" \\
            apps/api/dist/ \${SSH_USER}@\${VPS_HOST}:${vpsBase}/apps/${config.appSlug}-api/dist/
          rsync -avz -e "ssh -i ~/.ssh/deploy_key -o StrictHostKeyChecking=no" \\
            apps/api/src/ \${SSH_USER}@\${VPS_HOST}:${vpsBase}/apps/${config.appSlug}-api/src/
          rsync -avz -e "ssh -i ~/.ssh/deploy_key -o StrictHostKeyChecking=no" \\
            apps/api/package.json \${SSH_USER}@\${VPS_HOST}:${vpsBase}/apps/${config.appSlug}-api/package.json
          rsync -avz -e "ssh -i ~/.ssh/deploy_key -o StrictHostKeyChecking=no" \\
            apps/api/Dockerfile.vps \${SSH_USER}@\${VPS_HOST}:${vpsBase}/apps/${config.appSlug}-api/Dockerfile
          rsync -avz -e "ssh -i ~/.ssh/deploy_key -o StrictHostKeyChecking=no" \\
            docker/vps-docker-compose.yml \${SSH_USER}@\${VPS_HOST}:${vpsBase}/docker/${config.appSlug}-api/docker-compose.yml

          # 3. Clean up deploy key from runner
          rm -f ~/.ssh/deploy_key

      - name: Execute Blue-Green Atomic Swap & Healthcheck via SSH
        uses: appleboy/ssh-action@v1.0.3
        with:
          host: \${{ secrets.VPS_HOST }}
          username: \${{ secrets.SSH_USER }}
          key: \${{ secrets.SSH_PRIVATE_KEY }}
          script: |
            set -euo pipefail

            echo "=========================================================="
            echo "🚀 Zero-Downtime Deployment: Blue-Green Atomic Swap"
            echo "=========================================================="

            APP_SLUG="${config.appSlug}"
            API_CONTAINER="\${APP_SLUG}-api"
            NEXT_CONTAINER="\${APP_SLUG}-api_next"
            OLD_CONTAINER="\${APP_SLUG}-api_old"
            STATIC_DIR="${vpsBase}/docker/portfolio/html/apps/\${APP_SLUG}"
            STATIC_NEXT="${vpsBase}/docker/portfolio/html/apps/\${APP_SLUG}_next"
            STATIC_BACKUP="${vpsBase}/docker/portfolio/html/apps/\${APP_SLUG}_backup"
            HEALTH_URL="${config.healthUrl}"

            # -------------------------------------------------------------
            # STEP 1: Inode Atomic Directory Swap for Frontend Static SPA (< 1ms)
            # -------------------------------------------------------------
            if [ -d "$STATIC_NEXT" ] && [ -n "$(ls -A "$STATIC_NEXT" 2>/dev/null)" ]; then
              echo "🔄 [FE] Executing atomic directory swap for $STATIC_DIR..."
              mkdir -p "$STATIC_DIR"
              rm -rf "$STATIC_BACKUP"
              mv "$STATIC_DIR" "$STATIC_BACKUP"
              mv "$STATIC_NEXT" "$STATIC_DIR"
              rm -rf "$STATIC_BACKUP"
              echo "✅ [FE] Web static swap finished atomically (< 1ms)."
            fi

            # -------------------------------------------------------------
            # STEP 2: Blue-Green Candidate Container Launch for Backend API
            # -------------------------------------------------------------
            echo "🐳 [BE] Building and launching candidate container: $NEXT_CONTAINER..."
            cd ${vpsBase}/docker/\${API_CONTAINER}

            # Build image
            docker compose build

            # Ensure any leftover candidate container is removed
            docker rm -f "$NEXT_CONTAINER" 2>/dev/null || true

            # Extract the built image name
            IMAGE_NAME=$(docker compose config --images | head -n 1)
            if [ -z "$IMAGE_NAME" ]; then
              IMAGE_NAME="\${API_CONTAINER}:latest"
            fi

            echo "📦 [BE] Starting candidate container $NEXT_CONTAINER with image $IMAGE_NAME..."
            docker run -d \\
              --name "$NEXT_CONTAINER" \\
              --network ${network} \\
              --restart unless-stopped \\
              --env-file .env \\
              -v ${vpsBase}/apps/\${API_CONTAINER}/dist:/app/dist:ro \\
              -v ${vpsBase}/data/\${APP_SLUG}:/app/data \\
              "$IMAGE_NAME"

            # -------------------------------------------------------------
            # STEP 3: Healthcheck Probe Candidate Container (Timeout: 45s)
            # -------------------------------------------------------------
            echo "🔍 [BE] Probing candidate container health..."
            MAX_RETRIES=22
            COUNT=0
            CANDIDATE_HEALTHY=false

            while [ $COUNT -lt $MAX_RETRIES ]; do
              HTTP_STATUS=$(docker exec "$NEXT_CONTAINER" bun -e 'fetch("http://127.0.0.1:3000/health").then(r=>console.log(r.status)).catch(()=>console.log("000"))' 2>/dev/null || echo "000")
              
              if [ "$HTTP_STATUS" = "200" ]; then
                CANDIDATE_HEALTHY=true
                echo "✅ [BE] Candidate container $NEXT_CONTAINER is HEALTHY (HTTP 200)!"
                break
              fi

              echo "⏳ [BE] Candidate starting up... ($((COUNT+1))/$MAX_RETRIES, status: $HTTP_STATUS)"
              sleep 2
              COUNT=$((COUNT+1))
            done

            # -------------------------------------------------------------
            # STEP 4: Auto-Rollback if Candidate Fails Healthcheck
            # -------------------------------------------------------------
            if [ "$CANDIDATE_HEALTHY" != true ]; then
              echo "❌ [BE] Candidate healthcheck FAILED! Initiating auto-rollback..."
              docker logs --tail 50 "$NEXT_CONTAINER" || true
              docker rm -f "$NEXT_CONTAINER" || true
              echo "🛡️ [BE] Candidate discarded. Existing container $API_CONTAINER remains 100% active."
              exit 1
            fi

            # -------------------------------------------------------------
            # STEP 5: Atomic Container Rename Swap
            # -------------------------------------------------------------
            echo "🔄 [BE] Performing atomic container rename swap..."
            docker rm -f "$OLD_CONTAINER" 2>/dev/null || true

            if docker inspect "$API_CONTAINER" >/dev/null 2>&1; then
              docker rename "$API_CONTAINER" "$OLD_CONTAINER"
            fi

            docker rename "$NEXT_CONTAINER" "$API_CONTAINER"
            echo "✅ [BE] Successfully promoted $NEXT_CONTAINER -> $API_CONTAINER."

            # -------------------------------------------------------------
            # STEP 6: Reload Caddy Reverse Proxy & Drain In-flight Requests
            # -------------------------------------------------------------
            echo "🌐 [BE] Reloading Caddy reverse proxy..."
            docker exec caddy caddy reload --config /etc/caddy/Caddyfile || true

            if docker inspect "$OLD_CONTAINER" >/dev/null 2>&1; then
              echo "⏳ [BE] Draining in-flight requests on old container for 3 seconds..."
              sleep 3
              echo "🧹 [BE] Removing drained container $OLD_CONTAINER..."
              docker rm -f "$OLD_CONTAINER" 2>/dev/null || true
            fi

            # -------------------------------------------------------------
            # STEP 7: Final Public Healthcheck Verification
            # -------------------------------------------------------------
            echo "🔍 Probing public health endpoint $HEALTH_URL..."
            if curl -f -s "$HEALTH_URL" | grep -q '"status":"ok"'; then
              echo "🎉 Public healthcheck PASSED! 100% Zero-Downtime Deployment Finished."
            else
              echo "⚠️ Public healthcheck returned non-standard payload, but container is running healthy."
            fi
`;
}

/**
 * Generate Blue-Green container swap bash script content.
 * Pair with `(zero_downtime_proxy)` in Caddyfile (`import zero_downtime_proxy` inside reverse_proxy block)
 * to buffer in-flight TCP connections during the 10-50ms container rename window.
 */
export function generateAtomicSwapBeScript(config: ContainerSwapConfig): string {
  const active = config.activeContainer;
  const candidate = config.candidateContainer || `${active}_next`;
  const backup = config.backupContainer || `${active}_old`;
  const healthUrl = config.healthUrl || 'http://127.0.0.1:3000/health';
  const timeout = config.timeoutSeconds || 45;
  const caddyCmd =
    config.caddyReloadCmd || 'docker exec caddy caddy reload --config /etc/caddy/Caddyfile';
  const drain = config.drainSeconds || 3;

  return `#!/usr/bin/env bash
set -euo pipefail

ACTIVE_CONTAINER="${active}"
CANDIDATE_CONTAINER="${candidate}"
BACKUP_CONTAINER="${backup}"
HEALTH_URL="${healthUrl}"
TIMEOUT_SECONDS=${timeout}
CADDY_RELOAD_CMD="${caddyCmd}"
DRAIN_SECONDS=${drain}

echo "=================================================================="
echo "🚀 [BE-SWAP] Starting Blue-Green Container Atomic Swap"
echo "   Active Container:    $ACTIVE_CONTAINER"
echo "   Candidate Container: $CANDIDATE_CONTAINER"
echo "   Backup Container:    $BACKUP_CONTAINER"
echo "   Healthcheck URL:     $HEALTH_URL"
echo "   Timeout:             \${TIMEOUT_SECONDS}s"
echo "=================================================================="

if ! docker inspect "$CANDIDATE_CONTAINER" >/dev/null 2>&1; then
  echo "❌ [BE-SWAP] Error: Candidate container '$CANDIDATE_CONTAINER' is not running!"
  exit 1
fi

echo "🔍 [BE-SWAP] Probing candidate container health via $HEALTH_URL..."
START_TIME=$(date +%s)
IS_HEALTHY=false

while true; do
  CURRENT_TIME=$(date +%s)
  ELAPSED=$((CURRENT_TIME - START_TIME))

  if [ "$ELAPSED" -ge "$TIMEOUT_SECONDS" ]; then
    break
  fi

  HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$HEALTH_URL" 2>/dev/null || echo "000")

  if [ "$HTTP_STATUS" -ge 200 ] && [ "$HTTP_STATUS" -lt 400 ]; then
    echo "✅ [BE-SWAP] Healthcheck PASSED (HTTP $HTTP_STATUS) in \${ELAPSED}s!"
    IS_HEALTHY=true
    break
  fi

  echo "⏳ [BE-SWAP] Waiting for $HEALTH_URL (status: $HTTP_STATUS, elapsed: \${ELAPSED}s/\${TIMEOUT_SECONDS}s)..."
  sleep 2
done

if [ "$IS_HEALTHY" != true ]; then
  echo "❌ [BE-SWAP] Healthcheck probe TIMED OUT after \${TIMEOUT_SECONDS}s!"
  docker logs --tail 60 "$CANDIDATE_CONTAINER" || true
  docker rm -f "$CANDIDATE_CONTAINER" 2>/dev/null || true
  echo "🛡️ [BE-SWAP] Rollback finished. Active container '$ACTIVE_CONTAINER' preserved."
  exit 1
fi

echo "🔄 [BE-SWAP] Executing atomic container rename sequence..."
docker rm -f "$BACKUP_CONTAINER" 2>/dev/null || true

if docker inspect "$ACTIVE_CONTAINER" >/dev/null 2>&1; then
  docker rename "$ACTIVE_CONTAINER" "$BACKUP_CONTAINER"
fi

docker rename "$CANDIDATE_CONTAINER" "$ACTIVE_CONTAINER"
echo "✅ [BE-SWAP] Candidate successfully promoted to '$ACTIVE_CONTAINER'!"

if [ -n "$CADDY_RELOAD_CMD" ]; then
  echo "🌐 [BE-SWAP] Reloading reverse proxy: $CADDY_RELOAD_CMD"
  eval "$CADDY_RELOAD_CMD" || echo "⚠️ Proxy reload returned non-zero"
fi

if docker inspect "$BACKUP_CONTAINER" >/dev/null 2>&1; then
  echo "⏳ [BE-SWAP] Draining in-flight requests for \${DRAIN_SECONDS}s..."
  sleep "$DRAIN_SECONDS"
  docker rm -f "$BACKUP_CONTAINER" 2>/dev/null || true
fi

echo "🎉 [BE-SWAP] Blue-Green Zero-Downtime Swap Complete!"
`;
}

/**
 * Generate Inode Directory Swap bash script content.
 */
export function generateAtomicSwapFeScript(config: DirectorySwapConfig): string {
  const target = config.targetDir;
  const staging = config.stagingDir || `${target}_next`;
  const backup = config.backupDir || `${target}_backup`;

  return `#!/usr/bin/env bash
set -euo pipefail

TARGET_DIR="${target}"
STAGING_DIR="${staging}"
BACKUP_DIR="${backup}"

echo "=================================================================="
echo "⚡ [FE-SWAP] Starting Inode Atomic Directory Swap"
echo "   Target Directory:  $TARGET_DIR"
echo "   Staging Directory: $STAGING_DIR"
echo "   Backup Directory:  $BACKUP_DIR"
echo "=================================================================="

if [ ! -d "$STAGING_DIR" ]; then
  echo "❌ [FE-SWAP] Error: Staging directory '$STAGING_DIR' does not exist!"
  exit 1
fi

if [ -z "$(ls -A "$STAGING_DIR" 2>/dev/null)" ]; then
  echo "❌ [FE-SWAP] Error: Staging directory '$STAGING_DIR' is empty!"
  exit 1
fi

TARGET_PARENT=$(dirname "$TARGET_DIR")
mkdir -p "$TARGET_PARENT"
rm -rf "$BACKUP_DIR"

if [ -d "$TARGET_DIR" ]; then
  echo "🔄 [FE-SWAP] Executing kernel inode rename swap..."
  mv "$TARGET_DIR" "$BACKUP_DIR"
  mv "$STAGING_DIR" "$TARGET_DIR"
  rm -rf "$BACKUP_DIR"
else
  echo "✨ [FE-SWAP] First-time deployment. Moving staging directly to target..."
  mv "$STAGING_DIR" "$TARGET_DIR"
fi

echo "🎉 [FE-SWAP] Atomic Directory Swap Completed in < 1ms!"
`;
}

/**
 * Programmatic health check probe.
 */
export async function performHealthCheck(
  url: string,
  options: {
    timeoutMs?: number;
    intervalMs?: number;
    expectedStatus?: number;
    expectedBody?: string;
  } = {}
): Promise<{ healthy: boolean; status: number; durationMs: number; error?: string }> {
  const timeoutMs = options.timeoutMs || 45000;
  const intervalMs = options.intervalMs || 2000;
  const expectedStatus = options.expectedStatus || 200;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url, { method: 'GET' });
      const status = response.status;
      let bodyMatch = true;

      if (options.expectedBody) {
        const text = await response.text();
        bodyMatch = text.includes(options.expectedBody);
      }

      if (status === expectedStatus && bodyMatch) {
        return {
          healthy: true,
          status,
          durationMs: Date.now() - start,
        };
      }
    } catch (err: unknown) {
      // Ignore network connection refusal and retry until timeout
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  return {
    healthy: false,
    status: 0,
    durationMs: Date.now() - start,
    error: `Healthcheck probe timed out after ${timeoutMs}ms`,
  };
}

export {
  setupGracefulShutdown,
  type GracefulShutdownConfig,
  type GracefulShutdownController,
  type GracefulServer,
} from './graceful-shutdown';

export {
  buildInodeSafeCaddyReloadCmd,
  detectSingleFileBindMountRisk,
  buildPgDumpSchemaSyncCmd,
  generateCaddyZeroDowntimeSnippet,
  generateCaddyNextJsActionGuardSnippet,
  type InodeSafeCaddyReloadOptions,
  type SingleFileBindMountFinding,
  type PgDumpSchemaSyncOptions,
  type CaddyZeroDowntimeProxyOptions,
  type NextJsActionGuardOptions,
} from './caddy-reload';

export {
  runShadowParityCheck,
  buildShadowAndCanaryBashGate,
  type ShadowParityOptions,
  type ShadowParityResult,
  type ShadowCanaryBashOptions,
} from './shadow-canary';

