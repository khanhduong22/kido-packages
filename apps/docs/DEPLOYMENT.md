# Deployment Runbook: Kido Bag (`bag.khanhdp.com`)

> **Application**: Kido Bag Documentation & Architecture Blueprints  
> **Production URL**: `https://bag.khanhdp.com`  
> **Host Infrastructure**: Origin Linux VPS (`<VPS_PUBLIC_IP>`)  
> **Reverse Proxy**: Caddy v2 (Docker container `caddy` in `kido-infra`)  
> **Edge Network**: Cloudflare CDN & DNS (Proxied, Full Strict TLS)  
> **Author & Maintainer**: Duong Phuc Khanh (`khanhdp`, Kido)

---

## 🏛️ Architecture Overview

```mermaid
flowchart LR
    User([Developer / AI Agent]) -->|HTTPS / TLS 1.3| CF[Cloudflare Edge CDN]
    CF -->|Origin TLS / Port 443| Caddy[Caddy Reverse Proxy<br/>Origin Linux VPS <VPS_PUBLIC_IP>]
    
    subgraph Host [Origin Linux VPS <VPS_PUBLIC_IP>]
        Caddy -->|Reverse Proxy :3005| Next[Next.js Docs Server<br/>Port 3005]
        Caddy -.->|Alternative: Static| StaticFiles[/var/www/bag.khanhdp.com/out]
    end
```

---

## 🚀 Deployment Options

### Option 1: Next.js Standalone Node.js Service (Recommended for SSR & Dynamic Search)

Next.js Turbopack generates a lightweight standalone runtime in `apps/docs/.next/standalone` containing only production-required `node_modules`.

#### 1. Build Artifacts
```bash
# In monorepo root: <REPO_ROOT>
pnpm --filter docs build
```

#### 2. Process Manager (PM2 or Systemd)
```bash
PORT=3005 HOSTNAME=127.0.0.1 node apps/docs/.next/standalone/apps/docs/server.js
```

Or via PM2 `ecosystem.config.cjs`:
```javascript
module.exports = {
  apps: [
    {
      name: 'kido-bag-docs',
      script: 'apps/docs/.next/standalone/apps/docs/server.js',
      cwd: '/opt/kido-packages',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        PORT: 3005,
        HOSTNAME: '127.0.0.1',
      },
      max_memory_restart: '300M',
    },
  ],
};
```

---

### Option 2: Docker Multi-Stage Container

For complete containerization on the VPS, use this optimized Dockerfile:

```dockerfile
# apps/docs/Dockerfile
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@latest --activate

FROM base AS builder
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/docs/package.json ./apps/docs/
COPY packages/ ./packages/
RUN pnpm install --frozen-lockfile

COPY apps/docs/ ./apps/docs/
RUN pnpm --filter docs build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3005
ENV HOSTNAME="0.0.0.0"

COPY --from=builder /app/apps/docs/.next/standalone ./
COPY --from=builder /app/apps/docs/.next/static ./apps/docs/.next/static
COPY --from=builder /app/apps/docs/public ./apps/docs/public

EXPOSE 3005
CMD ["node", "apps/docs/server.js"]
```

#### Docker Compose Snippet
```yaml
# docker-compose.bag.yml
services:
  bag-docs:
    image: kido-bag-docs:latest
    container_name: kido_bag_docs
    restart: unless-stopped
    ports:
      - "127.0.0.1:3005:3005"
    environment:
      NODE_ENV: production
      PORT: 3005
    networks:
      - caddy_net

networks:
  caddy_net:
    external: true
```

---

### Option 3: Static Export (`output: 'export'`)

If purely static hosting without dynamic server runtime is preferred:

1. Add `output: 'export'` to `apps/docs/next.config.mjs`.
2. Build static files:
   ```bash
   pnpm --filter docs build
   ```
3. Deploy the resulting `apps/docs/out/` directory to `/var/www/bag.khanhdp.com/out`.
4. Caddy serves static files with zero CPU overhead using `file_server`.

---

## 🔒 Caddy Configuration on Origin Linux VPS (`<VPS_PUBLIC_IP>`)

The configuration is already registered in `kido-infra/caddy/Caddyfile`:

```caddyfile
# Kido Bag — The Shadcn for Distributed Systems & High-Concurrency Architecture
bag.khanhdp.com {
	import cf_ssl
	import security_headers
	import compression
	reverse_proxy 127.0.0.1:3005 {
		import zero_downtime_proxy
	}
}
```

### Standalone Caddyfile Alternative (Without kido-infra Snippets)

```caddyfile
bag.khanhdp.com {
    encode zstd gzip
    
    # Reverse proxy to standalone Node/Docker service:
    reverse_proxy 127.0.0.1:3005
    
    # Or static files if using Option 3:
    # root * /var/www/bag.khanhdp.com/out
    # file_server {
    #     precompressed br zstd gzip
    # }

    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
        X-Content-Type-Options "nosniff"
        X-Frame-Options "DENY"
        Referrer-Policy "strict-origin-when-cross-origin"
    }

    # High-performance caching for LLM grounding endpoints:
    @seo_meta path /llms.txt /llms-full.txt /robots.txt /sitemap*.xml
    header @seo_meta Cache-Control "public, max-age=3600, s-maxage=604800, stale-while-revalidate=2592000"
    header @seo_meta CDN-Cache-Control "public, max-age=604800, s-maxage=604800, stale-while-revalidate=2592000"

    # Immutable static assets:
    @immutable path /_next/static/* *.woff2 *.woff *.webp *.svg *.png *.ico
    header @immutable Cache-Control "public, max-age=31536000, immutable"
}
```

### Reloading Caddy Zero-Downtime
On the Origin Linux VPS, execute:
```bash
docker exec -w /etc/caddy caddy caddy reload
# Or with systemd Caddy:
sudo systemctl reload caddy
```

---

## 🌐 Cloudflare DNS & SSL Settings

1. **DNS Record**:
   - Type: `A`
   - Name: `bag`
   - Content: `<VPS_PUBLIC_IP>`
   - Proxy status: `Proxied` (Orange Cloud)
2. **SSL/TLS Mode**: `Full (Strict)` with Cloudflare Origin CA certificate installed in Caddy (`/certs/fullchain.pem`).
3. **Edge Cache TTL**:
   - `/_next/static/*`: 1 month (immutable)
   - `/llms.txt`: 7 days (with SWR)
   - `/llms-full.txt`: 7 days (with SWR)

---

## 🧪 Verification & Health Check Commands

After deployment, verify the live endpoints:

```bash
# 1. Verify HTTP Status & Security Headers
curl -sI https://bag.khanhdp.com | grep -E "HTTP/|server|strict-transport|x-content-type"

# 2. Verify LLMs.txt Grounding & Preamble
curl -s https://bag.khanhdp.com/llms.txt | head -n 30

# 3. Verify Full LLMs documentation
curl -s https://bag.khanhdp.com/llms-full.txt | head -n 40

# 4. Verify Search API
curl -s https://bag.khanhdp.com/api/search?query=youtube | jq .
```
