import { Partitioner } from './partitioner';
import type {
  SitemapEngineOptions,
  SitemapGenerationResult,
  SitemapIndexEntry,
  SitemapUrlEntry,
} from './types';
import { AtomicWriter } from './writer';
import { XmlBuilder } from './xml-builder';

export class SitemapIncrementalEngine {
  private options: Required<Omit<SitemapEngineOptions, 'adapter'>> & {
    adapter: SitemapEngineOptions['adapter'];
  };
  private partitioner: Partitioner;
  private writer: AtomicWriter;

  constructor(options: SitemapEngineOptions) {
    this.options = {
      outDir: options.outDir,
      baseUrl: options.baseUrl.replace(/\/+$/, ''),
      locales: options.locales || ['vi', 'en'],
      isIncremental: options.isIncremental !== false,
      isGzipEnabled: options.isGzipEnabled !== false,
      isDryRun: options.isDryRun || false,
      timezoneOffsetHours: options.timezoneOffsetHours ?? 7,
      adapter: options.adapter,
    };

    this.partitioner = new Partitioner(this.options.timezoneOffsetHours);
    this.writer = new AtomicWriter(
      this.options.outDir,
      this.options.isGzipEnabled,
      this.options.isDryRun
    );
  }

  async run(): Promise<SitemapGenerationResult> {
    const startTime = performance.now();
    const generatedFiles: string[] = [];
    const skippedFiles: string[] = [];

    const { yearMonth: currentYearMonth, day: currentDay, week: currentWeek } =
      this.partitioner.getCurrentPeriod();

    const distinctMonthsByLocale = await this.options.adapter.getDistinctMonths(
      this.options.locales
    );

    const weeklyLastmods: Record<string, string | null> = {};

    // 1. Process Weekly Archive Sitemaps
    for (const locale of this.options.locales) {
      const pathPrefix = locale === 'vi' ? '/tin-tuc/' : `/${locale}/news/`;
      const months = distinctMonthsByLocale[locale] || [];

      for (const month of months) {
        const weeks = this.partitioner.getWeeksForMonth(month, currentYearMonth, currentDay);

        for (const week of weeks) {
          const filename = `sitemap-${locale}-${month}-w${week}.xml`;
          const isCurrentActive = month === currentYearMonth && week === currentWeek;
          const fileExists = this.writer.exists(filename);

          // INCREMENTAL RULE: If file exists and it's a closed past week, skip!
          if (this.options.isIncremental && fileExists && !isCurrentActive) {
            skippedFiles.push(filename);
            const cachedXml = this.writer.read(filename);
            weeklyLastmods[filename] = cachedXml
              ? XmlBuilder.extractLastmodFromXml(cachedXml)
              : null;
            continue;
          }

          const dateRange = this.partitioner.getWeekDateRange(month, week);
          const articles = await this.options.adapter.getArticlesForWeek(locale, dateRange);

          if (articles.length === 0) {
            weeklyLastmods[filename] = null;
            continue;
          }

          const newestDate = this.partitioner.formatDate(articles[0].contentDate);
          weeklyLastmods[filename] = newestDate;

          const urlEntries: SitemapUrlEntry[] = articles.map(a => ({
            loc: `${this.options.baseUrl}${pathPrefix}${a.slug}`,
            lastmod: this.partitioner.formatDate(a.contentDate),
            changefreq: 'monthly',
            priority: 0.6,
          }));

          const xml = XmlBuilder.buildUrlset(urlEntries);
          this.writer.write(filename, xml);
          generatedFiles.push(filename);
        }
      }
    }

    // 2. Process Google News Sitemaps (Last 48 Hours)
    // 2.1 Crawled News
    const crawledNews = await this.options.adapter.getRecentNewsArticles({
      hoursAgo: 48,
      isCrawled: true,
    });

    const crawledEntries: SitemapUrlEntry[] = crawledNews.map(a => {
      const prefix = a.locale === 'vi' ? '/tin-tuc/' : `/${a.locale}/news/`;
      const lastmod = this.partitioner.formatDate(a.contentDate);
      return {
        loc: `${this.options.baseUrl}${prefix}${a.slug}`,
        lastmod,
        news: {
          publicationName: 'Index.vn',
          publicationLanguage: a.locale,
          publicationDate: lastmod,
          title: a.title || a.slug,
        },
      };
    });

    const crawledXml = XmlBuilder.buildGoogleNewsUrlset(crawledEntries);
    this.writer.write('sitemap-news.xml', crawledXml);
    generatedFiles.push('sitemap-news.xml');

    // 2.2 Manual Editorial News
    const manualNews = await this.options.adapter.getRecentNewsArticles({
      hoursAgo: 48,
      isCrawled: false,
    });

    const manualEntries: SitemapUrlEntry[] = manualNews.map(a => {
      const prefix = a.locale === 'vi' ? '/tin-tuc/' : `/${a.locale}/news/`;
      const lastmod = this.partitioner.formatDate(a.contentDate);
      return {
        loc: `${this.options.baseUrl}${prefix}${a.slug}`,
        lastmod,
        news: {
          publicationName: 'Index.vn',
          publicationLanguage: a.locale,
          publicationDate: lastmod,
          title: a.title || a.slug,
        },
      };
    });

    const manualXml = XmlBuilder.buildGoogleNewsUrlset(manualEntries);
    this.writer.write('sitemap-news-manual.xml', manualXml);
    generatedFiles.push('sitemap-news-manual.xml');

    // 3. Process Locale Index Sitemaps
    for (const locale of this.options.locales) {
      const indexEntries: SitemapIndexEntry[] = [];
      const months = distinctMonthsByLocale[locale] || [];

      for (const month of months) {
        const weeks = this.partitioner.getWeeksForMonth(month, currentYearMonth, currentDay);
        for (const week of weeks) {
          const filename = `sitemap-${locale}-${month}-w${week}.xml`;
          indexEntries.push({
            loc: `${this.options.baseUrl}/${filename}`,
            lastmod: weeklyLastmods[filename] ?? undefined,
          });
        }
      }

      // External entity lastmod
      const postDate = this.options.adapter.getLatestPostDate
        ? await this.options.adapter.getLatestPostDate(locale)
        : null;
      const catDate = this.options.adapter.getLatestCategoryDate
        ? await this.options.adapter.getLatestCategoryDate(locale)
        : null;

      indexEntries.push({
        loc: `${this.options.baseUrl}/${locale}/sitemap-posts.xml`,
        lastmod: postDate ? this.partitioner.formatDate(postDate) : undefined,
      });
      indexEntries.push({
        loc: `${this.options.baseUrl}/${locale}/sitemap-pages.xml`,
      });
      indexEntries.push({
        loc: `${this.options.baseUrl}/${locale}/sitemap-categories.xml`,
        lastmod: catDate ? this.partitioner.formatDate(catDate) : undefined,
      });

      const localeXml = XmlBuilder.buildSitemapIndex(indexEntries);
      const filename = `sitemap-${locale}.xml`;
      this.writer.write(filename, localeXml);
      generatedFiles.push(filename);
    }

    // 4. Process Master Sitemap Index
    const latestVi = this.options.adapter.getLatestArticleDate
      ? await this.options.adapter.getLatestArticleDate('vi')
      : null;
    const latestEn = this.options.adapter.getLatestArticleDate
      ? await this.options.adapter.getLatestArticleDate('en')
      : null;

    const masterEntries: SitemapIndexEntry[] = [
      {
        loc: `${this.options.baseUrl}/sitemap-news-manual.xml`,
        lastmod: manualNews[0]
          ? this.partitioner.formatDate(manualNews[0].contentDate)
          : undefined,
      },
      {
        loc: `${this.options.baseUrl}/sitemap-news.xml`,
        lastmod: crawledNews[0]
          ? this.partitioner.formatDate(crawledNews[0].contentDate)
          : undefined,
      },
      {
        loc: `${this.options.baseUrl}/sitemap-vi.xml`,
        lastmod: latestVi ? this.partitioner.formatDate(latestVi) : undefined,
      },
      {
        loc: `${this.options.baseUrl}/sitemap-en.xml`,
        lastmod: latestEn ? this.partitioner.formatDate(latestEn) : undefined,
      },
      {
        loc: `${this.options.baseUrl}/sitemap-prices.xml`,
        lastmod: (latestEn || latestVi)
          ? this.partitioner.formatDate(latestEn || latestVi!)
          : undefined,
      },
    ];

    const masterXml = XmlBuilder.buildSitemapIndex(masterEntries);
    this.writer.write('sitemap.xml', masterXml);
    generatedFiles.push('sitemap.xml');

    const elapsedMs = Math.round(performance.now() - startTime);

    return {
      totalFilesGenerated: generatedFiles.length,
      totalFilesSkipped: skippedFiles.length,
      elapsedMs,
      generatedFiles,
      skippedFiles,
    };
  }
}
