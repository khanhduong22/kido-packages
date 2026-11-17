'use client';

import React, { useState, useMemo } from 'react';
import Link from 'next/link';
import {
  Search,
  Check,
  Copy,
  ArrowRight,
  Sparkles,
  Boxes,
  Layers,
  Terminal,
  X,
  ChevronDown,
  ChevronUp,
  Gauge,
} from 'lucide-react';

export type DomainType =
  | 'All'
  | 'Concurrency'
  | 'Distributed Data'
  | 'AI Systems'
  | 'FinTech'
  | 'Security';

export type ScaleDimensionType =
  | 'All'
  | 'Throughput'
  | 'P99 Latency'
  | 'Zero Oversell'
  | 'RLS';

export type ViewTab = 'all' | 'blueprints' | 'packages';

export interface BlueprintItem {
  id: string;
  num: string;
  title: string;
  slug: string;
  domain: Exclude<DomainType, 'All'>;
  scaleDimension: Exclude<ScaleDimensionType, 'All'>;
  metricBadge: string;
  desc: string;
  architectureHighlight: string;
  packages: string[];
  slices: string[];
  cliCommand: string;
  benchmark: string;
}

export interface PackageItem {
  num: number;
  name: string;
  shortName: string;
  href: string;
  domain: Exclude<DomainType, 'All'>;
  scaleDimension: Exclude<ScaleDimensionType, 'All'>;
  slicesCount: number;
  desc: string;
  keySlices: string[];
  cliCommand: string;
}

