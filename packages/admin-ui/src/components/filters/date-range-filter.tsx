import * as React from 'react';
import { Calendar as CalendarIcon, Check, ChevronDown, RotateCcw } from 'lucide-react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { cn } from '../../lib/utils';

export type DatePresetKey =
  | 'today'
  | 'yesterday'
  | 'last7days'
  | 'last30days'
  | 'thisMonth'
  | 'lastMonth'
  | 'all';

export interface DateRangeValue {
  from: string | null; // Format YYYY-MM-DD
  to: string | null;   // Format YYYY-MM-DD
  preset?: DatePresetKey;
}

export interface DatePresetOption {
  key: DatePresetKey;
  label: string;
}

export const DATE_PRESETS: DatePresetOption[] = [
  { key: 'today', label: 'Hôm nay' },
  { key: 'yesterday', label: 'Hôm qua' },
  { key: 'last7days', label: '7 ngày qua' },
  { key: 'last30days', label: '30 ngày qua' },
  { key: 'thisMonth', label: 'Tháng này' },
  { key: 'lastMonth', label: 'Tháng trước' },
  { key: 'all', label: 'Tất cả thời gian' },
];

function formatDateToYMD(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function getDatePresetRange(preset: DatePresetKey): { from: string | null; to: string | null } {
  const now = new Date();
  const todayStr = formatDateToYMD(now);

  switch (preset) {
    case 'today':
      return { from: todayStr, to: todayStr };

    case 'yesterday': {
      const yesterday = new Date(now);
      yesterday.setDate(now.getDate() - 1);
      const str = formatDateToYMD(yesterday);
      return { from: str, to: str };
    }

    case 'last7days': {
      const past = new Date(now);
      past.setDate(now.getDate() - 6);
      return { from: formatDateToYMD(past), to: todayStr };
    }

    case 'last30days': {
      const past = new Date(now);
      past.setDate(now.getDate() - 29);
      return { from: formatDateToYMD(past), to: todayStr };
    }

    case 'thisMonth': {
      const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
      const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      return { from: formatDateToYMD(firstDay), to: formatDateToYMD(lastDay) };
    }

    case 'lastMonth': {
      const firstDay = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const lastDay = new Date(now.getFullYear(), now.getMonth(), 0);
      return { from: formatDateToYMD(firstDay), to: formatDateToYMD(lastDay) };
    }

    case 'all':
    default:
      return { from: null, to: null };
  }
}

export function formatDateRange(range: DateRangeValue | null | undefined): string {
  if (!range || (!range.from && !range.to)) {
    return 'Tất cả thời gian';
  }

  if (range.preset && range.preset !== 'all') {
    const found = DATE_PRESETS.find((p) => p.key === range.preset);
    if (found) return found.label;
  }

  const formatDisplay = (ymd: string) => {
    const [y, m, d] = ymd.split('-');
    return `${d}/${m}/${y}`;
  };

  if (range.from && !range.to) {
    return `Từ ${formatDisplay(range.from)}`;
  }
  if (!range.from && range.to) {
    return `Đến ${formatDisplay(range.to)}`;
  }
  if (range.from === range.to && range.from) {
    return formatDisplay(range.from);
  }

  return `${formatDisplay(range.from!)} - ${formatDisplay(range.to!)}`;
}

export interface DateRangeFilterProps {
  value?: DateRangeValue;
  defaultValue?: DateRangeValue;
  onChange?: (value: DateRangeValue) => void;
  className?: string;
  disabled?: boolean;
}

export function DateRangeFilter({
  value: controlledValue,
  defaultValue = { from: null, to: null, preset: 'thisMonth' },
  onChange,
  className,
  disabled = false,
}: DateRangeFilterProps) {
  const [internalValue, setInternalValue] = React.useState<DateRangeValue>(() => {
    if (controlledValue) return controlledValue;
    if (defaultValue.preset && defaultValue.preset !== 'all') {
      const computed = getDatePresetRange(defaultValue.preset);
      return { ...computed, preset: defaultValue.preset };
    }
    return defaultValue;
  });

  const value = controlledValue ?? internalValue;

  const [isOpen, setIsOpen] = React.useState(false);
  const [tempFrom, setTempFrom] = React.useState(value.from ?? '');
  const [tempTo, setTempTo] = React.useState(value.to ?? '');
  const [activePreset, setActivePreset] = React.useState<DatePresetKey | undefined>(
    value.preset
  );

  React.useEffect(() => {
    setTempFrom(value.from ?? '');
    setTempTo(value.to ?? '');
    setActivePreset(value.preset);
  }, [value]);

  const handleSelectPreset = (preset: DatePresetKey) => {
    const range = getDatePresetRange(preset);
    setActivePreset(preset);
    setTempFrom(range.from ?? '');
    setTempTo(range.to ?? '');

    const newValue: DateRangeValue = {
      from: range.from,
      to: range.to,
      preset,
    };
    if (!controlledValue) setInternalValue(newValue);
    onChange?.(newValue);
    setIsOpen(false);
  };

  const handleApplyCustom = () => {
    const newValue: DateRangeValue = {
      from: tempFrom || null,
      to: tempTo || null,
      preset: undefined,
    };
    if (!controlledValue) setInternalValue(newValue);
    onChange?.(newValue);
    setIsOpen(false);
  };

  const handleReset = () => {
    const newValue: DateRangeValue = {
      from: null,
      to: null,
      preset: 'all',
    };
    if (!controlledValue) setInternalValue(newValue);
    onChange?.(newValue);
    setIsOpen(false);
  };

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          disabled={disabled}
          className={cn(
            'flex h-9 items-center justify-between gap-2 px-3 text-left font-normal border-border/80 hover:bg-accent/60',
            !value.from && !value.to && 'text-muted-foreground',
            className
          )}
        >
          <div className="flex items-center gap-2">
            <CalendarIcon className="size-4 shrink-0 opacity-70 text-primary" />
            <span className="truncate max-w-[200px]">{formatDateRange(value)}</span>
          </div>
          <ChevronDown className="size-3.5 opacity-50 shrink-0" />
        </Button>
      </PopoverTrigger>

      <PopoverContent className="w-80 p-0 shadow-lg" align="start">
        <div className="border-b p-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
            Chọn nhanh
          </p>
          <div className="grid grid-cols-2 gap-1.5">
            {DATE_PRESETS.map((preset) => (
              <Button
                key={preset.key}
                variant={activePreset === preset.key ? 'default' : 'ghost'}
                size="sm"
                className="justify-start text-xs h-7 px-2"
                onClick={() => handleSelectPreset(preset.key)}
              >
                {activePreset === preset.key && (
                  <Check className="size-3 mr-1 shrink-0" />
                )}
                {preset.label}
              </Button>
            ))}
          </div>
        </div>

        <div className="p-3 space-y-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Tùy chỉnh khoảng ngày
          </p>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <label className="text-[11px] text-muted-foreground">Từ ngày</label>
              <Input
                type="date"
                value={tempFrom}
                onChange={(e) => {
                  setTempFrom(e.target.value);
                  setActivePreset(undefined);
                }}
                className="h-8 text-xs"
              />
            </div>
            <div className="space-y-1">
              <label className="text-[11px] text-muted-foreground">Đến ngày</label>
              <Input
                type="date"
                value={tempTo}
                onChange={(e) => {
                  setTempTo(e.target.value);
                  setActivePreset(undefined);
                }}
                className="h-8 text-xs"
              />
            </div>
          </div>

          <div className="flex items-center justify-between pt-2 border-t">
            <Button
              variant="ghost"
              size="sm"
              className="text-xs h-8 text-muted-foreground hover:text-foreground"
              onClick={handleReset}
            >
              <RotateCcw className="size-3 mr-1" />
              Đặt lại
            </Button>
            <Button
              size="sm"
              className="text-xs h-8"
              onClick={handleApplyCustom}
            >
              Áp dụng
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
