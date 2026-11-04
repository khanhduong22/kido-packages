import type { SitemapArticle, SitemapSourceAdapter, WeekDateRange } from '../types';

export class MemorySourceAdapter implements SitemapSourceAdapter {
  private articles: SitemapArticle[] = [];
  private latestPostDates: Record<string, string | Date | null> = {};
  private latestCategoryDates: Record<string, string | Date | null> = {};

  constructor(initialArticles: SitemapArticle[] = []) {
    this.articles = [...initialArticles];
  }

  addArticle(article: SitemapArticle): void {
    this.articles.push(article);
  }

  setArticles(articles: SitemapArticle[]): void {
    this.articles = [...articles];
  }

  setLatestPostDate(locale: string, date: string | Date | null): void {
    this.latestPostDates[locale] = date;
  }

  setLatestCategoryDate(locale: string, date: string | Date | null): void {
    this.latestCategoryDates[locale] = date;
  }

  async getDistinctMonths(locales: string[]): Promise<Record<string, string[]>> {
    const result: Record<string, string[]> = {};
    for (const loc of locales) {
      result[loc] = [];
    }

    for (const a of this.articles) {
      if (!locales.includes(a.locale)) continue;
      const d = new Date(a.contentDate);
      const m = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
      if (!result[a.locale].includes(m)) {
        result[a.locale].push(m);
      }
    }

    for (const loc of locales) {
      result[loc].sort().reverse();
    }

    return result;
  }

  async getArticlesForWeek(locale: string, range: WeekDateRange): Promise<SitemapArticle[]> {
    return this.articles
      .filter(a => {
        if (a.locale !== locale) return false;
        const d = new Date(a.contentDate).getTime();
        return d >= range.start.getTime() && d <= range.end.getTime();
      })
      .sort((a, b) => new Date(b.contentDate).getTime() - new Date(a.contentDate).getTime());
  }

  async getRecentNewsArticles(options: {
    hoursAgo: number;
    isCrawled?: boolean;
  }): Promise<SitemapArticle[]> {
    const thresholdMs = Date.now() - options.hoursAgo * 60 * 60 * 1000;
    return this.articles
      .filter(a => {
        const d = new Date(a.contentDate).getTime();
        if (d < thresholdMs) return false;
        if (options.isCrawled !== undefined) {
          if (options.isCrawled && !a.isCrawled) return false;
          if (!options.isCrawled && a.isCrawled) return false;
        }
        return true;
      })
      .sort((a, b) => new Date(b.contentDate).getTime() - new Date(a.contentDate).getTime());
  }

  async getLatestPostDate(locale: string): Promise<string | Date | null> {
    return this.latestPostDates[locale] ?? null;
  }

  async getLatestCategoryDate(locale: string): Promise<string | Date | null> {
    return this.latestCategoryDates[locale] ?? null;
  }

  async getLatestArticleDate(locale: string): Promise<string | Date | null> {
    const matching = this.articles.filter(a => a.locale === locale);
    if (matching.length === 0) return null;
    return matching[0].contentDate;
  }
}
