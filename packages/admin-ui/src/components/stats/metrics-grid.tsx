import * as React from 'react';
import { StatCard, type StatCardProps } from './stat-card';
import { cn } from '../../lib/utils';

export interface MetricsGridProps extends React.HTMLAttributes<HTMLDivElement> {
  columns?: 2 | 3 | 4;
  items?: StatCardProps[];
  loading?: boolean;
}

export function MetricsGrid({
  columns = 4,
  items,
  children,
  loading = false,
  className,
  ...props
}: MetricsGridProps) {
  const gridColsClass =
    columns === 2
      ? 'grid-cols-1 md:grid-cols-2'
      : columns === 3
      ? 'grid-cols-1 md:grid-cols-2 lg:grid-cols-3'
      : 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-4';

  return (
    <div
      className={cn('grid gap-4 w-full', gridColsClass, className)}
      {...props}
    >
      {items
        ? items.map((item, index) => (
            <StatCard
              key={item.id ?? item.title ?? index}
              loading={loading || item.loading}
              {...item}
            />
          ))
        : children}
    </div>
  );
}
