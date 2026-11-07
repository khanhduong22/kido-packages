import * as React from 'react';
import { Button } from '../ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';
import { cn } from '../../lib/utils';

export interface PaginationState {
  pageIndex: number; // 0-based or 1-based (we provide 1-based for standard SME usage)
  pageSize: number;
  totalRows: number;
  pageCount?: number;
}

export interface PaginationProps {
  currentPage: number;
  pageSize: number;
  totalRows: number;
  pageSizeOptions?: number[];
  onPageChange: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
  disabled?: boolean;
  className?: string;
  totalLabel?: string;
}

function buildPageItems(current: number, totalPages: number): (number | 'ellipsis')[] {
  if (totalPages <= 5) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }

  const items: (number | 'ellipsis')[] = [];
  items.push(1);

  if (current > 3) {
    items.push('ellipsis');
  }

  const start = Math.max(2, current - 1);
  const end = Math.min(totalPages - 1, current + 1);

  for (let i = start; i <= end; i++) {
    items.push(i);
  }

  if (current < totalPages - 2) {
    items.push('ellipsis');
  }

  items.push(totalPages);
  return items;
}

export function Pagination({
  currentPage,
  pageSize,
  totalRows,
  pageSizeOptions = [10, 20, 50, 100],
  onPageChange,
  onPageSizeChange,
  disabled = false,
  className,
  totalLabel = 'mục',
}: PaginationProps) {
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  const safeCurrent = Math.min(Math.max(1, currentPage), totalPages);

  const canGoPrev = safeCurrent > 1 && !disabled;
  const canGoNext = safeCurrent < totalPages && !disabled;

  const startRow = totalRows === 0 ? 0 : (safeCurrent - 1) * pageSize + 1;
  const endRow = Math.min(safeCurrent * pageSize, totalRows);

  const pageItems = buildPageItems(safeCurrent, totalPages);

  return (
    <div
      className={cn(
        'flex flex-col sm:flex-row items-center justify-between gap-4 py-3 px-1 text-sm text-muted-foreground',
        className
      )}
    >
      {/* Left: Row range info */}
      <div className="flex items-center gap-2 text-xs sm:text-sm">
        <span>
          Hiển thị <span className="font-medium text-foreground">{startRow}</span> -{' '}
          <span className="font-medium text-foreground">{endRow}</span> trên tổng số{' '}
          <span className="font-medium text-foreground">{totalRows.toLocaleString()}</span> {totalLabel}
        </span>

        {onPageSizeChange && (
          <div className="flex items-center gap-1.5 ml-2 pl-2 border-l border-border/60">
            <span className="text-xs">Cỡ trang:</span>
            <Select
              value={String(pageSize)}
              onValueChange={(val) => onPageSizeChange(Number(val))}
              disabled={disabled}
            >
              <SelectTrigger className="h-7 w-[70px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent side="top">
                {pageSizeOptions.map((opt) => (
                  <SelectItem key={opt} value={String(opt)} className="text-xs">
                    {opt}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      {/* Right: Page navigation */}
      <div className="flex items-center space-x-1">
        <Button
          variant="outline"
          size="icon"
          className="size-8"
          onClick={() => onPageChange(1)}
          disabled={!canGoPrev}
          title="Trang đầu"
        >
          <ChevronsLeft className="size-4" />
          <span className="sr-only">Trang đầu</span>
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="size-8"
          onClick={() => onPageChange(safeCurrent - 1)}
          disabled={!canGoPrev}
          title="Trang trước"
        >
          <ChevronLeft className="size-4" />
          <span className="sr-only">Trang trước</span>
        </Button>

        <div className="flex items-center space-x-1 px-1">
          {pageItems.map((item, idx) =>
            item === 'ellipsis' ? (
              <span key={`ell-${idx}`} className="px-1 text-xs text-muted-foreground">
                ...
              </span>
            ) : (
              <Button
                key={item}
                variant={item === safeCurrent ? 'default' : 'outline'}
                size="icon"
                className={cn('size-8 text-xs', item === safeCurrent && 'font-bold')}
                onClick={() => onPageChange(item)}
                disabled={disabled}
              >
                {item}
              </Button>
            )
          )}
        </div>

        <Button
          variant="outline"
          size="icon"
          className="size-8"
          onClick={() => onPageChange(safeCurrent + 1)}
          disabled={!canGoNext}
          title="Trang sau"
        >
          <ChevronRight className="size-4" />
          <span className="sr-only">Trang sau</span>
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="size-8"
          onClick={() => onPageChange(totalPages)}
          disabled={!canGoNext}
          title="Trang cuối"
        >
          <ChevronsRight className="size-4" />
          <span className="sr-only">Trang cuối</span>
        </Button>
      </div>
    </div>
  );
}
