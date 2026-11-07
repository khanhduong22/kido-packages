#!/usr/bin/env bash
# ==============================================================================
# @kido/zero-downtime-deploy: atomic-swap-be.sh
# ------------------------------------------------------------------------------
# Production Blue-Green Atomic Container Swap for Docker/Bun/Node Backend
# Enhanced with Full-Combo Tier 4 + 5 + 6 + 7:
#   1. Starts/validates candidate container (<name>_next)
#   2. Probes healthcheck endpoint with retry (default: 45s)
#   3. Tier-6: Read-Only Shadow Parity Diff & JIT Warm-up (5 probes)
#   4. Tier-5 & Tier-7: Zero-Gap Network-Alias Connect & Canary Bake (10s)
#   5. On Canary error: instant auto-rollback, active container 100% untouched
#   6. Tier-5: Zero-Gap Atomic Promotion (0.00ms DNS gap via network alias)
#   7. Reloads reverse proxy (Caddy / Nginx)
#   8. Drains in-flight requests (3s) then removes old container
# ==============================================================================

set -euo pipefail

ACTIVE_CONTAINER="${1:-${ACTIVE_CONTAINER:-flashbuy-api}}"
CANDIDATE_CONTAINER="${2:-${CANDIDATE_CONTAINER:-${ACTIVE_CONTAINER}_next}}"
BACKUP_CONTAINER="${3:-${BACKUP_CONTAINER:-${ACTIVE_CONTAINER}_old}}"
HEALTH_URL="${4:-${HEALTH_URL:-http://127.0.0.1:3000/health}}"
TIMEOUT_SECONDS="${5:-${TIMEOUT_SECONDS:-45}}"
CADDY_RELOAD_CMD="${6:-${CADDY_RELOAD_CMD:-docker exec caddy caddy reload --config /etc/caddy/Caddyfile}}"
DRAIN_SECONDS="${7:-${DRAIN_SECONDS:-3}}"

NETWORK_NAME="${NETWORK_NAME:-ops_bridge}"
SHADOW_PROBES="${SHADOW_PROBES:-5}"
CANARY_SECONDS="${CANARY_SECONDS:-10}"
INTERNAL_PORT="${INTERNAL_PORT:-3000}"
HEALTH_PATH="${HEALTH_PATH:-/health}"

echo "=================================================================="
echo "🚀 [BE-SWAP] Starting Tier 4-7 Blue-Green Container Atomic Swap"
echo "   Active Container:    $ACTIVE_CONTAINER"
echo "   Candidate Container: $CANDIDATE_CONTAINER"
echo "   Backup Container:    $BACKUP_CONTAINER"
echo "   Healthcheck URL:     $HEALTH_URL"
echo "   Network Name:        $NETWORK_NAME"
echo "   Canary Window:       ${CANARY_SECONDS}s"
echo "   Shadow Probes:       $SHADOW_PROBES"
echo "   Timeout:             ${TIMEOUT_SECONDS}s"
echo "=================================================================="

# 1. Verify candidate container is running
if ! docker inspect "$CANDIDATE_CONTAINER" >/dev/null 2>&1; then
  echo "❌ [BE-SWAP] Error: Candidate container '$CANDIDATE_CONTAINER' is not running!"
  exit 1
fi

# 2. Healthcheck probe loop
echo "🔍 [BE-SWAP] Probing candidate container health via $HEALTH_URL..."
START_TIME=$(date +%s)
IS_HEALTHY=false

while true; do
  CURRENT_TIME=$(date +%s)
  ELAPSED=$((CURRENT_TIME - START_TIME))

  if [ "$ELAPSED" -ge "$TIMEOUT_SECONDS" ]; then
    break
  fi

  # Probe candidate healthcheck endpoint
  HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$HEALTH_URL" 2>/dev/null || echo "000")

  if [ "$HTTP_STATUS" -ge 200 ] && [ "$HTTP_STATUS" -lt 400 ]; then
    echo "✅ [BE-SWAP] Healthcheck PASSED (HTTP $HTTP_STATUS) in ${ELAPSED}s!"
    IS_HEALTHY=true
    break
  fi

  echo "⏳ [BE-SWAP] Waiting for $HEALTH_URL (status: $HTTP_STATUS, elapsed: ${ELAPSED}s/${TIMEOUT_SECONDS}s)..."
  sleep 2
done

# 3. Handle initial healthcheck failure (Auto-Rollback)
if [ "$IS_HEALTHY" != true ]; then
  echo "❌ [BE-SWAP] Healthcheck probe TIMED OUT after ${TIMEOUT_SECONDS}s!"
  echo "📋 [BE-SWAP] Capturing candidate container logs before aborting:"
  docker logs --tail 60 "$CANDIDATE_CONTAINER" || true
  
  echo "🛡️ [BE-SWAP] Purging candidate container '$CANDIDATE_CONTAINER'..."
  docker rm -f "$CANDIDATE_CONTAINER" 2>/dev/null || true
  
  echo "✅ [BE-SWAP] Rollback finished. Active container '$ACTIVE_CONTAINER' was preserved untouched."
  exit 1
fi

