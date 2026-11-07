import * as React from 'react';
import {
  type ColumnDef,
  type ColumnFiltersState,
  type SortingState,
  type VisibilityState,
  type Row,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../ui/table';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { Skeleton } from '../ui/skeleton';
import { Pagination } from './pagination';
import { cn } from '../../lib/utils';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Columns3,
  Inbox,
  Search,
  X,
} from 'lucide-react';

export interface ServerPaginationConfig {
  currentPage: number;
  pageSize: number;
  totalRows: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
  pageSizeOptions?: number[];
}

export interface DataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[];
  data: TData[];
  loading?: boolean;
  emptyMessage?: string | React.ReactNode;
  emptyTitle?: string;

  // Search & Filtering
  searchKey?: string; // Client-side column search key (e.g. "name", "phone")
  searchPlaceholder?: string;
  searchValue?: string; // For server-driven search
  onSearchChange?: (val: string) => void;

  // Features toggles
  showSearch?: boolean;
  showColumnVisibility?: boolean;
  showIndexColumn?: boolean;

  // Pagination
  serverPagination?: ServerPaginationConfig;
  defaultPageSize?: number;

  // Slots
  toolbarActions?: React.ReactNode;
  toolbarLeft?: React.ReactNode;

  // Row customization
  getRowProps?: (row: Row<TData>) => React.HTMLAttributes<HTMLTableRowElement>;
  renderExpandedRow?: (row: Row<TData>) => React.ReactNode;

  className?: string;
}

