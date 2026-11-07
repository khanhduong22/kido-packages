import { z } from 'zod';

/**
 * Standard audit actions for retail/FMCG POS & ERP operations
 */
export const AuditActionSchema = z.enum([
  'ORDER_CREATE',
  'ORDER_CANCEL',
  'PRICE_OVERRIDE',
  'INVENTORY_ADJUST',
  'CASH_DRAWER_OPEN',
  'DEBT_WRITEOFF',
]);

export type StandardAuditAction = z.infer<typeof AuditActionSchema>;
export type AuditAction = StandardAuditAction | (string & {});

/**
 * Security actor context capturing who performed the action and from where
 */
export const ActorContextSchema = z.object({
  userId: z.string().min(1, 'User ID is required'),
  role: z.string().min(1, 'Role is required'),
  ipAddress: z.string().optional().default('127.0.0.1'),
  userAgent: z.string().optional().default('POS-Terminal/1.0'),
  branchId: z.string().optional().default('MAIN_BRANCH'),
});

export type ActorContext = z.infer<typeof ActorContextSchema>;

/**
 * Immutable Audit Log Entry with Cryptographic Hash-Chaining fields
 */
export const AuditEntrySchema = z.object({
  id: z.string().min(1),
  timestamp: z.number().int().positive(),
  actor: ActorContextSchema,
  action: z.string().min(1),
  entityId: z.string().min(1),
  payload: z.record(z.unknown()),
  previousHash: z.string().length(64),
  currentHash: z.string().length(64),
  nonce: z.union([z.number(), z.string()]).default(0),
  metadata: z.record(z.unknown()).optional(),
});

export type AuditEntry = z.infer<typeof AuditEntrySchema>;

/**
 * Parameter object for creating a new audit record (prior to hash calculation)
 */
export interface CreateAuditEntryInput {
  id?: string;
  timestamp?: number;
  actor: ActorContext;
  action: AuditAction;
  entityId: string;
  payload: Record<string, unknown>;
  nonce?: number | string;
  metadata?: Record<string, unknown>;
}

/**
 * Result of chain integrity validation and tamper detection
 */
export interface IntegrityVerificationResult {
  isValid: boolean;
  totalRecords: number;
  tamperedIndex: number | null;
  tamperedRecordId: string | null;
  reason: string | null;
  details?: Record<string, unknown>;
}

/**
 * Anomaly severity classification
 */
export type AnomalySeverity = 'INFO' | 'WARNING' | 'CRITICAL';

/**
 * Flag raised by the real-time anomaly detection engine
 */
export interface AnomalyFlag {
  ruleId: string;
  severity: AnomalySeverity;
  message: string;
  detectedAt: number;
  details?: Record<string, unknown>;
}

/**
 * Configuration thresholds for the anomaly detection engine
 */
export interface AnomalyConfig {
  /** Maximum threshold for order cancellation in VND before warning (default: 500,000) */
  orderCancelMaxAmount: number;
  /** Critical threshold for order cancellation in VND (default: 5,000,000) */
  orderCancelCriticalAmount: number;
  /** Night hours start (inclusive, 0-23, default: 22) */
  orderCancelNightHourStart: number;
  /** Night hours end (exclusive, 0-23, default: 6) */
  orderCancelNightHourEnd: number;
  /** Maximum allowed discount percentage before anomaly warning (default: 10%) */
  priceOverrideMaxDiscountPercent: number;
  /** Critical discount percentage before critical warning (default: 30%) */
  priceOverrideCriticalPercent: number;
  /** Cash drawer discrepancy threshold in VND (default: 200,000) */
  cashDiscrepancyThreshold: number;
  /** Critical cash drawer discrepancy in VND (default: 1,000,000) */
  cashDiscrepancyCriticalThreshold: number;
}

/**
 * Merkle proof node step
 */
export interface MerkleProofStep {
  position: 'left' | 'right';
  hash: string;
}

/**
 * Merkle audit proof for verification
 */
export interface MerkleProof {
  leafIndex: number;
  leafHash: string;
  proof: MerkleProofStep[];
  root: string;
}

/**
 * End-of-shift / Daily financial snapshot anchored by Merkle Root
 */
export interface ShiftSnapshot {
  shiftId: string;
  branchId?: string;
  timestamp: number;
  merkleRoot: string;
  totalTransactions: number;
  firstHash: string;
  lastHash: string;
  metadata?: Record<string, unknown>;
}
