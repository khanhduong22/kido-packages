import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import {
  DEFAULT_COLD_COMPRESSION_FORMAT,
  DEFAULT_COLD_QUALITY,
  DEFAULT_ESTIMATED_COMPRESSION_RATIO,
  DEFAULT_HOT_TO_WARM_DAYS,
  DEFAULT_R2_HARD_CAP_BYTES_LIFECYCLE,
  DEFAULT_TIERED_LIFECYCLE_POLICY,
  DEFAULT_WARM_TO_COLD_DAYS,
  buildImgproxyColdTranscodeUrl,
  planLifecycleTransitions,
  resolveUploadTargetTier,
  resolveWaterfallAssetUrls,
  type StorageObjectMeta,
} from './index';

describe('3-Tier Zero-Cost Storage Lifecycle & Cold AVIF Archiver', () => {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const BASE_NOW = 1770000000000; // Deterministic test timestamp

  // ==========================================
  // Test 1: Defaults & Configuration
  // ==========================================
  test('DEFAULT_TIERED_LIFECYCLE_POLICY contains 8.5GiB R2 cap, 90d/365d windows, and minAccessCountToStayHot=1 (0 views to demote)', () => {
    assert.equal(DEFAULT_TIERED_LIFECYCLE_POLICY.r2HardCapBytes, DEFAULT_R2_HARD_CAP_BYTES_LIFECYCLE);
    assert.equal(DEFAULT_TIERED_LIFECYCLE_POLICY.r2HardCapBytes, Math.floor(8.5 * 1024 * 1024 * 1024));
    assert.equal(DEFAULT_TIERED_LIFECYCLE_POLICY.hotToWarmDays, 90);
    assert.equal(DEFAULT_TIERED_LIFECYCLE_POLICY.warmToColdDays, 365);
    assert.equal(DEFAULT_TIERED_LIFECYCLE_POLICY.minAccessCountToStayHot, 1);
    assert.equal(DEFAULT_TIERED_LIFECYCLE_POLICY.coldCompressionFormat, 'avif');
    assert.equal(DEFAULT_TIERED_LIFECYCLE_POLICY.coldQuality, 72);
    assert.equal(DEFAULT_TIERED_LIFECYCLE_POLICY.estimatedCompressionRatio, 0.22);
  });

  // ==========================================
  // Test 2: Placement Router on Upload (resolveUploadTargetTier)
  // ==========================================
  test('resolveUploadTargetTier routes to r2_hot when within R2 free-tier budget', () => {
    const incomingBytes = 2 * 1024 * 1024; // 2 MiB file
    const currentR2Bytes = 4 * 1024 * 1024 * 1024; // 4 GiB used

    // Positional signature
    const result = resolveUploadTargetTier(incomingBytes, currentR2Bytes);
    assert.equal(result.targetTier, 'r2_hot');
    assert.equal(result.tier, 'r2_hot');
    assert.equal(result.allowedInR2, true);
    assert.match(result.reason, /routed to r2_hot/);

    // Options object signature
    const optionsResult = resolveUploadTargetTier({
      incomingFileBytes: incomingBytes,
      r2CurrentUsedBytes: currentR2Bytes,
    });
    assert.equal(optionsResult.targetTier, 'r2_hot');
    assert.equal(optionsResult.allowedInR2, true);
  });

  test('resolveUploadTargetTier trips circuit breaker and falls back to ssd_warm when > 8.5 GiB', () => {
    const incomingBytes = 100 * 1024 * 1024; // 100 MiB
    const currentR2Bytes = Math.floor(8.45 * 1024 * 1024 * 1024); // 8.45 GiB + 100MB > 8.5 GiB

    const result = resolveUploadTargetTier(incomingBytes, currentR2Bytes);
    assert.equal(result.targetTier, 'ssd_warm');
    assert.equal(result.allowedInR2, false);
    assert.match(result.reason, /circuit breaker tripped/i);
    assert.match(result.reason, /fallback to ssd_warm/i);
  });

  test('resolveUploadTargetTier respects custom policy r2HardCapBytes', () => {
    const customCap = 500 * 1024 * 1024; // 500 MiB cap
    const incomingBytes = 50 * 1024 * 1024;
    const currentR2Bytes = 480 * 1024 * 1024; // 480MB + 50MB = 530MB > 500MB

    const result = resolveUploadTargetTier(incomingBytes, currentR2Bytes, {
      r2HardCapBytes: customCap,
    });
    assert.equal(result.targetTier, 'ssd_warm');
    assert.equal(result.allowedInR2, false);
  });

  // ==========================================
  // Test 3: Lifecycle Transition Planner (planLifecycleTransitions)
  // ==========================================
  test('planLifecycleTransitions demotes r2_hot objects only when idle >= 90 days AND accessCount30d === 0', () => {
    const testObjects: StorageObjectMeta[] = [
      {
        key: 'avatars/recent-active.jpg',
        sizeBytes: 1 * 1024 * 1024,
        mimeType: 'image/jpeg',
        createdAtMs: BASE_NOW - 10 * MS_PER_DAY, // 10 days old (hot)
        accessCount30d: 12,
        currentTier: 'r2_hot',
      },
      {
        key: 'blog/old-niche-product.jpg',
        sizeBytes: 2 * 1024 * 1024,
        mimeType: 'image/jpeg',
        createdAtMs: BASE_NOW - 120 * MS_PER_DAY, // 120 days old, but had 1 view (>= 1 stays hot!)
        accessCount30d: 1,
        currentTier: 'r2_hot',
      },
      {
        key: 'invoices/old-inactive-receipt.png',
        sizeBytes: 4 * 1024 * 1024,
        mimeType: 'image/png',
        createdAtMs: BASE_NOW - 95 * MS_PER_DAY, // 95 days old (>= 90d), 0 views -> DEMOTE to ssd_warm
        accessCount30d: 0,
        currentTier: 'r2_hot',
      },
    ];

    const plan = planLifecycleTransitions(testObjects, { nowMs: BASE_NOW });

    assert.equal(plan.demotionsToWarm.length, 1);
    const demotion = plan.demotionsToWarm[0];
    assert.equal(demotion.key, 'invoices/old-inactive-receipt.png');
    assert.equal(demotion.fromTier, 'r2_hot');
    assert.equal(demotion.toTier, 'ssd_warm');
    assert.equal(demotion.reason, 'age_and_inactivity');
    assert.equal(demotion.originalSizeBytes, 4 * 1024 * 1024);
    assert.equal(plan.bytesReclaimedFromR2, 4 * 1024 * 1024);
  });

  test('planLifecycleTransitions evicts coldest objects when R2 watermark is breached', () => {
    const capBytes = 10 * 1024 * 1024; // 10 MiB cap
    const testObjects: StorageObjectMeta[] = [
      {
        key: 'assets/file-a.jpg',
        sizeBytes: 4 * 1024 * 1024,
        mimeType: 'image/jpeg',
        createdAtMs: BASE_NOW - 5 * MS_PER_DAY,
        accessCount30d: 200, // Very hot
        currentTier: 'r2_hot',
      },
      {
        key: 'assets/file-b.jpg',
        sizeBytes: 4 * 1024 * 1024,
        mimeType: 'image/jpeg',
        createdAtMs: BASE_NOW - 8 * MS_PER_DAY,
        accessCount30d: 60, // Active (> 50), but colder than A
        currentTier: 'r2_hot',
      },
      {
        key: 'assets/file-c.jpg',
        sizeBytes: 4 * 1024 * 1024,
        mimeType: 'image/jpeg',
        createdAtMs: BASE_NOW - 6 * MS_PER_DAY,
        accessCount30d: 70, // Active (> 50)
        currentTier: 'r2_hot',
      },
    ];
    // Total hot bytes = 12 MiB > 10 MiB cap. File B is coldest (accessCount: 60), should be evicted!

    const plan = planLifecycleTransitions(testObjects, {
      nowMs: BASE_NOW,
      policy: { r2HardCapBytes: capBytes },
    });

    assert.equal(plan.demotionsToWarm.length, 1);
    assert.equal(plan.demotionsToWarm[0].key, 'assets/file-b.jpg');
    assert.equal(plan.demotionsToWarm[0].reason, 'r2_capacity_watermark_breach');
    assert.equal(plan.bytesReclaimedFromR2, 4 * 1024 * 1024);
    assert.equal(plan.r2UsageAfterBytes, 8 * 1024 * 1024); // 12MB - 4MB = 8MB <= 10MB
  });

  test('planLifecycleTransitions archives warm SSD objects idle >= 365 days to cold HDD with AVIF transcode', () => {
    const testObjects: StorageObjectMeta[] = [
      {
        key: 'vault/recent-warm.jpg',
        sizeBytes: 3 * 1024 * 1024,
        mimeType: 'image/jpeg',
        createdAtMs: BASE_NOW - 180 * MS_PER_DAY, // 180 days old (< 365d, stays warm)
        currentTier: 'ssd_warm',
      },
      {
        key: 'archive/annual-report-scan.jpg',
        sizeBytes: 10 * 1024 * 1024, // 10 MiB original JPEG
        mimeType: 'image/jpeg',
        createdAtMs: BASE_NOW - 400 * MS_PER_DAY, // 400 days old (>= 365d, 0 views, archives to cold)
        currentTier: 'ssd_warm',
      },
    ];

    const plan = planLifecycleTransitions(testObjects, {
      nowMs: BASE_NOW,
      imgproxyBaseUrl: 'https://imgproxy.internal',
    });

    assert.equal(plan.archivesToCold.length, 1);
    const archive = plan.archivesToCold[0];
    assert.equal(archive.key, 'archive/annual-report-scan.jpg');
    assert.equal(archive.fromTier, 'ssd_warm');
    assert.equal(archive.toTier, 'hdd_cold');
    assert.equal(archive.reason, 'warm_retention_expired');
    assert.equal(archive.originalSizeBytes, 10 * 1024 * 1024);

    // 0.22 compression ratio -> 2.2 MiB AVIF (~78% savings)
    const expectedCompressedBytes = Math.round(10 * 1024 * 1024 * 0.22);
    assert.equal(archive.estimatedCompressedSizeBytes, expectedCompressedBytes);
    assert.equal(plan.bytesReclaimedFromSsd, 10 * 1024 * 1024);
    assert.equal(plan.estimatedHddBytesAdded, expectedCompressedBytes);
    assert.equal(plan.netStorageSavingsBytes, 10 * 1024 * 1024 - expectedCompressedBytes);

    assert.equal(
      archive.imgproxyTranscodeUrl,
      'https://imgproxy.internal/unsafe/rs:fit:1600:1600:0/q:72/plain/archive/annual-report-scan.jpg@avif'
    );
    assert.equal(archive.sourcePath, '/media/hot/archive/annual-report-scan.jpg');
    assert.equal(archive.targetPath, '/media/cold/archive/annual-report-scan.jpg');
  });

  test('planLifecycleTransitions uses LRU (lastAccessedAtMs) + LFU (accessCount30d === 0) to keep evergreen best-seller photos warm and supports webp cold compression', () => {
    const testObjects: StorageObjectMeta[] = [
      {
        key: 'catalog/evergreen-bestseller-brush.jpg',
        sizeBytes: 5 * 1024 * 1024,
        mimeType: 'image/jpeg',
        createdAtMs: BASE_NOW - 500 * MS_PER_DAY, // Uploaded 500 days ago!
        lastAccessedAtMs: BASE_NOW - 2 * MS_PER_DAY, // Viewed 2 days ago (LRU idle = 2d < 365d)
        accessCount30d: 1,
        currentTier: 'ssd_warm',
      },
      {
        key: 'catalog/abandoned-2025-promo.jpg',
        sizeBytes: 5 * 1024 * 1024,
        mimeType: 'image/jpeg',
        createdAtMs: BASE_NOW - 500 * MS_PER_DAY, // Uploaded 500 days ago
        lastAccessedAtMs: BASE_NOW - 380 * MS_PER_DAY, // Last viewed 380 days ago (LRU idle = 380d >= 365d)
        accessCount30d: 0,
        currentTier: 'ssd_warm',
      },
    ];

    const plan = planLifecycleTransitions(testObjects, {
      nowMs: BASE_NOW,
      imgproxyBaseUrl: 'https://imgproxy.internal',
      policy: {
        coldCompressionFormat: 'webp',
        coldQuality: 78,
      },
    });

    // Evergreen best-seller must STAY in ssd_warm; only abandoned promo is archived to hdd_cold
    assert.equal(plan.archivesToCold.length, 1);
    assert.equal(plan.archivesToCold[0].key, 'catalog/abandoned-2025-promo.jpg');
    assert.equal(
      plan.archivesToCold[0].imgproxyTranscodeUrl,
      'https://imgproxy.internal/unsafe/rs:fit:1600:1600:0/q:78/plain/catalog/abandoned-2025-promo.jpg@webp'
    );
  });

  // ==========================================
  // Test 4: Imgproxy Cold Compression URL Builder
  // ==========================================
  test('buildImgproxyColdTranscodeUrl builds canonical unsafe transcode URL with defaults', () => {
    const url = buildImgproxyColdTranscodeUrl('media/products/shoes-01.jpg');
    assert.equal(url, '/unsafe/rs:fit:1600:1600:0/q:72/plain/media/products/shoes-01.jpg@avif');
  });

  test('buildImgproxyColdTranscodeUrl handles custom quality, format, dimensions, and baseUrl', () => {
    const url = buildImgproxyColdTranscodeUrl('/uploads/banners/hero.png', {
      format: 'webp',
      quality: 85,
      maxDimension: 2048,
      imgproxyBaseUrl: 'https://images.example.com/',
    });
    assert.equal(
      url,
      'https://images.example.com/unsafe/rs:fit:2048:2048:0/q:85/plain/uploads/banners/hero.png@webp'
    );
  });

  // ==========================================
  // Test 5: Waterfall URL Builder (resolveWaterfallAssetUrls)
  // ==========================================
  test('resolveWaterfallAssetUrls generates deterministic 3-tier fallback chain', () => {
    const config = {
      r2PublicBaseUrl: 'https://r2.cdn.example.com/',
      ssdBaseUrl: 'https://garage.internal/media/',
      hddBaseUrl: 'https://cold.internal/archive/',
      cdnProxyBaseUrl: 'https://media.khanhdp.com',
    };

    const waterfall = resolveWaterfallAssetUrls('catalog/product-42.jpg', config);

    // Array destructuring
    const [r2, ssd, hdd] = waterfall;
    assert.equal(r2, 'https://r2.cdn.example.com/catalog/product-42.jpg');
    assert.equal(ssd, 'https://garage.internal/media/catalog/product-42.jpg');
    assert.equal(hdd, 'https://cold.internal/archive/catalog/product-42.jpg');

    // Named property access
    assert.equal(waterfall.r2Url, 'https://r2.cdn.example.com/catalog/product-42.jpg');
    assert.equal(waterfall.ssdUrl, 'https://garage.internal/media/catalog/product-42.jpg');
    assert.equal(waterfall.hddUrl, 'https://cold.internal/archive/catalog/product-42.jpg');
    assert.equal(waterfall.primaryUrl, 'https://r2.cdn.example.com/catalog/product-42.jpg');
    assert.equal(waterfall.cdnProxyUrl, 'https://media.khanhdp.com/catalog/product-42.jpg');
  });
});
