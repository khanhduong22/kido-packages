import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import {
  Partitioner,
  XmlBuilder,
  SitemapIncrementalEngine,
  MemorySourceAdapter,
  type SitemapArticle,
} from '../src';

describe('Partitioner', () => {
  const partitioner = new Partitioner(7); // GMT+7

  it('formats dates into Vietnam timezone +07:00 format', () => {
    const utcDate = new Date('2026-10-13T03:00:00Z');
    const formatted = partitioner.formatDate(utcDate);
    expect(formatted).toBe('2026-10-13T10:00:00+07:00');
  });

  it('calculates 4-week date ranges correctly for a month', () => {
    const w1 = partitioner.getWeekDateRange('2026-05', 1);
    expect(w1.start.getUTCDate()).toBe(1);
    expect(w1.end.getUTCDate()).toBe(7);

    const w2 = partitioner.getWeekDateRange('2026-05', 2);
    expect(w2.start.getUTCDate()).toBe(8);
    expect(w2.end.getUTCDate()).toBe(14);

    const w3 = partitioner.getWeekDateRange('2026-05', 3);
    expect(w3.start.getUTCDate()).toBe(15);
    expect(w3.end.getUTCDate()).toBe(21);

    const w4 = partitioner.getWeekDateRange('2026-05', 4);
    expect(w4.start.getUTCDate()).toBe(22);
    // May has 31 days
    expect(w4.end.getUTCDate()).toBe(31);
  });

  it('correctly identifies past closed weeks vs active current week', () => {
    // Current is 2026-10 Week 2
    expect(partitioner.isPastClosedWeek('2026-09', 4, '2026-10', 2)).toBe(true);
    expect(partitioner.isPastClosedWeek('2026-10', 1, '2026-10', 2)).toBe(true);
    expect(partitioner.isPastClosedWeek('2026-10', 2, '2026-10', 2)).toBe(false);
  });
});

describe('XmlBuilder', () => {
  it('escapes XML special characters safely', () => {
    const unescaped = '<hello & "world" \'quote\'>';
    expect(XmlBuilder.escape(unescaped)).toBe('&lt;hello &amp; &quot;world&quot; &apos;quote&apos;&gt;');
  });

  it('builds standard urlset XML', () => {
    const xml = XmlBuilder.buildUrlset([
      {
        loc: 'https://news.example.com/tin-tuc/bai-viet-1',
        lastmod: '2026-10-13T10:00:00+07:00',
        changefreq: 'monthly',
        priority: 0.6,
      },
    ]);

    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml).toContain('<loc>https://news.example.com/tin-tuc/bai-viet-1</loc>');
    expect(xml).toContain('<lastmod>2026-10-13T10:00:00+07:00</lastmod>');
    expect(xml).toContain('<changefreq>monthly</changefreq>');
    expect(xml).toContain('<priority>0.6</priority>');
  });

  it('builds Google News urlset XML with news metadata', () => {
    const xml = XmlBuilder.buildGoogleNewsUrlset([
      {
        loc: 'https://news.example.com/tin-tuc/gia-vang-tang-manh',
        lastmod: '2026-10-13T10:00:00+07:00',
        news: {
          publicationName: 'ExampleNews',
          publicationLanguage: 'vi',
          publicationDate: '2026-10-13T10:00:00+07:00',
          title: 'Giá Vàng Tăng Mạnh Sáng Nay & Chi Tiết',
        },
      },
    ]);

    expect(xml).toContain('xmlns:news="http://www.google.com/schemas/sitemap-news/0.9"');
    expect(xml).toContain('<news:publication_date>2026-10-13T10:00:00+07:00</news:publication_date>');
    expect(xml).toContain('<news:title>Giá Vàng Tăng Mạnh Sáng Nay &amp; Chi Tiết</news:title>');
  });

  it('builds sitemap index XML', () => {
    const xml = XmlBuilder.buildSitemapIndex([
      { loc: 'https://news.example.com/sitemap-news.xml', lastmod: '2026-10-13T10:00:00+07:00' },
      { loc: 'https://news.example.com/sitemap-vi.xml' },
    ]);

    expect(xml).toContain('<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml).toContain('<loc>https://news.example.com/sitemap-news.xml</loc>');
    expect(xml).toContain('<lastmod>2026-10-13T10:00:00+07:00</lastmod>');
    expect(xml).toContain('<loc>https://news.example.com/sitemap-vi.xml</loc>');
  });
});

describe('SitemapIncrementalEngine (End-to-End)', () => {
  let tmpDir: string;
  let adapter: MemorySourceAdapter;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sitemap-test-'));
    adapter = new MemorySourceAdapter();
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('executes full generation and incremental delta run with cold skipping', async () => {
    // Seed articles across past months and recent 48 hours
    const mockArticles: SitemapArticle[] = [
      {
        slug: 'bai-viet-thang-5-tuan-1',
        title: 'Bài viết tháng 5',
        locale: 'vi',
        contentDate: '2026-05-02T10:00:00Z',
        isCrawled: true,
      },
      {
        slug: 'article-may-week-1',
        title: 'Article May',
        locale: 'en',
        contentDate: '2026-05-03T10:00:00Z',
        isCrawled: true,
      },
      {
        slug: 'bai-viet-nong-hom-nay',
        title: 'Tin Nóng 24h & Cập Nhật Mới',
        locale: 'vi',
        contentDate: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        isCrawled: true,
      },
      {
        slug: 'bai-viet-bien-tap-hom-nay',
        title: 'Tin Biên Tập Độc Quyền',
        locale: 'vi',
        contentDate: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
        isCrawled: false,
      },
    ];

    adapter.setArticles(mockArticles);

    // Run 1: FULL GENERATION
    const engineFull = new SitemapIncrementalEngine({
      outDir: tmpDir,
      baseUrl: 'https://test.ExampleNews',
      locales: ['vi', 'en'],
      isIncremental: false,
      isGzipEnabled: true,
      adapter,
    });

    const fullResult = await engineFull.run();
    expect(fullResult.totalFilesGenerated).toBeGreaterThan(0);
    expect(fullResult.totalFilesSkipped).toBe(0);

    // Verify files created on disk
    expect(fs.existsSync(path.join(tmpDir, 'sitemap.xml'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'sitemap.xml.gz'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'sitemap-news.xml'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'sitemap-news-manual.xml'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'sitemap-vi.xml'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'sitemap-en.xml'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'sitemap-vi-2026-05-w1.xml'))).toBe(true);

    // Run 2: INCREMENTAL GENERATION (Hot delta only)
    const engineIncremental = new SitemapIncrementalEngine({
      outDir: tmpDir,
      baseUrl: 'https://test.ExampleNews',
      locales: ['vi', 'en'],
      isIncremental: true,
      isGzipEnabled: true,
      adapter,
    });

    const incResult = await engineIncremental.run();
    expect(incResult.totalFilesSkipped).toBeGreaterThan(0);
    // The past May week 1 sitemap must be skipped!
    expect(incResult.skippedFiles).toContain('sitemap-vi-2026-05-w1.xml');
    expect(incResult.skippedFiles).toContain('sitemap-en-2026-05-w1.xml');
    // Hot news and indexes must be regenerated
    expect(incResult.generatedFiles).toContain('sitemap-news.xml');
    expect(incResult.generatedFiles).toContain('sitemap-news-manual.xml');
    expect(incResult.generatedFiles).toContain('sitemap.xml');
  });
});
