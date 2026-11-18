/**
 * @kido/storage-uploader — 3-Tier Zero-Cost Storage Lifecycle & Cold AVIF Archiver
 *
 * SSoT module implementing the automated multi-tier storage waterfall:
 * 1. Cloudflare R2 Free Tier (Hot Tier: <= 8.5 GiB safety threshold under 10 GiB R2 Free Tier, $0 egress)
 * 2. Local NVMe SSD GarageHQ / Local Media (Warm Tier: active 30-90 day files)
 * 3. Local Cold HDD Archive (Cold Tier: > 90 day files converted to AVIF/WebP @ 72 quality, ~78% storage reclaimed)
 */

import {
  evaluateStorageBudgetGuard,
  type R2BudgetEvaluation,
} from '../budget-guard';

// ==========================================
// 1. Types & Configuration
// ==========================================

export type StorageTier = 'r2_hot' | 'ssd_warm' | 'hdd_cold';

export interface StorageObjectMeta {
  key: string;
  sizeBytes: number;
  mimeType: string;
  createdAtMs: number;
  lastAccessedAtMs?: number;
  accessCount30d?: number;
  currentTier: StorageTier;
  compressedFormat?: 'original' | 'webp' | 'avif';
}

export interface TieredLifecyclePolicy {
  /** R2 free-tier safety threshold (bytes). Defaults to 8.5 GiB */
  r2HardCapBytes?: number;
  /** LRU idle days before hot R2 object demotes to warm SSD. Defaults to 90 days */
  hotToWarmDays?: number;
  /** LRU idle days before warm SSD object archives to cold HDD. Defaults to 365 days */
  warmToColdDays?: number;
  /**
   * Minimum access count required to stay in hot/warm tier. Defaults to 1
   * (so only objects with `accessCount30d === 0` AND `idleDays >= threshold` are demoted,
   * protecting low-traffic SME/niche catalogs from false-positive demotions).
   */
  minAccessCountToStayHot?: number;
  /** Target image format for cold HDD compression. Defaults to 'avif' */
  coldCompressionFormat?: 'avif' | 'webp';
  /** Compression quality (1-100) for cold transcode. Defaults to 72 */
  coldQuality?: number;
  /** Expected compressed size / original size ratio. Defaults to 0.22 (~78% savings) */
  estimatedCompressionRatio?: number;
}

/** 8.5 GiB safety threshold under 10 GiB Cloudflare R2 Free Tier */
export const DEFAULT_R2_HARD_CAP_BYTES_LIFECYCLE = Math.floor(8.5 * 1024 * 1024 * 1024);
export const DEFAULT_HOT_TO_WARM_DAYS = 90;
export const DEFAULT_WARM_TO_COLD_DAYS = 365;
export const DEFAULT_MIN_ACCESS_COUNT_TO_STAY_HOT = 1;
export const DEFAULT_COLD_COMPRESSION_FORMAT = 'avif' as const;
export const DEFAULT_COLD_QUALITY = 72;
export const DEFAULT_ESTIMATED_COMPRESSION_RATIO = 0.22;

export const DEFAULT_TIERED_LIFECYCLE_POLICY: Required<TieredLifecyclePolicy> = {
  r2HardCapBytes: DEFAULT_R2_HARD_CAP_BYTES_LIFECYCLE,
  hotToWarmDays: DEFAULT_HOT_TO_WARM_DAYS,
  warmToColdDays: DEFAULT_WARM_TO_COLD_DAYS,
  minAccessCountToStayHot: DEFAULT_MIN_ACCESS_COUNT_TO_STAY_HOT,
  coldCompressionFormat: DEFAULT_COLD_COMPRESSION_FORMAT,
  coldQuality: DEFAULT_COLD_QUALITY,
  estimatedCompressionRatio: DEFAULT_ESTIMATED_COMPRESSION_RATIO,
};

// ==========================================
// 2. Placement Router on Upload
// ==========================================

