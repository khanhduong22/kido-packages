import { describe, expect, it, beforeEach } from 'bun:test';
import React from 'react';
import { renderToString } from 'react-dom/server';
import {
  // Components
  SpotlightTour,
  WalkthroughModal,
  // Hook
  useTour,
  // Utilities
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
  // Icons
  CloseIcon,
  ArrowRightIcon,
  ArrowLeftIcon,
  SparklesIcon,
  CheckIcon,
  CompassIcon,
  renderStepIcon,
  // Types
  type TourStep,
} from './index';

// In-memory mock storage for deterministic testing
class MemoryStorage implements Storage {
  private store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
}

const sampleSteps: TourStep[] = [
  {
    id: 'step-1',
    selector: '[data-tour="create-btn"]',
    title: 'Tạo Dự Án Mới',
    subtitle: 'Khởi tạo không gian làm việc',
    description: 'Bấm vào nút Tạo Mới để thiết lập kịch bản và cấu hình dự án.',
    badge: 'Bước 1 / 3',
    tab: 'dashboard',
    placement: 'auto',
  },
  {
    id: 'step-2',
    selector: '[data-tour="editor-canvas"]',
    title: 'Biên Tập Trực Tiếp',
    subtitle: 'Trình soạn thảo hỗ trợ AI',
    description: 'Chỉnh sửa nội dung và nhận gợi ý thông minh từ AI.',
    badge: 'Bước 2 / 3',
    tab: 'editor',
    placement: 'top',
  },
  {
    id: 'step-3',
    selector: '[data-tour="export-btn"]',
    title: 'Xuất Bản Nhanh',
    subtitle: 'Xuất bản đa kênh tiện lợi',
    description: 'Tải trọn bộ dữ liệu hoặc chia sẻ trực tiếp lên các nền tảng.',
    badge: 'Bước 3 / 3',
    tab: 'editor',
    placement: 'bottom',
  },
];

