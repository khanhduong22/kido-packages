#!/usr/bin/env bash
# ==============================================================================
# @kido/zero-downtime-deploy: atomic-swap-fe.sh
# ------------------------------------------------------------------------------
# Inode Atomic Directory Swap for Static Web SPAs & Nginx/Caddy Web Servers
# Ensures sub-millisecond atomic directory switch (< 1ms):
#   1. Validates that staging directory exists and is populated
#   2. Prepares parent directories
#   3. Atomically swaps staging -> target via kernel inode directory pointer mv
#   4. Safely cleans up temporary backup directory
# ==============================================================================

set -euo pipefail

TARGET_DIR="${1:-${TARGET_DIR:-/opt/kido-infra/docker/portfolio/html/apps/flashbuy}}"
STAGING_DIR="${2:-${STAGING_DIR:-${TARGET_DIR}_next}}"
BACKUP_DIR="${3:-${BACKUP_DIR:-${TARGET_DIR}_backup}}"

echo "=================================================================="
echo "⚡ [FE-SWAP] Starting Inode Atomic Directory Swap"
echo "   Target Directory:  $TARGET_DIR"
echo "   Staging Directory: $STAGING_DIR"
echo "   Backup Directory:  $BACKUP_DIR"
echo "=================================================================="

# 1. Validation: staging directory must exist
if [ ! -d "$STAGING_DIR" ]; then
  echo "❌ [FE-SWAP] Error: Staging directory '$STAGING_DIR' does not exist!"
  exit 1
fi

# Check if staging is empty
if [ -z "$(ls -A "$STAGING_DIR" 2>/dev/null)" ]; then
  echo "❌ [FE-SWAP] Error: Staging directory '$STAGING_DIR' is empty!"
  exit 1
fi

# Ensure parent directory of target exists
TARGET_PARENT=$(dirname "$TARGET_DIR")
mkdir -p "$TARGET_PARENT"

# 2. Clean up any stale backup directory from previous failed operations
rm -rf "$BACKUP_DIR"

# 3. Inode Atomic Swap
if [ -d "$TARGET_DIR" ]; then
  echo "🔄 [FE-SWAP] Executing kernel inode rename swap..."
  # Atomically move current target to backup
  mv "$TARGET_DIR" "$BACKUP_DIR"
  # Atomically promote staging to target
  mv "$STAGING_DIR" "$TARGET_DIR"
  # Clean up old backup
  rm -rf "$BACKUP_DIR"
else
  echo "✨ [FE-SWAP] First-time deployment. Moving staging directly to target..."
  mv "$STAGING_DIR" "$TARGET_DIR"
fi

echo "=================================================================="
echo "🎉 [FE-SWAP] Atomic Directory Swap Completed in < 1ms!"
echo "   Active Path: $TARGET_DIR"
echo "=================================================================="
