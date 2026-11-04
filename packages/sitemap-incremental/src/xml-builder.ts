import type { SitemapIndexEntry, SitemapUrlEntry } from './types';

export class XmlBuilder {
  static escape(unsafe: string): string {
    return unsafe
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  static buildUrlset(entries: SitemapUrlEntry[]): string {
    const urls = entries
      .map(entry => {
        const changefreqTag = entry.changefreq
          ? `\n    <changefreq>${entry.changefreq}</changefreq>`
          : '';
        const priorityTag =
          entry.priority !== undefined ? `\n    <priority>${entry.priority}</priority>` : '';

        return `  <url>
    <loc>${this.escape(entry.loc)}</loc>
    <lastmod>${entry.lastmod}</lastmod>${changefreqTag}${priorityTag}
  </url>`;
      })
      .join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`;
  }

  static buildGoogleNewsUrlset(entries: SitemapUrlEntry[]): string {
    const urls = entries
      .map(entry => {
        const news = entry.news;
        const newsTag = news
          ? `\n    <news:news>
      <news:publication>
        <news:name>${this.escape(news.publicationName)}</news:name>
        <news:language>${this.escape(news.publicationLanguage)}</news:language>
      </news:publication>
      <news:publication_date>${news.publicationDate}</news:publication_date>
      <news:title>${this.escape(news.title)}</news:title>
    </news:news>`
          : '';

        return `  <url>
    <loc>${this.escape(entry.loc)}</loc>
    <lastmod>${entry.lastmod}</lastmod>${newsTag}
  </url>`;
      })
      .join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">
${urls}
</urlset>`;
  }

  static buildSitemapIndex(entries: SitemapIndexEntry[]): string {
    const sitemaps = entries
      .map(entry => {
        const lastmodTag = entry.lastmod ? `\n    <lastmod>${entry.lastmod}</lastmod>` : '';
        return `  <sitemap>
    <loc>${this.escape(entry.loc)}</loc>${lastmodTag}
  </sitemap>`;
      })
      .join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sitemaps}
</sitemapindex>`;
  }

  static extractLastmodFromXml(xmlContent: string): string | null {
    const match = xmlContent.match(/<lastmod>(.*?)<\/lastmod>/);
    return match ? match[1] ?? null : null;
  }
}
