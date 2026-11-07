import { describe, expect, it } from 'bun:test';
import {
  parseRssOrAtomXml,
  cleanXmlNodeText,
  extractFeedHostname,
  parseFeedPublishedDate,
  evaluateScrapedArticleQuality,
  normalizeEditorialHeadline,
  normalizeEditorialContent,
  buildEditorialRefinerySchema,
  DEFAULT_BANNED_NEWS_DOMAINS,
} from '../index';

describe('@kido/anti-spam — Content Refinery & RSS/Atom Feed Normalizer', () => {
  describe('parseRssOrAtomXml & XML helpers', () => {
    it('parses standard RSS 2.0 <item> blocks with CDATA and strips www. from hostname', () => {
      const rssXml = `
        <?xml version="1.0" encoding="UTF-8"?>
        <rss version="2.0">
          <channel>
            <title>VnExpress Kinh Doanh</title>
            <item>
              <title><![CDATA[NHNN giữ nguyên lãi suất điều hành &amp; ổn định tỷ giá]]></title>
              <link>https://www.vnexpress.net/nhnn-giu-nguyen-lai-suat-4800123.html</link>
              <pubDate>Wed, 15 Oct 2025 08:30:00 +0700</pubDate>
            </item>
            <item>
              <title>Vietstock: Dòng tiền khối ngoại đảo chiều mua ròng</title>
              <link><![CDATA[https://vietstock.vn/2025/10/khoi-ngoai-mua-rong.htm]]></link>
              <pubdate>2025-10-15T02:00:00Z</pubdate>
            </item>
          </channel>
        </rss>
      `;

      const items = parseRssOrAtomXml(
        rssXml,
        'https://vnexpress.net/rss/kinh-doanh.rss',
      );
      expect(items.length).toBe(2);

      expect(items[0].title).toBe(
        'NHNN giữ nguyên lãi suất điều hành & ổn định tỷ giá',
      );
      expect(items[0].link).toBe(
        'https://www.vnexpress.net/nhnn-giu-nguyen-lai-suat-4800123.html',
      );
      expect(items[0].hostname).toBe('vnexpress.net');
      expect(items[0].pubDate).toBe('Wed, 15 Oct 2025 08:30:00 +0700');
      expect(items[0].publishedAt.toISOString()).toBe(
        '2025-10-15T01:30:00.000Z',
      );
      expect(items[0].sourceUrl).toBe(
        'https://vnexpress.net/rss/kinh-doanh.rss',
      );

      expect(items[1].title).toBe(
        'Vietstock: Dòng tiền khối ngoại đảo chiều mua ròng',
      );
      expect(items[1].hostname).toBe('vietstock.vn');
      expect(items[1].publishedAt.toISOString()).toBe(
        '2025-10-15T02:00:00.000Z',
      );
    });

    it('parses Atom <entry> feeds with <link href="..."> attributes and <published>/<updated>', () => {
      const atomXml = `
        <feed xmlns="http://www.w3.org/2005/Atom">
          <entry>
            <title>Federal Reserve Signals Measured Pace of Rate Adjustments</title>
            <link rel="self" href="https://www.reuters.com/feed/entry/1" />
            <link rel="alternate" type="text/html" href="https://www.reuters.com/markets/us/fed-signals-2025-10-15/" />
            <published>2025-10-15T14:00:00Z</published>
          </entry>
          <entry>
            <title>Treasury Yields Steady Ahead of CPI Print</title>
            <link href='https://bloomberg.com/news/articles/treasury-yields' />
            <updated>2025-10-15T15:30:00Z</updated>
          </entry>
        </feed>
      `;

      const items = parseRssOrAtomXml(atomXml);
      expect(items.length).toBe(2);

      // Should prefer rel="alternate" over rel="self"
      expect(items[0].link).toBe(
        'https://www.reuters.com/markets/us/fed-signals-2025-10-15/',
      );
      expect(items[0].hostname).toBe('reuters.com');
      expect(items[0].publishedAt.toISOString()).toBe(
        '2025-10-15T14:00:00.000Z',
      );

      expect(items[1].link).toBe(
        'https://bloomberg.com/news/articles/treasury-yields',
      );
      expect(items[1].hostname).toBe('bloomberg.com');
      expect(items[1].publishedAt.toISOString()).toBe(
        '2025-10-15T15:30:00.000Z',
      );
    });

    it('parses RDF feeds with <url> fallback and safe Date fallback when pubDate is invalid', () => {
      const rdfXml = `
        <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
          <item>
            <title>Gold Prices Reach Record High &#8212; Safe Haven Demand</title>
            <url>https://www.cafef.vn/gia-vang-lap-dinh-moi.chn</url>
            <pubDate>not-a-valid-date-string</pubDate>
          </item>
        </rdf:RDF>
      `;

      const before = Date.now();
      const items = parseRssOrAtomXml(rdfXml);
      const after = Date.now();

      expect(items.length).toBe(1);
      expect(items[0].title).toBe(
        'Gold Prices Reach Record High — Safe Haven Demand',
      );
      expect(items[0].link).toBe(
        'https://www.cafef.vn/gia-vang-lap-dinh-moi.chn',
      );
      expect(items[0].hostname).toBe('cafef.vn');
      expect(items[0].publishedAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(items[0].publishedAt.getTime()).toBeLessThanOrEqual(after);
    });

    it('returns empty array for empty or non-XML input and falls back to rss-source hostname', () => {
      expect(parseRssOrAtomXml('')).toEqual([]);
      expect(parseRssOrAtomXml('   ')).toEqual([]);
      expect(cleanXmlNodeText('   ')).toBeNull();
      expect(extractFeedHostname('invalid-url')).toBe('rss-source');

      const fallbackDate = new Date('2025-01-01T00:00:00.000Z');
      expect(parseFeedPublishedDate(null, fallbackDate)).toBe(fallbackDate);
      expect(parseFeedPublishedDate('invalid', fallbackDate)).toBe(fallbackDate);
    });
  });

  describe('evaluateScrapedArticleQuality', () => {
    const validContent =
      'Ngân hàng Nhà nước Việt Nam vừa công bố báo cáo điều hành chính sách tiền tệ quý III với trọng tâm ổn định kinh tế vĩ mô, kiểm soát lạm phát và hỗ trợ tăng trưởng tín dụng vào các lĩnh vực sản xuất ưu tiên.';

    it('accepts a clean, coherent financial news article', () => {
      const result = evaluateScrapedArticleQuality({
        title: 'Ngân hàng Nhà nước điều hành linh hoạt chính sách tiền tệ quý III',
        content: validContent,
        site: 'https://www.vnexpress.net/kinh-doanh',
      });

      expect(result.isValid).toBe(true);
      expect(result.rejectReason).toBeUndefined();
      expect(result.reasons).toEqual([]);
      expect(result.isClickbait).toBe(false);
      expect(result.hostname).toBe('vnexpress.net');
      expect(result.normalizedTitle).toBe(
        'Ngân hàng Nhà nước điều hành linh hoạt chính sách tiền tệ quý III',
      );
    });

    it('rejects articles from default and custom banned domains', () => {
      expect(DEFAULT_BANNED_NEWS_DOMAINS).toContain('seekingalpha.com');

      const resDefault = evaluateScrapedArticleQuality({
        title: 'Top 5 Stocks to Watch Today',
        content: validContent,
        site: 'www.seekingalpha.com',
      });
      expect(resDefault.isValid).toBe(false);
      expect(resDefault.rejectReason).toBe('banned_domain');

      const resCustom = evaluateScrapedArticleQuality({
        title: 'Market Update',
        content: validContent,
        url: 'https://sub.spam-aggregator.io/post/123',
        bannedDomains: ['spam-aggregator.io'],
      });
      expect(resCustom.isValid).toBe(false);
      expect(resCustom.rejectReason).toBe('banned_domain');
    });

    it('rejects Cloudflare / bot-detection / captcha walls', () => {
      const res = evaluateScrapedArticleQuality({
        title: 'Attention Required! | Cloudflare',
        content:
          'Checking your browser before accessing example.com. Please enable JavaScript and cookies to continue. Cloudflare Ray ID: 89abcdef12345678',
        site: 'vnexpress.net',
      });

      expect(res.isValid).toBe(false);
      expect(res.rejectReason).toBe('bot_detection_or_captcha');
      expect(res.reasons.some((r) => r.includes('cloudflare'))).toBe(true);
    });

    it('rejects cookie consent walls and subscription paywalls', () => {
      const paywallRes = evaluateScrapedArticleQuality({
        title: 'Exclusive Deep Dive Into Semiconductor Supply Chains',
        content:
          'This article is for subscribers only. Subscribe to continue reading our full institutional research report and unlock premium market data.',
        site: 'ft.com',
      });

      expect(paywallRes.isValid).toBe(false);
      expect(paywallRes.rejectReason).toBe('cookie_or_paywall');

      const cookieRes = evaluateScrapedArticleQuality({
        title: 'European Markets Open Higher',
        content:
          'We value your privacy and use cookies to personalize content. Please click Accept all cookies or Manage cookie preferences before reading.',
        site: 'reuters.com',
      });

      expect(cookieRes.isValid).toBe(false);
      expect(cookieRes.rejectReason).toBe('cookie_or_paywall');
    });

    it('rejects short filler text and repetitive boilerplate', () => {
      const shortRes = evaluateScrapedArticleQuality({
        title: 'Valid Headline',
        content: 'Too short to be an article.',
        site: 'cafef.vn',
      });
      expect(shortRes.isValid).toBe(false);
      expect(shortRes.rejectReason).toBe('insufficient_content');

      const fillerRes = evaluateScrapedArticleQuality({
        title: 'Valid Headline',
        content:
          'loading data please wait '.repeat(25),
        site: 'cafef.vn',
      });
      expect(fillerRes.isValid).toBe(false);
      expect(fillerRes.rejectReason).toBe('repetitive_filler');
    });

    it('detects clickbait/hype patterns in headlines and normalizes punctuation/emojis', () => {
      const rawHeadline =
        '🔥 [BREAKING] CỰC SỐC: Cổ phiếu này sắp TO THE MOON 100x gem?!   ';
      const result = evaluateScrapedArticleQuality({
        title: rawHeadline,
        content: validContent,
        site: 'vietstock.vn',
      });

      expect(result.isValid).toBe(true);
      expect(result.isClickbait).toBe(true);
      expect(result.clickbaitSignals).toContain('hype_phrase_en');
      expect(result.clickbaitSignals).toContain('hype_phrase_vi');
      expect(result.clickbaitSignals).toContain('excessive_punctuation');
      expect(result.clickbaitSignals).toContain('emoji_in_headline');
      expect(result.clickbaitSignals).toContain('all_caps_sensationalism');

      // Normalized title strips [BREAKING], emojis, and ?!
      expect(result.normalizedTitle).toBe(
        'CỰC SỐC: Cổ phiếu này sắp TO THE MOON 100x gem',
      );
      expect(normalizeEditorialHeadline('Hello   world ,  test !')).toBe(
        'Hello world, test',
      );
      expect(normalizeEditorialContent('Line 1\r\n\r\n\r\nLine   2  ')).toBe(
        'Line 1\n\nLine 2',
      );
    });
  });

  describe('buildEditorialRefinerySchema', () => {
    it('builds bilingual Firecrawl/LLM JSON schema and editorial prompt', () => {
      const categoriesEn = ['Macroeconomics', 'Stock Market', 'Crypto'];
      const categoriesVi = ['Kinh tế vĩ mô', 'Thị trường chứng khoán', 'Tiền mã hóa'];

      const spec = buildEditorialRefinerySchema(categoriesEn, categoriesVi);

      expect(spec.type).toBe('json');
      expect(spec.schema.type).toBe('object');
      expect(spec.schema.required).toEqual([
        'is_valid',
        'title',
        'author',
        'published_date',
        'main_content',
        'category',
        'image',
      ]);
      expect(spec.schema.properties.title.required).toEqual(['en', 'vi']);
      expect(spec.schema.properties.main_content.required).toEqual(['en', 'vi']);
      expect(spec.schema.properties.category.required).toEqual(['en', 'vi']);
      expect(spec.schema.properties.published_date.format).toBe('date');

      expect(spec.prompt).toContain('Macroeconomics, Stock Market, Crypto');
      expect(spec.prompt).toContain(
        'Kinh tế vĩ mô, Thị trường chứng khoán, Tiền mã hóa',
      );
      expect(spec.prompt).toContain(
        'Avoid clickbait, hype, emotional language, marketing terms, emojis',
      );
    });
  });
});
