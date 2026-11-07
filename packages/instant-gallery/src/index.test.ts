import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  TokenManager,
  generateGuestQrToken,
  RateLimiter,
  validateVietnamPhone,
  LeadGatekeeper,
  captureLead,
  StorageSigner,
  generateDownloadUrl,
  UnauthorizedTierError,
  WatermarkEngine,
  generateOverlaySvgTemplate,
  generateSocialSharePayload,
  generateOpenGraphMetaTags,
  MediaItem,
  EventGallery,
  GuestAccessPass,
} from './index';

describe('@kido/instant-gallery Test Suite', () => {
  const sampleEvent: EventGallery = {
    id: 'evt_vinfast_gala_2026',
    name: 'VinFast VF9 VIP Gala Launch',
    brand: 'T_RED_MEDIA',
    startDate: '2026-10-10T18:00:00Z',
    endDate: '2026-10-10T23:30:00Z',
    isActive: true,
    allowGuestUpload: false,
    requireLeadCapture: true,
    shortUrlPrefix: 'https://tr.vn/g',
    sponsorBanners: [
      {
        id: 'sp_vinfast',
        name: 'VinFast Auto',
        logoUrl: 'https://cdn.tred.vn/sponsors/vinfast.png',
        targetUrl: 'https://vinfastauto.com',
        callToAction: 'Lái thử VF9 nhận quà',
        displayPlacement: 'HEADER',
      },
    ],
    defaultWatermark: {
      text: 'VinFast Gala 2026 • T-RED Glambot',
      opacity: 0.35,
      position: 'CENTER',
      eventHashtag: '#VinFastGala2026',
      safeZoneMarginPx: 64,
    },
  };

  const sampleVideoItem: MediaItem = {
    id: 'media_glambot_001',
    eventId: sampleEvent.id,
    type: 'VIDEO_240FPS',
    title: 'Glambot 360 High-Speed Shot',
    aspectRatio: '9:16',
    previewUrl: 'https://r2.tred.vn/previews/media_glambot_001.webp',
    originalUrl: 'https://r2.tred.vn/raw/media_glambot_001_4k.mp4',
    thumbnailUrl: 'https://r2.tred.vn/thumbs/media_glambot_001.jpg',
    durationSeconds: 15,
    fileSizeBytes: 120_000_000, // 120 MB 4K
    resolution: { width: 2160, height: 3840 },
    fps: 240,
    capturedAt: new Date().toISOString(),
    assignedTable: 'VIP_01',
    downloadCount: 0,
  };

  const samplePhotoItem: MediaItem = {
    id: 'media_photo_002',
    eventId: sampleEvent.id,
    type: 'PHOTO',
    title: 'Photobooth Studio Portrait 24MP',
    aspectRatio: '3:4',
    previewUrl: 'https://r2.tred.vn/previews/media_photo_002.webp',
    originalUrl: 'https://r2.tred.vn/raw/media_photo_002_raw.jpg',
    thumbnailUrl: 'https://r2.tred.vn/thumbs/media_photo_002.jpg',
    fileSizeBytes: 24_000_000, // 24 MB
    resolution: { width: 4000, height: 6000 },
    capturedAt: new Date().toISOString(),
    assignedGuestId: 'guest_vip_007',
    downloadCount: 0,
  };

  // Test 1: Generate Short QR Guest Pass
  it('1. should generate a cryptographic short QR guest access pass for K80 printing', () => {
    const pass = generateGuestQrToken(sampleEvent.id, 'guest_101', 'Table_08');

    assert.ok(pass.tokenId.startsWith('pass_'));
    assert.ok(pass.shortCode.startsWith('v7_'));
    assert.strictEqual(pass.eventId, sampleEvent.id);
    assert.strictEqual(pass.guestId, 'guest_101');
    assert.strictEqual(pass.tableNumber, 'Table_08');
    assert.strictEqual(pass.accessTier, 'PREVIEW_LOCKED');
    assert.strictEqual(pass.leadCaptured, false);
    assert.ok(pass.fullShortUrl.startsWith('https://tr.vn/g/v7_'));
    assert.ok(pass.qrPayload.includes('src=k80_print'));
    assert.ok(pass.qrPayload.includes('sig='));
  });

  // Test 2: Token verification & expiration
  it('2. should verify valid token and reject expired token', () => {
    const manager = new TokenManager({ secretKey: 'test-secret' });
    const pass = manager.createGuestPass({
      eventId: sampleEvent.id,
      guestId: 'guest_102',
      ttlSeconds: 3600, // 1 hour
    });

    const verifyResult = manager.verifyPass(pass);
    assert.strictEqual(verifyResult.isValid, true);
    assert.strictEqual(verifyResult.pass?.tokenId, pass.tokenId);

    // Test expired pass
    const expiredPass: GuestAccessPass = {
      ...pass,
      expiresAt: new Date(Date.now() - 5000).toISOString(),
    };

    const expiredResult = manager.verifyPass(expiredPass);
    assert.strictEqual(expiredResult.isValid, false);
    assert.ok(expiredResult.error?.includes('hết hạn'));
  });

  // Test 3: Rate Limiting & brute force prevention
  it('3. should rate-limit and block repeated verification failures', () => {
    const rateLimiter = new RateLimiter(3, 10_000, 30_000);
    const clientKey = 'ip_192.168.1.50';

    const check1 = rateLimiter.check(clientKey);
    assert.strictEqual(check1.isBlocked, false);
    assert.strictEqual(check1.remainingAttempts, 3);

    // Record failures
    rateLimiter.recordFailure(clientKey);
    rateLimiter.recordFailure(clientKey);
    const fail3 = rateLimiter.recordFailure(clientKey);

    assert.strictEqual(fail3.isBlocked, true);
    assert.strictEqual(fail3.remainingAttempts, 0);
    assert.ok(fail3.retryAfterSeconds > 0);

    const checkBlocked = rateLimiter.check(clientKey);
    assert.strictEqual(checkBlocked.isBlocked, true);

    // Reset clears block
    rateLimiter.reset(clientKey);
    assert.strictEqual(rateLimiter.check(clientKey).isBlocked, false);
  });

  // Test 4: Tampering & Cryptographic Signature Check
  it('4. should detect tampered signatures on guest passes', () => {
    const manager = new TokenManager({ secretKey: 'super-secure-secret' });
    const pass = manager.createGuestPass({
      eventId: sampleEvent.id,
      guestId: 'guest_103',
    });

    const validSig = manager.generateSignature({
      eventId: pass.eventId,
      guestId: pass.guestId,
      tableNumber: pass.tableNumber,
      expiresAt: pass.expiresAt,
      shortCode: pass.shortCode,
    });

    const checkValid = manager.verifyPass(pass, { signature: validSig });
    assert.strictEqual(checkValid.isValid, true);

    // Tampered signature
    const checkTampered = manager.verifyPass(pass, { signature: 'fake_tampered_sig' });
    assert.strictEqual(checkTampered.isValid, false);
    assert.ok(checkTampered.error?.includes('không hợp lệ'));
  });

  // Test 5: Vietnam Mobile Phone Number Validation
  it('5. should validate and normalize standard Vietnamese 10-digit mobile numbers', () => {
    // Valid formats
    const v1 = validateVietnamPhone('0901234567');
    assert.strictEqual(v1.isValid, true);
    assert.strictEqual(v1.normalized, '0901234567');

    const v2 = validateVietnamPhone('+84 98 123 4567');
    assert.strictEqual(v2.isValid, true);
    assert.strictEqual(v2.normalized, '0981234567');

    const v3 = validateVietnamPhone('039.876.5432');
    assert.strictEqual(v3.isValid, true);
    assert.strictEqual(v3.normalized, '0398765432');

    const v4 = validateVietnamPhone('84771234567');
    assert.strictEqual(v4.isValid, true);
    assert.strictEqual(v4.normalized, '0771234567');

    // Invalid numbers
    assert.strictEqual(validateVietnamPhone('0123456789').isValid, false); // old 11-digit prefix or non-mobile
    assert.strictEqual(validateVietnamPhone('09012345').isValid, false); // too short
    assert.strictEqual(validateVietnamPhone('not-a-number').isValid, false);
    assert.strictEqual(validateVietnamPhone('').isValid, false);
  });

  // Test 6: Lead Form Validation with Zod
  it('6. should validate lead submission form and require marketing consent', async () => {
    const pass = generateGuestQrToken(sampleEvent.id);

    // Missing consent
    const invalidSubmission = {
      fullName: 'Nguyễn Văn A',
      phoneNumber: '0901234567',
      email: 'nguyenvana@example.com',
      company: 'T-RED Media',
      consentMarketing: false, // Must be true!
    };

    const res1 = await captureLead(pass, invalidSubmission);
    assert.strictEqual(res1.success, false);
    assert.strictEqual(res1.accessTier, 'PREVIEW_LOCKED');
    assert.ok(res1.error || res1.fieldErrors?.consentMarketing);

    // Invalid email
    const invalidEmailSubmission = {
      fullName: 'Nguyễn Văn A',
      phoneNumber: '0901234567',
      email: 'not-an-email',
      consentMarketing: true,
    };
    const res2 = await captureLead(pass, invalidEmailSubmission);
    assert.strictEqual(res2.success, false);
    assert.ok(res2.fieldErrors?.email);
  });

  // Test 7: Block 4K download when pass is PREVIEW_LOCKED
  it('7. should block 4K download request when guest has not unlocked pass', () => {
    const pass = generateGuestQrToken(sampleEvent.id);
    const signer = new StorageSigner();

    assert.strictEqual(pass.accessTier, 'PREVIEW_LOCKED');

    // Trying to explicitly request 4K download while locked must throw UnauthorizedTierError
    assert.throws(
      () => {
        signer.generateDownloadUrl(sampleVideoItem, pass, { requestedTier: 'UNLOCKED_4K' });
      },
      UnauthorizedTierError,
      'Khách chưa mở khóa quyền tải file 4K'
    );

    // Default request returns 720p watermarked preview
    const previewResult = signer.generateDownloadUrl(sampleVideoItem, pass);
    assert.strictEqual(previewResult.tier, 'PREVIEW_LOCKED');
    assert.strictEqual(previewResult.isWatermarked, true);
    assert.ok(previewResult.fileName.startsWith('preview_watermarked'));
  });

  // Test 8: Unlock 4K access after successful lead capture
  it('8. should unlock 4K download access tier after valid lead capture', async () => {
    const pass = generateGuestQrToken(sampleEvent.id, 'guest_202', 'Bàn 12');
    const gatekeeper = new LeadGatekeeper();

    let callbackCalled = false;
    const validSubmission = {
      fullName: 'Phạm Minh Khang',
      phoneNumber: '0912.345.678',
      email: 'khang.pham@vinfast.vn',
      company: 'VinFast Corporation',
      jobTitle: 'Giám Đốc Marketing',
      consentMarketing: true,
    };

    const result = await gatekeeper.processLeadCapture(pass, validSubmission, {
      clientIp: '118.69.182.10',
      userAgent: 'Mozilla/5.0 iPhone',
      unlockedMediaIds: [sampleVideoItem.id, samplePhotoItem.id],
      onLeadCaptured: () => {
        callbackCalled = true;
      },
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.accessTier, 'UNLOCKED_4K');
    assert.strictEqual(result.updatedPass.leadCaptured, true);
    assert.strictEqual(result.updatedPass.accessTier, 'UNLOCKED_4K');
    assert.strictEqual(callbackCalled, true);
    assert.strictEqual(result.leadRecord?.leadData.phoneNumber, '0912345678');
    assert.strictEqual(result.leadRecord?.leadData.company, 'VinFast Corporation');

    // Pass is now unlocked
    assert.strictEqual(gatekeeper.isUnlocked(result.updatedPass), true);
  });

  // Test 9: Generate 4K Presigned Download URL
  it('9. should generate uncompressed 4K 240fps MP4 presigned download URL for unlocked pass', () => {
    const unlockedPass: GuestAccessPass = {
      ...generateGuestQrToken(sampleEvent.id),
      accessTier: 'UNLOCKED_4K',
      leadCaptured: true,
    };

    const downloadResult = generateDownloadUrl(sampleVideoItem, unlockedPass);

    assert.strictEqual(downloadResult.tier, 'UNLOCKED_4K');
    assert.strictEqual(downloadResult.isWatermarked, false);
    assert.strictEqual(downloadResult.contentType, 'video/mp4');
    assert.ok(downloadResult.fileName.includes('Glambot_4K_240fps'));
    assert.ok(downloadResult.url.includes('tier=UNLOCKED_4K'));
    assert.ok(downloadResult.url.includes('sig='));

    // Verify signature integrity
    const signer = new StorageSigner();
    const verifyUrl = signer.verifySignedUrl(downloadResult.url);
    assert.strictEqual(verifyUrl.isValid, true);
  });

  // Test 10: Generate 24MP Photo Full-Res Download URL
  it('10. should generate full-resolution 24MP JPEG presigned download URL for photo item', () => {
    const downloadResult = generateDownloadUrl(samplePhotoItem, 'UNLOCKED_4K');

    assert.strictEqual(downloadResult.tier, 'UNLOCKED_4K');
    assert.strictEqual(downloadResult.isWatermarked, false);
    assert.strictEqual(downloadResult.contentType, 'image/jpeg');
    assert.ok(downloadResult.fileName.includes('Photobooth_24MP'));
  });

  // Test 11: Watermark & Overlay Frame Generation
  it('11. should compute 9:16 safe zones and generate branded SVG overlay frame', () => {
    const safeZones = WatermarkEngine.calculateSafeZones('9:16', { width: 1080, height: 1920 });

    assert.strictEqual(safeZones.topSafePx, 120);
    assert.strictEqual(safeZones.bottomSafePx, 220);
    assert.strictEqual(safeZones.rightSafePx, 88);
    assert.strictEqual(safeZones.leftSafePx, 48);
    assert.strictEqual(safeZones.usableWidth, 1080 - 48 - 88);

    const svgTemplate = generateOverlaySvgTemplate({
      eventName: 'VinFast VF9 VIP Gala',
      sponsorName: 'T-RED Media & fotobooth.vn',
      eventDate: '10.10.2026',
      previewMode: true,
    });

    assert.ok(svgTemplate.includes('<svg'));
    assert.ok(svgTemplate.includes('VINFAST VF9 VIP GALA'));
    assert.ok(svgTemplate.includes('PREVIEW WATERMARK'));
    assert.ok(svgTemplate.includes('SCAN QR ON K80 PRINT TO GET 4K'));
  });

  // Test 12: Viral Social Share Payload Generation
  it('12. should generate viral 9:16 story sharing payloads for TikTok, Instagram Reels and OpenGraph', () => {
    const pass = generateGuestQrToken(sampleEvent.id);
    const sharePayload = generateSocialSharePayload(sampleVideoItem, sampleEvent, pass, {
      customHashtags: ['#GlambotDaNang', '#VinFastVIP'],
    });

    assert.strictEqual(sharePayload.openGraphUrl, pass.fullShortUrl);
    assert.ok(sharePayload.hashtags.includes('#VinFastGala2026'));
    assert.ok(sharePayload.hashtags.includes('#GlambotDaNang'));
    assert.ok(sharePayload.platformTargets.FACEBOOK_STORY.shareUrl.includes('facebook.com/sharer'));
    assert.ok(sharePayload.platformTargets.ZALO.shareUrl.includes('sp.zalo.me'));
    assert.ok(sharePayload.platformTargets.TIKTOK.shareUrl.includes('tiktok.com'));

    const metaTags = generateOpenGraphMetaTags(sharePayload);
    assert.ok(metaTags.includes('<meta property="og:type" content="video.other" />'));
    assert.ok(metaTags.includes('og:video'));
    assert.ok(metaTags.includes('twitter:card'));
  });
});
