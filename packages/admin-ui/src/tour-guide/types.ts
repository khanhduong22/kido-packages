import type React from 'react';

/** Placement preference for the tour popover card relative to the target element */
export type TourPlacement = 'auto' | 'top' | 'bottom';

/**
 * Definition of an individual step within a tour
 */
export interface TourStep {
  /** Unique identifier for the step (e.g. 'step-1' or 1) */
  id: string | number;
  /** CSS selector to target in the DOM (e.g. `[data-tour="tour-create-post"]` or `#save-btn`) */
  selector: string;
  /** Primary headline or title of the step */
  title: string;
  /** Comprehensive instructions or descriptive text for the user */
  description: string;
  /** Optional badge text displayed on top of the step card (e.g. 'Bước 1 / 4', 'Tính năng mới') */
  badge?: string;
  /** Subtitle for richer walkthrough carousel cards */
  subtitle?: string;
  /** Identifier of the tab or route that must be active for this step */
  tab?: string;
  /** Positioning mode for the card: 'auto' (detects screen quadrant), 'top', or 'bottom' */
  placement?: TourPlacement;
  /**
   * Icon representation for the step. Can be a React component class,
   * an instantiated ReactNode, or an emoji string.
   */
  icon?: React.ComponentType<{ className?: string }> | React.ReactNode | string;
  /** Custom accent color token or CSS color (e.g. '#3b82f6', 'text-blue-400') */
  accentColor?: string;
  /** Custom accent background class or CSS value */
  accentBg?: string;
  /** Custom accent border class or CSS value */
  accentBorder?: string;
  /** Extra padding in pixels around the target element cutout (default: 6px) */
  targetPadding?: number;
  /** Optional arbitrary metadata payload for custom integrations */
  meta?: Record<string, unknown>;
}

/**
 * Customizable internationalization and UI text labels for the tour
 */
export interface TourLabels {
  /** Label for advancing to next step (default: 'Tiếp tục') */
  next?: string;
  /** Label for retreating to previous step (default: 'Quay lại') */
  prev?: string;
  /** Label for the final completion button (default: 'Hoàn tất & Bắt đầu trải nghiệm') */
  finish?: string;
  /** Label for skipping or staying on current step (default: 'Bỏ qua tour') */
  skip?: string;
  /** Label for close button accessible text (default: 'Đóng hướng dẫn') */
  close?: string;
  /** Keyboard shortcut hint text (default: 'Phím tắt: ← / → / Esc') */
  keyboardHint?: string;
  /** Custom step badge formatter (e.g. (cur, tot) => `Bước ${cur} / ${tot}`) */
  stepFormat?: (currentStep: number, totalSteps: number) => string;
}

/**
 * Props for the SpotlightTour cutout overlay component
 */
export interface SpotlightTourProps {
  /** Whether the spotlight tour overlay is currently rendered */
  isOpen: boolean;
  /** Array of tour steps to navigate through */
  steps: TourStep[];
  /** Callback invoked when the user closes or dismisses the tour */
  onClose: () => void;
  /** Callback invoked when the user reaches and completes the final step */
  onComplete?: () => void;
  /** Currently active tab identifier in the host application */
  currentTab?: string;
  /** Callback fired when a step requires switching to a different tab */
  onTabChange?: (tab: string) => void;
  /** Primary accent color for spotlight glowing border and highlights (default: '#3b82f6') */
  accentColor?: string;
  /** Optional localStorage key to automatically flag as completed on finish */
  storageKey?: string;
  /** Dark cutout mask backdrop color (default: 'rgba(0, 0, 0, 0.75)') */
  maskColor?: string;
  /** Text labels localization dictionary */
  labels?: TourLabels;
  /** Whether clicking the backdrop overlay closes the tour (default: false) */
  closeOnOverlayClick?: boolean;
  /** Z-index layer for the spotlight portal (default: 99990) */
  zIndex?: number;
  /** Step index override for controlled mode */
  stepIndex?: number;
  /** Callback fired whenever the active step index changes */
  onStepChange?: (index: number) => void;
  /** Scroll behavior when bringing target element into view (default: 'smooth') */
  scrollBehavior?: ScrollBehavior;
  /** Optional custom container class */
  className?: string;
}

/**
 * Props for the WalkthroughModal component
 */
export interface WalkthroughModalProps {
  /** Whether the walkthrough modal is visible */
  isOpen: boolean;
  /** Array of feature overview steps */
  steps: TourStep[];
  /** Callback invoked when closing or dismissing the modal */
  onClose: () => void;
  /** Callback invoked when completing the walkthrough */
  onComplete?: () => void;
  /** Accent color token or hex string (default: '#3b82f6') */
  accentColor?: string;
  /** Optional special CTA action button label (e.g. '⚡ Điền Mẫu 1-Chạm') */
  actionLabel?: string;
  /** Callback invoked when the special action button is clicked */
  onAction?: () => void;
  /** Optional custom modal title override */
  title?: string;
  /** Text labels dictionary */
  labels?: TourLabels;
  /** Custom z-index layer (default: 99990) */
  zIndex?: number;
  /** Step index override for controlled mode */
  stepIndex?: number;
  /** Callback fired whenever the active step index changes */
  onStepChange?: (index: number) => void;
  /** Optional custom container class */
  className?: string;
}

/**
 * Options for the useTour hook
 */
export interface UseTourOptions {
  /** Unique key identifier used for localStorage completion tracking */
  tourKey: string;
  /** List of tour steps */
  steps: TourStep[];
  /** If true, automatically starts the tour on first visit if not yet completed */
  autoStart?: boolean;
  /** Callback invoked when tour successfully completes */
  onComplete?: () => void;
  /** Callback invoked when tab switching is needed */
  onTabChange?: (tab: string) => void;
  /** Custom storage backend (defaults to window.localStorage) */
  storage?: Storage | null;
}

/**
 * Return interface of the useTour hook
 */
export interface UseTourReturn {
  /** Whether the tour overlay or modal is active */
  isOpen: boolean;
  /** Current step index (0-indexed) */
  currentStepIndex: number;
  /** Current active TourStep object, or null if none */
  currentStep: TourStep | null;
  /** Total number of steps */
  totalSteps: number;
  /** True if currently on the first step */
  isFirstStep: boolean;
  /** True if currently on the final step */
  isLastStep: boolean;
  /** True if the tour has previously been completed and saved in storage */
  hasCompleted: boolean;
  /** Start or restart the tour, optionally at a designated step index */
  startTour: (stepIndex?: number) => void;
  /** Advance to the next step, or complete if already at the last step */
  nextStep: () => void;
  /** Retreat to the previous step */
  prevStep: () => void;
  /** Jump directly to any valid step index */
  goToStep: (index: number) => void;
  /** Close and skip the tour without marking it as completed */
  skipTour: () => void;
  /** Mark the tour as completed in storage, trigger onComplete, and close */
  completeTour: () => void;
  /** Reset completion state in storage so the tour can be viewed again */
  resetTour: () => void;
  /** Pre-configured props bundle ready to spread directly onto <SpotlightTour {...tourProps} /> */
  tourProps: {
    isOpen: boolean;
    steps: TourStep[];
    stepIndex: number;
    onStepChange: (index: number) => void;
    onClose: () => void;
    onComplete: () => void;
    storageKey: string;
    onTabChange?: (tab: string) => void;
  };
}
