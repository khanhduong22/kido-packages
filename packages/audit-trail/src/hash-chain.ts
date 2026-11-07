import { createHash, randomUUID } from 'node:crypto';
import {
  AuditEntry,
  CreateAuditEntryInput,
  IntegrityVerificationResult,
} from './types';

/**
 * Standard Genesis Hash representing the root of a new audit trail
 */
export const GENESIS_HASH = '0'.repeat(64);

/**
 * Deterministically stringify JSON by sorting object keys recursively.
 * Ensures consistent hash generation regardless of JavaScript key insertion order.
 */
export function canonicalJsonStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJsonStringify(item)).join(',')}]`;
  }

  const sortedKeys = Object.keys(value as Record<string, unknown>).sort();
  const pairs = sortedKeys.map(
    (key) =>
      `${JSON.stringify(key)}:${canonicalJsonStringify((value as Record<string, unknown>)[key])}`
  );

  return `{${pairs.join(',')}}`;
}

/**
 * Compute SHA-256 hash string for an audit log entry
 * Formula: SHA256(previousHash + timestamp + actor.userId + action + JSON.stringify(payload) + nonce)
 */
export function computeEntryHash(params: {
  previousHash: string;
  timestamp: number | string;
  userId: string;
  action: string;
  payload: unknown;
  nonce?: number | string;
}): string {
  const nonce = params.nonce ?? 0;
  const payloadStr = canonicalJsonStringify(params.payload);
  const data = `${params.previousHash}${params.timestamp}${params.userId}${params.action}${payloadStr}${nonce}`;

  return createHash('sha256').update(data).digest('hex');
}

/**
 * Compute SHA-256 hash directly from an existing AuditEntry
 */
export function getAuditEntryHash(entry: AuditEntry): string {
  return computeEntryHash({
    previousHash: entry.previousHash,
    timestamp: entry.timestamp,
    userId: entry.actor.userId,
    action: entry.action,
    payload: entry.payload,
    nonce: entry.nonce,
  });
}

/**
 * Create a new cryptographically chained audit record
 */
export function createAuditEntry(
  input: CreateAuditEntryInput,
  previousHash: string = GENESIS_HASH
): AuditEntry {
  const id = input.id ?? `audit_${randomUUID()}`;
  const timestamp = input.timestamp ?? Date.now();
  const nonce = input.nonce ?? 0;

  const currentHash = computeEntryHash({
    previousHash,
    timestamp,
    userId: input.actor.userId,
    action: input.action,
    payload: input.payload,
    nonce,
  });

  return {
    id,
    timestamp,
    actor: {
      userId: input.actor.userId,
      role: input.actor.role,
      ipAddress: input.actor.ipAddress ?? '127.0.0.1',
      userAgent: input.actor.userAgent ?? 'POS-Terminal/1.0',
      branchId: input.actor.branchId ?? 'MAIN_BRANCH',
    },
    action: input.action,
    entityId: input.entityId,
    payload: input.payload,
    previousHash,
    currentHash,
    nonce,
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
}

/**
 * Verify cryptographic integrity of an entire chain of audit records.
 * Scans sequentially and pinpoints any inserted, modified, or deleted records.
 */
export function verifyChainIntegrity(
  records: AuditEntry[],
  expectedGenesisHash: string = GENESIS_HASH
): IntegrityVerificationResult {
  const totalRecords = records.length;

  if (totalRecords === 0) {
    return {
      isValid: true,
      totalRecords: 0,
      tamperedIndex: null,
      tamperedRecordId: null,
      reason: null,
    };
  }

  // Check 1: Genesis record must point to expected genesis hash
  if (records[0].previousHash !== expectedGenesisHash) {
    return {
      isValid: false,
      totalRecords,
      tamperedIndex: 0,
      tamperedRecordId: records[0].id,
      reason: `Genesis previousHash mismatch: expected ${expectedGenesisHash}, found ${records[0].previousHash}`,
      details: {
        expectedPreviousHash: expectedGenesisHash,
        actualPreviousHash: records[0].previousHash,
      },
    };
  }

  // Check 2: Sequential verification of each block
  for (let i = 0; i < totalRecords; i++) {
    const record = records[i];

    // Verify self-integrity: does currentHash match recalculation?
    const computedHash = getAuditEntryHash(record);
    if (record.currentHash !== computedHash) {
      return {
        isValid: false,
        totalRecords,
        tamperedIndex: i,
        tamperedRecordId: record.id,
        reason: `Data tampering detected at index ${i} (ID: ${record.id}): record hash does not match content`,
        details: {
          storedHash: record.currentHash,
          computedHash,
          action: record.action,
          entityId: record.entityId,
        },
      };
    }

    // Verify chain linkage with previous record
    if (i > 0) {
      const prevRecord = records[i - 1];
      if (record.previousHash !== prevRecord.currentHash) {
        return {
          isValid: false,
          totalRecords,
          tamperedIndex: i,
          tamperedRecordId: record.id,
          reason: `Broken chain link detected at index ${i} (ID: ${record.id}): previousHash does not match prior record's currentHash`,
          details: {
            previousRecordId: prevRecord.id,
            priorRecordCurrentHash: prevRecord.currentHash,
            currentRecordPreviousHash: record.previousHash,
          },
        };
      }
    }
  }

  return {
    isValid: true,
    totalRecords,
    tamperedIndex: null,
    tamperedRecordId: null,
    reason: null,
  };
}
