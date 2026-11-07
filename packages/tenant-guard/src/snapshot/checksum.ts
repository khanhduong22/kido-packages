import { createHash } from 'node:crypto';
import { SnapshotIntegrityResult, TenantSnapshotPayload } from './types';

// ============================================================================
// Deterministic Canonical JSON & SHA-256 Tamper Seal
// ============================================================================

/**
 * Recursively normalizes a value into a deterministic structure with sorted object keys
 * so that key-order differences never cause false SHA-256 mismatches.
 */
export function canonicalizeValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeValue(item));
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sortedKeys = Object.keys(record).sort();
    const result: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      const v = record[key];
      if (v !== undefined) {
        result[key] = canonicalizeValue(v);
      }
    }
    return result;
  }
  return value;
}

/**
 * Serializes any value into deterministic canonical JSON string.
 */
export function canonicalizeJson(data: unknown): string {
  return JSON.stringify(canonicalizeValue(data)) ?? 'null';
}

/**
 * Computes a deterministic SHA-256 hex digest over the canonicalized snapshot `data`.
 */
export function computeSnapshotChecksum(data: unknown): string {
  const canonical = canonicalizeJson(data);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Verifies the SHA-256 integrity seal of a `TenantSnapshotPayload`.
 */
export function verifySnapshotIntegrity(
  payload: TenantSnapshotPayload
): SnapshotIntegrityResult {
  const actual = typeof payload?.checksum === 'string' ? payload.checksum : '';
  if (!payload || typeof payload !== 'object' || !payload.data) {
    return {
      valid: false,
      expected: '',
      actual,
    };
  }
  const expected = computeSnapshotChecksum(payload.data);
  return {
    valid: Boolean(actual.length > 0 && actual === expected),
    expected,
    actual,
  };
}