export interface ResolveUploadTargetOptions {
  incomingFileBytes: number;
  r2CurrentUsedBytes: number;
  policy?: TieredLifecyclePolicy;
}

export interface ResolveUploadTargetResult {
  targetTier: StorageTier;
  tier: StorageTier;
  allowedInR2: boolean;
  budgetEvaluation: R2BudgetEvaluation;
  reason: string;
}

/**
 * Pure deterministic placement router on upload.
 * Evaluates Cloudflare R2 $0 budget circuit breaker via `evaluateStorageBudgetGuard`:
 * - If `r2CurrentUsedBytes + incomingFileBytes <= r2HardCapBytes`: routes to `'r2_hot'` ($0 egress)
 * - If R2 budget trips (`> 8.5 GiB`): automatically falls back to `'ssd_warm'` (Local NVMe SSD GarageHQ)
 */
export function resolveUploadTargetTier(
  options: ResolveUploadTargetOptions
): ResolveUploadTargetResult;
export function resolveUploadTargetTier(
  incomingFileBytes: number,
  r2CurrentUsedBytes: number,
  policy?: TieredLifecyclePolicy
): ResolveUploadTargetResult;
export function resolveUploadTargetTier(
  arg1: number | ResolveUploadTargetOptions,
  arg2?: number,
  arg3?: TieredLifecyclePolicy
): ResolveUploadTargetResult {
  let incomingFileBytes: number;
  let r2CurrentUsedBytes: number;
  let policy: TieredLifecyclePolicy | undefined;

  if (typeof arg1 === 'object' && arg1 !== null) {
    incomingFileBytes = arg1.incomingFileBytes;
    r2CurrentUsedBytes = arg1.r2CurrentUsedBytes;
    policy = arg1.policy;
  } else {
    incomingFileBytes = Number(arg1 || 0);
    r2CurrentUsedBytes = Number(arg2 || 0);
    policy = arg3;
  }

  const hardCapBytes = policy?.r2HardCapBytes ?? DEFAULT_TIERED_LIFECYCLE_POLICY.r2HardCapBytes;

  const budgetEvaluation = evaluateStorageBudgetGuard(
    { payloadSize: r2CurrentUsedBytes, metadataSize: 0 },
    incomingFileBytes,
    hardCapBytes
  );

  const allowedInR2 = budgetEvaluation.allowed;
  const targetTier: StorageTier = allowedInR2 ? 'r2_hot' : 'ssd_warm';
  const reason = allowedInR2
    ? `Within Cloudflare R2 $0 free-tier safety budget (${budgetEvaluation.projectedTotalBytes} <= ${hardCapBytes} bytes): routed to r2_hot ($0 cloud egress)`
    : `Cloudflare R2 $0 safety budget circuit breaker tripped (${budgetEvaluation.projectedTotalBytes} > ${hardCapBytes} bytes): automatic fallback to ssd_warm (Local NVMe SSD GarageHQ)`;

  return {
    targetTier,
    tier: targetTier,
    allowedInR2,
    budgetEvaluation,
    reason,
  };
}

// ==========================================
// 3. Lifecycle Transition Planner
// ==========================================

export type LifecycleTransitionReason =
  | 'age_and_inactivity'
  | 'r2_capacity_watermark_breach'
  | 'warm_retention_expired';

export interface LifecycleTransitionAction {
  key: string;
  objectKey: string;
  fromTier: StorageTier;
  toTier: StorageTier;
  originalSizeBytes: number;
  estimatedCompressedSizeBytes?: number;
  reason: LifecycleTransitionReason;
  reasonDetails: string;
  imgproxyTranscodeUrl?: string;
  sourcePath?: string;
  targetPath?: string;
}

export interface PlanLifecycleTransitionsOptions {
  nowMs?: number;
  policy?: TieredLifecyclePolicy;
  /** Override current total R2 storage usage (bytes). If omitted, summed from `r2_hot` objects */
  currentR2SizeBytes?: number;
  /** Optional base URL for imgproxy service */
  imgproxyBaseUrl?: string;
}

