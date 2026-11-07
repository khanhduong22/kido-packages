import { test, describe, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  StirlingPdfClient,
  StirlingPdfError,
  createStirlingPdfClient,
} from './stirling-client';

describe('StirlingPdfClient Test Suite', () => {
  const originalFetch = globalThis.fetch;
  let warnLogs: string[] = [];

  const mockLogger = {
    warn: (msg: string) => {
      warnLogs.push(msg);
    },
    error: () => {},
  };

  beforeEach(() => {
    warnLogs = [];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('1. isAvailable() should return true when server responds OK', async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes('/api/v1/info/status')) {
        return new Response(JSON.stringify({ status: 'UP' }), { status: 200 });
      }
      return new Response('Not Found', { status: 404 });
    }) as typeof fetch;

    const client = createStirlingPdfClient({ baseUrl: 'http://stirling.internal:8080' });
    const available = await client.isAvailable();
    assert.equal(available, true);
  });

  test('2. isAvailable() should return false when server connection fails', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED 127.0.0.1:8080');
    }) as typeof fetch;

    const client = createStirlingPdfClient({ baseUrl: 'http://localhost:8080', timeoutMs: 100 });
    const available = await client.isAvailable();
    assert.equal(available, false);
  });

  test('3. compressPdf() should return compressed bytes on 200 OK', async () => {
    const fakeCompressedData = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55, 10, 37, 37, 69, 79, 70]); // %PDF-1.7\n%%EOF

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString();
      assert.ok(urlStr.includes('/api/v1/general/compress-pdf'));
      assert.equal(init?.method, 'POST');
      assert.ok(init?.body instanceof FormData);

      const formData = init.body as FormData;
      assert.equal(formData.get('optimizeLevel'), '2');

      return new Response(fakeCompressedData, {
        status: 200,
        headers: { 'Content-Type': 'application/pdf' },
      });
    }) as typeof fetch;

    const client = new StirlingPdfClient({ baseUrl: 'http://localhost:8080' });
    const original = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const compressed = await client.compressPdf(original, { optimizeLevel: 2 });

    assert.deepEqual(compressed, fakeCompressedData);
  });

  test('4. compressPdf() should gracefully fallback to original buffer when server is offline', async () => {
    globalThis.fetch = (async () => {
      throw new Error('Network unreachable');
    }) as typeof fetch;

    const client = new StirlingPdfClient({
      baseUrl: 'http://localhost:8080',
      logger: mockLogger,
      fallbackOnFailure: true,
    });

    const original = new Uint8Array([10, 20, 30, 40]);
    const result = await client.compressPdf(original);

    // Verify it returned original without throwing
    assert.deepEqual(result, original);
    assert.ok(warnLogs.some((l) => l.includes('Gracefully falling back')));
  });

  test('5. compressPdf() should throw StirlingPdfError when fallback is explicitly disabled', async () => {
    globalThis.fetch = (async () => {
      return new Response('Internal Server Error', { status: 500 });
    }) as typeof fetch;

    const client = new StirlingPdfClient({
      baseUrl: 'http://localhost:8080',
      fallbackOnFailure: false,
    });

    const original = new Uint8Array([1, 2, 3]);
    await assert.rejects(
      async () => {
        await client.compressPdf(original, { fallbackToOriginal: false });
      },
      (err: unknown) => {
        assert.ok(err instanceof StirlingPdfError);
        assert.equal(err.statusCode, 500);
        return true;
      }
    );
  });

  test('6. addWatermark() should apply watermark via REST API', async () => {
    const fakeWatermarkedData = new Uint8Array([100, 101, 102]);

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString();
      assert.ok(urlStr.includes('/api/v1/security/add-watermark'));
      const formData = init?.body as FormData;
      assert.equal(formData.get('watermarkText'), 'ĐÃ THANH TOÁN');
      assert.equal(formData.get('fontSize'), '35');

      return new Response(fakeWatermarkedData, {
        status: 200,
        headers: { 'Content-Type': 'application/pdf' },
      });
    }) as typeof fetch;

    const client = new StirlingPdfClient({ baseUrl: 'http://localhost:8080' });
    const original = new Uint8Array([1, 2, 3]);
    const watermarked = await client.addWatermark(original, 'ĐÃ THANH TOÁN', {
      fontSize: 35,
      rotation: 45,
    });

    assert.deepEqual(watermarked, fakeWatermarkedData);
  });

  test('7. addWatermark() should gracefully return original buffer on server failure', async () => {
    globalThis.fetch = (async () => {
      throw new Error('Connection reset by peer');
    }) as typeof fetch;

    const client = new StirlingPdfClient({
      baseUrl: 'http://localhost:8080',
      logger: mockLogger,
      fallbackOnFailure: true,
    });

    const original = new Uint8Array([55, 66, 77]);
    const result = await client.addWatermark(original, 'BẢO HÀNH');

    assert.deepEqual(result, original);
    assert.ok(warnLogs.some((l) => l.includes('falling back to unwatermarked PDF')));
  });

  test('8. convertHtmlToPdf() should convert HTML into PDF bytes', async () => {
    const fakePdfBytes = new Uint8Array([37, 80, 68, 70, 45, 50, 46, 48]);

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString();
      assert.ok(urlStr.includes('/api/v1/convert/html/pdf'));
      const formData = init?.body as FormData;
      assert.ok(formData.get('fileInput'));

      return new Response(fakePdfBytes, {
        status: 200,
        headers: { 'Content-Type': 'application/pdf' },
      });
    }) as typeof fetch;

    const client = new StirlingPdfClient({ baseUrl: 'http://localhost:8080' });
    const html = '<html><body><h1>Hóa đơn bán hàng #ORD-01</h1></body></html>';
    const pdf = await client.convertHtmlToPdf(html);

    assert.deepEqual(pdf, fakePdfBytes);
  });

  test('9. convertHtmlToPdf() should invoke fallbackHandler when server is offline', async () => {
    globalThis.fetch = (async () => {
      throw new Error('Service Unavailable');
    }) as typeof fetch;

    const client = new StirlingPdfClient({
      baseUrl: 'http://localhost:8080',
      logger: mockLogger,
    });

    const fallbackBytes = new Uint8Array([99, 88, 77]);
    const html = '<html><body>Invoice</body></html>';

    const pdf = await client.convertHtmlToPdf(html, {
      fallbackHandler: async (rawHtml) => {
        assert.equal(rawHtml, html);
        return fallbackBytes;
      },
    });

    assert.deepEqual(pdf, fallbackBytes);
    assert.ok(warnLogs.some((l) => l.includes('custom fallbackHandler')));
  });

  test('10. convertHtmlToPdf() should throw StirlingPdfError when server fails and no fallback is given', async () => {
    globalThis.fetch = (async () => {
      throw new Error('Connect timeout');
    }) as typeof fetch;

    const client = new StirlingPdfClient({ baseUrl: 'http://localhost:8080' });

    await assert.rejects(
      async () => {
        await client.convertHtmlToPdf('<html></html>');
      },
      (err: unknown) => {
        assert.ok(err instanceof StirlingPdfError);
        assert.ok(err.message.includes('Failed to convert HTML to PDF'));
        return true;
      }
    );
  });
});
