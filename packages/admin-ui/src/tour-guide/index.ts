// Components
export { SpotlightTour, default as SpotlightTourComponent } from './spotlight-overlay';
export { WalkthroughModal } from './walkthrough-modal';

// Hook
export { useTour, default as useTourHook } from './use-tour';

// Utilities
export {
  isTourCompleted,
  markTourCompleted,
  resetTourCompletion,
  getTourStorageKey,
  calculateTargetBounds,
  shouldCardFlipToTop,
  formatStepBadge,
  retryFindElement,
  cn,
  STORAGE_KEY_PREFIX,
} from './utils';

// Built-in Icons & Helpers
export {
  CloseIcon,
  ArrowRightIcon,
  ArrowLeftIcon,
  ChevronRightIcon,
  ChevronLeftIcon,
  SparklesIcon,
  CheckIcon,
  CompassIcon,
  renderStepIcon,
} from './icons';

// Types
export type {
  TourStep,
  TourPlacement,
  TourLabels,
  SpotlightTourProps,
  WalkthroughModalProps,
  UseTourOptions,
  UseTourReturn,
} from './types';
