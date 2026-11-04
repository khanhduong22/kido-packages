import { PreloadableResource } from './types';

function unwrapModuleDefault<T>(mod: { default: T } | T): T {
  if (
    mod !== null &&
    (typeof mod === 'object' || typeof mod === 'function') &&
    'default' in (mod as Record<string, unknown>) &&
    (mod as { default?: T }).default !== undefined
  ) {
    return (mod as { default: T }).default;
  }
  return mod as T;
}

/**
 * Creates a synchronous in-memory Preloadable Resource wrapper around a dynamic
 * import `loader`.
 *
 * - Deduplicates concurrent in-flight `preload()` calls.
 * - Stores the resolved module synchronously in closure memory (`getSync()`),
 *   allowing preloaded tabs/modals to render in `0ms` on click without flashing
 *   a `<Suspense>` or skeleton fallback.
 * - Automatically clears the in-flight promise on rejection so subsequent
 *   interactions can retry loading cleanly.
 * - Exposes `onPointerEnter`, `onTouchStart`, and `onFocus` handlers for zero-friction
 *   attachment to navigation items or trigger buttons.
 */
export function createPreloadableLoader<T>(
  loader: () => Promise<{ default: T } | T>
): PreloadableResource<T> {
  let resolvedValue: T | null = null;
  let hasResolved = false;
  let inFlightPromise: Promise<T> | null = null;

  const preload = (): Promise<T> => {
    if (hasResolved && resolvedValue !== null) {
      return Promise.resolve(resolvedValue);
    }
    if (!inFlightPromise) {
      inFlightPromise = Promise.resolve()
        .then(() => loader())
        .then((mod) => {
          const unwrapped = unwrapModuleDefault(mod);
          resolvedValue = unwrapped;
          hasResolved = true;
          return unwrapped;
        })
        .catch((err) => {
          inFlightPromise = null;
          throw err;
        });
    }
    return inFlightPromise;
  };

  const safeTrigger = (): void => {
    void preload().catch(() => {
      // Swallow background prefetch errors; explicit callers can await preload()
    });
  };

  const triggerHandlers = {
    onPointerEnter: safeTrigger,
    onTouchStart: safeTrigger,
    onFocus: safeTrigger,
  };

  return {
    preload,
    getSync: () => resolvedValue,
    isLoaded: () => hasResolved,
    reset: () => {
      resolvedValue = null;
      hasResolved = false;
      inFlightPromise = null;
    },
    onPointerEnter: safeTrigger,
    onTouchStart: safeTrigger,
    onFocus: safeTrigger,
    triggerHandlers,
  };
}