export const BLUEPRINTS: BlueprintItem[] = [
  {
    id: 'bp-01',
    num: '01',
    title: 'YouTube-Scale Video View Counter',
    slug: '01-youtube-view-counter',
    domain: 'Concurrency',
    scaleDimension: 'Throughput',
    metricBadge: '100k views/sec',
    desc: 'Adaptive 16-Slot Sharded Write + HyperLogLog Deduplication + Anti-F5 Bot Defense cutting database write contention by 99.9%.',
    architectureHighlight:
      '16-slot sharded DB rows + in-memory HLL deduplication + 1s micro-batch drain to PostgreSQL.',
    packages: ['@kido/hot-counter'],
    slices: [
      'youtube-view-engine',
      'valkey-write-behind',
      'slotted-counter',
      'micro-batch-coalescer',
    ],
    cliCommand: 'npx kido-bag add hot-counter/youtube-view-engine',
    benchmark: '100k views/sec → 99.9% DB write reduction; sub-millisecond hot-key writes',
  },
  {
    id: 'bp-02',
    num: '02',
    title: '5-Stage RAG & AI Copilot Pipeline',
    slug: '02-ai-rag-copilot',
    domain: 'AI Systems',
    scaleDimension: 'P99 Latency',
    metricBadge: 'TTFT < 350ms',
    desc: 'Semantic Vector Cache + Hybrid RRF fusion + UTF-8 safe SSE token streaming + Dual RPM/TPM rate guard with citation integrity.',
    architectureHighlight:
      'L1 exact hash (0ms) + L2 cosine similarity (0.92) + Dual RPM/TPM token bucket + edge-flushed SSE.',
    packages: ['@kido/resilient-cache', '@kido/ai-stream'],
    slices: ['semantic-cache', 'sse-protocol', 'rpm-rate-guard', 'edge-flush-headers'],
    cliCommand: 'npx kido-bag add ai-stream/sse-protocol',
    benchmark: '80% LLM cost reduction; TTFT < 350ms; zero mid-token UTF-8 corruption',
  },
  {
    id: 'bp-03',
    num: '03',
    title: 'Zero-Oversell Bounded Flash Sale Engine',
    slug: '03-flash-sale-engine',
    domain: 'Concurrency',
    scaleDimension: 'Zero Oversell',
    metricBadge: '50k req/sec',
    desc: 'Atomic Valkey Lua reservation + SingleFlight cache coalescing + Token Bucket rate limiter + bounded write-behind recovery.',
    architectureHighlight:
      'Atomic Redis/Valkey Lua EVALSHA reservation + SingleFlight deduplication + bounded write-behind drain.',
    packages: ['@kido/resilient-cache', '@kido/hot-counter'],
    slices: ['flashsale-engine', 'rate-limiter', 'in-flight', 'valkey-write-behind'],
    cliCommand: 'npx kido-bag add resilient-cache/flashsale-engine',
    benchmark: '50,000 req/sec; zero negative inventory; atomic stock rollback',
  },
  {
    id: 'bp-04',
    num: '04',
    title: 'Distributed Database Sharding & Partitioning',
    slug: '04-distributed-db-sharding',
    domain: 'Distributed Data',
    scaleDimension: 'Throughput',
    metricBadge: '150 VNodes · RF=3',
    desc: 'MurmurHash3 single-shard routing + 150-VNode consistent hash ring (RF=3) + 2-level compound partitioning eliminating hot-shard bottlenecks.',
    architectureHighlight:
      "Consistent hash ring with 150 vnodes/node + PostgreSQL 2-level hash-range sub-partitioning + Little's Law headroom guard.",
    packages: ['@kido/db-sharding'],
    slices: ['murmurhash', 'hash-router', 'consistent-hash-ring', 'compound-partition'],
    cliCommand: 'npx kido-bag add db-sharding/consistent-hash-ring',
    benchmark: 'Zero scatter-gather hot paths; minimal key migration during shard expansion',
  },
  {
    id: 'bp-05',
    num: '05',
    title: 'Twitter/X Hybrid Fanout Feed Engine',
    slug: '05-twitter-hybrid-feed',
    domain: 'Concurrency',
    scaleDimension: 'Throughput',
    metricBadge: 'Hybrid Push/Pull',
    desc: 'Fanout-on-write for standard accounts paired with fanout-on-read for celebrity nodes using an O(N log K) max-heap merger.',
    architectureHighlight:
      'Push fanout (<25k followers) + Pull bypass (celebrity) + O(N log K) Binary Max-Heap timeline merger.',
    packages: ['@kido/hybrid-feed'],
    slices: ['hybrid-fanout-engine', 'k-way-cursor-merger', 'valkey-timeline-mixer'],
    cliCommand: 'npx kido-bag add hybrid-feed/k-way-cursor-merger',
    benchmark: '20,600 req/s → 1,201 req/s DB load; Base64URL keyset cursor pagination',
  },
  {
    id: 'bp-06',
    num: '06',
    title: 'PostgreSQL Logical CDC Outbox & Cold Archiver',
    slug: '07-pg-cdc-outbox',
    domain: 'Distributed Data',
    scaleDimension: 'Throughput',
    metricBadge: 'Sub-5ms Lag',
    desc: 'Native WAL replication slot polling + idempotent LSN tracker + zero-lock concurrent partition detaching + Litestream PITR.',
    architectureHighlight:
      'Native PG WAL slot poller bypassing row locks + two-phase peek-then-ack + zero-lock partition detach.',
    packages: ['@kido/async-sync'],
    slices: ['pg-cdc-stream', 'pg-partition-archiver', 'pg-replication', 'uuidv7'],
    cliCommand: 'npx kido-bag add async-sync/pg-cdc-stream',
    benchmark: 'Sub-5ms event lag; zero-lock concurrent historical partition archiving',
  },
  {
    id: 'bp-07',
    num: '07',
    title: 'Multi-Tenant SaaS Isolation & Snapshot',
    slug: '08-multitenant-snapshot',
    domain: 'Security',
    scaleDimension: 'RLS',
    metricBadge: '100% RLS Safe',
    desc: 'Scoped tenant context + ORM RLS query injection + ABAC policy engine + Merkle surgical snapshot + safe demo sandbox.',
    architectureHighlight:
      'Automatic tenant filter injection on all queries + Merkle checksum snapshot + safe persona sandbox.',
    packages: ['@kido/tenant-guard'],
    slices: ['tenant-context', 'rls-query-filter', 'team-rbac', 'snapshot', 'sandbox'],
    cliCommand: 'npx kido-bag add tenant-guard/rls-query-filter',
    benchmark: '100% cross-tenant isolation; tamper-evident snapshot verification',
  },
  {
    id: 'bp-08',
    num: '08',
    title: 'Double-Entry Financial Escrow & Idempotency',
    slug: '11-double-entry-fintech',
    domain: 'FinTech',
    scaleDimension: 'Zero Oversell',
    metricBadge: 'Zero Drift',
    desc: 'Immutable double-entry ledger (Sum(Debit) = Sum(Credit)) + Stripe-style atomic recovery-point idempotency + crypto micro-decimal reconciliation.',
    architectureHighlight:
      'Recovery-point state machine (started -> locked -> ledger_posted -> completed) + strict ∑ Debit = ∑ Credit invariant.',
    packages: ['@kido/wallet-ledger'],
    slices: ['ledger', 'withdrawal', 'crypto-reconcile', 'portfolio-nav'],
    cliCommand: 'npx kido-bag add wallet-ledger/ledger',
    benchmark: 'Zero balance drift; crash-safe atomic idempotency across retries',
  },
];

