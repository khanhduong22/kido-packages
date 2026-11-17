'use client';

import React, { useEffect, useId, useState } from 'react';
import { Check, Copy, AlertCircle, RefreshCw } from 'lucide-react';

export interface MermaidProps {
  chart?: string;
  children?: React.ReactNode;
  className?: string;
  title?: string;
}

function extractChartString(chart?: string, children?: React.ReactNode): string {
  if (typeof chart === 'string' && chart.trim().length > 0) {
    return chart.trim();
  }
  if (typeof children === 'string' && children.trim().length > 0) {
    return children.trim();
  }

  function extractText(node: any): string {
    if (typeof node === 'string') return node;
    if (typeof node === 'number') return String(node);
    if (!node) return '';
    if (Array.isArray(node)) return node.map(extractText).join('');
    if (node.props?.children) return extractText(node.props.children);
    return '';
  }

  return extractText(children).trim();
}

export function Mermaid({ chart, children, className = '', title }: MermaidProps) {
  const chartCode = extractChartString(chart, children);
  const rawId = useId();
  const safeId = `mermaid-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`;

  const [svg, setSvg] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [copied, setCopied] = useState<boolean>(false);

  useEffect(() => {
    let isMounted = true;

    if (!chartCode) {
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    const renderDiagram = async () => {
      try {
        const mermaidModule = await import('mermaid');
        const mermaid = mermaidModule.default || mermaidModule;

        mermaid.initialize({
          startOnLoad: false,
          theme: 'dark',
          securityLevel: 'loose',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
          themeVariables: {
            darkMode: true,
            background: 'transparent',
            mainBkg: '#121316',
            primaryColor: '#181a1f',
            primaryTextColor: '#f4f4f5',
            primaryBorderColor: '#3f3f46',
            lineColor: '#71717a',
            secondaryColor: '#1f2228',
            tertiaryColor: '#121316',
            secondaryBorderColor: '#3f3f46',
            secondaryTextColor: '#e4e4e7',
            clusterBkg: '#121316',
            clusterBorder: '#27272a',
            nodeBorder: '#3f3f46',
            edgeLabelBackground: '#181a1f',
            actorBkg: '#181a1f',
            actorBorder: '#3f3f46',
            actorTextColor: '#f4f4f5',
            actorLineColor: '#71717a',
            signalColor: '#71717a',
            signalTextColor: '#f4f4f5',
            labelBoxBkgColor: '#181a1f',
            labelBoxBorderColor: '#3f3f46',
            labelTextColor: '#f4f4f5',
            loopTextColor: '#f4f4f5',
            noteBkgColor: '#1f2228',
            noteBorderColor: '#3f3f46',
            noteTextColor: '#f4f4f5',
            fontSize: '13px',
          },
        });

        // Use a unique element ID for mermaid rendering
        const renderId = `render-${safeId}`;
        const { svg: renderedSvg } = await mermaid.render(renderId, chartCode);

        if (isMounted) {
          setSvg(renderedSvg);
          setLoading(false);
        }
      } catch (err: any) {
        if (isMounted) {
          console.error('[Mermaid] render error:', err);
          setError(err?.message || 'Failed to render Mermaid diagram');
          setLoading(false);
        }
      }
    };

    renderDiagram();

    return () => {
      isMounted = false;
      const el = document.getElementById(`drender-${safeId}`);
      if (el) el.remove();
    };
  }, [chartCode, safeId]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(chartCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.error('Failed to copy diagram code', e);
    }
  };

  return (
    <div
      className={`my-6 rounded-xl border border-zinc-800 bg-[#0d0e11] overflow-hidden shadow-2xl not-prose ${className}`}
    >
      {/* Header bar */}
      <div className="flex items-center justify-between border-b border-zinc-800/80 bg-[#121316] px-4 py-2 text-xs font-mono text-zinc-400">
        <div className="flex items-center gap-2">
          <span className="inline-block h-2 w-2 rounded-full bg-emerald-500/80" />
          <span className="font-semibold text-zinc-300">
            {title || 'Architecture Blueprint'}
          </span>
          <span className="text-[10px] text-zinc-500 uppercase tracking-wider">
            Mermaid
          </span>
        </div>
        <button
          onClick={handleCopy}
          type="button"
          title="Copy Mermaid source"
          className="flex items-center gap-1.5 rounded px-2 py-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition-colors cursor-pointer"
        >
          {copied ? (
            <>
              <Check className="h-3.5 w-3.5 text-emerald-400" />
              <span className="text-emerald-400">Copied</span>
            </>
          ) : (
            <>
              <Copy className="h-3.5 w-3.5" />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>

      {/* Main Diagram Canvas */}
      <div className="relative min-h-[160px] p-6 flex items-center justify-center overflow-x-auto bg-[#0d0e11]/90">
        {loading && (
          <div className="flex flex-col items-center justify-center gap-3 py-10 text-zinc-500 font-mono text-xs">
            <RefreshCw className="h-5 w-5 animate-spin text-zinc-400" />
            <span>Compiling architecture diagram...</span>
          </div>
        )}

        {error && (
          <div className="w-full rounded-lg border border-rose-900/40 bg-rose-950/20 p-4 text-xs font-mono text-rose-300">
            <div className="flex items-center gap-2 font-semibold text-rose-200 mb-2">
              <AlertCircle className="h-4 w-4 text-rose-400 shrink-0" />
              <span>Mermaid Compilation Error</span>
            </div>
            <p className="text-rose-400/90 mb-3">{error}</p>
            <pre className="p-3 bg-black/40 rounded border border-rose-900/30 overflow-x-auto text-[11px] text-zinc-300 font-mono">
              {chartCode}
            </pre>
          </div>
        )}

        {!loading && !error && svg && (
          <div
            className="w-full flex justify-center items-center [&_svg]:max-w-full [&_svg]:h-auto [&_svg]:filter [&_svg]:drop-shadow-sm"
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        )}
      </div>
    </div>
  );
}

export default Mermaid;
