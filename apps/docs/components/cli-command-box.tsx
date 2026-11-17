'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { ArrowUpRight, Check, Copy, Terminal } from 'lucide-react';

type RuntimeMode = 'python' | 'typescript';

interface SuiteCommand {
  id: string;
  label: string;
  docHref: string;
  commands: Record<RuntimeMode, string>;
  hint: Record<RuntimeMode, string>;
}

const SUITE_COMMANDS: SuiteCommand[] = [
  {
    id: 'hot-counter',
    label: 'hot-counter',
    docHref: '/docs/packages/02-concurrency-and-caching/hot-counter',
    commands: {
      python:
        'curl -fsSL https://bag.khanhdp.com/llms.mdx/docs/packages/02-concurrency-and-caching/hot-counter/content.md',
      typescript: 'npx kido-bag add hot-counter/youtube-view-engine',
    },
    hint: {
      python: 'Python 3.12+ (FastAPI / valkey.asyncio) reference + Invariant Spec — zero PyPI lock-in',
      typescript: 'White-box shadcn copy into src/lib/ — zero black-box npm dependencies',
    },
  },
  {
    id: 'ai-stream',
    label: 'ai-stream',
    docHref: '/docs/packages/02-concurrency-and-caching/ai-stream',
    commands: {
      python:
        'curl -fsSL https://bag.khanhdp.com/llms.mdx/docs/packages/02-concurrency-and-caching/ai-stream/content.md',
      typescript: 'npx kido-bag add ai-stream/sse-protocol',
    },
    hint: {
      python: 'Python 3.12+ (FastAPI StreamingResponse / dual RPM-TPM guard) + Invariant Spec',
      typescript: 'Zero-dep UTF-8 SSE parser, edge flush headers & dual RPM/TPM guard',
    },
  },
  {
    id: 'resilient-cache',
    label: 'resilient-cache',
    docHref: '/docs/packages/02-concurrency-and-caching/resilient-cache',
    commands: {
      python:
        'curl -fsSL https://bag.khanhdp.com/llms.mdx/docs/packages/02-concurrency-and-caching/resilient-cache/content.md',
      typescript: 'npx kido-bag add resilient-cache/semantic-cache',
    },
    hint: {
      python: 'Python 3.12+ (asyncio SingleFlight, Lua flash-sale & cosine cache) + Invariant Spec',
      typescript: 'Stampede-safe L1/L2 cache, atomic Lua reservation & semantic RRF slice',
    },
  },
];

export function CliCommandBox() {
  const [activeId, setActiveId] = useState(SUITE_COMMANDS[0].id);
  const [runtime, setRuntime] = useState<RuntimeMode>('python');
  const [copied, setCopied] = useState(false);

  const activeSuite = SUITE_COMMANDS.find((c) => c.id === activeId) ?? SUITE_COMMANDS[0];
  const activeCmd = activeSuite.commands[runtime];

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(activeCmd);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy command', err);
    }
  };

  return (
    <div className="w-full max-w-3xl mx-auto rounded-xl border border-zinc-800 bg-[#121316]/90 p-2 shadow-2xl backdrop-blur-md">
      {/* Top Bar: Suite Tabs + Polyglot Runtime Toggle */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-zinc-800/80 px-3 pb-2.5 pt-1">
        <div className="flex items-center flex-wrap gap-1.5">
          <Terminal className="h-4 w-4 text-amber-500 mr-1" />
          {SUITE_COMMANDS.map((suite) => (
            <button
              key={suite.id}
              onClick={() => setActiveId(suite.id)}
              type="button"
              className={`rounded px-2.5 py-1 text-xs font-mono transition-colors cursor-pointer ${
                activeId === suite.id
                  ? 'bg-zinc-800 text-amber-400 font-semibold border border-zinc-700/60'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40'
              }`}
            >
              {suite.label}
            </button>
          ))}
        </div>

        {/* Equal Python + TypeScript Switcher */}
        <div className="flex items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-900/90 p-0.5 self-start sm:self-auto">
          <button
            type="button"
            onClick={() => setRuntime('python')}
            className={`rounded-md px-2.5 py-1 text-[11px] font-mono transition-colors cursor-pointer ${
              runtime === 'python'
                ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 font-semibold'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            Python 3.12+
          </button>
          <button
            type="button"
            onClick={() => setRuntime('typescript')}
            className={`rounded-md px-2.5 py-1 text-[11px] font-mono transition-colors cursor-pointer ${
              runtime === 'typescript'
                ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40 font-semibold'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            TypeScript
          </button>
        </div>
      </div>

      {/* Terminal Command Row */}
      <div className="flex items-center justify-between gap-3 px-3 py-3 font-mono text-xs sm:text-sm">
        <div className="flex items-center gap-2 overflow-x-auto scrollbar-none text-left">
          <span className="select-none text-amber-500/90 font-bold">$</span>
          <span className="text-zinc-200 tracking-tight whitespace-nowrap">{activeCmd}</span>
        </div>
        <button
          onClick={handleCopy}
          type="button"
          aria-label="Copy reference command"
          title="Copy command to clipboard"
          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-zinc-700/60 bg-zinc-800/80 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700 hover:text-white transition-all cursor-pointer"
        >
          {copied ? (
            <>
              <Check className="h-3.5 w-3.5 text-emerald-400" />
              <span className="text-emerald-400 font-medium">Copied</span>
            </>
          ) : (
            <>
              <Copy className="h-3.5 w-3.5 text-zinc-400" />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>

      {/* Bottom White-Box Hint & Direct Spec Link */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-t border-zinc-800/60 px-3 pt-2 pb-1 text-[11px] font-mono text-zinc-400">
        <span>{activeSuite.hint[runtime]}</span>
        <Link
          href={activeSuite.docHref}
          className="inline-flex items-center gap-1 text-amber-400 hover:text-amber-300 shrink-0 transition-colors"
        >
          <span>Inspect Spec &amp; Dual Code</span>
          <ArrowUpRight className="h-3 w-3" />
        </Link>
      </div>
    </div>
  );
}

export default CliCommandBox;