export const PACKAGES: PackageItem[] = [
  {
    num: 1,
    name: '@kido/hot-counter',
    shortName: 'hot-counter',
    href: '/docs/packages/02-concurrency-and-caching/hot-counter',
    domain: 'Concurrency',
    scaleDimension: 'Throughput',
    slicesCount: 5,
    desc: 'High-concurrency counter suite with 16-slot sharded rows, HyperLogLog anti-F5 dedupe, Valkey write-behind drain, and micro-batch coalescing.',
    keySlices: ['youtube-view-engine', 'valkey-write-behind', 'slotted-counter', 'micro-batch-coalescer'],
    cliCommand: 'npx kido-bag add hot-counter',
  },
  {
    num: 2,
    name: '@kido/ai-stream',
    shortName: 'ai-stream',
    href: '/docs/packages/02-concurrency-and-caching/ai-stream',
    domain: 'AI Systems',
    scaleDimension: 'P99 Latency',
    slicesCount: 5,
    desc: 'UTF-8 multi-byte safe SSE token streaming, fetch ReadableStream engine, edge proxy flush headers, and dual RPM/TPM rate guard.',
    keySlices: ['sse-protocol', 'rpm-rate-guard', 'readable-stream-engine', 'edge-flush-headers'],
    cliCommand: 'npx kido-bag add ai-stream',
  },
  {
    num: 3,
    name: '@kido/resilient-cache',
    shortName: 'resilient-cache',
    href: '/docs/packages/02-concurrency-and-caching/resilient-cache',
    domain: 'Concurrency',
    scaleDimension: 'P99 Latency',
    slicesCount: 7,
    desc: 'Stampede-safe L1/L2 SingleFlight cache, circuit breaker, sliding-window rate limiter, atomic Lua flash-sale engine, and semantic vector cache.',
    keySlices: ['semantic-cache', 'flashsale-engine', 'in-flight', 'rate-limiter'],
    cliCommand: 'npx kido-bag add resilient-cache',
  },
  {
    num: 4,
    name: '@kido/db-sharding',
    shortName: 'db-sharding',
    href: '/docs/packages/02-concurrency-and-caching/db-sharding',
    domain: 'Distributed Data',
    scaleDimension: 'Throughput',
    slicesCount: 5,
    desc: "MurmurHash3 shard router, 150-VNode consistent hash ring (RF=3), 2-level compound partitioning, and Little's Law capacity headroom guard.",
    keySlices: ['murmurhash', 'hash-router', 'consistent-hash-ring', 'compound-partition'],
    cliCommand: 'npx kido-bag add db-sharding',
  },
  {
    num: 5,
    name: '@kido/hybrid-feed',
    shortName: 'hybrid-feed',
    href: '/docs/packages/02-concurrency-and-caching/hybrid-feed',
    domain: 'Concurrency',
    scaleDimension: 'Throughput',
    slicesCount: 4,
    desc: 'Twitter/X push/pull hybrid fanout engine, O(N log K) binary max-heap cursor merger, and Valkey capped sorted-set timeline mixer.',
    keySlices: ['hybrid-fanout-engine', 'k-way-cursor-merger', 'valkey-timeline-mixer'],
    cliCommand: 'npx kido-bag add hybrid-feed',
  },
  {
    num: 6,
    name: '@kido/async-sync',
    shortName: 'async-sync',
    href: '/docs/packages/02-concurrency-and-caching/async-sync',
    domain: 'Distributed Data',
    scaleDimension: 'Throughput',
    slicesCount: 7,
    desc: 'PostgreSQL logical WAL CDC stream, LSN replication monitor, zero-lock cold partition archiver, Litestream PITR, and monotonic UUIDv7 outbox.',
    keySlices: ['pg-cdc-stream', 'pg-partition-archiver', 'pg-replication', 'uuidv7'],
    cliCommand: 'npx kido-bag add async-sync',
  },
  {
    num: 7,
    name: '@kido/tenant-guard',
    shortName: 'tenant-guard',
    href: '/docs/packages/01-security-and-isolation/tenant-guard',
    domain: 'Security',
    scaleDimension: 'RLS',
    slicesCount: 8,
    desc: 'Multi-tenant request context isolation, ORM RLS query filter, dynamic RBAC/ABAC guard, Merkle surgical snapshot, and safe demo sandbox.',
    keySlices: ['tenant-context', 'rls-query-filter', 'team-rbac', 'snapshot'],
    cliCommand: 'npx kido-bag add tenant-guard',
  },
  {
    num: 8,
    name: '@kido/wallet-ledger',
    shortName: 'wallet-ledger',
    href: '/docs/packages/04-fintech-and-payments/wallet-ledger',
    domain: 'FinTech',
    scaleDimension: 'Zero Oversell',
    slicesCount: 6,
    desc: 'Immutable double-entry escrow ledger, atomic recovery-point idempotency, micro-decimal crypto reconciliation, fraud guard, and portfolio NAV.',
    keySlices: ['ledger', 'withdrawal', 'crypto-reconcile', 'portfolio-nav'],
    cliCommand: 'npx kido-bag add wallet-ledger',
  },
];