describe('@kido/tour-guide Test Suite', () => {
  let mockStorage: MemoryStorage;

  beforeEach(() => {
    mockStorage = new MemoryStorage();
  });

  describe('1. Storage & Persistence Utilities', () => {
    it('generates consistent storage keys with standard prefix', () => {
      expect(getTourStorageKey('fb_story')).toBe('kt_tour_fb_story_completed');
      expect(getTourStorageKey('onboarding_v2')).toBe('kt_tour_onboarding_v2_completed');
      expect(STORAGE_KEY_PREFIX).toBe('kt_tour_');
    });

    it('identifies uncompleted tours by default', () => {
      expect(isTourCompleted('fb_story', mockStorage)).toBe(false);
    });

    it('marks and confirms tour completion in storage', () => {
      markTourCompleted('fb_story', mockStorage);
      expect(isTourCompleted('fb_story', mockStorage)).toBe(true);
      expect(mockStorage.getItem('kt_tour_fb_story_completed')).toBe('true');
    });

    it('resets tour completion so users can retake the tour', () => {
      markTourCompleted('fb_story', mockStorage);
      expect(isTourCompleted('fb_story', mockStorage)).toBe(true);

      resetTourCompletion('fb_story', mockStorage);
      expect(isTourCompleted('fb_story', mockStorage)).toBe(false);
      expect(mockStorage.getItem('kt_tour_fb_story_completed')).toBeNull();
    });

    it('safely handles null storage or exceptions without throwing', () => {
      expect(isTourCompleted('fb_story', null)).toBe(false);
      expect(() => markTourCompleted('fb_story', null)).not.toThrow();
      expect(() => resetTourCompletion('fb_story', null)).not.toThrow();
    });
  });

  describe('2. Layout & Positioning Mathematics', () => {
    it('calculates target cutout bounds with custom padding', () => {
      const rect = { top: 100, left: 200, width: 300, height: 150 };
      const bounds = calculateTargetBounds(rect, 8);

      expect(bounds.top).toBe(92);
      expect(bounds.left).toBe(192);
      expect(bounds.width).toBe(316);
      expect(bounds.height).toBe(166);
    });

    it('prevents negative top/left coordinates near screen edges', () => {
      const rect = { top: 2, left: 4, width: 100, height: 50 };
      const bounds = calculateTargetBounds(rect, 10);

      expect(bounds.top).toBe(0);
      expect(bounds.left).toBe(0);
      expect(bounds.width).toBe(120);
      expect(bounds.height).toBe(70);
    });

    it('honors explicit top/bottom placement overrides', () => {
      const rect = { top: 700, height: 50 };
      expect(shouldCardFlipToTop(rect, 800, 'top')).toBe(true);
      expect(shouldCardFlipToTop(rect, 800, 'bottom')).toBe(false);
    });

    it('dynamically flips card to top when target is in bottom half of viewport', () => {
      const windowHeight = 800;
      // Target at y=500 (> 400 half): popover card flips to top-5 to avoid occlusion
      const bottomTarget = { top: 500, height: 60 };
      expect(shouldCardFlipToTop(bottomTarget, windowHeight, 'auto')).toBe(true);

      // Target at y=200 (< 400 half): popover card remains at bottom-6
      const topTarget = { top: 200, height: 60 };
      expect(shouldCardFlipToTop(topTarget, windowHeight, 'auto')).toBe(false);
    });

    it('handles null target gracefully defaulting to bottom placement', () => {
      expect(shouldCardFlipToTop(null, 800, 'auto')).toBe(false);
    });
  });

  describe('3. Text Formatting & Class Utilities', () => {
    it('formats step badges with fallback, custom badge, and custom formatter', () => {
      // Default auto-formatting
      expect(formatStepBadge(0, 4)).toBe('Bước 1 / 4');
      expect(formatStepBadge(2, 5)).toBe('Bước 3 / 5');

      // Custom badge override
      expect(formatStepBadge(0, 4, 'Bắt đầu ngay')).toBe('Bắt đầu ngay');

      // Custom formatter callback
      const customFormatter = (c: number, t: number) => `Step ${c} of ${t}`;
      expect(formatStepBadge(1, 3, undefined, customFormatter)).toBe('Step 2 of 3');
    });

    it('combines css classnames filtering out falsy values', () => {
      expect(cn('fixed', false && 'hidden', 'inset-0', undefined, 'z-50')).toBe(
        'fixed inset-0 z-50'
      );
      expect(cn()).toBe('');
    });
  });

  describe('4. Retry Resolver & Resilient Finder', () => {
    it('resolves null if selector cannot be found after max retries in SSR/test environment', async () => {
      const result = await retryFindElement('#non-existent-selector', 2, 10);
      expect(result).toBeNull();
    });
  });

  describe('5. Built-in Zero-Dependency SVG Icons & Render Helper', () => {
    it('renders built-in SVG icons into HTML strings without error', () => {
      const closeSvg = renderToString(React.createElement(CloseIcon));
      expect(closeSvg).toContain('<svg');
      expect(closeSvg).toContain('viewBox="0 0 24 24"');

      const nextSvg = renderToString(React.createElement(ArrowRightIcon));
      expect(nextSvg).toContain('<polyline');

      const prevSvg = renderToString(React.createElement(ArrowLeftIcon));
      expect(prevSvg).toContain('<polyline');

      const sparklesSvg = renderToString(React.createElement(SparklesIcon));
      expect(sparklesSvg).toContain('<path');

      const checkSvg = renderToString(React.createElement(CheckIcon));
      expect(checkSvg).toContain('<polyline');

      const compassSvg = renderToString(React.createElement(CompassIcon));
      expect(compassSvg).toContain('<circle');
    });

    it('renders step icon properly when given a component, node, or string', () => {
      // Default icon
      const defaultIcon = renderToString(React.createElement(() => <>{renderStepIcon(undefined)}</>));
      expect(defaultIcon).toContain('<svg');

      // Emoji string icon
      const emojiIcon = renderToString(React.createElement(() => <>{renderStepIcon('🚀')}</>));
      expect(emojiIcon).toContain('🚀');

      // Custom ComponentType icon
      const CustomIcon: React.FC<{ className?: string }> = ({ className }) => (
        <span className={className}>CUSTOM</span>
      );
      const customRender = renderToString(
        React.createElement(() => <>{renderStepIcon(CustomIcon, undefined, 'my-class')}</>)
      );
      expect(customRender).toContain('CUSTOM');
      expect(customRender).toContain('my-class');
    });
  });

  describe('6. SpotlightTour Cutout Component Rendering', () => {
    it('renders nothing when isOpen is false', () => {
      const html = renderToString(
        React.createElement(SpotlightTour, {
          isOpen: false,
          steps: sampleSteps,
          onClose: () => {},
        })
      );
      expect(html).toBe('');
    });

    it('renders dialog overlay with cutout mask and step details when isOpen is true', () => {
      const html = renderToString(
        React.createElement(SpotlightTour, {
          isOpen: true,
          steps: sampleSteps,
          onClose: () => {},
        })
      );

      expect(html).toContain('role="dialog"');
      expect(html).toContain('Tạo Dự Án Mới');
      expect(html).toContain('Bước 1 / 3');
      expect(html).toContain('Bỏ qua tour');
      expect(html).toContain('Tiếp tục');
      // Verify stepper buttons rendered for all 3 steps
      expect(html).toContain('aria-label="Chuyển đến Bước 1"');
      expect(html).toContain('aria-label="Chuyển đến Bước 2"');
      expect(html).toContain('aria-label="Chuyển đến Bước 3"');
    });

    it('renders finish button on the last step', () => {
      const html = renderToString(
        React.createElement(SpotlightTour, {
          isOpen: true,
          steps: sampleSteps,
          stepIndex: 2, // Last step
          onClose: () => {},
        })
      );

      expect(html).toContain('Xuất Bản Nhanh');
      expect(html).toContain('Hoàn tất &amp; Bắt đầu trải nghiệm');
      expect(html).toContain('Quay lại');
    });

    it('supports custom labels and accent colors', () => {
      const html = renderToString(
        React.createElement(SpotlightTour, {
          isOpen: true,
          steps: sampleSteps,
          stepIndex: 0,
          onClose: () => {},
          accentColor: '#10b981',
          labels: {
            next: 'Tiến Lên',
            skip: 'Dừng Lại',
            close: 'Tắt Ngay',
          },
        })
      );

      expect(html).toContain('Tiến Lên');
      expect(html).toContain('Dừng Lại');
      expect(html).toContain('aria-label="Tắt Ngay"');
    });

    it('renders controlled mode respecting stepIndex', () => {
      const html = renderToString(
        React.createElement(SpotlightTour, {
          isOpen: true,
          steps: sampleSteps,
          stepIndex: 1,
          onClose: () => {},
        })
      );

      expect(html).toContain('Biên Tập Trực Tiếp');
      expect(html).toContain('Bước 2 / 3');
    });
  });

  describe('7. WalkthroughModal Component Rendering', () => {
    it('renders nothing when isOpen is false', () => {
      const html = renderToString(
        React.createElement(WalkthroughModal, {
          isOpen: false,
          steps: sampleSteps,
          onClose: () => {},
        })
      );
      expect(html).toBe('');
    });

    it('renders walkthrough carousel modal when isOpen is true', () => {
      const html = renderToString(
        React.createElement(WalkthroughModal, {
          isOpen: true,
          steps: sampleSteps,
          onClose: () => {},
          actionLabel: '⚡ Thử Ngay',
          onAction: () => {},
        })
      );

      expect(html).toContain('role="dialog"');
      expect(html).toContain('Tạo Dự Án Mới');
      expect(html).toContain('Khởi tạo không gian làm việc');
      expect(html).toContain('⚡ Thử Ngay');
      expect(html).toContain('Phím tắt: ← / → / Esc');
      expect(html).toContain('Tiếp tục');
    });

    it('renders controlled step index in WalkthroughModal', () => {
      const html = renderToString(
        React.createElement(WalkthroughModal, {
          isOpen: true,
          steps: sampleSteps,
          stepIndex: 2,
          onClose: () => {},
        })
      );

      expect(html).toContain('Xuất Bản Nhanh');
      expect(html).toContain('Hoàn tất &amp; Bắt đầu');
      expect(html).toContain('Quay lại');
    });

    it('supports custom modal title and labels', () => {
      const html = renderToString(
        React.createElement(WalkthroughModal, {
          isOpen: true,
          steps: sampleSteps,
          title: 'Giới Thiệu Hệ Thống V2',
          labels: {
            next: 'Bước Tiếp',
            prev: 'Trang Trước',
            skip: 'Bỏ Qua Hết',
          },
          onClose: () => {},
        })
      );

      expect(html).toContain('Giới Thiệu Hệ Thống V2');
      expect(html).toContain('Bước Tiếp');
      expect(html).toContain('Bỏ Qua Hết');
    });
  });

  describe('8. useTour Hook Orchestration Logic', () => {
    // Pure test harness helper to test hook states deterministically
    function TestHookHarness({
      tourKey,
      steps,
      autoStart,
      onComplete,
      storage,
      onRender,
    }: {
      tourKey: string;
      steps: TourStep[];
      autoStart?: boolean;
      onComplete?: () => void;
      storage?: Storage;
      onRender: (tour: ReturnType<typeof useTour>) => void;
    }) {
      const tour = useTour({
        tourKey,
        steps,
        autoStart,
        onComplete,
        storage,
      });
      onRender(tour);
      return null;
    }

    it('initializes in closed state with step 0 and correct step counts', () => {
      let hookOutput: ReturnType<typeof useTour> | undefined;

      renderToString(
        React.createElement(TestHookHarness, {
          tourKey: 'test_tour',
          steps: sampleSteps,
          storage: mockStorage,
          onRender: (tour) => {
            hookOutput = tour;
          },
        })
      );

      expect(hookOutput).toBeDefined();
      expect(hookOutput?.isOpen).toBe(false);
      expect(hookOutput?.currentStepIndex).toBe(0);
      expect(hookOutput?.totalSteps).toBe(3);
      expect(hookOutput?.isFirstStep).toBe(true);
      expect(hookOutput?.isLastStep).toBe(false);
      expect(hookOutput?.hasCompleted).toBe(false);
      expect(hookOutput?.currentStep?.id).toBe('step-1');
      expect(hookOutput?.tourProps.storageKey).toBe('test_tour');
    });

    it('detects previously completed status from storage on initialization', () => {
      markTourCompleted('onboarding_done', mockStorage);
      let hookOutput: ReturnType<typeof useTour> | undefined;

      renderToString(
        React.createElement(TestHookHarness, {
          tourKey: 'onboarding_done',
          steps: sampleSteps,
          storage: mockStorage,
          onRender: (tour) => {
            hookOutput = tour;
          },
        })
      );

      expect(hookOutput?.hasCompleted).toBe(true);
    });

    it('provides complete, reset, next, and jump API handles in tourProps', () => {
      let hookOutput: ReturnType<typeof useTour> | undefined;

      renderToString(
        React.createElement(TestHookHarness, {
          tourKey: 'api_test',
          steps: sampleSteps,
          storage: mockStorage,
          onRender: (tour) => {
            hookOutput = tour;
          },
        })
      );

      expect(typeof hookOutput?.startTour).toBe('function');
      expect(typeof hookOutput?.nextStep).toBe('function');
      expect(typeof hookOutput?.prevStep).toBe('function');
      expect(typeof hookOutput?.goToStep).toBe('function');
      expect(typeof hookOutput?.skipTour).toBe('function');
      expect(typeof hookOutput?.completeTour).toBe('function');
      expect(typeof hookOutput?.resetTour).toBe('function');
      expect(hookOutput?.tourProps.steps.length).toBe(3);
    });
  });
});
