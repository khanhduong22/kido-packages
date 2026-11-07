import type { TourPlacement } from './types';

export const STORAGE_KEY_PREFIX = 'kt_tour_';

/**
 * Derives the unique localStorage key for a given tour
 */
export function getTourStorageKey(tourKey: string): string {
  return `${STORAGE_KEY_PREFIX}${tourKey}_completed`;
}

/**
 * Checks whether a tour has been marked completed in storage
 */
export function isTourCompleted(tourKey: string, customStorage?: Storage | null): boolean {
  try {
    const storage =
      customStorage ??
      (typeof window !== 'undefined' && window.localStorage ? window.localStorage : null);
    if (!storage) return false;
    return storage.getItem(getTourStorageKey(tourKey)) === 'true';
  } catch {
    return false;
  }
}

/**
 * Marks a tour as completed in storage
 */
export function markTourCompleted(tourKey: string, customStorage?: Storage | null): void {
  try {
    const storage =
      customStorage ??
      (typeof window !== 'undefined' && window.localStorage ? window.localStorage : null);
    if (!storage) return;
    storage.setItem(getTourStorageKey(tourKey), 'true');
  } catch {
    // Fail silently in private/restricted storage contexts
  }
}

/**
 * Resets a tour's completed status so it can be taken again
 */
export function resetTourCompletion(tourKey: string, customStorage?: Storage | null): void {
  try {
    const storage =
      customStorage ??
      (typeof window !== 'undefined' && window.localStorage ? window.localStorage : null);
    if (!storage) return;
    storage.removeItem(getTourStorageKey(tourKey));
  } catch {
    // Fail silently
  }
}

/**
 * Calculates spotlight cutout bounding box with custom padding and boundary guards
 */
export function calculateTargetBounds(
  rect: { top: number; left: number; width: number; height: number },
  padding = 6
): { top: number; left: number; width: number; height: number } {
  return {
    top: Math.max(0, rect.top - padding),
    left: Math.max(0, rect.left - padding),
    width: Math.max(0, rect.width + padding * 2),
    height: Math.max(0, rect.height + padding * 2),
  };
}

/**
 * Determines whether the popover card should be flipped to the top of the viewport
 * to avoid covering the spotlight target
 */
export function shouldCardFlipToTop(
  targetRect: { top: number; height?: number } | null,
  windowHeight: number,
  placement?: TourPlacement
): boolean {
  if (placement === 'top') return true;
  if (placement === 'bottom') return false;

  // 'auto' placement logic
  if (!targetRect) return false;
  const viewportCenter = windowHeight > 0 ? windowHeight / 2 : 400;
  // If target element is situated in the lower half of screen, flip card to top
  return targetRect.top > viewportCenter;
}

/**
 * Formats a user-friendly step badge (e.g. 'Bước 1 / 4')
 */
export function formatStepBadge(
  currentStepIndex: number,
  totalSteps: number,
  customBadge?: string,
  customFormatter?: (cur: number, tot: number) => string
): string {
  if (customBadge) return customBadge;
  if (customFormatter) return customFormatter(currentStepIndex + 1, totalSteps);
  return `Bước ${currentStepIndex + 1} / ${totalSteps}`;
}

/**
 * Resilient DOM element finder with exponential or linear retry intervals
 */
export function retryFindElement(
  selector: string,
  maxRetries = 6,
  interval = 150
): Promise<Element | null> {
  return new Promise((resolve) => {
    let attempts = 0;

    const probe = () => {
      if (typeof document === 'undefined') {
        resolve(null);
        return;
      }

      const el = document.querySelector(selector);
      if (el) {
        resolve(el);
        return;
      }

      attempts++;
      if (attempts >= maxRetries) {
        resolve(null);
      } else {
        setTimeout(probe, interval);
      }
    };

    probe();
  });
}

/**
 * Lightweight classNames combiner without external dependencies
 */
export function cn(...classes: (string | boolean | undefined | null)[]): string {
  return classes.filter(Boolean).join(' ');
}
