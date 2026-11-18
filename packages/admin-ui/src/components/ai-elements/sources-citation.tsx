import * as React from 'react';
import {
  FileText,
  ShoppingBag,
  Globe,
  HelpCircle,
  Code2,
  Database,
  ExternalLink,
  ChevronDown,
  Layers,
  Sparkles,
  BookOpen,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import {
  TraceCollapsible,
  TraceCollapsibleTrigger,
  TraceCollapsibleContent,
} from './chain-of-thought';

// ============================================================================
// Types & Interfaces
// ============================================================================

export type SourceType =
  | 'document'
  | 'product'
  | 'web'
  | 'faq'
  | 'code'
  | 'vector_chunk'
  | 'custom';

export interface CitationSource {
  id: string | number;
  title: string;
  url?: string;
  snippet?: string;
  score?: number; // 0.0 to 1.0 or 0 to 100
  sourceType?: SourceType;
  metadata?: {
    path?: string;
    chunkIndex?: number;
    price?: number;
    author?: string;
    date?: string;
    sku?: string;
    pageNumber?: number;
    collection?: string;
    [key: string]: any;
  };
}

// ============================================================================
// Helpers
// ============================================================================

export function normalizeScore(score?: number): { percentage: number; label: string } | null {
  if (score === undefined || score === null || isNaN(score)) return null;
  // If score is <= 1.0, treat as decimal ratio (e.g., 0.88 -> 88%)
  const percentage = score <= 1.0 ? Math.round(score * 100) : Math.round(score);
  return {
    percentage,
    label: `${percentage}%`,
  };
}

export function resolveSourceIcon(sourceType?: SourceType): React.ReactNode {
  switch (sourceType) {
    case 'product':
      return <ShoppingBag className="size-3.5 text-amber-600 dark:text-amber-400" />;
    case 'web':
      return <Globe className="size-3.5 text-sky-600 dark:text-sky-400" />;
    case 'faq':
      return <HelpCircle className="size-3.5 text-purple-600 dark:text-purple-400" />;
    case 'code':
      return <Code2 className="size-3.5 text-emerald-600 dark:text-emerald-400" />;
    case 'vector_chunk':
      return <Layers className="size-3.5 text-indigo-600 dark:text-indigo-400" />;
    case 'document':
    default:
      return <FileText className="size-3.5 text-blue-600 dark:text-blue-400" />;
  }
}

// ============================================================================
// Score Badge Primitive
// ============================================================================

export interface SourceScoreBadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  score?: number;
  showPercentSymbol?: boolean;
}

export const SourceScoreBadge = React.forwardRef<HTMLSpanElement, SourceScoreBadgeProps>(
  ({ score, showPercentSymbol = true, className, ...props }, ref) => {
    const normalized = normalizeScore(score);
    if (!normalized) return null;

    const { percentage } = normalized;
    let colorClasses =
      'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-400';

    if (percentage < 65) {
      colorClasses =
        'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-400';
    } else if (percentage < 80) {
      colorClasses =
        'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-800 dark:bg-sky-950/60 dark:text-sky-400';
    }

    return (
      <span
        ref={ref}
        className={cn(
          'inline-flex items-center px-1.5 py-0.2 rounded-xs border text-[10px] font-semibold tabular-nums font-mono tracking-tight',
          colorClasses,
          className
        )}
        title={`Relevance score: ${percentage}%`}
        {...props}
      >
        {percentage}
        {showPercentSymbol && '%'}
      </span>
    );
  }
);
SourceScoreBadge.displayName = 'SourceScoreBadge';

// ============================================================================
// Source Chip Primitive
// ============================================================================

export interface SourceChipProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'onSelect'> {
  source: CitationSource;
  index?: number;
  onSelect?: (source: CitationSource) => void;
  showScore?: boolean;
}

export const SourceChip = React.forwardRef<HTMLDivElement, SourceChipProps>(
  ({ source, index, onSelect, showScore = true, className, ...props }, ref) => {
    const icon = resolveSourceIcon(source.sourceType);

    const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
      onSelect?.(source);
    };

    const inner = (
      <div
        ref={ref}
        onClick={handleClick}
        className={cn(
          'group inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-border/80 bg-background hover:bg-muted/60 text-xs text-foreground/90 transition-all hover:border-border shadow-2xs cursor-pointer select-none',
          className
        )}
        title={source.snippet || source.title}
        {...props}
      >
        <span className="shrink-0">{icon}</span>
        {index !== undefined && (
          <span className="text-[10px] font-bold text-muted-foreground group-hover:text-foreground">
            {`[${index + 1}]`}
          </span>
        )}
        <span className="truncate max-w-[140px] sm:max-w-[200px] font-medium">
          {source.title}
        </span>
        {showScore && source.score !== undefined && (
          <SourceScoreBadge score={source.score} />
        )}
        {source.url && (
          <ExternalLink className="size-2.5 text-muted-foreground/60 group-hover:text-foreground shrink-0" />
        )}
      </div>
    );

    if (source.url) {
      return (
        <a
          href={source.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-block text-inherit no-underline"
        >
          {inner}
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      );
    }

    return inner;
  }
);
SourceChip.displayName = 'SourceChip';

// ============================================================================
// Source Card Primitive
// ============================================================================

export interface SourceCardProps extends React.HTMLAttributes<HTMLDivElement> {
  source: CitationSource;
  index?: number;
  showSnippet?: boolean;
}

