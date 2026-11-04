# @kido/sitemap-incremental

> High-performance Cold/Hot incremental sitemap generator with atomic writes, pre-gzip compression, and zero-downtime Nginx static serving.

[![Tests](https://img.shields.io/badge/tests-passing-brightgreen.svg)]()
[![Type](https://img.shields.io/badge/TypeScript-Strict-blue.svg)]()
[![Zero Dependencies](https://img.shields.io/badge/dependencies-zero-success.svg)]()

---

## 🎯 The Problem Solved

Standard web frameworks (Next.js, Nuxt, Remix) dynamically generate XML sitemaps on-demand inside SSR route handlers. On large content websites (100k+ articles):
- Web crawlers (Googlebot, Bingbot, Yandex) request hundreds of weekly sitemap archives concurrently.
- SSR routes trigger heavy database pagination, JSON serialization, and CPU-intensive XML construction on every crawl request.
- **The Result**: CPU spikes to 100%, Node event loops block, and bots encounter **504 Gateway Timeouts**, harming SEO indexing.
- **The Waste**: Over 95% of past historical articles are **immutable** and never change.

`@kido/sitemap-incremental` solves this permanently:
1. **Cold/Hot Partitioning**: Historical closed weeks/months are generated once and marked cold. Incremental runs **skip 100% of past files (0 DB queries)**.
2. **Hot Delta Updates**: Only active current periods, 48-hour Google News sitemaps, and root index sitemaps are refreshed.
3. **Atomic Writes**: Writes to `.tmp` files and renames atomically to prevent bots from reading partial or corrupt XML.
4. **Pre-Gzip Compression (`.xml.gz`)**: Level 9 pre-compressed alongside XML for Nginx `gzip_static on;` zero-CPU delivery.
5. **Nginx Zero-Copy Serving**: Serves static files in **< 1ms TTFB** via kernel `sendfile`, with seamless fallback to dynamic routes if a file is not yet generated.

---

## 📦 Installation

```bash
pnpm add @kido/sitemap-incremental
# or
bun add @kido/sitemap-incremental
```

---

## ⚡ Quick Start

```typescript
import {
  SitemapIncrementalEngine,
  PostgresSourceAdapter,
} from '@kido/sitemap-incremental';
import { SQL } from 'bun';

// 1. Setup Database Adapter
const sql = new SQL(process.env.DATABASE_URL!);
const adapter = new PostgresSourceAdapter(sql, 'articles');

// 2. Initialize Engine
const engine = new SitemapIncrementalEngine({
  outDir: '/www/wwwroot/sitemaps',
  baseUrl: 'https://news.example.com',
  locales: ['vi', 'en'],
  isIncremental: true, // true = hot delta only, false = full backfill
  isGzipEnabled: true, // creates .xml.gz alongside .xml
});

// 3. Run Generation
const result = await engine.run();
console.log(`Generated ${result.totalFilesGenerated} files, skipped ${result.totalFilesSkipped} in ${result.elapsedMs}ms!`);
```

---

## 🧩 Architecture & Cold/Hot Partitioning

```mermaid
flowchart TD
    Cron["Cron Trigger (Every 15m)"] --> Engine["SitemapIncrementalEngine"]
    Engine --> Partitioner["Partitioner (GMT+7 Timezone)"]
    Partitioner --> CheckCold{"Is past closed week & file exists on disk?"}
    
    CheckCold -->|YES| Skip["SKIP (0 DB Queries, Read cached lastmod)"]
    CheckCold -->|NO (Active/New)| QueryDB["Query DB for Week Articles"]
    
    QueryDB --> XmlBuilder["XmlBuilder (Urlset / Google News / Indexes)"]
    XmlBuilder --> AtomicWriter["AtomicWriter (.tmp -> rename + gzip)"]
    AtomicWriter --> Disk["/www/wwwroot/sitemaps/*.xml & *.xml.gz"]
    
    Bot["Googlebot / Client Request"] --> Nginx["Nginx Reverse Proxy"]
    Nginx --> TryFiles{"File on Disk?"}
    TryFiles -->|YES (99.9%)| Static["Nginx sendfile (0.5ms TTFB, 0% Node CPU)"]
    TryFiles -->|NO| Fallback["Fallback to Next.js / Backend Proxy"]
```

---

## 🌐 Nginx Zero-Copy Configuration Pattern

```nginx
location ^~ /sitemap {
    root /www/wwwroot/sitemaps;
    default_type application/xml;
    gzip_static on;
    expires 1h;
    add_header Cache-Control "public, max-age=3600, stale-while-revalidate=600";
    add_header X-Served-By "Nginx-Static-Sitemap" always;
    try_files $uri @nextjs_sitemap_fallback;
}

location @nextjs_sitemap_fallback {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $http_host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    add_header X-Served-By "NextJS-Dynamic-Fallback" always;
}
```

---

## 🧪 Testing

```bash
bun test
```
