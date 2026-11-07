import React, { useState, useEffect, useCallback, useRef } from 'react';
import type { SpotlightTourProps, TourStep } from './types';
import {
  calculateTargetBounds,
  formatStepBadge,
  markTourCompleted,
  shouldCardFlipToTop,
  cn,
} from './utils';
import {
  CloseIcon,
  ArrowRightIcon,
  ArrowLeftIcon,
  SparklesIcon,
  renderStepIcon,
} from './icons';

export const SpotlightTour: React.FC<SpotlightTourProps> = ({
  isOpen,
  steps,
  onClose,
  onComplete,
  currentTab,
  onTabChange,
  accentColor = '#3b82f6',
  storageKey,
  maskColor = 'rgba(0, 0, 0, 0.75)',
  labels,
  closeOnOverlayClick = false,
  zIndex = 99990,
  stepIndex: controlledStepIndex,
  onStepChange,
  scrollBehavior = 'smooth',
  className,
}) => {
  const [internalStepIndex, setInternalStepIndex] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);

  const isControlled = controlledStepIndex !== undefined;
  const currentStepIdx = isControlled ? controlledStepIndex : internalStepIndex;

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevIsOpenRef = useRef(false);
  const currentTabRef = useRef(currentTab);
  currentTabRef.current = currentTab;
  const onTabChangeRef = useRef(onTabChange);
  onTabChangeRef.current = onTabChange;

  const totalSteps = steps.length;
  const step: TourStep | undefined = steps[currentStepIdx];
  const isFirst = currentStepIdx === 0;
  const isLast = currentStepIdx >= totalSteps - 1;

  // Localized action labels with fallbacks
  const nextLabel = labels?.next ?? 'Tiếp tục';
  const prevLabel = labels?.prev ?? 'Quay lại';
  const finishLabel = labels?.finish ?? 'Hoàn tất & Bắt đầu trải nghiệm';
  const skipLabel = labels?.skip ?? 'Bỏ qua tour';
  const closeLabel = labels?.close ?? 'Đóng hướng dẫn';

  const setIndex = useCallback(
    (newIdx: number) => {
      if (!isControlled) {
        setInternalStepIndex(newIdx);
      }
      onStepChange?.(newIdx);
    },
    [isControlled, onStepChange]
  );

  /**
   * Resilient DOM measurement with multiple retry intervals for lazy-loaded
   * or tab-switched elements.
   */
  const measure = useCallback(
    (selector: string, retryCount = 0) => {
      if (typeof document === 'undefined') return;
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);

      const el = document.querySelector(selector);
      if (el) {
        try {
          el.scrollIntoView({ behavior: scrollBehavior, block: 'center' });
        } catch {
          // Fallback if smooth scrollIntoView options are unsupported
          el.scrollIntoView();
        }

        const updateRect = () => {
          const domRect = el.getBoundingClientRect();
          if (domRect.width > 0 && domRect.height > 0) {
            setRect(domRect);
          }
        };

        // Immediate measurement
        updateRect();
        // Follow-up passes to account for smooth scroll & layout shift
        setTimeout(updateRect, 180);
        setTimeout(updateRect, 380);
      } else if (retryCount < 7) {
        // Resilient retry: wait for lazy components or tab transition
        retryTimerRef.current = setTimeout(() => {
          measure(selector, retryCount + 1);
        }, 150);
      } else {
        setRect(null);
      }
    },
    [scrollBehavior]
  );

  /**
   * Step navigation handler with automatic tab switching
   */
  const goToStep = useCallback(
    (newIdx: number) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);

      const target = steps[newIdx];
      if (!target) return;

      setIndex(newIdx);

      // Auto-switch tab if step belongs to a different view
      if (target.tab && currentTabRef.current !== target.tab && onTabChangeRef.current) {
        onTabChangeRef.current(target.tab);
        // Give time for the tab to render DOM elements
        timerRef.current = setTimeout(() => measure(target.selector), 350);
      } else {
        measure(target.selector);
      }
    },
    [steps, setIndex, measure]
  );

  // Initialize and track isOpen lifecycle
  useEffect(() => {
    const wasOpen = prevIsOpenRef.current;
    prevIsOpenRef.current = isOpen;

    if (!isOpen) {
      if (!isControlled) setInternalStepIndex(0);
      setRect(null);
      if (timerRef.current) clearTimeout(timerRef.current);
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      return;
    }

    if (!wasOpen && isOpen && steps.length > 0) {
      const initialStep = steps[0];
      if (!isControlled) setInternalStepIndex(0);

      if (initialStep.tab && currentTabRef.current !== initialStep.tab && onTabChangeRef.current) {
        onTabChangeRef.current(initialStep.tab);
        timerRef.current = setTimeout(() => measure(initialStep.selector), 350);
      } else {
        measure(initialStep.selector);
      }
    }

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    };
  }, [isOpen, steps, isControlled, measure]);

  // Track dynamic changes to current step selector
  useEffect(() => {
    if (!isOpen || !step) return;
    measure(step.selector);
  }, [isOpen, currentStepIdx, step?.selector, measure]);

  // Keep spotlight aligned during viewport resize and scroll
  useEffect(() => {
    if (!isOpen || !step) return;

    const onReposition = () => {
      const el = document.querySelector(step.selector);
      if (el) {
        setRect(el.getBoundingClientRect());
      }
    };

    window.addEventListener('resize', onReposition, { passive: true });
    window.addEventListener('scroll', onReposition, { passive: true, capture: true });

    return () => {
      window.removeEventListener('resize', onReposition);
      window.removeEventListener('scroll', onReposition, { capture: true });
    };
  }, [isOpen, step]);

  // Keyboard navigation & accessibility (ArrowRight, ArrowLeft, Escape)
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'ArrowRight' && !isLast) {
        e.preventDefault();
        goToStep(currentStepIdx + 1);
      } else if (e.key === 'ArrowLeft' && !isFirst) {
        e.preventDefault();
        goToStep(currentStepIdx - 1);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, currentStepIdx, isFirst, isLast, onClose, goToStep]);

  if (!isOpen || !step) return null;

  const windowHeight = typeof window !== 'undefined' ? window.innerHeight : 800;
  const isFlippedToTop = shouldCardFlipToTop(rect, windowHeight, step.placement);
  const padding = step.targetPadding ?? 6;
  const bounds = rect ? calculateTargetBounds(rect, padding) : null;
  const badgeText = formatStepBadge(currentStepIdx, totalSteps, step.badge, labels?.stepFormat);

  const handleFinish = () => {
    if (storageKey) {
      markTourCompleted(storageKey);
    }
    onComplete?.();
    onClose();
  };

  return (
    <div
      className={cn('fixed inset-0 select-none', className)}
      style={{
        zIndex,
        pointerEvents: 'none',
      }}
      role="dialog"
      aria-modal="true"
      aria-label={step.title}
    >
      {/* 
        ========================================================================
        CSS CUTOUT SPOTLIGHT TECHNIQUE
        Uses a massive 9999px box-shadow on the spotlight boundary box.
        Creates an infallible, hardware-accelerated transparent cutout hole
        without heavy canvas or SVG clip-path computations.
        ========================================================================
      */}
      {bounds ? (
        <div
          data-testid="spotlight-cutout"
          className="fixed rounded-2xl transition-all duration-300 pointer-events-none"
          style={{
            top: bounds.top,
            left: bounds.left,
            width: bounds.width,
            height: bounds.height,
            boxShadow: `0 0 0 9999px ${maskColor}`,
            border: `2px solid ${accentColor}`,
            outline: `3px solid ${accentColor}40`,
          }}
        />
      ) : (
        /* Fallback dark overlay while element is being located */
        <div
          data-testid="spotlight-fallback-overlay"
          className="fixed inset-0 transition-opacity"
          style={{
            backgroundColor: maskColor,
            backdropFilter: 'blur(2px)',
            pointerEvents: closeOnOverlayClick ? 'auto' : 'none',
          }}
          onClick={closeOnOverlayClick ? onClose : undefined}
        />
      )}

      {/* Floating Tour Step Card */}
      <div
        className={cn(
          'fixed left-1/2 -translate-x-1/2 w-[calc(100%-2rem)] max-w-[440px] pointer-events-auto transition-all duration-300',
          isFlippedToTop ? 'top-5' : 'bottom-6'
        )}
        style={{
          zIndex: zIndex + 10,
        }}
      >
        <div className="relative rounded-2xl p-5 bg-[#0D121F]/95 backdrop-blur-md border border-blue-500/30 shadow-2xl shadow-blue-500/20 text-white flex flex-col gap-3">
          {/* Header */}
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="px-2.5 py-0.5 rounded-full text-[10px] font-mono font-bold tracking-wider uppercase bg-blue-500/15 text-blue-400 border border-blue-500/30">
                {badgeText}
              </span>
              {step.icon && (
                <div className="w-5 h-5 flex items-center justify-center text-blue-400">
                  {renderStepIcon(step.icon, undefined, 'w-4 h-4')}
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={onClose}
              className="w-7 h-7 rounded-full flex items-center justify-center text-slate-400 hover:text-white hover:bg-white/10 transition-colors"
              title={closeLabel}
              aria-label={closeLabel}
            >
              <CloseIcon className="w-4 h-4" />
            </button>
          </div>

          {/* Body Content */}
          <div className="flex flex-col gap-1.5">
            <h3 className="text-base font-bold text-white tracking-tight flex items-center gap-2">
              <span>{step.title}</span>
            </h3>
            {step.subtitle && (
              <p className="text-xs font-medium text-blue-300/80 -mt-0.5">{step.subtitle}</p>
            )}
            <p className="text-xs text-slate-300 leading-relaxed font-sans">{step.description}</p>
          </div>

          {/* Stepper Dots Indicator (Clickable Jump) */}
          <div className="flex items-center gap-1.5 pt-1" role="tablist" aria-label="Tour Steps">
            {steps.map((_, idx) => {
              const isCurrent = idx === currentStepIdx;
              const isPast = idx < currentStepIdx;
              return (
                <button
                  key={idx}
                  type="button"
                  onClick={() => goToStep(idx)}
                  className={cn(
                    'h-1.5 rounded-full transition-all focus:outline-none focus:ring-1 focus:ring-blue-400',
                    isCurrent
                      ? 'w-6 bg-blue-400'
                      : isPast
                      ? 'w-2 bg-emerald-400'
                      : 'w-2 bg-slate-700 hover:bg-slate-600'
                  )}
                  title={`Bước ${idx + 1}`}
                  aria-label={`Chuyển đến Bước ${idx + 1}`}
                  aria-selected={isCurrent}
                />
              );
            })}
          </div>

          {/* Footer Action Buttons */}
          <div className="flex items-center justify-between pt-2 border-t border-white/10 gap-2">
            <button
              type="button"
              onClick={onClose}
              className="text-xs font-semibold text-slate-400 hover:text-slate-200 px-2 py-1.5 transition-colors"
            >
              {skipLabel}
            </button>

            <div className="flex items-center gap-2">
              {!isFirst && (
                <button
                  type="button"
                  onClick={() => goToStep(currentStepIdx - 1)}
                  className="px-3 py-1.5 rounded-xl text-xs font-bold text-slate-200 bg-white/10 hover:bg-white/15 transition-all flex items-center gap-1 active:scale-95"
                >
                  <ArrowLeftIcon className="w-3.5 h-3.5" />
                  <span>{prevLabel}</span>
                </button>
              )}

              <button
                type="button"
                onClick={isLast ? handleFinish : () => goToStep(currentStepIdx + 1)}
                className="px-3.5 py-2 rounded-xl text-xs font-bold text-white bg-gradient-to-r from-blue-600 via-indigo-600 to-blue-500 hover:from-blue-500 hover:to-indigo-500 shadow-md shadow-blue-500/25 active:scale-95 transition-all flex items-center gap-1.5 border border-blue-400/30"
              >
                <span>{isLast ? finishLabel : nextLabel}</span>
                {isLast ? (
                  <SparklesIcon className="w-3.5 h-3.5 text-amber-300" />
                ) : (
                  <ArrowRightIcon className="w-3.5 h-3.5" />
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SpotlightTour;
