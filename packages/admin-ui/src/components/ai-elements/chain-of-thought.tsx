import * as React from 'react';
import {
  Brain,
  Sparkles,
  ChevronDown,
  Search,
  ArrowUpDown,
  Filter,
  Layers,
  Terminal,
  CheckCircle2,
  AlertCircle,
  Loader2,
  SlidersHorizontal,
  FileText,
  Clock,
} from 'lucide-react';
import { cn } from '../../lib/utils';

// ============================================================================
// Types & Interfaces
// ============================================================================

export type TraceStepStatus = 'running' | 'completed' | 'error' | 'pending';

export type TraceStepType =
  | 'search'
  | 'rerank'
  | 'prune'
  | 'filter'
  | 'embed'
  | 'reason'
  | 'tool'
  | 'custom';

export interface ChainOfThoughtStep {
  id?: string | number;
  title: string;
  description?: string;
  status?: TraceStepStatus;
  stepType?: TraceStepType;
  durationMs?: number;
  icon?: React.ReactNode;
  details?: React.ReactNode | string;
  output?: React.ReactNode | string;
  metadata?: Record<string, any>;
}

export interface TraceContextValue {
  isCollapsible?: boolean;
}

const TraceContext = React.createContext<TraceContextValue>({});

// ============================================================================
// Helpers
// ============================================================================

