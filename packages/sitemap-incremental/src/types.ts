export interface SitemapArticle {
  slug: string;
  title?: string;
  locale: string;
  contentDate: string | Date;
  isCrawled?: boolean;
}

export interface SitemapUrlEntry {
  loc: string;
  lastmod: string;
  changefreq?: "always" | "hourly" | "daily" | "weekly" | "monthly" | "yearly" | "never";
  priority?: number;
  news?: {
    publicationName: string;
    publicationLanguage: string;
    publicationDate: string;
    title: string;
  };
}

export interface SitemapIndexEntry {
  loc: string;
  lastmod?: string | null;
}

export interface WeekDateRange {
  month: string; // YYYY-MM
  week: number;  // 1-4
  start: Date;
  end: Date;
}

export interface SitemapSourceAdapter {
  getDistinctMonths(locales: string[]): Promise<Record<string, string[]>>;
  getArticlesForWeek(locale: string, range: WeekDateRange): Promise<SitemapArticle[]>;
  getRecentNewsArticles(options: {
    hoursAgo: number;
    isCrawled?: boolean;
  }): Promise<SitemapArticle[]>;
  getLatestPostDate?(locale: string): Promise<string | Date | null>;
  getLatestCategoryDate?(locale: string): Promise<string | Date | null>;
  getLatestArticleDate?(locale: string): Promise<string | Date | null>;
}

export interface SitemapEngineOptions {
  outDir: string;
  baseUrl: string;
  locales?: string[];
  isIncremental?: boolean;
  isGzipEnabled?: boolean;
  isDryRun?: boolean;
  adapter: SitemapSourceAdapter;
  timezoneOffsetHours?: number; // Default 7 (Asia/Ho_Chi_Minh)
}

export interface SitemapGenerationResult {
  totalFilesGenerated: number;
  totalFilesSkipped: number;
  elapsedMs: number;
  generatedFiles: string[];
  skippedFiles: string[];
}
