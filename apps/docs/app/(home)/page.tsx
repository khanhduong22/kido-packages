import Link from 'next/link';
import {
  ArrowRight,
  ExternalLink,
  Zap,
  Boxes,
  Bot,
  FileText,
} from 'lucide-react';
import { CliCommandBox } from '@/components/cli-command-box';
import { BlueprintMatrix } from '@/components/blueprint-matrix';
import { authorUrl, gitConfig } from '@/lib/shared';

function GithubIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" {...props}>
      <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
    </svg>
  );
}

const CORE_PILLARS = [
  {
    icon: Boxes,
    title: 'Karpathy nanoGPT + shadcn Stance',
    desc: 'Zero black-box npm or PyPI maintainer lock-in. Read the distilled reference code, understand every line, and copy it directly into your repository.',
  },
  {
    icon: Zap,
    title: 'Polyglot Python 3.12+ & TypeScript',
    desc: 'First-class reference implementations in Python 3.12+ (FastAPI / asyncio / asyncpg / valkey) alongside zero-dependency TypeScript + SQL.',
  },
  {
    icon: Bot,
    title: 'Invariant-First AI Agent Porting',
    desc: 'Every suite pairs Big-O complexity proofs and concurrency boundaries with an AI Agent Porting Spec for accurate cross-language translation.',
  },
];

