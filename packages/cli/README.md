# `@kido/cli` (`kido-bag`)

> **The Shadcn for Distributed Systems & High-Concurrency Primitives**  
> Lightweight, zero-bloat CLI that powers `npx kido-bag add <slice>` and `npx kido-bag list`.

---

## ⚡ Features

- **Surgical Slice Cherry-Picking (`npx kido-bag add <slice>`)**: Copies only the exact isolated module needed into `src/lib/kido/` with 0 bytes of unused code and zero extra dependencies.
- **Master Blueprint Extraction (`npx kido-bag add <blueprint-id>`)**: Extracts composite architecture recipes (e.g. `01` for YouTube View Counter or `02` for 5-Stage RAG) with all composed slices.
- **Automatic Dependency Resolution**: Scans copied source code for external npm dependencies (`zod`, `ioredis`, `hono`, etc.) and formats ready-to-run installation commands (`pnpm add ...`).
- **Interactive Registry Querying (`npx kido-bag list`)**: Categorized by 6 domain pillars with filtering by pillar, blueprint, keyword search, or JSON output.
- **Detailed Slice & Blueprint Inspection (`npx kido-bag info <name>`)**: Inspect exports, source paths, and external dependencies before extracting.
- **Zero Runtime Dependencies**: Pure TypeScript & Node.js stdlib (<20ms startup time).

---

## 🚀 Quick Start

### 1. List Blueprints & Domain Slices
```bash
# List all 12 Master Architecture Blueprints and Domain Slices
npx kido-bag list

# List only Master Architecture Blueprints
npx kido-bag list --blueprints

# Filter slices by Pillar (1 to 6)
npx kido-bag list --pillar 2

# Search blueprints & slices by keyword
npx kido-bag list --search "counter"

# Machine-readable JSON output
npx kido-bag list --json
```

### 2. Cherry-Pick an Isolated Slice
```bash
# Extract slotted-counter into default destination (src/lib/kido)
npx kido-bag add slotted-counter

# Specify custom destination directory
npx kido-bag add rpm-rate-guard --out src/lib/stream

# Preview extraction without writing to disk
npx kido-bag add micro-batch-coalescer --dry-run

# Overwrite existing files
npx kido-bag add tenant-context --force
```

### 3. Extract Master Composite Architecture Blueprints
```bash
# Extract Blueprint 01 (YouTube-Scale Video View Counter)
npx kido-bag add 01

# Extract Blueprint 02 (5-Stage Zero-Spam RAG & AI Copilot)
npx kido-bag add 02
```

### 4. Inspect Slices or Blueprints
```bash
# View metadata, exports, and dependencies for a slice
npx kido-bag info slotted-counter

# View blueprint architecture paradigm and composed slices
npx kido-bag info 01
```

---

## 🧪 Testing & Verification

```bash
# Run unit tests
pnpm test

# Typecheck
pnpm typecheck

# Build bundle (CJS + ESM + Types)
pnpm build
```