export const SourceCard = React.forwardRef<HTMLDivElement, SourceCardProps>(
  ({ source, index, showSnippet = true, className, ...props }, ref) => {
    const icon = resolveSourceIcon(source.sourceType);

    return (
      <div
        ref={ref}
        className={cn(
          'flex flex-col gap-1.5 p-2.5 rounded-md border border-border/70 bg-card hover:bg-muted/30 transition-colors text-xs text-card-foreground',
          className
        )}
        {...props}
      >
        {/* Card Header */}
        <div className="flex items-center justify-between gap-2 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="shrink-0">{icon}</span>
            {index !== undefined && (
              <span className="text-[11px] font-bold text-muted-foreground shrink-0">
                {`[${index + 1}]`}
              </span>
            )}
            <span className="font-medium text-foreground truncate" title={source.title}>
              {source.title}
            </span>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            {source.score !== undefined && <SourceScoreBadge score={source.score} />}
            {source.url && (
              <a
                href={source.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-muted-foreground hover:text-foreground inline-flex items-center p-0.5 rounded"
                title="Open original document"
              >
                <ExternalLink className="size-3" />
                <span className="sr-only">Open source in new tab</span>
              </a>
            )}
          </div>
        </div>

        {/* Snippet text */}
        {showSnippet && source.snippet && (
          <p className="text-[11px] leading-relaxed text-muted-foreground line-clamp-3 pl-5 border-l-2 border-border/40 my-0.5">
            {`"${source.snippet}"`}
          </p>
        )}

        {/* Metadata pills */}
        {source.metadata && (
          <div className="flex items-center flex-wrap gap-1.5 pt-0.5 pl-5 text-[10px] text-muted-foreground">
            {source.metadata.path && (
              <span className="font-mono bg-muted px-1.5 py-0.2 rounded border border-border/40 truncate max-w-[180px]">
                {source.metadata.path}
              </span>
            )}
            {source.metadata.chunkIndex !== undefined && (
              <span className="bg-muted px-1.5 py-0.2 rounded border border-border/40">
                {`Chunk #${source.metadata.chunkIndex}`}
              </span>
            )}
            {source.metadata.price !== undefined && (
              <span className="font-semibold text-foreground bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400 px-1.5 py-0.2 rounded border border-amber-200 dark:border-amber-800">
                {new Intl.NumberFormat('vi-VN', {
                  style: 'currency',
                  currency: 'VND',
                }).format(source.metadata.price)}
              </span>
            )}
          </div>
        )}
      </div>
    );
  }
);
SourceCard.displayName = 'SourceCard';

// ============================================================================
// SourcesCitation Main Component
// ============================================================================

export interface SourcesCitationProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  sources: CitationSource[];
  variant?: 'chips' | 'list' | 'collapsible';
  title?: string;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  maxVisible?: number;
  showScore?: boolean;
  onSourceSelect?: (source: CitationSource) => void;
}

export function SourcesCitation({
  sources = [],
  variant = 'chips',
  title,
  defaultOpen = false,
  open: controlledOpen,
  onOpenChange,
  maxVisible,
  showScore = true,
  onSourceSelect,
  className,
  ...props
}: SourcesCitationProps) {
  if (!sources || sources.length === 0) return null;

  const visibleSources = maxVisible ? sources.slice(0, maxVisible) : sources;
  const remainingCount = maxVisible && sources.length > maxVisible ? sources.length - maxVisible : 0;
  const displayTitle = title ?? `Used ${sources.length} sources`;

  // 1. Variant: Horizontal Badge Chips
  if (variant === 'chips') {
    return (
      <div
        className={cn('flex items-center flex-wrap gap-1.5 my-1.5', className)}
        {...props}
      >
        <div className="flex items-center gap-1 text-xs text-muted-foreground mr-1 select-none font-medium">
          <BookOpen className="size-3 text-muted-foreground" />
          <span>{`${displayTitle}:`}</span>
        </div>
        {visibleSources.map((source, idx) => (
          <SourceChip
            key={source.id ?? `chip-${idx}`}
            source={source}
            index={idx}
            showScore={showScore}
            onSelect={onSourceSelect}
          />
        ))}
        {remainingCount > 0 && (
          <span className="text-[11px] font-medium text-muted-foreground px-1.5 py-0.5 rounded bg-muted">
            +{remainingCount} more
          </span>
        )}
      </div>
    );
  }

  // 2. Variant: Collapsible Container
  return (
    <div
      className={cn(
        'rounded-lg border border-border/60 bg-muted/20 text-card-foreground shadow-2xs overflow-hidden',
        className
      )}
      {...props}
    >
      <TraceCollapsible
        defaultOpen={defaultOpen}
        open={controlledOpen}
        onOpenChange={onOpenChange}
      >
        <TraceCollapsibleTrigger className="px-3 py-2 hover:bg-muted/40 transition-colors">
          <div className="flex items-center gap-2 min-w-0">
            <BookOpen className="size-3.5 text-muted-foreground shrink-0" />
            <span className="text-xs font-medium text-foreground truncate">
              {displayTitle}
            </span>
            <span className="text-[10px] text-muted-foreground font-semibold bg-muted px-1.5 py-0.2 rounded border border-border/50">
              {sources.length}
            </span>
          </div>
        </TraceCollapsibleTrigger>

        <TraceCollapsibleContent className="px-3 pb-3 pt-1 border-l-0 space-y-2">
          {visibleSources.map((source, idx) => (
            <SourceCard
              key={source.id ?? `card-${idx}`}
              source={source}
              index={idx}
            />
          ))}
          {remainingCount > 0 && (
            <div className="text-center py-1 text-xs text-muted-foreground">
              +{remainingCount} additional sources omitted
            </div>
          )}
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </div>
  );
}
