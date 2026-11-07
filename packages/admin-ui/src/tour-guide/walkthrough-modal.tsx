import React, { useState, useEffect, useCallback } from 'react';
import type { WalkthroughModalProps, TourStep } from './types';
import { formatStepBadge, cn } from './utils';
import {
  CloseIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  SparklesIcon,
  renderStepIcon,
} from './icons';

export const WalkthroughModal: React.FC<WalkthroughModalProps> = ({
  isOpen,
  steps,
  onClose,
  onComplete,
  accentColor = '#3b82f6',
  actionLabel,
  onAction,
  title,
  labels,
  zIndex = 99990,
  stepIndex: controlledStepIndex,
  onStepChange,
  className,
}) => {
  const [internalStepIndex, setInternalStepIndex] = useState(0);

  const isControlled = controlledStepIndex !== undefined;
  const currentStepIdx = isControlled ? controlledStepIndex : internalStepIndex;

  const totalSteps = steps.length;
  const step: TourStep | undefined = steps[currentStepIdx];
  const isFirst = currentStepIdx === 0;
  const isLast = currentStepIdx >= totalSteps - 1;

  // Localized action labels
  const nextLabel = labels?.next ?? 'Tiếp tục';
  const prevLabel = labels?.prev ?? 'Quay lại';
  const finishLabel = labels?.finish ?? 'Hoàn tất & Bắt đầu';
  const skipLabel = labels?.skip ?? 'Bỏ qua';
  const closeLabel = labels?.close ?? 'Đóng hướng dẫn';
  const keyboardHint = labels?.keyboardHint ?? 'Phím tắt: ← / → / Esc';

  const setIndex = useCallback(
    (newIdx: number) => {
      if (!isControlled) {
        setInternalStepIndex(newIdx);
      }
      onStepChange?.(newIdx);
    },
    [isControlled, onStepChange]
  );

  // Reset to first step whenever reopened
  useEffect(() => {
    if (isOpen && !isControlled) {
      setInternalStepIndex(0);
    }
  }, [isOpen, isControlled]);

  // Keyboard navigation: Left/Right to change steps, Escape to close
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!isOpen) return;
      if (e.key === 'ArrowRight' && !isLast) {
        e.preventDefault();
        setIndex(currentStepIdx + 1);
      } else if (e.key === 'ArrowLeft' && !isFirst) {
        e.preventDefault();
        setIndex(currentStepIdx - 1);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    },
    [isOpen, isFirst, isLast, currentStepIdx, setIndex, onClose]
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  if (!isOpen || !step) return null;

  const handleNext = () => {
    if (isLast) {
      onComplete?.();
      onClose();
    } else {
      setIndex(currentStepIdx + 1);
    }
  };

  const handlePrev = () => {
    if (!isFirst) {
      setIndex(currentStepIdx - 1);
    }
  };

  const handleActionClick = () => {
    onAction?.();
    onClose();
  };

  const progressPercentage = Math.round(((currentStepIdx + 1) / totalSteps) * 100);
  const badgeText = formatStepBadge(currentStepIdx, totalSteps, step.badge, labels?.stepFormat);

  // Styling accents for active card
  const accentText = step.accentColor ?? 'text-blue-400';
  const accentBg = step.accentBg ?? 'bg-blue-600/10';
  const accentBorder = step.accentBorder ?? 'border-blue-500/30';

  return (
    <div
      className={cn(
        'fixed inset-0 flex items-center justify-center p-3 sm:p-5 bg-black/85 backdrop-blur-md select-none overflow-y-auto',
        className
      )}
      style={{ zIndex }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="walkthrough-modal-title"
    >
      <div className="w-full max-w-3xl rounded-2xl bg-[#0A0C10] border border-white/[0.08] shadow-2xl shadow-black/80 overflow-hidden flex flex-col my-auto transition-all animate-fadeIn">
        {/* Top Header */}
        <div className="px-5 py-3.5 border-b border-white/[0.08] flex items-center justify-between bg-[#0F131C]">
          <div className="flex items-center gap-2.5">
            <div
              className={cn(
                'w-8 h-8 rounded-lg flex items-center justify-center border transition-all',
                accentBg,
                accentBorder,
                accentText
              )}
            >
              {renderStepIcon(step.icon, undefined, 'w-4 h-4')}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-mono font-semibold uppercase tracking-wider text-blue-400">
                  {badgeText}
                </span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/[0.06] text-slate-400 font-mono">
                  {keyboardHint}
                </span>
              </div>
              <h3
                id="walkthrough-modal-title"
                className="text-sm sm:text-base font-bold text-white tracking-tight"
              >
                {title ?? step.title}
              </h3>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/[0.08] transition-colors"
            title={closeLabel}
            aria-label={closeLabel}
          >
            <CloseIcon className="w-4 h-4" />
          </button>
        </div>

        {/* Progress Bar & Stepper Tabs */}
        <div className="px-5 pt-3 pb-1 bg-[#0A0C10]">
          <div className="w-full bg-white/[0.06] h-1.5 rounded-full overflow-hidden mb-3">
            <div
              className="h-full bg-gradient-to-r from-blue-500 via-indigo-500 to-emerald-400 transition-all duration-300 ease-out rounded-full"
              style={{ width: `${progressPercentage}%` }}
            />
          </div>

          {/* Stepper Dots Navigation */}
          <div className="flex items-center justify-between gap-1 overflow-x-auto pb-1" role="tablist">
            {steps.map((s, idx) => {
              const isCurrent = idx === currentStepIdx;
              const isPast = idx < currentStepIdx;
              return (
                <button
                  key={s.id ?? idx}
                  type="button"
                  onClick={() => setIndex(idx)}
                  className={cn(
                    'flex-1 flex items-center justify-center gap-1.5 py-1 px-1.5 rounded-md text-[11px] font-medium transition-all',
                    isCurrent
                      ? 'bg-blue-600/20 text-blue-300 border border-blue-500/30 font-semibold shadow-sm'
                      : isPast
                      ? 'text-slate-400 hover:text-white hover:bg-white/[0.04]'
                      : 'text-slate-600 hover:text-slate-400'
                  )}
                  title={`Bước ${idx + 1}: ${s.title}`}
                  aria-label={`Chuyển đến Bước ${idx + 1}`}
                  aria-selected={isCurrent}
                >
                  <span
                    className={cn(
                      'w-2 h-2 rounded-full transition-all',
                      isCurrent
                        ? 'bg-blue-400 ring-2 ring-blue-400/40'
                        : isPast
                        ? 'bg-emerald-400'
                        : 'bg-slate-700'
                    )}
                  />
                  <span className="hidden sm:inline font-mono">B{idx + 1}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Main Content Area */}
        <div className="p-5 sm:p-6 flex flex-col gap-4 bg-gradient-to-b from-[#0A0C10] to-[#0D111A]">
          <div className="flex flex-col gap-1.5">
            <h4 className="text-lg sm:text-xl font-bold text-white tracking-tight flex items-center gap-2">
              <span>{step.title}</span>
            </h4>
            {step.subtitle && (
              <p className="text-xs sm:text-sm font-medium text-slate-300">
                {step.subtitle}
              </p>
            )}
            <p className="text-xs sm:text-sm text-slate-400 leading-relaxed font-sans pt-1">
              {step.description}
            </p>
          </div>

          {/* Optional visual presentation container or highlight banner */}
          <div className="p-4 rounded-xl bg-white/[0.03] border border-white/[0.06] flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div
                className={cn(
                  'w-10 h-10 rounded-xl flex items-center justify-center border',
                  accentBg,
                  accentBorder,
                  accentText
                )}
              >
                {renderStepIcon(step.icon, undefined, 'w-5 h-5')}
              </div>
              <div className="flex flex-col">
                <span className="text-xs font-semibold text-white">
                  {step.tab ? `Khu vực: ${step.tab}` : `Bộ chọn: ${step.selector}`}
                </span>
                <span className="text-[11px] text-slate-400">
                  {step.placement ? `Vị trí: ${step.placement}` : 'Tự động canh lề tối ưu'}
                </span>
              </div>
            </div>

            {actionLabel && (
              <button
                type="button"
                onClick={handleActionClick}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-blue-600/80 hover:bg-blue-600 border border-blue-400/30 transition-all active:scale-95 shadow-sm"
              >
                {actionLabel}
              </button>
            )}
          </div>
        </div>

        {/* Bottom Footer Controls */}
        <div className="px-5 py-3.5 border-t border-white/[0.08] flex items-center justify-between bg-[#0F131C] gap-3">
          <button
            type="button"
            onClick={onClose}
            className="text-xs font-semibold text-slate-400 hover:text-white px-2 py-1.5 transition-colors"
          >
            {skipLabel}
          </button>

          <div className="flex items-center gap-2">
            {!isFirst && (
              <button
                type="button"
                onClick={handlePrev}
                className="px-3.5 py-2 rounded-xl text-xs font-bold text-slate-200 bg-white/[0.08] hover:bg-white/[0.12] transition-all flex items-center gap-1.5 active:scale-95 border border-white/[0.06]"
              >
                <ChevronLeftIcon className="w-3.5 h-3.5" />
                <span>{prevLabel}</span>
              </button>
            )}

            <button
              type="button"
              onClick={handleNext}
              className="px-4 py-2 rounded-xl text-xs font-bold text-white bg-gradient-to-r from-blue-600 via-indigo-600 to-blue-500 hover:from-blue-500 hover:to-indigo-500 shadow-md shadow-blue-500/25 active:scale-95 transition-all flex items-center gap-1.5 border border-blue-400/30"
            >
              <span>{isLast ? finishLabel : nextLabel}</span>
              {isLast ? (
                <SparklesIcon className="w-3.5 h-3.5 text-amber-300" />
              ) : (
                <ChevronRightIcon className="w-3.5 h-3.5" />
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default WalkthroughModal;
