import type { SitemapArticle, SitemapSourceAdapter, WeekDateRange } from '../types';

export interface SqlQueryClient {
  (strings: TemplateStringsArray, ...values: any[]): Promise<any[]>;
}

export class PostgresSourceAdapter implements SitemapSourceAdapter {
  private sql: SqlQueryClient;
  private tableName: string;

  constructor(sqlClient: SqlQueryClient, tableName: string = 'articles') {
    this.sql = sqlClient;
    this.tableName = tableName;
  }

  async getDistinctMonths(locales: string[]): Promise<Record<string, string[]>> {
    const result: Record<string, string[]> = {};
    for (const loc of locales) {
      result[loc] = [];
    }

    const rows = await this.sql`
      SELECT 
        locale,
        to_char(COALESCE(first_publish_date, published_at), 'YYYY-MM') as month
      FROM articles
      WHERE published_at IS NOT NULL
      GROUP BY locale, month
      ORDER BY locale, month DESC
    `;

    for (const row of rows) {
      if (result[row.locale] && !result[row.locale].includes(row.month)) {
        result[row.locale].push(row.month);
      }
    }

    return result;
  }

  async getArticlesForWeek(locale: string, range: WeekDateRange): Promise<SitemapArticle[]> {
    const rows = await this.sql`
      SELECT 
        slug,
        title,
        locale,
        COALESCE(first_publish_date, published_at) as content_date,
        is_crawled
      FROM articles
      WHERE published_at IS NOT NULL
        AND locale = ${locale}
        AND COALESCE(first_publish_date, published_at) >= ${range.start.toISOString()}
        AND COALESCE(first_publish_date, published_at) <= ${range.end.toISOString()}
      ORDER BY COALESCE(first_publish_date, published_at) DESC
    `;

    return rows.map(r => ({
      slug: r.slug,
      title: r.title,
      locale: r.locale,
      contentDate: r.content_date,
      isCrawled: r.is_crawled,
    }));
  }

  async getRecentNewsArticles(options: {
    hoursAgo: number;
    isCrawled?: boolean;
  }): Promise<SitemapArticle[]> {
    const threshold = new Date(Date.now() - options.hoursAgo * 60 * 60 * 1000).toISOString();

    let rows: any[];
    if (options.isCrawled === true) {
      rows = await this.sql`
        SELECT 
          slug,
          title,
          locale,
          COALESCE(first_publish_date, published_at) as content_date,
          is_crawled
        FROM articles
        WHERE published_at IS NOT NULL
          AND is_crawled = true
          AND COALESCE(first_publish_date, published_at) >= ${threshold}
        ORDER BY COALESCE(first_publish_date, published_at) DESC
      `;
    } else if (options.isCrawled === false) {
      rows = await this.sql`
        SELECT 
          slug,
          title,
          locale,
          COALESCE(first_publish_date, published_at) as content_date,
          is_crawled
        FROM articles
        WHERE published_at IS NOT NULL
          AND (is_crawled = false OR is_crawled IS NULL)
          AND COALESCE(first_publish_date, published_at) >= ${threshold}
        ORDER BY COALESCE(first_publish_date, published_at) DESC
      `;
    } else {
      rows = await this.sql`
        SELECT 
          slug,
          title,
          locale,
          COALESCE(first_publish_date, published_at) as content_date,
          is_crawled
        FROM articles
        WHERE published_at IS NOT NULL
          AND COALESCE(first_publish_date, published_at) >= ${threshold}
        ORDER BY COALESCE(first_publish_date, published_at) DESC
      `;
    }

    return rows.map(r => ({
      slug: r.slug,
      title: r.title,
      locale: r.locale,
      contentDate: r.content_date,
      isCrawled: r.is_crawled,
    }));
  }

  async getLatestPostDate(locale: string): Promise<string | Date | null> {
    try {
      const rows = await this.sql`
        SELECT max(published_at) as d FROM posts WHERE locale = ${locale} AND published_at IS NOT NULL
      `;
      return rows[0]?.d ?? null;
    } catch {
      return null;
    }
  }

  async getLatestCategoryDate(locale: string): Promise<string | Date | null> {
    try {
      const rows = await this.sql`
        SELECT max(updated_at) as d FROM categories WHERE locale = ${locale}
      `;
      return rows[0]?.d ?? null;
    } catch {
      return null;
    }
  }

  async getLatestArticleDate(locale: string): Promise<string | Date | null> {
    try {
      const rows = await this.sql`
        SELECT max(COALESCE(first_publish_date, published_at)) as d 
        FROM articles 
        WHERE published_at IS NOT NULL AND locale = ${locale}
      `;
      return rows[0]?.d ?? null;
    } catch {
      return null;
    }
  }
}
