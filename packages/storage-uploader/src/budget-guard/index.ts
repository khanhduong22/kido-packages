import * as crypto from 'crypto';

// ==========================================
// 1. Cloudflare R2 Free-Tier Budget Circuit Breaker
// ==========================================

/** Cloudflare R2 permanent free tier is 10 GiB (10 * 1024^3 bytes) */
export const R2_FREE_TIER_BYTES = 10 * 1024 * 1024 * 1024;

/** Default safety circuit breaker cap: 1 GiB (10% of R2 free tier) */
export const DEFAULT_R2_HARD_CAP_BYTES = 1 * 1024 * 1024 * 1024;

export interface R2UsageSnapshot {
  payloadSize: number;
  metadataSize: number;
  objectCount?: number;
}

export interface R2BudgetEvaluation {
  allowed: boolean;
  currentUsedBytes: number;
  incomingBatchBytes: number;
  projectedTotalBytes: number;
  hardCapBytes: number;
  freeTierBytes: number;
  utilizationRatio: number;
  reason?: string;
}

/**
 * Pure deterministic evaluator for object storage free-tier circuit breaking.
 * Blocks uploads before any PUT requests fire if current usage + incoming batch
 * reaches or exceeds the configured hard cap.
 */
export function evaluateStorageBudgetGuard(
  usage: R2UsageSnapshot,
  incomingBatchBytes = 0,
  hardCapBytes: number = DEFAULT_R2_HARD_CAP_BYTES,
  freeTierBytes: number = R2_FREE_TIER_BYTES
): R2BudgetEvaluation {
  const payload = Math.max(0, Number(usage.payloadSize || 0));
  const metadata = Math.max(0, Number(usage.metadataSize || 0));
  const batch = Math.max(0, Number(incomingBatchBytes || 0));

  const currentUsedBytes = payload + metadata;
  const projectedTotalBytes = currentUsedBytes + batch;
  const utilizationRatio = hardCapBytes > 0 ? projectedTotalBytes / hardCapBytes : 1;

  if (currentUsedBytes >= hardCapBytes) {
    return {
      allowed: false,
      currentUsedBytes,
      incomingBatchBytes: batch,
      projectedTotalBytes,
      hardCapBytes,
      freeTierBytes,
      utilizationRatio,
      reason: `HARD $0 BUDGET CIRCUIT BREAKER: Current bucket usage (${currentUsedBytes} bytes) has reached or exceeded hard cap (${hardCapBytes} bytes).`,
    };
  }

  if (projectedTotalBytes > hardCapBytes) {
    return {
      allowed: false,
      currentUsedBytes,
      incomingBatchBytes: batch,
      projectedTotalBytes,
      hardCapBytes,
      freeTierBytes,
      utilizationRatio,
      reason: `HARD $0 BUDGET CIRCUIT BREAKER: Uploading batch (${batch} bytes) would push usage to ${projectedTotalBytes} bytes, exceeding hard cap (${hardCapBytes} bytes).`,
    };
  }

  return {
    allowed: true,
    currentUsedBytes,
    incomingBatchBytes: batch,
    projectedTotalBytes,
    hardCapBytes,
    freeTierBytes,
    utilizationRatio,
  };
}

export interface CheckCloudflareR2BudgetOptions {
  accountId: string;
  bucketName: string;
  apiToken: string;
  incomingBatchBytes?: number;
  hardCapBytes?: number;
  fetchFn?: typeof fetch;
}

/**
 * Queries the Cloudflare R2 Bucket Usage REST API and evaluates the $0 budget circuit breaker.
 */
export async function checkCloudflareR2Budget(
  options: CheckCloudflareR2BudgetOptions
): Promise<R2BudgetEvaluation> {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(
    options.accountId
  )}/r2/buckets/${encodeURIComponent(options.bucketName)}/usage`;

  const res = await fetchFn(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${options.apiToken}`,
    },
  });

  if (!res.ok) {
    throw new Error(`Cloudflare R2 usage check failed with HTTP ${res.status}`);
  }

  const data = (await res.json()) as {
    success?: boolean;
    result?: {
      payloadSize?: number | string;
      metadataSize?: number | string;
      objectCount?: number | string;
    };
  };

  const snapshot: R2UsageSnapshot = {
    payloadSize: Number(data?.result?.payloadSize ?? 0),
    metadataSize: Number(data?.result?.metadataSize ?? 0),
    objectCount: data?.result?.objectCount !== undefined ? Number(data.result.objectCount) : undefined,
  };

  return evaluateStorageBudgetGuard(
    snapshot,
    options.incomingBatchBytes ?? 0,
    options.hardCapBytes ?? DEFAULT_R2_HARD_CAP_BYTES
  );
}

// ==========================================
// 2. GarageHQ Rust S3 Key Format Validator & Generator
// ==========================================

/**
 * GarageHQ (`garage key import`) strictly requires:
 * - Access Key ID: `GK` prefix followed by 24 lowercase/uppercase hex characters (12 raw bytes)
 * - Secret Access Key: exact 64 hex characters (32 raw bytes). Arbitrary ASCII secrets fail import!
 */
export const GARAGE_ACCESS_KEY_REGEX = /^GK[0-9a-fA-F]{24}$/;
export const GARAGE_SECRET_KEY_HEX_REGEX = /^[0-9a-fA-F]{64}$/;

export interface GarageS3KeyValidation {
  valid: boolean;
  accessKeyValid: boolean;
  secretKeyValid: boolean;
  errors: string[];
}

export function validateGarageS3Credentials(
  accessKeyId: string,
  secretAccessKey: string
): GarageS3KeyValidation {
  const errors: string[] = [];
  const accessKeyValid = GARAGE_ACCESS_KEY_REGEX.test(accessKeyId);
  const secretKeyValid = GARAGE_SECRET_KEY_HEX_REGEX.test(secretAccessKey);

  if (!accessKeyValid) {
    errors.push(
      'Invalid GarageHQ Access Key ID: must start with "GK" followed by exactly 24 hexadecimal characters (e.g. GK + 12 bytes hex).'
    );
  }
  if (!secretKeyValid) {
    errors.push(
      `Invalid GarageHQ Secret Key: must be an exact 64-character hexadecimal string (32 raw bytes), received length ${secretAccessKey.length}.`
    );
  }

  return {
    valid: accessKeyValid && secretKeyValid,
    accessKeyValid,
    secretKeyValid,
    errors,
  };
}

/**
 * Generates a cryptographically strong or deterministic (from seed) GarageHQ-compliant S3 keypair.
 */
export function generateGarageS3Credentials(seed?: string): {
  accessKeyId: string;
  secretAccessKey: string;
} {
  if (seed) {
    const keyHash = crypto.createHash('sha256').update(`garage-key:${seed}`).digest('hex');
    const secretHash = crypto.createHash('sha256').update(`garage-secret:${seed}`).digest('hex');
    return {
      accessKeyId: `GK${keyHash.slice(0, 24)}`,
      secretAccessKey: secretHash, // 64 hex chars (32 bytes)
    };
  }

  return {
    accessKeyId: `GK${crypto.randomBytes(12).toString('hex')}`,
    secretAccessKey: crypto.randomBytes(32).toString('hex'),
  };
}
