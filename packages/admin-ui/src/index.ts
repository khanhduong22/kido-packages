// ============================================================================
// @kido/admin-ui
// Modern Admin UI component system for SME management apps
// ============================================================================

// Utilities
export * from './lib/utils';

// UI Primitives
export * from './components/ui/button';
export * from './components/ui/badge';
export * from './components/ui/card';
export * from './components/ui/input';
export * from './components/ui/avatar';
export * from './components/ui/skeleton';
export * from './components/ui/separator';
export * from './components/ui/table';
export * from './components/ui/dialog';
export * from './components/ui/dropdown-menu';
export * from './components/ui/select';
export * from './components/ui/tooltip';
export * from './components/ui/popover';
export * from './components/ui/breadcrumb';

// SME Business & Admin Modules
export * from './components/badge/status-badge';
export * from './components/stats/stat-card';
export * from './components/stats/metrics-grid';
export * from './components/filters/date-range-filter';
export * from './components/table/pagination';
export * from './components/table/data-table';
export * from './components/layout/admin-shell';

// Sparkline SVG (Zero-Dependency Mathematical SVG Sparkline & React Component)
export * from './sparkline';

// Tour Guide & Walkthrough Modal System
export {
  SpotlightTour,
  SpotlightTourComponent,
  WalkthroughModal,
  useTour,
  useTourHook,
  isTourCompleted,
  markTourCompleted,
  resetTourCompletion,
  getTourStorageKey,
  calculateTargetBounds,
  shouldCardFlipToTop,
  formatStepBadge,
  retryFindElement,
  cn as tourCn,
  STORAGE_KEY_PREFIX,
  CloseIcon,
  ArrowRightIcon,
  ArrowLeftIcon,
  ChevronRightIcon,
  ChevronLeftIcon,
  SparklesIcon,
  CheckIcon,
  CompassIcon,
  renderStepIcon,
} from './tour-guide';
export type {
  TourStep,
  TourPlacement,
  TourLabels,
  SpotlightTourProps,
  WalkthroughModalProps,
  UseTourOptions,
  UseTourReturn,
} from './tour-guide';

