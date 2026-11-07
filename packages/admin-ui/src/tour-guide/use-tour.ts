import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import type { TourStep, UseTourOptions, UseTourReturn } from './types';
import {
  isTourCompleted,
  markTourCompleted,
  resetTourCompletion,
} from './utils';

/**
 * React hook to orchestrate interactive product and feature tours
 * with integrated localStorage persistence and lifecycle callbacks.
 */
export function useTour({
  tourKey,
  steps,
  autoStart = false,
  onComplete,
  onTabChange,
  storage,
}: UseTourOptions): UseTourReturn {
  const [isOpen, setIsOpen] = useState(false);
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [hasCompleted, setHasCompleted] = useState<boolean>(() =>
    isTourCompleted(tourKey, storage)
  );

  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  const totalSteps = steps.length;
  const isFirstStep = currentStepIndex === 0;
  const isLastStep = currentStepIndex >= totalSteps - 1;
  const currentStep = steps[currentStepIndex] ?? null;

  // Sync completion state if tourKey or storage changes
  useEffect(() => {
    setHasCompleted(isTourCompleted(tourKey, storage));
  }, [tourKey, storage]);

  /**
   * Start or resume the tour
   */
  const startTour = useCallback(
    (stepIndex = 0) => {
      const validIndex = Math.max(0, Math.min(stepIndex, totalSteps - 1));
      setCurrentStepIndex(validIndex);
      setIsOpen(true);
    },
    [totalSteps]
  );

  /**
   * Close without completing
   */
  const skipTour = useCallback(() => {
    setIsOpen(false);
  }, []);

  /**
   * Complete the tour, store flag in localStorage, and trigger callback
   */
  const completeTour = useCallback(() => {
    markTourCompleted(tourKey, storage);
    setHasCompleted(true);
    setIsOpen(false);
    onCompleteRef.current?.();
  }, [tourKey, storage]);

  /**
   * Move to next step or complete if on the last step
   */
  const nextStep = useCallback(() => {
    if (currentStepIndex >= totalSteps - 1) {
      completeTour();
    } else {
      setCurrentStepIndex((prev) => prev + 1);
    }
  }, [currentStepIndex, totalSteps, completeTour]);

  /**
   * Move to previous step
   */
  const prevStep = useCallback(() => {
    if (currentStepIndex > 0) {
      setCurrentStepIndex((prev) => prev - 1);
    }
  }, [currentStepIndex]);

  /**
   * Jump directly to an index
   */
  const goToStep = useCallback(
    (index: number) => {
      if (index >= 0 && index < totalSteps) {
        setCurrentStepIndex(index);
      }
    },
    [totalSteps]
  );

  /**
   * Reset completion status so user can take the tour again
   */
  const resetTour = useCallback(() => {
    resetTourCompletion(tourKey, storage);
    setHasCompleted(false);
    setCurrentStepIndex(0);
  }, [tourKey, storage]);

  // Handle auto-start on mount if tour hasn't been completed yet
  useEffect(() => {
    if (autoStart && !isTourCompleted(tourKey, storage) && steps.length > 0) {
      setIsOpen(true);
      setCurrentStepIndex(0);
    }
  }, [autoStart, tourKey, storage, steps.length]);

  /**
   * Pre-packaged props bundle to spread cleanly onto <SpotlightTour {...tourProps} />
   */
  const tourProps = useMemo(
    () => ({
      isOpen,
      steps,
      stepIndex: currentStepIndex,
      onStepChange: setCurrentStepIndex,
      onClose: skipTour,
      onComplete: completeTour,
      storageKey: tourKey,
      onTabChange,
    }),
    [isOpen, steps, currentStepIndex, skipTour, completeTour, tourKey, onTabChange]
  );

  return {
    isOpen,
    currentStepIndex,
    currentStep,
    totalSteps,
    isFirstStep,
    isLastStep,
    hasCompleted,
    startTour,
    nextStep,
    prevStep,
    goToStep,
    skipTour,
    completeTour,
    resetTour,
    tourProps,
  };
}

export default useTour;
