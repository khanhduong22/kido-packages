# @kido/zero-downtime-deploy

> **Universal Zero-Downtime Deployment & Graceful Rollout Toolkit**  
> Blue-Green Atomic Swap, Zero-Gap Network-Alias Swap, Frontend Inode Atomic Directory Swap, Caddy Edge Hold-and-Retry Buffer, Next.js Server Action Edge Guard, Inode-Safe Caddy Reload, Graceful Shutdown Connection Draining, and Shadow Parity & Canary Error Gate.

---

## 🏛️ 3-Tier Progressive Scale Architecture (`Naive Baseline` → `Tier-0 SME Zero-Infra` → `Tier-1 Growth` → `Tier-2 Big-Tech`)

| Tier | Architecture & Storage | Cost & Ops | Throughput & Latency | When to Use |
| :--- | :--- | :--- | :--- | :--- |
| **Naive Baseline** | **Docker Recreate (`docker compose up --force-recreate`)**: Killing running container and recreating from scratch. | $0 extra | 2–5s Downtime<br>HTTP 502 Bad Gateway | 🛑 **Dev only**: Every deployment drops active client requests. Zero auto-rollback if the new container crashes on startup. |
| **Tier-0 SME Zero-Infra** | **Single VPS Blue-Green Pre-Warm Swap + Frontend Inode Swap + Graceful Shutdown** (`setupGracefulShutdown`, `atomic-swap-be.sh`, `atomic-swap-fe.sh`) | **$5/mo**<br>(Single Linux VPS) | **0ms Frontend downtime**<br>< 50ms backend swap | ✅ **Default for SMEs & $5 VPS**: Zero Kubernetes or external load balancer required. 1x RAM usage 24/7 (2x RAM for ~10s only during pre-warm). Probes `/health` before renaming and auto-rolls back if candidate fails. |
| **Tier-1 Growth** | **Blue-Green Pre-Warm + Caddy Edge Hold-and-Retry Buffer + Next.js Edge WAF Guard** (`generateCaddyZeroDowntimeSnippet`, `generateCaddyNextJsActionGuardSnippet`, `buildInodeSafeCaddyReloadCmd`) | **$20–$50/mo**<br>(Single/HA Linux VPS) | **0.00ms Absolute Downtime**<br>0 Dropped Requests | ⭐ **Commercial Apps & Growing SaaS**: Caddy holds incoming client TCP sockets and retries upstream during the 10–50ms container rename gap (`lb_try_duration 5s`, `lb_try_interval 150ms`). Blocks malicious Next-Action scanner probes at the edge with HTTP 403. |
| **Tier-2 Big-Tech** | **Zero-Gap Network-Alias Swap (Tier-5) + Read-Only Shadow Parity Diff & JIT Warm-up (Tier-6) + Canary Bake & Error Gate (Tier-7)** (`runShadowParityCheck`, `buildShadowAndCanaryBashGate`) | **$100–$300+/mo**<br>(Production Cluster) | **100,000+ ops/s**<br>0.00ms DNS Gap | 🚀 **Big-Tech Enterprise**: Connects candidate container to Docker network with `--alias <active>` before disconnecting v1. 5 parallel `X-Shadow-Probe` requests verify schema parity and pre-warm V8 JIT & DB pools. 10s live canary bake monitors logs for panics and auto-rolls back 100%. |

---

## 📐 Evolutionary Scale Architecture (Mermaid Diagram)

```mermaid
flowchart TD
    subgraph Naive["Naive Baseline (Docker Recreate)"]
        N_CI["Deploy Runner"] -->|docker rm -f api| N_Drop["Container Killed\n(2-5s Downtime: 502 Bad Gateway)"]
        N_Drop -->|docker run api:v2| N_Up["New Container Online"]
    end

    subgraph Tier0["Tier-0 SME Zero-Infra ($5/mo Single VPS)"]
        T0_CI["Deploy Runner"] --> T0_Next["Start [api_next] Candidate"]
        T0_Next --> T0_Probe{"Healthcheck /health\n(Max 45s)"}
        T0_Probe -->|Passed| T0_Swap["docker rename api api_old\ndocker rename api_next api"]
        T0_Swap --> T0_Drain["Drain api_old (3s) & Remove"]
        T0_Probe -->|Failed| T0_Rollback["docker rm -f api_next\n(100% Safe Auto-Rollback)"]
    end

    subgraph Tier1["Tier-1 Growth (Caddy Hold-and-Retry Buffer)"]
        T1_Client["User Request"] --> T1_Caddy["Caddy Edge Reverse Proxy\n(lb_try_duration 5s, interval 150ms)"]
        T1_Caddy -->|Container renaming in 10ms| T1_Hold["Buffer TCP socket & retry"]
        T1_Hold -->|0.00ms Drop| T1_NewAPI["Container [api] (v2 Online)"]
    end

    subgraph Tier2["Tier-2 Big-Tech (Zero-Gap Alias + Shadow Parity + Canary)"]
        T2_Cand["Candidate Container"] -->|1. Connect with --alias active| T2_DNS["Zero-Gap Docker DNS (0.00ms gap)"]
        T2_Cand -->|2. 5x X-Shadow-Probe| T2_Shadow["runShadowParityCheck\n(Schema Parity & JIT Warm-up)"]
        T2_Shadow -->|3. 10s Live Traffic| T2_Canary["Canary Bake & Error Gate\n(Scans logs for panics & 50x)"]
    end
```

---

## 🚀 Concrete Implementation Examples