export default function HomePage() {
  return (
    <div className="relative min-h-screen bg-[#0d0e11] text-[#f4f4f5] selection:bg-amber-500/30 selection:text-white">
      {/* Background ambient radial gradients */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute top-[-10%] left-1/2 -translate-x-1/2 w-[1000px] h-[500px] bg-gradient-to-b from-amber-500/10 via-zinc-800/10 to-transparent blur-3xl opacity-60" />
        <div className="absolute top-[30%] left-1/2 -translate-x-1/2 w-[800px] h-[400px] bg-gradient-to-b from-emerald-500/5 to-transparent blur-3xl opacity-40" />
      </div>

      <div className="relative z-10 mx-auto max-w-6xl px-4 pt-16 pb-24 sm:px-6 lg:px-8">
        {/* Top Authority Pill */}
        <div className="flex justify-center mb-8">
          <a
            href={authorUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="group inline-flex items-center gap-2 rounded-full border border-zinc-800 bg-[#121316]/90 px-4 py-1.5 text-xs font-mono text-zinc-300 backdrop-blur-md hover:border-amber-500/60 transition-all hover:bg-zinc-800"
          >
            <span className="flex h-2 w-2 rounded-full bg-amber-500 animate-pulse" />
            <span>Engineered by Duong Phuc Khanh</span>
            <span className="text-zinc-500">•</span>
            <span className="text-zinc-400 group-hover:text-amber-400 flex items-center gap-1 transition-colors">
              khanhdp.com <ExternalLink className="h-3 w-3" />
            </span>
          </a>
        </div>

        {/* Hero Section */}
        <div className="text-center mb-12">
          <div className="inline-block mb-3 px-3 py-1 rounded border border-zinc-800 bg-zinc-900/60 text-[11px] font-mono tracking-widest text-zinc-400 uppercase">
            8 Systems Suites · 8 Architecture Blueprints · White-Box Reference
          </div>
          <h1 className="text-4xl sm:text-6xl font-extrabold tracking-tight text-white mb-6 leading-tight">
            Kido Bag —{' '}
            <span className="bg-gradient-to-r from-amber-400 via-amber-200 to-amber-500 bg-clip-text text-transparent">
              The nanoGPT + Shadcn for Distributed Systems
            </span>
          </h1>
          <p className="mx-auto max-w-3xl text-lg sm:text-xl text-zinc-400 font-normal leading-relaxed mb-8">
            8 Principal-Grade Systems Suites &amp; 8 Production Architecture Blueprints by{' '}
            <a
              href={authorUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-zinc-200 underline decoration-zinc-700 underline-offset-4 hover:decoration-amber-400 hover:text-white transition-colors"
            >
              Duong Phuc Khanh (khanhdp.com)
            </a>
            . White-box, invariant-first reference code in{' '}
            <span className="text-emerald-300 font-medium">Python 3.12+ (FastAPI / asyncio)</span> and{' '}
            <span className="text-amber-300 font-medium">TypeScript</span> — built to copy, own, and port via AI coding agents.
          </p>

          {/* Interactive Polyglot Command Box */}
          <div className="mb-10">
            <CliCommandBox />
          </div>

          {/* Clean CTA Buttons */}
          <div className="flex flex-wrap items-center justify-center gap-4">
            <Link
              href="/docs"
              className="inline-flex items-center gap-2 rounded-lg bg-amber-500 px-6 py-3 text-sm font-semibold text-zinc-950 hover:bg-amber-400 transition-all shadow-lg shadow-amber-500/20 hover:shadow-amber-500/30 font-mono cursor-pointer"
            >
              Explore 8 Blueprints &amp; Suites
              <ArrowRight className="h-4 w-4" />
            </Link>
            <a
              href="/llms.txt"
              className="inline-flex items-center gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-5 py-3 text-sm font-medium text-emerald-300 hover:bg-emerald-500/20 hover:text-emerald-200 transition-all font-mono"
            >
              <FileText className="h-4 w-4" />
              llms.txt Agent Spec
            </a>
            <a
              href={`https://github.com/${gitConfig.user}/${gitConfig.repo}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-lg border border-zinc-800 bg-[#121316] px-5 py-3 text-sm font-medium text-zinc-300 hover:bg-zinc-800 hover:text-white hover:border-zinc-700 transition-all font-mono"
            >
              <GithubIcon className="h-4 w-4" />
              GitHub Repository
            </a>
          </div>
        </div>

        {/* 3 Core Value Pillars */}
        <div className="my-14 grid grid-cols-1 md:grid-cols-3 gap-6">
          {CORE_PILLARS.map((p, idx) => {
            const Icon = p.icon;
            return (
              <div
                key={idx}
                className="rounded-xl border border-zinc-800/80 bg-[#121316]/50 p-6 backdrop-blur-sm hover:border-zinc-700 transition-all"
              >
                <div className="mb-4 inline-flex h-10 w-10 items-center justify-center rounded-lg border border-zinc-700/60 bg-zinc-800/60 text-amber-400">
                  <Icon className="h-5 w-5" />
                </div>
                <h3 className="text-base font-semibold text-white mb-2">{p.title}</h3>
                <p className="text-sm text-zinc-400 leading-relaxed">{p.desc}</p>
              </div>
            );
          })}
        </div>

        {/* Interactive Architecture Blueprint & Suite Matrix */}
        <BlueprintMatrix />

        {/* Global Architecture Suite Stats */}
        <div className="my-16 rounded-2xl border border-zinc-800 bg-[#121316]/40 p-8 text-center backdrop-blur-md">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
            <div>
              <div className="text-3xl font-extrabold text-white font-mono">8</div>
              <div className="text-xs text-zinc-400 mt-1 uppercase font-mono">Crown Jewel Suites</div>
            </div>
            <div>
              <div className="text-3xl font-extrabold text-amber-400 font-mono">8</div>
              <div className="text-xs text-zinc-400 mt-1 uppercase font-mono">Battle Blueprints</div>
            </div>
            <div>
              <div className="text-3xl font-extrabold text-white font-mono">0</div>
              <div className="text-xs text-zinc-400 mt-1 uppercase font-mono">Black-Box Lock-In</div>
            </div>
            <div>
              <div className="text-3xl font-extrabold text-emerald-400 font-mono">Python + TS</div>
              <div className="text-xs text-zinc-400 mt-1 uppercase font-mono">FastAPI / asyncio &amp; TS</div>
            </div>
          </div>
        </div>

        {/* Bottom Callout / Footer Note */}
        <div className="mt-20 pt-8 border-t border-zinc-800/60 text-center text-xs font-mono text-zinc-500 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div>
            Built with rigor by{' '}
            <a
              href={authorUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-zinc-400 hover:text-amber-400 underline decoration-zinc-700 transition-colors"
            >
              Duong Phuc Khanh
            </a>{' '}
            • Systems Architect &amp; AI Pioneer
          </div>
          <div className="flex items-center gap-4">
            <a
              href="https://blog.khanhdp.com"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-zinc-300 transition-colors"
            >
              Engineering Blog
            </a>
            <span>•</span>
            <a
              href="https://truyen.khanhdp.com"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-zinc-300 transition-colors"
            >
              Dev War Stories
            </a>
            <span>•</span>
            <a
              href={`https://github.com/${gitConfig.user}/${gitConfig.repo}`}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-zinc-300 transition-colors"
            >
              GitHub
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
