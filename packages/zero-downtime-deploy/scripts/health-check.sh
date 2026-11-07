#!/usr/bin/env bash
# ==============================================================================
# @kido/zero-downtime-deploy: health-check.sh
# ------------------------------------------------------------------------------
# Robust Healthcheck Probe with Exponential / Fixed Retry & Auto-Rollback Trigger
# Polls target endpoint until healthy or timeout expires.
# ==============================================================================

set -euo pipefail

URL="${1:-${HEALTH_URL:-http://127.0.0.1:3000/health}}"
TIMEOUT="${2:-${HEALTH_TIMEOUT:-45}}"
INTERVAL="${3:-${HEALTH_INTERVAL:-2}}"
EXPECTED_STATUS="${4:-${EXPECTED_STATUS:-200}}"
EXPECTED_BODY="${5:-${EXPECTED_BODY:-}}"
ROLLBACK_CMD="${6:-${ROLLBACK_CMD:-}}"

echo "=================================================================="
echo "🩺 [HEALTH-CHECK] Initiating Healthcheck Probe"
echo "   Endpoint:        $URL"
echo "   Timeout:         ${TIMEOUT}s (interval: ${INTERVAL}s)"
echo "   Expected Status: $EXPECTED_STATUS"
[ -n "$EXPECTED_BODY" ] && echo "   Expected Match:  $EXPECTED_BODY"
echo "=================================================================="

START_TIME=$(date +%s)
PASSED=false

while true; do
  CURRENT_TIME=$(date +%s)
  ELAPSED=$((CURRENT_TIME - START_TIME))

  if [ "$ELAPSED" -ge "$TIMEOUT" ]; then
    break
  fi

  # Perform curl probe
  RESPONSE=$(curl -s -w "\n%{http_code}" "$URL" 2>/dev/null || echo -e "\n000")
  HTTP_STATUS=$(echo "$RESPONSE" | tail -n1)
  HTTP_BODY=$(echo "$RESPONSE" | sed '$d')

  STATUS_MATCH=false
  if [ "$HTTP_STATUS" = "$EXPECTED_STATUS" ] || ([ "$EXPECTED_STATUS" = "200" ] && [ "$HTTP_STATUS" -ge 200 ] && [ "$HTTP_STATUS" -lt 300 ]); then
    STATUS_MATCH=true
  fi

  BODY_MATCH=true
  if [ -n "$EXPECTED_BODY" ]; then
    if ! echo "$HTTP_BODY" | grep -q "$EXPECTED_BODY"; then
      BODY_MATCH=false
    fi
  fi

  if [ "$STATUS_MATCH" = true ] && [ "$BODY_MATCH" = true ]; then
    echo "✅ [HEALTH-CHECK] Target is HEALTHY! Status: $HTTP_STATUS in ${ELAPSED}s."
    PASSED=true
    break
  fi

  echo "⏳ [HEALTH-CHECK] Polling... (Status: $HTTP_STATUS, elapsed: ${ELAPSED}s/${TIMEOUT}s)"
  sleep "$INTERVAL"
done

if [ "$PASSED" = true ]; then
  exit 0
else
  echo "❌ [HEALTH-CHECK] Probe FAILED! Timed out after ${TIMEOUT}s without healthy response."
  if [ -n "$ROLLBACK_CMD" ]; then
    echo "🛡️ [HEALTH-CHECK] Executing rollback command: $ROLLBACK_CMD"
    eval "$ROLLBACK_CMD" || true
  fi
  exit 1
fi