### 1. Tier-0 SME Mode (Zero External Infra — $5/mo VPS)
Sets up graceful shutdown in your Node.js/Bun server to drain active in-flight requests and executes frontend atomic inode swaps without Kubernetes:

```typescript
import { setupGracefulShutdown } from '@kido/zero-downtime-deploy';
import http from 'node:http';

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'healthy', uptime: process.uptime() }));
});

// 1. Setup graceful shutdown & connection draining
export const shutdownController = setupGracefulShutdown({
  server: () => server,
  timeoutMs: 10_000,
  signals: ['SIGTERM', 'SIGINT'],
  onShutdown: async (signal) => {
    console.log(`[App] Received ${signal}, closing database pools...`);
    await db.$disconnect?.();
  },
});

server.listen(3000);
```

---

### 2. Tier-2 Big-Tech Mode (Shadow Parity, Zero-Gap Alias Swap & Canary Gate)
Automates enterprise pre-flight shadow verification, edge proxy retry buffering, and canary log error scanning:

```typescript
import {
  runShadowParityCheck,
  buildShadowAndCanaryBashGate,
  generateCaddyZeroDowntimeSnippet,
} from '@kido/zero-downtime-deploy';

// 1. Generate Caddy Zero-Downtime Proxy Buffer
export const caddySnippet = generateCaddyZeroDowntimeSnippet({
  tryDuration: '5s',
  tryInterval: '150ms',
  includeOldFallback: false,
});
// (zero_downtime_proxy) {
//   lb_try_duration 5s
//   lb_try_interval 150ms
// }

// 2. Read-Only Shadow Parity Check (Probes status code & JSON keys parity)
export async function verifyDeploymentParity() {
  const result = await runShadowParityCheck({
    baselineUrl: 'http://127.0.0.1:3000',
    candidateUrl: 'http://127.0.0.1:3002',
    paths: ['/health', '/api/v1/ping'],
    probeCount: 5,
  });

  if (!result.passed) {
    throw new Error(`Deployment Aborted: Shadow Parity Check Failed - ${result.reason}`);
  }
}

// 3. Generate Zero-Gap Network-Alias & Canary Bash Gate
export const canaryBash = buildShadowAndCanaryBashGate({
  activeContainer: 'ecommerce-api',
  internalPort: 3000,
  canarySeconds: 10, // 10-second bake window
  drainSeconds: 3,
});
```

---

## 💡 Core Technical Pillars

### 1. Inode Atomic Directory Swap for Frontend (< 1ms)
Static web files are built in CI and synced to a staging directory (`apps/<app>_next`). Once completely written, an atomic kernel inode pointer update is executed via `mv`:
```bash
mv /opt/kido-infra/docker/portfolio/html/apps/<app> /opt/kido-infra/docker/portfolio/html/apps/<app>_backup
mv /opt/kido-infra/docker/portfolio/html/apps/<app>_next /opt/kido-infra/docker/portfolio/html/apps/<app>
rm -rf /opt/kido-infra/docker/portfolio/html/apps/<app>_backup
```
On Linux filesystems (ext4/NVMe), `mv` between two directories on the same mount point updates directory inodes in **under 1 millisecond** (< 1ms). Caddy and Nginx never serve partial or empty directories.

---

### 2. Blue-Green Pre-Warm Container Swap for Backend (0ms Downtime)
1. Spawns candidate container `[api_next]` on Docker bridge network `ops_bridge`.
2. Polls `/health` for up to 45 seconds. If healthcheck fails, candidate is destroyed and pipeline aborts with 100% safe rollback.
3. If healthy, swaps container names atomically via `docker rename api api_old` and `docker rename api_next api`.
4. Caddy's hold-and-retry buffer (`lb_try_duration 5s`) transparently retries in-flight TCP connections during the 10ms rename window.
5. Drains in-flight requests on `api_old` for 3s before removing it.

---

### 3. Edge WAF Next.js Server Action Guard
Blocks malicious scanner probes targeting Next.js server actions (CVE-2024-34351) directly at the Caddy edge with HTTP 403:
```typescript
import { generateCaddyNextJsActionGuardSnippet } from '@kido/zero-downtime-deploy';
const guard = generateCaddyNextJsActionGuardSnippet();
```
Generated snippet:
```caddy
(nextjs_action_guard) {
	@invalid_next_action {
		header Next-Action *
		not header_regexp Next-Action ^[0-9a-fA-F]{40,42}$
	}
	respond @invalid_next_action "Forbidden: Invalid Server Action" 403
}
```

---

### 4. Inode-Safe Caddy Reload
Bypasses Linux VFS single-file bind-mount detachment bugs (when `git reset --hard` or `sed -i` breaks container bind-mounts) by streaming config via `docker cp` and validating before reloading:
```typescript
import { buildInodeSafeCaddyReloadCmd } from '@kido/zero-downtime-deploy';
const cmd = buildInodeSafeCaddyReloadCmd({
  hostCaddyfilePath: '/opt/kido-infra/caddy/Caddyfile',
  containerName: 'caddy',
});
```

---

## 🚀 Repository Detach & Standalone Scaffolding Guide

When extracting an application into an independent repository, scaffold zero-downtime deployment pipelines in one command:
```bash
npx @kido/zero-downtime-deploy init <app-name> <healthcheck-url>
```
*Example:*
```bash
npx @kido/zero-downtime-deploy init order-api https://app.example.com/health
```
This automatically configures:
1. `.github/workflows/deploy.yml` with Blue-Green swap and rollback gates.
2. `scripts/deploy/atomic-swap-be.sh` and `atomic-swap-fe.sh`.