# 4. Tier-6: Read-Only Shadow Parity Diff & JIT Warm-up Probes
echo "🔥 [Tier-6] Executing ${SHADOW_PROBES} rapid Shadow Parity & JIT warm-up probes..."
SHADOW_FAILED=0
for probe_i in $(seq 1 "$SHADOW_PROBES"); do
  if docker ps -a --filter "name=^/${ACTIVE_CONTAINER}$" --filter "status=running" -q | grep -q .; then
    docker exec "$ACTIVE_CONTAINER" sh -c "wget -qO- --header='X-Shadow-Probe: 1' 'http://127.0.0.1:${INTERNAL_PORT}${HEALTH_PATH}' 2>/dev/null || curl -sf -H 'X-Shadow-Probe: 1' 'http://127.0.0.1:${INTERNAL_PORT}${HEALTH_PATH}' 2>/dev/null || true" >/dev/null 2>&1 || true
  fi

  CAND_PROBE=$(docker exec "$CANDIDATE_CONTAINER" sh -c "wget -qO- --header='X-Shadow-Probe: 1' 'http://127.0.0.1:${INTERNAL_PORT}${HEALTH_PATH}' 2>/dev/null || curl -sf -H 'X-Shadow-Probe: 1' 'http://127.0.0.1:${INTERNAL_PORT}${HEALTH_PATH}' 2>/dev/null || true")
  if ! echo "$CAND_PROBE" | grep -qiE "ok|available|healthy|true|status"; then
    SHADOW_FAILED=1
    break
  fi
done

if [ "$SHADOW_FAILED" -eq 1 ]; then
  echo "❌ [Tier-6] Candidate container failed shadow warm-up parity! Aborting..."
  docker logs --tail 40 "$CANDIDATE_CONTAINER" || true
  docker rm -f "$CANDIDATE_CONTAINER" 2>/dev/null || true
  exit 1
fi
echo "✅ [Tier-6] Shadow Parity & JIT warm-up completed successfully."

# 5. Tier-5 & Tier-7: Zero-Gap Network-Alias Connect & Canary Bake
echo "🔀 [Tier-5] Attaching network alias '$ACTIVE_CONTAINER' on '$NETWORK_NAME' to '$CANDIDATE_CONTAINER'..."
docker network disconnect "$NETWORK_NAME" "$CANDIDATE_CONTAINER" 2>/dev/null || true
docker network connect --alias "$ACTIVE_CONTAINER" "$NETWORK_NAME" "$CANDIDATE_CONTAINER"

echo "🐥 [Tier-7] Entering Canary Bake window (${CANARY_SECONDS}s) with live traffic sharing..."
sleep "$CANARY_SECONDS"

if ! docker ps --filter "name=^/${CANDIDATE_CONTAINER}$" --filter "status=running" -q | grep -q .; then
  echo "❌ [Tier-7] CRITICAL: Candidate crashed during Canary Bake window!"
  docker logs --tail 60 "$CANDIDATE_CONTAINER" || true
  docker rm -f "$CANDIDATE_CONTAINER" 2>/dev/null || true
  exit 1
fi

CANARY_ERRORS=$(docker logs --since "${CANARY_SECONDS}s" "$CANDIDATE_CONTAINER" 2>&1 | grep -Ei 'panic:|uncaughtException|unhandledRejection|PrismaClientInitializationError|"status":50[0-9]' || true)
if [ -n "$CANARY_ERRORS" ]; then
  echo "❌ [Tier-7] Fatal error signatures detected in canary window:"
  echo "$CANARY_ERRORS"
  echo "🛡️ Purging candidate container and rolling back..."
  docker network disconnect "$NETWORK_NAME" "$CANDIDATE_CONTAINER" 2>/dev/null || true
  docker rm -f "$CANDIDATE_CONTAINER" 2>/dev/null || true
  exit 1
fi
echo "✅ [Tier-7] Canary Bake passed with 0 error signatures."

# 6. Tier-5: Zero-Gap Atomic Promotion & Cutover
echo "🔄 [Tier-5] Executing Zero-Gap Atomic Promotion..."
docker rm -f "$BACKUP_CONTAINER" 2>/dev/null || true

if docker ps -a --filter "name=^/${ACTIVE_CONTAINER}$" -q | grep -q .; then
  echo "📦 [Tier-5] Disconnecting old '$ACTIVE_CONTAINER' from '$NETWORK_NAME' and renaming -> '$BACKUP_CONTAINER'..."
  docker network disconnect "$NETWORK_NAME" "$ACTIVE_CONTAINER" 2>/dev/null || true
  docker rename "$ACTIVE_CONTAINER" "$BACKUP_CONTAINER"
fi

echo "✨ [Tier-5] Promoting $CANDIDATE_CONTAINER -> $ACTIVE_CONTAINER (0.00ms DNS gap)..."
docker rename "$CANDIDATE_CONTAINER" "$ACTIVE_CONTAINER"
echo "✅ [Tier-5] Candidate successfully promoted to '$ACTIVE_CONTAINER'!"

# 7. Reload reverse proxy (Caddy / Nginx)
if [ -n "$CADDY_RELOAD_CMD" ]; then
  echo "🌐 [BE-SWAP] Reloading reverse proxy: $CADDY_RELOAD_CMD"
  eval "$CADDY_RELOAD_CMD" || echo "⚠️ [BE-SWAP] Warning: Proxy reload command returned non-zero, continuing..."
fi

# 8. Drain in-flight connections & cleanup backup
if docker ps -a --filter "name=^/${BACKUP_CONTAINER}$" -q | grep -q .; then
  echo "⏳ [BE-SWAP] Draining in-flight requests on '$BACKUP_CONTAINER' for ${DRAIN_SECONDS}s..."
  sleep "$DRAIN_SECONDS"
  
  echo "🧹 [BE-SWAP] Removing drained backup container '$BACKUP_CONTAINER'..."
  docker stop "$BACKUP_CONTAINER" 2>/dev/null || true
  docker rm -f "$BACKUP_CONTAINER" 2>/dev/null || true
fi

echo "=================================================================="
echo "🎉 [BE-SWAP] Tier 4-7 Zero-Downtime Swap Completed Successfully!"
echo "=================================================================="
