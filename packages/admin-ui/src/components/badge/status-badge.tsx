import * as React from 'react';
import { Badge, type badgeVariants } from '../ui/badge';
import { cn } from '../../lib/utils';
import type { VariantProps } from 'class-variance-authority';
import {
  Clock,
  Loader2,
  CheckCircle2,
  XCircle,
  CreditCard,
  AlertCircle,
  RotateCcw,
  Truck,
  PackageCheck,
  type LucideIcon,
} from 'lucide-react';

export type StandardSMEStatus =
  | 'PENDING'
  | 'PROCESSING'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'PAID'
  | 'UNPAID'
  | 'REFUNDED'
  | 'SHIPPING'
  | 'DELIVERED';

export type StatusBadgeVariant = NonNullable<
  VariantProps<typeof badgeVariants>['variant']
>;

export interface StatusConfig {
  label: string;
  variant: StatusBadgeVariant;
  dotColor: string;
  icon: LucideIcon;
}

export const STATUS_CONFIG_MAP: Record<StandardSMEStatus, StatusConfig> = {
  PENDING: {
    label: 'Chờ xử lý',
    variant: 'warning',
    dotColor: 'bg-amber-500',
    icon: Clock,
  },
  PROCESSING: {
    label: 'Đang thực hiện',
    variant: 'info',
    dotColor: 'bg-blue-500',
    icon: Loader2,
  },
  COMPLETED: {
    label: 'Hoàn thành',
    variant: 'success',
    dotColor: 'bg-emerald-500',
    icon: CheckCircle2,
  },
  CANCELLED: {
    label: 'Đã hủy',
    variant: 'destructive',
    dotColor: 'bg-rose-500',
    icon: XCircle,
  },
  PAID: {
    label: 'Đã thanh toán',
    variant: 'success',
    dotColor: 'bg-emerald-500',
    icon: CreditCard,
  },
  UNPAID: {
    label: 'Chưa thanh toán',
    variant: 'warning',
    dotColor: 'bg-amber-500',
    icon: AlertCircle,
  },
  REFUNDED: {
    label: 'Đã hoàn tiền',
    variant: 'purple',
    dotColor: 'bg-purple-500',
    icon: RotateCcw,
  },
  SHIPPING: {
    label: 'Đang giao hàng',
    variant: 'info',
    dotColor: 'bg-sky-500',
    icon: Truck,
  },
  DELIVERED: {
    label: 'Đã giao hàng',
    variant: 'success',
    dotColor: 'bg-teal-500',
    icon: PackageCheck,
  },
};

export function normalizeStatusKey(status: string): string {
  return status.trim().toUpperCase().replace(/[\s-]+/g, '_');
}

export function getStatusBadgeConfig(status: string): StatusConfig {
  const normalized = normalizeStatusKey(status) as StandardSMEStatus;
  if (normalized in STATUS_CONFIG_MAP) {
    return STATUS_CONFIG_MAP[normalized];
  }

  // Vietnamese textual fallback lookups - check specific multi-word patterns first
  const lower = status.trim().toLowerCase();
  if (lower.includes('giao hàng') || lower.includes('shipping')) {
    return STATUS_CONFIG_MAP.SHIPPING;
  }
  if (lower.includes('đã giao') || lower.includes('delivered')) {
    return STATUS_CONFIG_MAP.DELIVERED;
  }
  if (lower.includes('đã thanh toán') || lower.includes('paid')) {
    return STATUS_CONFIG_MAP.PAID;
  }
  if (lower.includes('chưa thanh toán') || lower.includes('unpaid')) {
    return STATUS_CONFIG_MAP.UNPAID;
  }
  if (lower.includes('hoàn tiền') || lower.includes('refund')) {
    return STATUS_CONFIG_MAP.REFUNDED;
  }
  if (lower.includes('hủy') || lower.includes('cancel')) {
    return STATUS_CONFIG_MAP.CANCELLED;
  }
  if (lower.includes('hoàn thành') || lower.includes('completed') || lower.includes('done')) {
    return STATUS_CONFIG_MAP.COMPLETED;
  }
  if (lower.includes('đang') || lower.includes('processing')) {
    return STATUS_CONFIG_MAP.PROCESSING;
  }
  if (lower.includes('chờ') || lower.includes('pending')) {
    return STATUS_CONFIG_MAP.PENDING;
  }

  return {
    label: status,
    variant: 'secondary',
    dotColor: 'bg-zinc-400',
    icon: Clock,
  };
}

export interface StatusBadgeProps extends React.HTMLAttributes<HTMLDivElement> {
  status: StandardSMEStatus | string;
  label?: string;
  showDot?: boolean;
  showIcon?: boolean;
  variant?: StatusBadgeVariant;
}

export function StatusBadge({
  status,
  label,
  showDot = true,
  showIcon = false,
  variant,
  className,
  ...props
}: StatusBadgeProps) {
  const config = getStatusBadgeConfig(status);
  const displayLabel = label ?? config.label;
  const effectiveVariant = variant ?? config.variant;
  const Icon = config.icon;

  return (
    <Badge
      variant={effectiveVariant}
      className={cn('inline-flex items-center gap-1.5 font-medium', className)}
      {...props}
    >
      {showDot && (
        <span
          className={cn('size-1.5 rounded-full shrink-0 animate-pulse', config.dotColor)}
          aria-hidden="true"
        />
      )}
      {showIcon && <Icon className="size-3 shrink-0" aria-hidden="true" />}
      <span>{displayLabel}</span>
    </Badge>
  );
}
