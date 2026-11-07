export interface GracefulServer {
  close(cb?: (err?: Error) => void): void;
  closeIdleConnections?: () => void;
}

export interface GracefulShutdownConfig {
  server?: GracefulServer | null | (() => GracefulServer | null);
  timeoutMs?: number;
  signals?: NodeJS.Signals[];
  onShutdown?: (signal: string) => Promise<void> | void;
  logger?: {
    info?: (...args: any[]) => void;
    error?: (...args: any[]) => void;
    warn?: (...args: any[]) => void;
  };
  exitFn?: (code: number) => void;
  autoRegister?: boolean;
}

export interface GracefulShutdownController {
  isShuttingDown(): boolean;
  triggerShutdown(signal?: string, customExitFn?: (code: number) => void): Promise<void>;
  register(): void;
  unregister(): void;
}

/**
 * Universal Production-Grade Graceful Shutdown Utility.
 * 
 * Coordinates:
 * - Immediate closing of keep-alive idle connections
 * - In-flight HTTP request draining with timeout
 * - Teardown hooks for databases, queues, and caches (Prisma, Redis, etc.)
 * - Prevention of duplicate signal execution
 * - Hard safety timeout to force exit if teardown hangs
 */
export function setupGracefulShutdown(config: GracefulShutdownConfig = {}): GracefulShutdownController {
  const timeoutMs = config.timeoutMs ?? 10000;
  const signals: NodeJS.Signals[] = config.signals ?? ['SIGTERM', 'SIGINT'];
  const logger = config.logger ?? console;
  const defaultExitFn = config.exitFn ?? ((code: number) => {
    if (typeof process !== 'undefined' && typeof process.exit === 'function') {
      process.exit(code);
    }
  });
  const autoRegister = config.autoRegister ?? true;

  let shuttingDown = false;
  let shutdownPromise: Promise<void> | null = null;
  const signalListeners = new Map<NodeJS.Signals, () => void>();

  function isShuttingDown(): boolean {
    return shuttingDown;
  }

  async function triggerShutdown(
    signal = 'SIGTERM',
    customExitFn?: (code: number) => void
  ): Promise<void> {
    if (shuttingDown) {
      return shutdownPromise ?? Promise.resolve();
    }
    shuttingDown = true;

    const exitFn = customExitFn ?? defaultExitFn;

    shutdownPromise = (async () => {
      logger.info?.(`[GracefulShutdown] Received ${signal}, starting graceful shutdown...`);

      let timedOut = false;
      const shutdownTimer = setTimeout(() => {
        timedOut = true;
        logger.error?.(`[GracefulShutdown] Graceful shutdown timeout reached (${timeoutMs}ms), forcing exit.`);
        exitFn(1);
      }, timeoutMs);

      // Unref timer so it does not keep Node process alive if all else is resolved
      shutdownTimer.unref?.();

      try {
        // 1. Drain HTTP server connections
        const resolvedServer = typeof config.server === 'function' ? config.server() : config.server;
        if (resolvedServer) {
          if (typeof resolvedServer.closeIdleConnections === 'function') {
            try {
              resolvedServer.closeIdleConnections();
              logger.info?.('[GracefulShutdown] Closed idle keep-alive connections.');
            } catch (idleErr) {
              logger.warn?.('[GracefulShutdown] Warning closing idle connections:', idleErr);
            }
          }

          await new Promise<void>((resolve) => {
            try {
              resolvedServer.close((err) => {
                if (err) {
                  logger.error?.('[GracefulShutdown] Error closing HTTP server:', err);
                } else {
                  logger.info?.('[GracefulShutdown] HTTP server closed and active connections drained.');
                }
                resolve();
              });
            } catch (err) {
              logger.error?.('[GracefulShutdown] Exception calling server.close():', err);
              resolve();
            }
          });
        }

        // 2. Execute custom teardown hook (Prisma, Redis, Message Queues, etc.)
        if (config.onShutdown) {
          try {
            await config.onShutdown(signal);
            logger.info?.('[GracefulShutdown] Custom teardown hook completed.');
          } catch (hookErr) {
            logger.error?.('[GracefulShutdown] Error executing custom onShutdown hook:', hookErr);
          }
        }

        clearTimeout(shutdownTimer);
        if (!timedOut) {
          logger.info?.('[GracefulShutdown] Graceful shutdown completed cleanly.');
          exitFn(0);
        }
      } catch (fatalError) {
        clearTimeout(shutdownTimer);
        if (!timedOut) {
          logger.error?.('[GracefulShutdown] Fatal error during graceful shutdown:', fatalError);
          exitFn(1);
        }
      }
    })();

    return shutdownPromise;
  }

  function register(): void {
    if (typeof process === 'undefined' || typeof process.on !== 'function') {
      return;
    }
    for (const sig of signals) {
      if (!signalListeners.has(sig)) {
        const listener = () => {
          void triggerShutdown(sig);
        };
        signalListeners.set(sig, listener);
        process.on(sig, listener);
      }
    }
  }

  function unregister(): void {
    if (typeof process === 'undefined' || typeof process.removeListener !== 'function') {
      return;
    }
    for (const [sig, listener] of signalListeners.entries()) {
      process.removeListener(sig, listener);
    }
    signalListeners.clear();
  }

  if (autoRegister) {
    register();
  }

  return {
    isShuttingDown,
    triggerShutdown,
    register,
    unregister,
  };
}
