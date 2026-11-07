import * as React from 'react';
import { Card, CardContent } from '../ui/card';
import { Skeleton } from '../ui/skeleton';
import { cn } from '../../lib/utils';
import { TrendingUp, TrendingDown, Minus, type LucideIcon } from 'lucide-react';

export type TrendDirection = 'up' | 'down' | 'neutral';

export interface StatCardProps extends React.HTMLAttributes<HTMLDivElement> {
  title: string;
  value: string | number;
  description?: string;
  change?: number; // e.g. 12.5 means +12.5%, -4.2 means -4.2%
  trend?: TrendDirection;
  badgeText?: string;
  icon?: LucideIcon | React.ReactNode;
  iconClassName?: string;
  iconBgClassName?: string;
  loading?: boolean;
}

export function StatCard({
  title,
  value,
  description,
  change,
  trend,
  badgeText,
  icon: Icon,
  iconClassName,
  iconBgClassName,
  loading = false,
  className,
  ...props
}: StatCardProps) {
  // Infer trend if not explicitly provided
  const effectiveTrend: TrendDirection =
    trend ??
    (typeof change === 'number'
      ? change > 0
        ? 'up'
        : change < 0
        ? 'down'
        : 'neutral'
      : 'neutral');

  const formattedChange =
    typeof change === 'number'
      ? `${change > 0 ? '+' : ''}${change.toFixed(1)}%`
      : undefined;

  const displayBadgeText = badgeText ?? formattedChange;

  if (loading) {
    return (
      <Card className={cn('p-6', className)} {...props}>
        <div className="flex items-center justify-between space-y-0 pb-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="size-9 rounded-lg" />
        </div>
        <div className="mt-3 space-y-2">
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-4 w-40" />
        </div>
      </Card>
    );
  }

  const renderIcon = () => {
    if (!Icon) return null;
    if (React.isValidElement(Icon)) {
      return Icon;
    }
    // Assume it's a LucideIcon component
    const LucideComp = Icon as LucideIcon;
    return <LucideComp className={cn('size-5', iconClassName)} />;
  };

  return (
    <Card
      className={cn(
        'overflow-hidden transition-all hover:shadow-md border-border/60',
        props.onClick && 'cursor-pointer hover:border-primary/50',
        className
      )}
      {...props}
    >
      <CardContent className="p-6">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium text-muted-foreground">{title}</p>
          {Icon && (
            <div
              className={cn(
                'flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary',
                iconBgClassName
              )}
            >
              {renderIcon()}
            </div>
          )}
        </div>

        <div className="mt-3 flex items-baseline justify-between gap-2">
          <div className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
            {value}
          </div>

          {displayBadgeText && (
            <div
              className={cn(
                'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold shrink-0',
                effectiveTrend === 'up' &&
                  'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-400',
                effectiveTrend === 'down' &&
                  'bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-400',
                effectiveTrend === 'neutral' &&
                  'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300'
              )}
            >
              {effectiveTrend === 'up' && <TrendingUp className="size-3" />}
              {effectiveTrend === 'down' && <TrendingDown className="size-3" />}
              {effectiveTrend === 'neutral' && <Minus className="size-3" />}
              <span>{displayBadgeText}</span>
            </div>
          )}
        </div>

        {description && (
          <p className="mt-2 text-xs text-muted-foreground">{description}</p>
        )}
      </CardContent>
    </Card>
  );
}