export function DataTable<TData, TValue>({
  columns,
  data,
  loading = false,
  emptyMessage = 'Không tìm thấy kết quả nào phù hợp.',
  emptyTitle = 'Không có dữ liệu',
  searchKey,
  searchPlaceholder = 'Tìm kiếm dữ liệu...',
  searchValue,
  onSearchChange,
  showSearch = true,
  showColumnVisibility = true,
  showIndexColumn = true,
  serverPagination,
  defaultPageSize = 10,
  toolbarActions,
  toolbarLeft,
  getRowProps,
  renderExpandedRow,
  className,
}: DataTableProps<TData, TValue>) {
  const [sorting, setSorting] = React.useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>([]);
  const [columnVisibility, setColumnVisibility] = React.useState<VisibilityState>({});
  const [rowSelection, setRowSelection] = React.useState({});
  const [clientSearch, setClientSearch] = React.useState('');

  const [pagination, setPagination] = React.useState({
    pageIndex: 0,
    pageSize: defaultPageSize,
  });

  // Prepare index column
  const effectiveColumns = React.useMemo(() => {
    if (!showIndexColumn) return columns;

    const indexCol: ColumnDef<TData, TValue> = {
      id: '__index',
      header: '#',
      cell: ({ row }) => {
        if (serverPagination) {
          return (
            (serverPagination.currentPage - 1) * serverPagination.pageSize +
            row.index +
            1
          );
        }
        return pagination.pageIndex * pagination.pageSize + row.index + 1;
      },
      enableSorting: false,
      enableHiding: false,
      size: 50,
    };

    return [indexCol, ...columns];
  }, [showIndexColumn, columns, serverPagination, pagination]);

  const isServerPaged = !!serverPagination;

  const table = useReactTable({
    data,
    columns: effectiveColumns,
    state: {
      sorting,
      columnFilters,
      columnVisibility,
      rowSelection,
      ...(isServerPaged ? {} : { pagination }),
    },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onColumnVisibilityChange: setColumnVisibility,
    onRowSelectionChange: setRowSelection,
    onPaginationChange: setPagination,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    ...(isServerPaged ? {} : { getPaginationRowModel: getPaginationRowModel() }),
    manualPagination: isServerPaged,
  });

  // Handle client search input
  const handleClientSearch = (val: string) => {
    setClientSearch(val);
    if (searchKey) {
      table.getColumn(searchKey)?.setFilterValue(val);
    }
  };

  const currentSearchTerm = onSearchChange ? searchValue ?? '' : clientSearch;

  return (
    <div className={cn('w-full space-y-3', className)}>
      {/* Top Toolbar */}
      {(showSearch || showColumnVisibility || toolbarActions || toolbarLeft) && (
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2 flex-1 max-w-md">
            {showSearch && (
              <div className="relative flex-1">
                <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
                <Input
                  placeholder={searchPlaceholder}
                  value={currentSearchTerm}
                  onChange={(e) => {
                    if (onSearchChange) {
                      onSearchChange(e.target.value);
                    } else {
                      handleClientSearch(e.target.value);
                    }
                  }}
                  className="pl-9 pr-8 h-9 text-sm bg-background border-border/70"
                />
                {currentSearchTerm && (
                  <button
                    type="button"
                    onClick={() => {
                      if (onSearchChange) onSearchChange('');
                      else handleClientSearch('');
                    }}
                    className="absolute right-2.5 top-2.5 text-muted-foreground hover:text-foreground"
                    title="Xóa tìm kiếm"
                  >
                    <X className="size-4" />
                  </button>
                )}
              </div>
            )}
            {toolbarLeft}
          </div>

          <div className="flex items-center gap-2 justify-end">
            {toolbarActions}

            {showColumnVisibility && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="h-9 gap-1.5 border-border/80">
                    <Columns3 className="size-4 opacity-70" />
                    <span className="hidden sm:inline">Cột hiển thị</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  {table
                    .getAllColumns()
                    .filter((column) => column.getCanHide())
                    .map((column) => (
                      <DropdownMenuCheckboxItem
                        key={column.id}
                        className="capitalize text-xs cursor-pointer"
                        checked={column.getIsVisible()}
                        onCheckedChange={(value) => column.toggleVisibility(!!value)}
                      >
                        {typeof column.columnDef.header === 'string'
                          ? column.columnDef.header
                          : column.id}
                      </DropdownMenuCheckboxItem>
                    ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>
      )}

      {/* Main Table Card */}
      <div className="rounded-xl border border-border/80 bg-card overflow-hidden shadow-xs">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id} className="hover:bg-transparent">
                {headerGroup.headers.map((header) => {
                  const canSort = header.column.getCanSort();
                  const isSorted = header.column.getIsSorted();

                  return (
                    <TableHead
                      key={header.id}
                      style={{ width: header.getSize() !== 150 ? header.getSize() : undefined }}
                    >
                      {header.isPlaceholder ? null : canSort ? (
                        <button
                          type="button"
                          onClick={header.column.getToggleSortingHandler()}
                          className="flex items-center gap-1.5 font-semibold text-foreground/90 hover:text-foreground transition-colors group cursor-pointer"
                        >
                          {flexRender(
                            header.column.columnDef.header,
                            header.getContext()
                          )}
                          <span className="shrink-0 text-muted-foreground group-hover:text-foreground">
                            {isSorted === 'asc' ? (
                              <ArrowUp className="size-3.5 text-primary" />
                            ) : isSorted === 'desc' ? (
                              <ArrowDown className="size-3.5 text-primary" />
                            ) : (
                              <ArrowUpDown className="size-3 opacity-40 group-hover:opacity-100" />
                            )}
                          </span>
                        </button>
                      ) : (
                        flexRender(
                          header.column.columnDef.header,
                          header.getContext()
                        )
                      )}
                    </TableHead>
                  );
                })}
              </TableRow>
            ))}
          </TableHeader>

          <TableBody>
            {loading ? (
              // Loading Skeleton
              Array.from({ length: 5 }).map((_, rIdx) => (
                <TableRow key={`skeleton-row-${rIdx}`}>
                  {effectiveColumns.map((col, cIdx) => (
                    <TableCell key={`skeleton-cell-${rIdx}-${col.id ?? cIdx}`}>
                      <Skeleton className="h-5 w-full max-w-[140px]" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : table.getRowModel().rows?.length ? (
              // Render Data Rows
              table.getRowModel().rows.map((row) => {
                const customRowProps = getRowProps ? getRowProps(row) : {};

                return (
                  <React.Fragment key={row.id}>
                    <TableRow
                      data-state={row.getIsSelected() && 'selected'}
                      {...customRowProps}
                    >
                      {row.getVisibleCells().map((cell) => (
                        <TableCell key={cell.id}>
                          {flexRender(
                            cell.column.columnDef.cell,
                            cell.getContext()
                          )}
                        </TableCell>
                      ))}
                    </TableRow>
                    {renderExpandedRow && renderExpandedRow(row) && (
                      <TableRow className="bg-muted/20 hover:bg-muted/30">
                        <TableCell colSpan={effectiveColumns.length}>
                          {renderExpandedRow(row)}
                        </TableCell>
                      </TableRow>
                    )}
                  </React.Fragment>
                );
              })
            ) : (
              // Empty State
              <TableRow>
                <TableCell
                  colSpan={effectiveColumns.length}
                  className="h-48 text-center"
                >
                  <div className="flex flex-col items-center justify-center p-6 text-muted-foreground">
                    <div className="size-12 rounded-full bg-muted/50 flex items-center justify-center mb-3">
                      <Inbox className="size-6 opacity-40" />
                    </div>
                    <p className="font-semibold text-foreground text-sm">{emptyTitle}</p>
                    <p className="text-xs text-muted-foreground mt-1 max-w-sm">
                      {emptyMessage}
                    </p>
                  </div>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination Footer */}
      {isServerPaged ? (
        <Pagination
          currentPage={serverPagination.currentPage}
          pageSize={serverPagination.pageSize}
          totalRows={serverPagination.totalRows}
          onPageChange={serverPagination.onPageChange}
          onPageSizeChange={serverPagination.onPageSizeChange}
          pageSizeOptions={serverPagination.pageSizeOptions}
          disabled={loading}
        />
      ) : (
        <Pagination
          currentPage={pagination.pageIndex + 1}
          pageSize={pagination.pageSize}
          totalRows={table.getFilteredRowModel().rows.length}
          onPageChange={(page) =>
            setPagination((prev) => ({ ...prev, pageIndex: page - 1 }))
          }
          onPageSizeChange={(size) =>
            setPagination({ pageIndex: 0, pageSize: size })
          }
          disabled={loading}
        />
      )}
    </div>
  );
}