export interface LifecycleTransitionPlan {
  actions: LifecycleTransitionAction[];
  demotionsToWarm: LifecycleTransitionAction[];
  archivesToCold: LifecycleTransitionAction[];
  bytesReclaimedFromR2: number;
  bytesReclaimedFromSsd: number;
  estimatedHddBytesAdded: number;
  netStorageSavingsBytes: number;
  r2UsageBeforeBytes: number;
  r2UsageAfterBytes: number;
  evaluatedAtMs: number;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Evaluates storage objects against tiered retention policies and R2 capacity limits:
 * 1. Demotes `r2_hot -> ssd_warm` when age >= hotToWarmDays AND accessCount30d < minAccessCountToStayHot.
 * 2. Evicts oldest/coldest `r2_hot` objects when R2 usage exceeds r2HardCapBytes until usage drops below cap.
 * 3. Archives `ssd_warm -> hdd_cold` when age >= warmToColdDays with AVIF cold transcode.
 */
export function planLifecycleTransitions(
  objects: StorageObjectMeta[],
  options?: PlanLifecycleTransitionsOptions
): LifecycleTransitionPlan {
  const nowMs = options?.nowMs ?? Date.now();
  const policy: Required<TieredLifecyclePolicy> = {
    ...DEFAULT_TIERED_LIFECYCLE_POLICY,
    ...options?.policy,
  };

  const hotToWarmMs = policy.hotToWarmDays * MS_PER_DAY;
  const warmToColdMs = policy.warmToColdDays * MS_PER_DAY;

  // Track R2 usage
  const hotObjects = objects.filter((o) => o.currentTier === 'r2_hot');
  const sumHotBytes = hotObjects.reduce((acc, o) => acc + o.sizeBytes, 0);
  const r2UsageBeforeBytes = options?.currentR2SizeBytes ?? sumHotBytes;
  let runningR2Bytes = r2UsageBeforeBytes;

  const actions: LifecycleTransitionAction[] = [];
  const processedKeys = new Set<string>();

  // ----------------------------------------------------
  // Step 1: LRU Inactivity & Age Demotion (r2_hot -> ssd_warm)
  // Uses LRU (lastAccessedAtMs || createdAtMs) + LFU (accessCount30d)
  // so old best-seller photos that are still actively viewed stay HOT!
  // ----------------------------------------------------
  for (const obj of hotObjects) {
    const lastActiveMs = Math.max(obj.createdAtMs, obj.lastAccessedAtMs ?? 0);
    const idleMs = Math.max(0, nowMs - lastActiveMs);
    const accessCount = obj.accessCount30d ?? 0;

    if (idleMs >= hotToWarmMs && accessCount < policy.minAccessCountToStayHot) {
      processedKeys.add(obj.key);
      runningR2Bytes -= obj.sizeBytes;

      const idleDays = Math.floor(idleMs / MS_PER_DAY);
      actions.push({
        key: obj.key,
        objectKey: obj.key,
        fromTier: 'r2_hot',
        toTier: 'ssd_warm',
        originalSizeBytes: obj.sizeBytes,
        reason: 'age_and_inactivity',
        reasonDetails: `Object LRU idle duration (${idleDays}d >= ${policy.hotToWarmDays}d) and 30-day access count (${accessCount} < ${policy.minAccessCountToStayHot}) qualified for demotion to ssd_warm`,
        sourcePath: `/media/r2/${obj.key}`,
        targetPath: `/media/hot/${obj.key}`,
      });
    }
  }

  // ----------------------------------------------------
  // Step 2: Capacity Watermark Eviction (r2_hot -> ssd_warm)
  // If R2 usage still breaches hard cap, evict coldest/oldest first
  // ----------------------------------------------------
  if (runningR2Bytes > policy.r2HardCapBytes) {
    const remainingHotCandidates = hotObjects
      .filter((o) => !processedKeys.has(o.key))
      .sort((a, b) => {
        // 1. Coldest (lowest 30-day access count) first
        const countA = a.accessCount30d ?? 0;
        const countB = b.accessCount30d ?? 0;
        if (countA !== countB) {
          return countA - countB;
        }

        // 2. Oldest accessed time first (or oldest createdAtMs)
        const lastA = a.lastAccessedAtMs ?? a.createdAtMs;
        const lastB = b.lastAccessedAtMs ?? b.createdAtMs;
        if (lastA !== lastB) {
          return lastA - lastB;
        }

        // 3. Larger file first to reclaim capacity faster
        return b.sizeBytes - a.sizeBytes;
      });

    for (const obj of remainingHotCandidates) {
      if (runningR2Bytes <= policy.r2HardCapBytes) {
        break;
      }

      processedKeys.add(obj.key);
      runningR2Bytes -= obj.sizeBytes;

      actions.push({
        key: obj.key,
        objectKey: obj.key,
        fromTier: 'r2_hot',
        toTier: 'ssd_warm',
        originalSizeBytes: obj.sizeBytes,
        reason: 'r2_capacity_watermark_breach',
        reasonDetails: `R2 usage exceeds safety hard cap (${policy.r2HardCapBytes} bytes); evicted coldest/oldest object to restore $0 free tier headroom`,
        sourcePath: `/media/r2/${obj.key}`,
        targetPath: `/media/hot/${obj.key}`,
      });
    }
  }

  // ----------------------------------------------------
  // Step 3: Archive & Cold-Compress (ssd_warm -> hdd_cold)
  // Evaluates LRU idle time (nowMs - max(createdAtMs, lastAccessedAtMs))
  // and 30-day access frequency so actively viewed warm items stay on SSD!
  // ----------------------------------------------------
  const warmObjects = objects.filter((o) => o.currentTier === 'ssd_warm');
  for (const obj of warmObjects) {
    const lastActiveMs = Math.max(obj.createdAtMs, obj.lastAccessedAtMs ?? 0);
    const idleMs = Math.max(0, nowMs - lastActiveMs);
    const accessCount = obj.accessCount30d ?? 0;

    if (idleMs >= warmToColdMs && accessCount < policy.minAccessCountToStayHot) {
      const idleDays = Math.floor(idleMs / MS_PER_DAY);
      const estimatedCompressedSizeBytes = Math.round(
        obj.sizeBytes * policy.estimatedCompressionRatio
      );

      const transcodeUrl = buildImgproxyColdTranscodeUrl(obj.key, {
        format: policy.coldCompressionFormat,
        quality: policy.coldQuality,
        imgproxyBaseUrl: options?.imgproxyBaseUrl,
      });

      actions.push({
        key: obj.key,
        objectKey: obj.key,
        fromTier: 'ssd_warm',
        toTier: 'hdd_cold',
        originalSizeBytes: obj.sizeBytes,
        estimatedCompressedSizeBytes,
        reason: 'warm_retention_expired',
        reasonDetails: `Object LRU idle duration (${idleDays}d >= ${policy.warmToColdDays}d, 30d views=${accessCount}) exceeded warm retention; scheduled for imgproxy ${policy.coldCompressionFormat.toUpperCase()} cold transcode and move to HDD`,
        imgproxyTranscodeUrl: transcodeUrl,
        sourcePath: `/media/hot/${obj.key}`,
        targetPath: `/media/cold/${obj.key}`,
      });
    }
  }

  // ----------------------------------------------------
  // Summary Aggregates
  // ----------------------------------------------------
  const demotionsToWarm = actions.filter((a) => a.toTier === 'ssd_warm');
  const archivesToCold = actions.filter((a) => a.toTier === 'hdd_cold');

  let bytesReclaimedFromR2 = 0;
  for (const a of demotionsToWarm) {
    bytesReclaimedFromR2 += a.originalSizeBytes;
  }

  let bytesReclaimedFromSsd = 0;
  let estimatedHddBytesAdded = 0;
  for (const a of archivesToCold) {
    bytesReclaimedFromSsd += a.originalSizeBytes;
    estimatedHddBytesAdded += a.estimatedCompressedSizeBytes ?? 0;
  }

  const netStorageSavingsBytes = bytesReclaimedFromSsd - estimatedHddBytesAdded;
  const r2UsageAfterBytes = Math.max(0, r2UsageBeforeBytes - bytesReclaimedFromR2);

  return {
    actions,
    demotionsToWarm,
    archivesToCold,
    bytesReclaimedFromR2,
    bytesReclaimedFromSsd,
    estimatedHddBytesAdded,
    netStorageSavingsBytes,
    r2UsageBeforeBytes,
    r2UsageAfterBytes,
    evaluatedAtMs: nowMs,
  };
}

// ==========================================
// 4. Imgproxy Cold Compression & Waterfall URL Builder
// ==========================================

export interface ImgproxyColdTranscodeOptions {
  format?: 'avif' | 'webp';
  quality?: number;
  maxDimension?: number;
  imgproxyBaseUrl?: string;
}

/**
 * Builds the exact `imgproxy` URL used by the nightly archiver daemon to shrink
 * large raw images down to lightweight AVIFs before writing to Cold HDD.
 *
 * Example: `/unsafe/rs:fit:1600:1600:0/q:72/plain/media/photos/banner.jpg@avif`
 */
export function buildImgproxyColdTranscodeUrl(
  sourceUrlOrLocalPath: string,
  options?: ImgproxyColdTranscodeOptions
): string {
  const format = options?.format ?? DEFAULT_COLD_COMPRESSION_FORMAT;
  const quality = options?.quality ?? DEFAULT_COLD_QUALITY;
  const maxDimension = options?.maxDimension ?? 1600;

  const cleanSource = sourceUrlOrLocalPath.replace(/^\/+/, '');
  const pathPart = `/unsafe/rs:fit:${maxDimension}:${maxDimension}:0/q:${quality}/plain/${cleanSource}@${format}`;

  if (options?.imgproxyBaseUrl) {
    const trimmedBase = options.imgproxyBaseUrl.replace(/\/+$/, '');
    return `${trimmedBase}${pathPart}`;
  }

  return pathPart;
}

export interface WaterfallConfig {
  r2PublicBaseUrl: string;
  ssdBaseUrl: string;
  hddBaseUrl: string;
  cdnProxyBaseUrl?: string;
}

export type WaterfallAssetUrls = [string, string, string] & {
  r2Url: string;
  ssdUrl: string;
  hddUrl: string;
  primaryUrl: string;
  cdnProxyUrl?: string;
};

/**
 * Returns the deterministic 3-tier fallback chain `[r2Url, ssdUrl, hddUrl]` so
 * Caddy / imgproxy / client can resolve any asset across `R2 -> SSD -> HDD` without
 * altering its database `objectKey`.
 */
export function resolveWaterfallAssetUrls(
  objectKey: string,
  config: WaterfallConfig
): WaterfallAssetUrls {
  const cleanKey = objectKey.replace(/^\/+/, '');

  const cleanBase = (base: string) => base.replace(/\/+$/, '');
  const r2Url = `${cleanBase(config.r2PublicBaseUrl)}/${cleanKey}`;
  const ssdUrl = `${cleanBase(config.ssdBaseUrl)}/${cleanKey}`;
  const hddUrl = `${cleanBase(config.hddBaseUrl)}/${cleanKey}`;

  const tuple = [r2Url, ssdUrl, hddUrl] as unknown as WaterfallAssetUrls;
  tuple.r2Url = r2Url;
  tuple.ssdUrl = ssdUrl;
  tuple.hddUrl = hddUrl;
  tuple.primaryUrl = r2Url;

  if (config.cdnProxyBaseUrl) {
    tuple.cdnProxyUrl = `${cleanBase(config.cdnProxyBaseUrl)}/${cleanKey}`;
  }

  return tuple;
}