const DOMAINS: DomainType[] = [
  'All',
  'Concurrency',
  'Distributed Data',
  'AI Systems',
  'FinTech',
  'Security',
];

const SCALE_DIMENSIONS: ScaleDimensionType[] = [
  'All',
  'Throughput',
  'P99 Latency',
  'Zero Oversell',
  'RLS',
];

export function BlueprintMatrix() {
  const [selectedDomain, setSelectedDomain] = useState<DomainType>('All');
  const [selectedScale, setSelectedScale] = useState<ScaleDimensionType>('All');
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<ViewTab>('all');
  const [copiedCmd, setCopiedCmd] = useState<string | null>(null);
  const [expandedBpId, setExpandedBpId] = useState<string | null>(null);

  const handleCopy = async (cmd: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    try {
      await navigator.clipboard.writeText(cmd);
      setCopiedCmd(cmd);
      setTimeout(() => setCopiedCmd(null), 2200);
    } catch (err) {
      console.error('Failed to copy', err);
    }
  };

  const filteredBlueprints = useMemo(() => {
    return BLUEPRINTS.filter((bp) => {
      const matchDomain = selectedDomain === 'All' || bp.domain === selectedDomain;
      const matchScale = selectedScale === 'All' || bp.scaleDimension === selectedScale;
      const q = searchQuery.toLowerCase().trim();
      const matchQuery =
        !q ||
        bp.title.toLowerCase().includes(q) ||
        bp.slug.toLowerCase().includes(q) ||
        bp.desc.toLowerCase().includes(q) ||
        bp.benchmark.toLowerCase().includes(q) ||
        bp.packages.some((p) => p.toLowerCase().includes(q)) ||
        bp.slices.some((s) => s.toLowerCase().includes(q));

      return matchDomain && matchScale && matchQuery;
    });
  }, [selectedDomain, selectedScale, searchQuery]);

  const filteredPackages = useMemo(() => {
    return PACKAGES.filter((pkg) => {
      const matchDomain = selectedDomain === 'All' || pkg.domain === selectedDomain;
      const matchScale = selectedScale === 'All' || pkg.scaleDimension === selectedScale;
      const q = searchQuery.toLowerCase().trim();
      const matchQuery =
        !q ||
        pkg.name.toLowerCase().includes(q) ||
        pkg.shortName.toLowerCase().includes(q) ||
        pkg.desc.toLowerCase().includes(q) ||
        pkg.keySlices.some((s) => s.toLowerCase().includes(q));

      return matchDomain && matchScale && matchQuery;
    });
  }, [selectedDomain, selectedScale, searchQuery]);

  const hasActiveFilters =
    selectedDomain !== 'All' || selectedScale !== 'All' || searchQuery !== '';

  const clearFilters = () => {
    setSelectedDomain('All');
    setSelectedScale('All');
    setSearchQuery('');
  };

  const domainColor = (domain: DomainType) => {
    switch (domain) {
      case 'Concurrency':
        return 'text-amber-400 border-amber-500/30 bg-amber-500/10';
      case 'Distributed Data':
        return 'text-blue-400 border-blue-500/30 bg-blue-500/10';
      case 'AI Systems':
        return 'text-cyan-400 border-cyan-500/30 bg-cyan-500/10';
      case 'FinTech':
        return 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10';
      case 'Security':
        return 'text-red-400 border-red-500/30 bg-red-500/10';
      default:
        return 'text-zinc-400 border-zinc-700/40 bg-zinc-800/40';
    }
  };

  const scaleColor = (scale: ScaleDimensionType) => {
    switch (scale) {
      case 'Throughput':
        return 'text-orange-400 border-orange-500/30 bg-orange-500/10';
      case 'P99 Latency':
        return 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10';
      case 'Zero Oversell':
        return 'text-amber-400 border-amber-500/30 bg-amber-500/10';
      case 'RLS':
        return 'text-indigo-400 border-indigo-500/30 bg-indigo-500/10';
      default:
        return 'text-zinc-400 border-zinc-700/40 bg-zinc-800/40';
    }
  };

  return (
    <section id="architecture-matrix" className="my-16 scroll-mt-20">
      {/* Header and Value Proposition */}
      <div className="mb-8 border-b border-zinc-800/80 pb-6">
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
          <div>
            <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-md border border-amber-500/30 bg-amber-500/10 text-xs font-mono text-amber-400 font-semibold mb-2">
              <Sparkles className="h-3.5 w-3.5" />
              <span>CROWN JEWEL ARCHITECTURE MATRIX</span>
            </div>
            <h2 className="text-3xl sm:text-4xl font-extrabold text-white tracking-tight">
              Interactive Blueprint &amp; Suite Matrix
            </h2>
            <p className="mt-2 text-sm sm:text-base text-zinc-400 max-w-2xl">
              Explore 8 production architecture blueprints and 8 Principal-grade systems suites —
              each documented in Python 3.12+ (FastAPI / asyncio) and TypeScript with explicit AI
              agent porting invariants.
            </p>
          </div>

          {/* Quick Metrics Badges */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="rounded-lg border border-zinc-800 bg-[#121316]/90 px-3 py-1.5 font-mono text-xs text-zinc-300">
              <span className="font-bold text-amber-400">8</span> Blueprints
            </div>
            <div className="rounded-lg border border-zinc-800 bg-[#121316]/90 px-3 py-1.5 font-mono text-xs text-zinc-300">
              <span className="font-bold text-emerald-400">8</span> Systems Suites
            </div>
            <div className="rounded-lg border border-zinc-800 bg-[#121316]/90 px-3 py-1.5 font-mono text-xs text-zinc-300">
              <span className="font-bold text-cyan-400">Python + TS</span> White-Box
            </div>
          </div>
        </div>
      </div>

      {/* Control Panel: Search, Tabs, and Multi-Faceted Filters */}
      <div className="rounded-2xl border border-zinc-800/90 bg-[#121316]/80 p-5 shadow-2xl backdrop-blur-md mb-8">
        {/* Top Controls: Search Input + View Tabs */}
        <div className="flex flex-col lg:flex-row items-stretch lg:items-center justify-between gap-4 mb-5">
          {/* Search Box */}
          <div className="relative flex-1">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-500 pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search blueprints, suites, Lua, Valkey, SSE, RLS, WAL CDC, idempotency..."
              className="w-full rounded-xl border border-zinc-800 bg-zinc-900/90 pl-10 pr-10 py-2.5 text-sm text-zinc-200 placeholder-zinc-500 focus:border-amber-500/70 focus:outline-none focus:ring-1 focus:ring-amber-500/50 transition-all font-mono"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 p-1"
                title="Clear search"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          {/* View Tab Selector */}
          <div className="flex items-center rounded-xl border border-zinc-800 bg-zinc-900/90 p-1">
            <button
              onClick={() => setActiveTab('all')}
              className={`rounded-lg px-3 py-1.5 text-xs font-mono transition-all cursor-pointer ${
                activeTab === 'all'
                  ? 'bg-amber-500 text-zinc-950 font-bold shadow'
                  : 'text-zinc-400 hover:text-white'
              }`}
            >
              All Items ({filteredBlueprints.length + filteredPackages.length})
            </button>
            <button
              onClick={() => setActiveTab('blueprints')}
              className={`rounded-lg px-3 py-1.5 text-xs font-mono transition-all cursor-pointer ${
                activeTab === 'blueprints'
                  ? 'bg-amber-500 text-zinc-950 font-bold shadow'
                  : 'text-zinc-400 hover:text-white'
              }`}
            >
              Blueprints ({filteredBlueprints.length})
            </button>
            <button
              onClick={() => setActiveTab('packages')}
              className={`rounded-lg px-3 py-1.5 text-xs font-mono transition-all cursor-pointer ${
                activeTab === 'packages'
                  ? 'bg-amber-500 text-zinc-950 font-bold shadow'
                  : 'text-zinc-400 hover:text-white'
              }`}
            >
              Suites ({filteredPackages.length})
            </button>
          </div>
        </div>

        {/* Filter Rows: Domain & Scale Dimension */}
        <div className="space-y-3 pt-3 border-t border-zinc-800/80">
          {/* Domain Filter Row */}
          <div className="flex flex-col sm:flex-row sm:items-center gap-2">
            <span className="text-xs font-mono text-zinc-400 w-32 shrink-0 flex items-center gap-1.5">
              <Layers className="h-3.5 w-3.5 text-amber-500" />
              <span>Domain:</span>
            </span>
            <div className="flex flex-wrap items-center gap-1.5">
              {DOMAINS.map((domain) => (
                <button
                  key={domain}
                  onClick={() => setSelectedDomain(domain)}
                  className={`rounded-lg px-2.5 py-1 text-xs font-mono transition-all cursor-pointer ${
                    selectedDomain === domain
                      ? 'border border-amber-500/60 bg-amber-500/20 text-amber-300 font-semibold shadow-sm'
                      : 'border border-zinc-800 bg-zinc-900/50 text-zinc-400 hover:text-zinc-200 hover:border-zinc-700'
                  }`}
                >
                  {domain}
                </button>
              ))}
            </div>
          </div>

          {/* Scale Dimension Filter Row */}
          <div className="flex flex-col sm:flex-row sm:items-center gap-2">
            <span className="text-xs font-mono text-zinc-400 w-32 shrink-0 flex items-center gap-1.5">
              <Gauge className="h-3.5 w-3.5 text-emerald-400" />
              <span>Scale Invariant:</span>
            </span>
            <div className="flex flex-wrap items-center gap-1.5">
              {SCALE_DIMENSIONS.map((dim) => (
                <button
                  key={dim}
                  onClick={() => setSelectedScale(dim)}
                  className={`rounded-lg px-2.5 py-1 text-xs font-mono transition-all cursor-pointer ${
                    selectedScale === dim
                      ? 'border border-emerald-500/60 bg-emerald-500/20 text-emerald-300 font-semibold shadow-sm'
                      : 'border border-zinc-800 bg-zinc-900/50 text-zinc-400 hover:text-zinc-200 hover:border-zinc-700'
                  }`}
                >
                  {dim}
                </button>
              ))}
            </div>
          </div>

          {/* Filter Status & Reset */}
          {hasActiveFilters && (
            <div className="flex items-center justify-between pt-2 text-xs font-mono text-zinc-500">
              <span>
                Showing {filteredBlueprints.length} blueprints and {filteredPackages.length} suites
                matching active filters.
              </span>
              <button
                onClick={clearFilters}
                className="text-amber-400 hover:text-amber-300 underline underline-offset-4 cursor-pointer"
              >
                Clear all filters
              </button>
            </div>
          )}
        </div>
      </div>

      {/* SECTION 1: 8 Production Architecture Blueprints */}
      {(activeTab === 'all' || activeTab === 'blueprints') && (
        <div className="mb-14">
          <div className="flex items-center justify-between mb-6 pb-2 border-b border-zinc-800/60">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-amber-500" />
              <h3 className="text-xl font-bold text-white font-mono">
                8 Production Architecture Blueprints
              </h3>
            </div>
            <span className="text-xs font-mono text-zinc-500">
              {filteredBlueprints.length} of 8 available
            </span>
          </div>

          {filteredBlueprints.length === 0 ? (
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-8 text-center text-zinc-500 font-mono text-sm">
              No blueprints match the selected domain or scale filter.
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {filteredBlueprints.map((bp) => {
                const isExpanded = expandedBpId === bp.id;
                const isCopied = copiedCmd === bp.cliCommand;

                return (
                  <div
                    key={bp.id}
                    className="group relative flex flex-col justify-between rounded-xl border border-zinc-800/80 bg-[#121316]/70 p-6 transition-all duration-200 hover:border-amber-500/50 hover:bg-[#15171c] hover:shadow-xl hover:shadow-black/40"
                  >
                    <div>
                      {/* Top Meta: BP Number, Domain, Metric Badge */}
                      <div className="flex items-center justify-between mb-3 gap-2">
                        <div className="flex items-center gap-1.5">
                          <span className="font-mono text-xs text-amber-400 font-bold px-2 py-0.5 rounded border border-amber-500/30 bg-amber-500/10">
                            BP-{bp.num}
                          </span>
                          <span
                            className={`font-mono text-[11px] px-2 py-0.5 rounded border ${domainColor(
                              bp.domain
                            )}`}
                          >
                            {bp.domain}
                          </span>
                        </div>
                        <span className="text-[11px] font-mono text-zinc-400 font-semibold px-2 py-0.5 rounded bg-zinc-800/80 border border-zinc-700/50">
                          {bp.metricBadge}
                        </span>
                      </div>

                      {/* Title & Description */}
                      <Link href={`/docs/blueprints/${bp.slug}`} className="block">
                        <h4 className="text-base font-bold text-white group-hover:text-amber-300 transition-colors mb-2">
                          {bp.title}
                        </h4>
                      </Link>
                      <p className="text-xs text-zinc-400 leading-relaxed mb-4">{bp.desc}</p>

                      {/* Scale Invariant Tag */}
                      <div className="mb-4 flex flex-wrap items-center gap-1.5">
                        <span
                          className={`inline-block font-mono text-[10px] px-2 py-0.5 rounded border ${scaleColor(
                            bp.scaleDimension
                          )}`}
                        >
                          Invariant: {bp.scaleDimension}
                        </span>
                        <span className="inline-block font-mono text-[10px] px-2 py-0.5 rounded border border-emerald-500/20 bg-emerald-500/5 text-emerald-300">
                          Python + TS
                        </span>
                      </div>

                      {/* Composed Slices Badges */}
                      <div className="mb-4">
                        <div className="text-[10px] font-mono uppercase tracking-wider text-zinc-500 mb-1.5">
                          Composed Reference Slices:
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {bp.slices.map((slice, sIdx) => (
                            <span
                              key={sIdx}
                              className="rounded bg-zinc-900 px-2 py-0.5 text-[10px] font-mono text-zinc-300 border border-zinc-800"
                            >
                              {slice}
                            </span>
                          ))}
                        </div>
                      </div>

                      {/* Expandable Architecture Invariant Details */}
                      {isExpanded && (
                        <div className="mt-3 p-3 rounded-lg border border-zinc-800/90 bg-zinc-950/80 font-mono text-xs text-zinc-300 space-y-2 mb-4 animate-in fade-in duration-200">
                          <div>
                            <span className="text-amber-400 font-semibold">Production Invariant:</span>{' '}
                            {bp.architectureHighlight}
                          </div>
                          <div>
                            <span className="text-emerald-400 font-semibold">Benchmark Proof:</span>{' '}
                            {bp.benchmark}
                          </div>
                          <div>
                            <span className="text-cyan-400 font-semibold">Composed Suites:</span>{' '}
                            {bp.packages.join(' + ')}
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Bottom Actions: CLI Command Copy + Inspect Link */}
                    <div className="pt-4 border-t border-zinc-800/80 space-y-3">
                      <div className="flex items-center justify-between gap-2 rounded-lg border border-zinc-800 bg-zinc-900/90 px-2.5 py-1.5 font-mono text-xs">
                        <div className="flex items-center gap-1.5 truncate text-zinc-300">
                          <Terminal className="h-3.5 w-3.5 text-amber-500 shrink-0" />
                          <span className="text-zinc-500">$</span>
                          <span className="truncate">{bp.cliCommand}</span>
                        </div>
                        <button
                          onClick={(e) => handleCopy(bp.cliCommand, e)}
                          type="button"
                          title="Copy install command"
                          aria-label={`Copy command ${bp.cliCommand}`}
                          className="flex shrink-0 items-center gap-1 rounded bg-zinc-800 px-2 py-1 text-[11px] text-zinc-300 hover:bg-zinc-700 hover:text-white transition-all cursor-pointer"
                        >
                          {isCopied ? (
                            <>
                              <Check className="h-3 w-3 text-emerald-400" />
                              <span className="text-emerald-400 font-semibold">Copied</span>
                            </>
                          ) : (
                            <>
                              <Copy className="h-3 w-3 text-zinc-400" />
                              <span>Copy</span>
                            </>
                          )}
                        </button>
                      </div>

                      <div className="flex items-center justify-between text-xs font-mono">
                        <button
                          onClick={() => setExpandedBpId(isExpanded ? null : bp.id)}
                          type="button"
                          className="flex items-center gap-1 text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer"
                        >
                          <span>{isExpanded ? 'Less info' : 'Architecture proof'}</span>
                          {isExpanded ? (
                            <ChevronUp className="h-3 w-3" />
                          ) : (
                            <ChevronDown className="h-3 w-3" />
                          )}
                        </button>

                        <Link
                          href={`/docs/blueprints/${bp.slug}`}
                          className="flex items-center gap-1 text-amber-400 hover:text-amber-300 transition-colors"
                        >
                          <span>Full Recipe</span>
                          <ArrowRight className="h-3 w-3 group-hover:translate-x-0.5 transition-transform" />
                        </Link>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* SECTION 2: 8 Crown Jewel Systems Suites */}
      {(activeTab === 'all' || activeTab === 'packages') && (
        <div>
          <div className="flex items-center justify-between mb-6 pb-2 border-b border-zinc-800/60">
            <div className="flex items-center gap-2">
              <Boxes className="h-4 w-4 text-emerald-400" />
              <h3 className="text-xl font-bold text-white font-mono">
                8 Crown Jewel Systems Suites
              </h3>
            </div>
            <span className="text-xs font-mono text-zinc-500">
              {filteredPackages.length} of 8 available
            </span>
          </div>

          {filteredPackages.length === 0 ? (
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-8 text-center text-zinc-500 font-mono text-sm">
              No suites match the selected domain or scale filter.
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
              {filteredPackages.map((pkg) => {
                const isCopied = copiedCmd === pkg.cliCommand;

                return (
                  <div
                    key={pkg.num}
                    className="group flex flex-col justify-between rounded-xl border border-zinc-800/70 bg-[#121316]/50 p-5 hover:border-emerald-500/40 hover:bg-[#15171c] transition-all"
                  >
                    <div>
                      {/* Meta Pill: Number, Domain, Scale Dimension */}
                      <div className="flex items-center justify-between mb-2.5">
                        <span className="font-mono text-xs text-zinc-500">
                          #0{pkg.num}
                        </span>
                        <div className="flex items-center gap-1.5">
                          <span
                            className={`font-mono text-[10px] px-2 py-0.5 rounded border ${domainColor(
                              pkg.domain
                            )}`}
                          >
                            {pkg.domain}
                          </span>
                          <span
                            className={`font-mono text-[10px] px-2 py-0.5 rounded border ${scaleColor(
                              pkg.scaleDimension
                            )}`}
                          >
                            {pkg.scaleDimension}
                          </span>
                        </div>
                      </div>

                      {/* Clickable Package Name */}
                      <Link href={pkg.href} className="block mb-1.5">
                        <h4 className="text-sm font-bold text-zinc-100 group-hover:text-emerald-300 transition-colors font-mono flex items-center justify-between">
                          <span>{pkg.name}</span>
                          <span className="text-[11px] font-normal text-zinc-500">
                            {pkg.slicesCount} slices · Py+TS
                          </span>
                        </h4>
                      </Link>

                      {/* Description */}
                      <p className="text-xs text-zinc-400 leading-relaxed mb-3">{pkg.desc}</p>

                      {/* Key Slices */}
                      <div className="flex flex-wrap gap-1 mb-4">
                        {pkg.keySlices.map((s, idx) => (
                          <span
                            key={idx}
                            className="rounded bg-zinc-900/80 px-1.5 py-0.5 text-[10px] font-mono text-zinc-400 border border-zinc-800"
                          >
                            {s}
                          </span>
                        ))}
                      </div>
                    </div>

                    {/* Bottom Copy Command + Direct Doc Link */}
                    <div className="pt-3 border-t border-zinc-800/80 space-y-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <div className="font-mono text-[11px] text-zinc-400 truncate flex items-center gap-1">
                          <Terminal className="h-3 w-3 text-amber-500 shrink-0" />
                          <span className="truncate">{pkg.cliCommand}</span>
                        </div>
                        <button
                          onClick={() => handleCopy(pkg.cliCommand)}
                          type="button"
                          className="shrink-0 flex items-center gap-1 rounded bg-zinc-800 px-2 py-1 text-[11px] font-mono text-zinc-300 hover:bg-zinc-700 hover:text-white transition-all cursor-pointer"
                          title="Copy install command"
                        >
                          {isCopied ? (
                            <>
                              <Check className="h-3 w-3 text-emerald-400" />
                              <span className="text-emerald-400 font-semibold">Copied</span>
                            </>
                          ) : (
                            <>
                              <Copy className="h-3 w-3 text-zinc-400" />
                              <span>Copy</span>
                            </>
                          )}
                        </button>
                      </div>

                      <div className="flex items-center justify-between text-xs font-mono">
                        <span className="text-[10px] text-zinc-500">White-Box Spec + Code</span>
                        <Link
                          href={pkg.href}
                          className="flex items-center gap-1 text-emerald-400 hover:text-emerald-300 transition-colors"
                        >
                          <span>Read Guide</span>
                          <ArrowRight className="h-3 w-3 group-hover:translate-x-0.5 transition-transform" />
                        </Link>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

export default BlueprintMatrix;