export function formatTraceDuration(msOrSeconds?: number, isSeconds = false): string {
  if (msOrSeconds === undefined || msOrSeconds === null || isNaN(msOrSeconds)) {
    return '';
  }
  const ms = isSeconds ? msOrSeconds * 1000 : msOrSeconds;
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

export function resolveStepIcon(
  stepType?: TraceStepType,
  status?: TraceStepStatus,
  customIcon?: React.ReactNode
): React.ReactNode {
  if (customIcon) return customIcon;

  if (status === 'running') {
    return <Loader2 className="size-3.5 animate-spin text-blue-500 dark:text-blue-400" />;
  }
  if (status === 'error') {
    return <AlertCircle className="size-3.5 text-rose-500" />;
  }

  switch (stepType) {
    case 'search':
      return <Search className="size-3.5 text-sky-500" />;
    case 'rerank':
      return <ArrowUpDown className="size-3.5 text-purple-500" />;
    case 'prune':
    case 'filter':
      return <Filter className="size-3.5 text-amber-500" />;
    case 'embed':
      return <Layers className="size-3.5 text-indigo-500" />;
    case 'reason':
      return <Brain className="size-3.5 text-violet-500" />;
    case 'tool':
      return <Terminal className="size-3.5 text-emerald-500" />;
    case 'custom':
    default:
      if (status === 'completed') {
        return <CheckCircle2 className="size-3.5 text-emerald-500" />;
      }
      return <Sparkles className="size-3.5 text-muted-foreground" />;
  }
}

// ============================================================================
// Trace Base Primitives
// ============================================================================

export interface TraceProps extends React.HTMLAttributes<HTMLDivElement> {}

export const Trace = React.forwardRef<HTMLDivElement, TraceProps>(
  ({ className, children, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={cn('flex flex-col gap-1.5 font-sans text-sm', className)}
        {...props}
      >
        {children}
      </div>
    );
  }
);
Trace.displayName = 'Trace';

export interface TraceIconProps extends React.HTMLAttributes<HTMLSpanElement> {}

export const TraceIcon = React.forwardRef<HTMLSpanElement, TraceIconProps>(
  ({ className, children, ...props }, ref) => {
    return (
      <span
        ref={ref}
        className={cn(
          'inline-flex items-center justify-center shrink-0 size-4 text-muted-foreground',
          className
        )}
        {...props}
      >
        {children}
      </span>
    );
  }
);
TraceIcon.displayName = 'TraceIcon';

export interface TraceTitleProps extends React.HTMLAttributes<HTMLSpanElement> {}

export const TraceTitle = React.forwardRef<HTMLSpanElement, TraceTitleProps>(
  ({ className, children, ...props }, ref) => {
    return (
      <span
        ref={ref}
        className={cn('font-medium text-foreground text-xs leading-none', className)}
        {...props}
      >
        {children}
      </span>
    );
  }
);
TraceTitle.displayName = 'TraceTitle';

export interface TraceDescriptionProps extends React.HTMLAttributes<HTMLSpanElement> {}

export const TraceDescription = React.forwardRef<HTMLSpanElement, TraceDescriptionProps>(
  ({ className, children, ...props }, ref) => {
    return (
      <span
        ref={ref}
        className={cn('text-xs text-muted-foreground truncate', className)}
        {...props}
      >
        {children}
      </span>
    );
  }
);
TraceDescription.displayName = 'TraceDescription';

// ============================================================================
// TraceCollapsible Primitives
// ============================================================================

interface TraceCollapsibleContextValue {
  open: boolean;
  toggleOpen: () => void;
}

const TraceCollapsibleContext = React.createContext<TraceCollapsibleContextValue>({
  open: false,
  toggleOpen: () => {},
});

export interface TraceCollapsibleProps extends React.HTMLAttributes<HTMLDivElement> {
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export const TraceCollapsible = React.forwardRef<HTMLDivElement, TraceCollapsibleProps>(
  ({ defaultOpen = false, open: controlledOpen, onOpenChange, className, children, ...props }, ref) => {
    const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen);
    const isControlled = controlledOpen !== undefined;
    const open = isControlled ? controlledOpen : uncontrolledOpen;

    const toggleOpen = React.useCallback(() => {
      const next = !open;
      if (!isControlled) {
        setUncontrolledOpen(next);
      }
      onOpenChange?.(next);
    }, [open, isControlled, onOpenChange]);

    return (
      <TraceCollapsibleContext.Provider value={{ open, toggleOpen }}>
        <div ref={ref} className={cn('group/collapsible flex flex-col', className)} {...props}>
          {children}
        </div>
      </TraceCollapsibleContext.Provider>
    );
  }
);
TraceCollapsible.displayName = 'TraceCollapsible';

export interface TraceCollapsibleTriggerProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {}

export const TraceCollapsibleTrigger = React.forwardRef<
  HTMLButtonElement,
  TraceCollapsibleTriggerProps
>(({ className, children, ...props }, ref) => {
  const { open, toggleOpen } = React.useContext(TraceCollapsibleContext);

  return (
    <button
      ref={ref}
      type="button"
      onClick={toggleOpen}
      aria-expanded={open}
      className={cn(
        'flex items-center justify-between w-full text-left text-xs text-muted-foreground hover:text-foreground transition-colors group cursor-pointer focus:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-sm py-0.5',
        className
      )}
      {...props}
    >
      <div className="flex items-center gap-2 min-w-0 flex-1">{children}</div>
      <ChevronDown
        className={cn(
          'size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-200 group-hover:text-foreground',
          open && 'rotate-180'
        )}
      />
    </button>
  );
});
TraceCollapsibleTrigger.displayName = 'TraceCollapsibleTrigger';

export interface TraceCollapsibleContentProps extends React.HTMLAttributes<HTMLDivElement> {}

export const TraceCollapsibleContent = React.forwardRef<
  HTMLDivElement,
  TraceCollapsibleContentProps
>(({ className, children, ...props }, ref) => {
  const { open } = React.useContext(TraceCollapsibleContext);

  if (!open) return null;

  return (
    <div
      ref={ref}
      className={cn(
        'mt-1.5 pl-5 pr-1 border-l-2 border-border/40 space-y-1.5 animate-in fade-in-50 duration-150',
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
});
TraceCollapsibleContent.displayName = 'TraceCollapsibleContent';

// ============================================================================
// TraceLine Primitive
// ============================================================================

export interface TraceLineProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  status?: TraceStepStatus;
  stepType?: TraceStepType;
  icon?: React.ReactNode;
  title?: React.ReactNode;
  description?: React.ReactNode;
  durationMs?: number;
  details?: React.ReactNode | string;
  output?: React.ReactNode | string;
  isTrigger?: boolean;
  defaultOpen?: boolean;
}

export const TraceLine = React.forwardRef<HTMLDivElement, TraceLineProps>(
  (
    {
      status,
      stepType,
      icon,
      title,
      description,
      durationMs,
      details,
      output,
      isTrigger = false,
      defaultOpen = false,
      className,
      children,
      ...props
    },
    ref
  ) => {
    const renderedIcon = resolveStepIcon(stepType, status, icon);
    const content = (
      <div
        ref={ref}
        className={cn(
          'flex items-center gap-2 py-1 px-1.5 rounded-md text-xs transition-colors',
          status === 'running' && 'bg-blue-50/50 dark:bg-blue-950/20 text-foreground',
          status === 'error' && 'bg-rose-50/50 dark:bg-rose-950/20 text-rose-700 dark:text-rose-400',
          !status && 'text-muted-foreground hover:text-foreground',
          className
        )}
        {...props}
      >
        <TraceIcon>{renderedIcon}</TraceIcon>
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {title && <TraceTitle>{title}</TraceTitle>}
          {description && <TraceDescription>{description}</TraceDescription>}
          {children}
        </div>
        {durationMs !== undefined && (
          <span className="text-[10px] text-muted-foreground/80 font-mono shrink-0 ml-auto flex items-center gap-0.5">
            <Clock className="size-2.5" />
            {formatTraceDuration(durationMs)}
          </span>
        )}
      </div>
    );

    // If details or output exists and not inside a custom trigger, wrap in TraceCollapsible
    const detailContent = details || output;
    if (detailContent && !isTrigger) {
      return (
        <TraceCollapsible defaultOpen={defaultOpen}>
          <TraceCollapsibleTrigger className="p-0 hover:bg-muted/40 rounded-md">
            {content}
          </TraceCollapsibleTrigger>
          <TraceCollapsibleContent>
            {typeof detailContent === 'string' ? (
              <pre className="text-[11px] font-mono text-muted-foreground bg-muted/50 p-2 rounded border border-border/50 overflow-x-auto whitespace-pre-wrap max-h-48">
                {detailContent}
              </pre>
            ) : (
              detailContent
            )}
          </TraceCollapsibleContent>
        </TraceCollapsible>
      );
    }

    return content;
  }
);
TraceLine.displayName = 'TraceLine';


// ============================================================================
// ChainOfThought Compound Component
// ============================================================================

export interface ChainOfThoughtProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  /**
   * Whether the AI model or RAG pipeline is currently reasoning / generating.
   */
  isThinking?: boolean;
  /**
   * Step execution status. If provided, overrides isThinking.
   */
  status?: TraceStepStatus;
  /**
   * Elapsed time in seconds (e.g. 1.4 for "Thought for 1.4s").
   */
  durationSeconds?: number;
  /**
   * Elapsed time in milliseconds.
   */
  durationMs?: number;
  /**
   * Total number of reasoning / execution steps.
   */
  stepsCount?: number;
  /**
   * Custom title text for the reasoning container.
   */
  title?: string;
  /**
   * Custom subtitle / summary message.
   */
  summary?: React.ReactNode;
  /**
   * Whether the collapsible starts open (default: false).
   */
  defaultOpen?: boolean;
  /**
   * Controlled open state.
   */
  open?: boolean;
  /**
   * Callback when open state changes.
   */
  onOpenChange?: (open: boolean) => void;
  /**
   * Data-driven list of steps to render within the container.
   */
  steps?: ChainOfThoughtStep[];
  /**
   * Whether to display an animated pulse during thinking (default: true).
   */
  pulse?: boolean;
}

export function ChainOfThought({
  isThinking = false,
  status: explicitStatus,
  durationSeconds,
  durationMs,
  stepsCount,
  title,
  summary,
  defaultOpen = false,
  open: controlledOpen,
  onOpenChange,
  steps = [],
  pulse = true,
  className,
  children,
  ...props
}: ChainOfThoughtProps) {
  const status: TraceStepStatus = explicitStatus ?? (isThinking ? 'running' : 'completed');
  const running = status === 'running';

  // Compute effective step count
  const effectiveStepsCount = stepsCount ?? (steps.length > 0 ? steps.length : undefined);

  // Compute display duration
  const effectiveDuration =
    durationSeconds !== undefined
      ? formatTraceDuration(durationSeconds, true)
      : durationMs !== undefined
      ? formatTraceDuration(durationMs, false)
      : '';

  // Compute default title
  const displayTitle = React.useMemo(() => {
    if (title) return title;
    if (running) return 'Thinking...';
    if (status === 'error') return 'Reasoning stopped with error';
    if (effectiveDuration) return `Thought for ${effectiveDuration}`;
    return 'Reasoning process';
  }, [title, running, status, effectiveDuration]);

  return (
    <div
      className={cn(
        'rounded-lg border border-border/60 bg-muted/20 text-card-foreground shadow-xs transition-all overflow-hidden',
        running && pulse && 'border-blue-400/40 dark:border-blue-500/30 bg-blue-500/[0.02]',
        className
      )}
      {...props}
    >
      <TraceCollapsible
        defaultOpen={defaultOpen}
        open={controlledOpen}
        onOpenChange={onOpenChange}
      >
        <TraceCollapsibleTrigger className="px-3 py-2.5 hover:bg-muted/40 transition-colors">
          <div className="flex items-center gap-2.5 min-w-0">
            {/* Status Icon */}
            <div
              className={cn(
                'size-6 rounded-md flex items-center justify-center shrink-0 border transition-colors',
                running
                  ? 'bg-blue-100 border-blue-200 text-blue-600 dark:bg-blue-950/60 dark:border-blue-800 dark:text-blue-400'
                  : status === 'error'
                  ? 'bg-rose-100 border-rose-200 text-rose-600 dark:bg-rose-950/60 dark:border-rose-800 dark:text-rose-400'
                  : 'bg-muted border-border/70 text-muted-foreground'
              )}
            >
              {running ? (
                <Brain className="size-3.5 animate-pulse" />
              ) : status === 'error' ? (
                <AlertCircle className="size-3.5" />
              ) : (
                <Brain className="size-3.5" />
              )}
            </div>

            {/* Title & Duration */}
            <div className="flex items-center gap-2 truncate">
              <span className="text-xs font-semibold text-foreground tracking-tight">
                {displayTitle}
              </span>
              {running && pulse && (
                <span className="flex h-1.5 w-1.5 relative">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-blue-500" />
                </span>
              )}
            </div>

            {/* Steps Count Badge */}
            {effectiveStepsCount !== undefined && (
              <span className="text-[11px] font-medium text-muted-foreground bg-muted/80 px-1.5 py-0.5 rounded border border-border/40">
                {`${effectiveStepsCount} ${effectiveStepsCount === 1 ? 'step' : 'steps'}`}
              </span>
            )}
          </div>
        </TraceCollapsibleTrigger>

        <TraceCollapsibleContent className="px-3 pb-3 pt-1 border-l-0">
          {summary && (
            <div className="text-xs text-muted-foreground mb-2 italic">
              {summary}
            </div>
          )}

          <Trace className="gap-1 pl-1 border-l-2 border-border/50 ml-2">
            {steps.length > 0
              ? steps.map((step, idx) => (
                  <TraceLine
                    key={step.id ?? `step-${idx}`}
                    title={step.title}
                    description={step.description}
                    status={step.status}
                    stepType={step.stepType}
                    durationMs={step.durationMs}
                    icon={step.icon}
                    details={step.details}
                    output={step.output}
                  />
                ))
              : children}
          </Trace>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </div>
  );
}
