import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import {
  ASPECT_RATIO_PRESETS,
  checkAspectRatio,
  CloudinaryAdapter,
  DEFAULT_ALLOWED_MIME_TYPES,
  formatBytes,
  generateCloudinarySignature,
  generatePresignedPutUrl,
  ImageMetadataSchema,
  LocalMockStorageAdapter,
  MAX_FILE_SIZE_10MB,
  MAX_FILE_SIZE_5MB,
  S3R2Adapter,
  transformCloudinaryUrl,
  uploadClientWithPresignedUrl,
  UploadOptionsSchema,
  UploadResultSchema,
  validateFileSize,
  validateFileType,
  validateImage,
  evaluateStorageBudgetGuard,
  checkCloudflareR2Budget,
  validateGarageS3Credentials,
  generateGarageS3Credentials,
  DEFAULT_R2_HARD_CAP_BYTES,
} from './index';

describe('@kido/storage-uploader Test Suite', () => {
  // ==========================================
  // Test 1: Client Image Processing - File Type
  // ==========================================
  test('validateFileType accepts valid image formats and rejects unsupported types', () => {
    // Valid types
    assert.equal(validateFileType('image/jpeg').valid, true);
    assert.equal(validateFileType('image/png').valid, true);
    assert.equal(validateFileType('image/webp').valid, true);
    assert.equal(validateFileType('IMAGE/JPEG').valid, true); // Case insensitive

    // Invalid types with default settings
    const gifResult = validateFileType('image/gif');
    assert.equal(gifResult.valid, false);
    assert.match(gifResult.error || '', /Invalid file type/);

    const pdfResult = validateFileType('application/pdf');
    assert.equal(pdfResult.valid, false);

    // Custom allowed list
    const customResult = validateFileType('image/svg+xml', ['image/svg+xml']);
    assert.equal(customResult.valid, true);
  });

  // ==========================================
  // Test 2: Client Image Processing - File Size Guard
  // ==========================================
  test('validateFileSize guards max 5MB and 10MB limits correctly', () => {
    // Under 5MB
    const fourMb = 4 * 1024 * 1024;
    const res5mb = validateFileSize(fourMb, MAX_FILE_SIZE_5MB);
    assert.equal(res5mb.valid, true);

    // Exactly 5MB
    assert.equal(validateFileSize(MAX_FILE_SIZE_5MB, MAX_FILE_SIZE_5MB).valid, true);

    // Over 5MB fails default guard
    const sixMb = 6 * 1024 * 1024;
    const over5mb = validateFileSize(sixMb, MAX_FILE_SIZE_5MB);
    assert.equal(over5mb.valid, false);
    assert.match(over5mb.error || '', /exceeds maximum limit/);

    // 6MB passes 10MB guard
    const pass10mb = validateFileSize(sixMb, MAX_FILE_SIZE_10MB);
    assert.equal(pass10mb.valid, true);

    // Zero or negative size
    assert.equal(validateFileSize(0).valid, false);
    assert.equal(validateFileSize(-100).valid, false);

    // formatBytes helper
    assert.equal(formatBytes(1024), '1 KB');
    assert.equal(formatBytes(MAX_FILE_SIZE_5MB), '5 MB');
    assert.equal(formatBytes(MAX_FILE_SIZE_10MB), '10 MB');
  });

  // ==========================================
  // Test 3: Client Image Processing - Aspect Ratio Checker
  // ==========================================
  test('checkAspectRatio accurately evaluates 1:1, 4:3, and 16:9 ratios with tolerance', () => {
    // 1:1 Square (e.g. 500x500, 800x800)
    const squareResult = checkAspectRatio(800, 800, '1:1');
    assert.equal(squareResult.matches, true);
    assert.equal(squareResult.actualRatio, 1.0);
    assert.equal(squareResult.label, '1:1');

    // 4:3 Standard (e.g. 1024x768 -> 1.3333)
    const ratio43Result = checkAspectRatio(1024, 768, '4:3');
    assert.equal(ratio43Result.matches, true);
    assert.equal(ratio43Result.label, '4:3');

    // 16:9 Widescreen (e.g. 1920x1080 -> 1.7777)
    const ratio169Result = checkAspectRatio(1920, 1080, '16:9');
    assert.equal(ratio169Result.matches, true);
    assert.equal(ratio169Result.label, '16:9');

    // Mismatched ratio
    const mismatch = checkAspectRatio(1920, 1080, '1:1');
    assert.equal(mismatch.matches, false);

    // Numeric ratio with tolerance
    const numericCheck = checkAspectRatio(1610, 1000, 1.6, 0.02); // 1.61 vs 1.6 within 2%
    assert.equal(numericCheck.matches, true);
  });

  // ==========================================
  // Test 4: Unified Image Validation
  // ==========================================
  test('validateImage orchestrates type, size, and aspect ratio checks', () => {
    // Valid case
    const valid = validateImage(
      {
        size: 2 * 1024 * 1024,
        mimeType: 'image/webp',
        width: 1200,
        height: 1200,
        name: 'avatar.webp',
      },
      {
        maxSizeBytes: MAX_FILE_SIZE_5MB,
        targetAspectRatio: '1:1',
      }
    );

    assert.equal(valid.valid, true);
    assert.equal(valid.errors.length, 0);
    assert.ok(valid.metadata);
    assert.equal(valid.metadata?.format, 'webp');
    assert.equal(valid.metadata?.aspectRatio, 1.0);

    // Multiple failures case (oversized + invalid type + wrong ratio)
    const invalid = validateImage(
      {
        size: 12 * 1024 * 1024, // 12MB > 5MB
        mimeType: 'application/pdf',
        width: 1920,
        height: 1080,
      },
      {
        maxSizeBytes: MAX_FILE_SIZE_5MB,
        targetAspectRatio: '1:1',
      }
    );

    assert.equal(invalid.valid, false);
    assert.equal(invalid.errors.length, 3);
  });

  // ==========================================
  // Test 5: Cloudinary Adapter - Signature & Transformation
  // ==========================================
  test('CloudinaryAdapter generates valid SHA-1 signature and transforms URLs', () => {
    const apiSecret = 'test_secret_12345';
    const params = {
      folder: 'avatars',
      timestamp: 1700000000,
      public_id: 'user_99',
    };

    // Signature must be deterministic SHA-1 of 'folder=avatars&public_id=user_99&timestamp=1700000000test_secret_12345'
    const sig = generateCloudinarySignature(params, apiSecret);
    assert.ok(typeof sig === 'string');
    assert.equal(sig.length, 40); // 40 hex chars for SHA-1

    // Excluded params should not affect signature
    const sigWithIgnored = generateCloudinarySignature(
      { ...params, file: 'blob_data', api_key: 'ignored_key', cloud_name: 'test_cloud' },
      apiSecret
    );
    assert.equal(sigWithIgnored, sig);

    // URL Transformation: resize, quality auto, format webp
    const transformed = transformCloudinaryUrl(
      'profile-pic',
      {
        width: 800,
        height: 600,
        crop: 'fill',
        quality: 'auto',
        format: 'webp',
      },
      'kt-cloud'
    );

    assert.equal(
      transformed,
      'https://res.cloudinary.com/kt-cloud/image/upload/c_fill,w_800,h_600,q_auto,f_webp/profile-pic'
    );

    // Existing full Cloudinary URL transformation injection
    const fullUrl = 'https://res.cloudinary.com/kt-cloud/image/upload/v1234/sample.jpg';
    const injected = transformCloudinaryUrl(fullUrl, {
      width: 400,
      height: 400,
      crop: 'thumb',
      gravity: 'face',
      quality: 'auto',
      format: 'webp',
    });

    assert.equal(
      injected,
      'https://res.cloudinary.com/kt-cloud/image/upload/c_thumb,w_400,h_400,g_face,q_auto,f_webp/v1234/sample.jpg'
    );
  });

  // ==========================================
  // Test 6: Cloudinary Adapter - Direct Upload with Mocked Fetch
  // ==========================================
  test('CloudinaryAdapter performs upload and parses result with Zod schema', async () => {
    let capturedUrl = '';
    let capturedMethod = '';

    const mockFetch: typeof fetch = async (input, init) => {
      capturedUrl = input.toString();
      capturedMethod = init?.method || 'GET';

      const mockResponse = {
        public_id: 'portfolio/banner-1',
        url: 'http://res.cloudinary.com/kt-cloud/image/upload/v1/portfolio/banner-1.webp',
        secure_url: 'https://res.cloudinary.com/kt-cloud/image/upload/v1/portfolio/banner-1.webp',
        bytes: 145020,
        format: 'webp',
        width: 1920,
        height: 1080,
        created_at: new Date().toISOString(),
        resource_type: 'image',
        etag: 'mock-etag-abc',
      };

      return new Response(JSON.stringify(mockResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const adapter = new CloudinaryAdapter({
      config: {
        cloudName: 'kt-cloud',
        apiKey: '1234567890',
        apiSecret: 'secret_key_mock',
        folder: 'portfolio',
      },
      fetchFn: mockFetch,
    });

    const result = await adapter.upload('mock-binary-data', {
      fileName: 'banner-1',
      tags: ['hero', 'homepage'],
    });

    assert.equal(capturedUrl, 'https://api.cloudinary.com/v1_1/kt-cloud/image/upload');
    assert.equal(capturedMethod, 'POST');
    assert.equal(result.provider, 'cloudinary');
    assert.equal(result.key, 'portfolio/banner-1');
    assert.equal(result.bytes, 145020);
    assert.equal(result.format, 'webp');
    assert.equal(result.width, 1920);
    assert.equal(result.height, 1080);
  });

  // ==========================================
  // Test 7: S3 / Cloudflare R2 - Presigned PUT URL & SigV4
  // ==========================================
  test('S3R2Adapter generates valid AWS SigV4 presigned PUT URL and executes client upload', async () => {
    const config = {
      bucket: 'kt-assets',
      endpoint: 'https://acc123.r2.cloudflarestorage.com',
      region: 'auto',
      accessKeyId: 'AKIA_MOCK_KEY',
      secretAccessKey: 'mock_secret_access_key_98765',
      publicUrlBase: 'https://cdn.kt-portfolio.vn',
    };

    const fixedDate = new Date('2026-09-30T12:00:00Z');
    const presigned = generatePresignedPutUrl(config, 'uploads/hero.png', {
      expiresInSeconds: 1800,
      contentType: 'image/png',
      date: fixedDate,
    });

    assert.equal(presigned.method, 'PUT');
    assert.equal(presigned.headers['Content-Type'], 'image/png');
    assert.equal(presigned.key, 'uploads/hero.png');

    const parsedUrl = new URL(presigned.url);
    assert.equal(parsedUrl.origin, 'https://acc123.r2.cloudflarestorage.com');
    assert.equal(parsedUrl.pathname, '/kt-assets/uploads/hero.png');

    // SigV4 Query parameters verification
    assert.equal(parsedUrl.searchParams.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
    assert.equal(
      parsedUrl.searchParams.get('X-Amz-Credential'),
      'AKIA_MOCK_KEY/20260930/auto/s3/aws4_request'
    );
    assert.equal(parsedUrl.searchParams.get('X-Amz-Date'), '20260930T120000Z');
    assert.equal(parsedUrl.searchParams.get('X-Amz-Expires'), '1800');
    assert.equal(parsedUrl.searchParams.get('X-Amz-SignedHeaders'), 'host');
    assert.ok(parsedUrl.searchParams.get('X-Amz-Signature')!.length > 0);

    // Mock Client Upload execution
    let putCalled = false;
    let putBodyLength = 0;
    const mockPutFetch: typeof fetch = async (input, init) => {
      putCalled = true;
      assert.equal(init?.method, 'PUT');
      assert.equal((init?.headers as any)['Content-Type'], 'image/png');
      putBodyLength = Buffer.byteLength(init?.body as any);
      return new Response('', { status: 200 });
    };

    await uploadClientWithPresignedUrl(presigned.url, 'fake-image-bytes', {
      contentType: 'image/png',
      fetchFn: mockPutFetch,
    });
    assert.equal(putCalled, true);
    assert.equal(putBodyLength, 'fake-image-bytes'.length);

    // S3R2Adapter class integration
    const adapter = new S3R2Adapter({
      config,
      fetchFn: mockPutFetch,
    });
    assert.equal(adapter.provider, 'r2');
    assert.equal(
      adapter.getPublicUrl('uploads/hero.png'),
      'https://cdn.kt-portfolio.vn/uploads/hero.png'
    );
  });

  // ==========================================
  // Test 8: Local Mock Storage Adapter
  // ==========================================
  test('LocalMockStorageAdapter stores files in memory, provides URLs, and manages lifecycle', async () => {
    const mockStorage = new LocalMockStorageAdapter({
      baseUrl: 'http://localhost:4000/static',
    });

    assert.equal(mockStorage.provider, 'local-mock');
    assert.equal(mockStorage.size, 0);

    // Upload
    const result = await mockStorage.upload('sample-file-content', {
      fileName: 'test-doc.txt',
      folder: 'temp',
      contentType: 'text/plain',
      metadata: { author: 'Kido' },
    });

    assert.equal(result.provider, 'local-mock');
    assert.equal(result.key, 'temp/test-doc.txt');
    assert.equal(result.url, 'http://localhost:4000/static/temp/test-doc.txt');
    assert.equal(result.bytes, 'sample-file-content'.length);
    assert.equal(mockStorage.size, 1);
    assert.equal(mockStorage.has('temp/test-doc.txt'), true);

    // Retrieve
    const item = mockStorage.getItem('temp/test-doc.txt');
    assert.ok(item);
    assert.equal(item?.data, 'sample-file-content');
    assert.equal(item?.metadata?.author, 'Kido');

    // Transformation URL formatting
    const transformedUrl = mockStorage.getPublicUrl('temp/test-doc.txt', {
      width: 400,
      height: 300,
      quality: 80,
      format: 'webp',
    });
    assert.ok(transformedUrl.includes('w=400'));
    assert.ok(transformedUrl.includes('f=webp'));

    // Deletion & Clear
    await mockStorage.delete('temp/test-doc.txt');
    assert.equal(mockStorage.size, 0);
    assert.equal(mockStorage.has('temp/test-doc.txt'), false);
  });

  // ==========================================
  // Test 9: Type-Safe Zod Schemas Validation
  // ==========================================
  test('Zod schemas enforce strict validation and reject invalid data', () => {
    // Valid UploadResult
    const validResult = {
      url: 'https://example.com/img.webp',
      secureUrl: 'https://example.com/img.webp',
      key: 'img-123',
      provider: 'cloudinary',
      bytes: 2048,
      createdAt: new Date().toISOString(),
    };
    assert.doesNotThrow(() => UploadResultSchema.parse(validResult));

    // Invalid UploadResult (invalid URL and missing key)
    assert.throws(() => {
      UploadResultSchema.parse({
        url: 'not-a-valid-url',
        provider: 'unknown-provider',
        bytes: -10,
      });
    });

    // Valid ImageMetadata
    const validMeta = {
      width: 1920,
      height: 1080,
      size: 500000,
      mimeType: 'image/png',
    };
    assert.doesNotThrow(() => ImageMetadataSchema.parse(validMeta));

    // Valid UploadOptions
    assert.doesNotThrow(() =>
      UploadOptionsSchema.parse({
        folder: 'products',
        tags: ['sale', 'summer'],
        accessMode: 'public',
      })
    );
  });

  // ==========================================
  // Test 10: R2 $0 Budget Circuit Breaker & GarageHQ S3 Key Guard
  // ==========================================
  test('evaluateStorageBudgetGuard and checkCloudflareR2Budget enforce hard storage caps', async () => {
    const fiftyMb = 50 * 1024 * 1024;
    const cap1Gb = DEFAULT_R2_HARD_CAP_BYTES;

    // 1. Safe usage under cap
    const okEval = evaluateStorageBudgetGuard(
      { payloadSize: fiftyMb, metadataSize: 1024 },
      10 * 1024 * 1024,
      cap1Gb
    );
    assert.equal(okEval.allowed, true);
    assert.equal(okEval.currentUsedBytes, fiftyMb + 1024);

    // 2. Batch pushes total over 1 GiB cap -> Circuit breaker trips
    const batchOverflow = evaluateStorageBudgetGuard(
      { payloadSize: cap1Gb - 5 * 1024 * 1024, metadataSize: 0 },
      10 * 1024 * 1024,
      cap1Gb
    );
    assert.equal(batchOverflow.allowed, false);
    assert.match(batchOverflow.reason || '', /HARD \$0 BUDGET CIRCUIT BREAKER/);

    // 3. Mocked Cloudflare REST API check
    const mockFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          success: true,
          result: { payloadSize: 100 * 1024 * 1024, metadataSize: 2048, objectCount: 51 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );

    const apiEval = await checkCloudflareR2Budget({
      accountId: 'acc_test',
      bucketName: 'media-bucket',
      apiToken: 'tok_test',
      incomingBatchBytes: 5 * 1024 * 1024,
      fetchFn: mockFetch,
    });
    assert.equal(apiEval.allowed, true);
    assert.equal(apiEval.currentUsedBytes, 100 * 1024 * 1024 + 2048);
  });

  test('validateGarageS3Credentials enforces GK+24hex access key and 64-hex (32-byte) secret key', () => {
    // Generated deterministic keypair should pass
    const generated = generateGarageS3Credentials('test-seed-2026');
    const validCheck = validateGarageS3Credentials(generated.accessKeyId, generated.secretAccessKey);
    assert.equal(validCheck.valid, true);
    assert.equal(validCheck.errors.length, 0);

    // Non-hex or wrong-length secret key fails (the exact GarageHQ trap)
    const badSecret = validateGarageS3Credentials(
      generated.accessKeyId,
      'arbitrary_ascii_secret_not_64_hex_chars'
    );
    assert.equal(badSecret.valid, false);
    assert.equal(badSecret.secretKeyValid, false);
    assert.match(badSecret.errors[0] || '', /64-character hexadecimal/);
  });
});
