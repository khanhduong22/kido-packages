import { describe, it, expect, mock, spyOn, beforeEach } from 'bun:test';
import { setupGracefulShutdown, type GracefulServer } from '../src/index';

const vi = {
  fn: mock,
  spyOn,
  clearAllMocks: () => {},
};

describe('setupGracefulShutdown Unit Test Suite', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should cleanly shut down server and drain active connections', async () => {
    const mockClose = vi.fn((cb?: (err?: Error) => void) => {
      if (cb) cb();
    });
    const mockCloseIdle = vi.fn();
    const mockServer: GracefulServer = {
      close: mockClose,
      closeIdleConnections: mockCloseIdle,
    };

    const exitFn = vi.fn();
    const loggerInfo = vi.fn();

    const controller = setupGracefulShutdown({
      server: mockServer,
      autoRegister: false,
      exitFn,
      logger: { info: loggerInfo },
    });

    expect(controller.isShuttingDown()).toBe(false);

    await controller.triggerShutdown('SIGTERM');

    expect(controller.isShuttingDown()).toBe(true);
    expect(mockCloseIdle).toHaveBeenCalledTimes(1);
    expect(mockClose).toHaveBeenCalledTimes(1);
    expect(exitFn).toHaveBeenCalledWith(0);
    expect(loggerInfo).toHaveBeenCalledWith(expect.stringContaining('Graceful shutdown completed cleanly'));
  });

  it('should shut down cleanly when server does not provide closeIdleConnections', async () => {
    const mockClose = vi.fn((cb?: (err?: Error) => void) => {
      if (cb) cb();
    });
    const mockServer: GracefulServer = {
      close: mockClose,
    };

    const exitFn = vi.fn();
    const controller = setupGracefulShutdown({
      server: mockServer,
      autoRegister: false,
      exitFn,
    });

    await controller.triggerShutdown('SIGTERM');

    expect(mockClose).toHaveBeenCalledTimes(1);
    expect(exitFn).toHaveBeenCalledWith(0);
  });

  it('should invoke custom onShutdown hook with signal and handle async teardown', async () => {
    let hookExecuted = false;
    let receivedSignal = '';

    const onShutdown = vi.fn(async (signal: string) => {
      await new Promise((r) => setTimeout(r, 10));
      hookExecuted = true;
      receivedSignal = signal;
    });

    const exitFn = vi.fn();
    const controller = setupGracefulShutdown({
      autoRegister: false,
      exitFn,
      onShutdown,
    });

    await controller.triggerShutdown('SIGINT');

    expect(onShutdown).toHaveBeenCalledTimes(1);
    expect(receivedSignal).toBe('SIGINT');
    expect(hookExecuted).toBe(true);
    expect(exitFn).toHaveBeenCalledWith(0);
  });

  it('should safely catch errors in onShutdown hook and proceed with exit', async () => {
    const errorLogger = vi.fn();
    const onShutdown = vi.fn(async () => {
      throw new Error('Database connection failed to close');
    });

    const exitFn = vi.fn();
    const controller = setupGracefulShutdown({
      autoRegister: false,
      exitFn,
      onShutdown,
      logger: { error: errorLogger },
    });

    await controller.triggerShutdown('SIGTERM');

    expect(onShutdown).toHaveBeenCalledTimes(1);
    expect(errorLogger).toHaveBeenCalledWith(
      expect.stringContaining('Error executing custom onShutdown hook:'),
      expect.any(Error)
    );
    expect(exitFn).toHaveBeenCalledWith(0);
  });

  it('should force exit with code 1 if teardown exceeds timeoutMs', async () => {
    // Hanging server that never invokes close callback
    const hangingServer: GracefulServer = {
      close: vi.fn(),
    };

    const exitFn = vi.fn();
    const errorLogger = vi.fn();

    const controller = setupGracefulShutdown({
      server: hangingServer,
      timeoutMs: 50,
      autoRegister: false,
      exitFn,
      logger: { error: errorLogger },
    });

    // Start shutdown (which will hang on server.close)
    const shutdownPromise = controller.triggerShutdown('SIGTERM');

    // Wait for the 50ms safety timer to trigger
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(exitFn).toHaveBeenCalledWith(1);
    expect(errorLogger).toHaveBeenCalledWith(
      expect.stringContaining('Graceful shutdown timeout reached (50ms), forcing exit.')
    );

    // If server eventually resolves after timeout, exit(0) must NOT be called
    (hangingServer.close as any).mock.calls[0]?.[0]?.();
    await shutdownPromise;
    expect(exitFn).not.toHaveBeenCalledWith(0);
  });

  it('should prevent double execution if multiple signals are received concurrently', async () => {
    let closeCallCount = 0;
    const slowServer: GracefulServer = {
      close: vi.fn((cb) => {
        closeCallCount++;
        setTimeout(() => cb?.(), 30);
      }),
    };

    const onShutdown = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    const exitFn = vi.fn();
    const controller = setupGracefulShutdown({
      server: slowServer,
      autoRegister: false,
      exitFn,
      onShutdown,
    });

    // Trigger multiple signals concurrently
    const [res1, res2, res3] = await Promise.all([
      controller.triggerShutdown('SIGTERM'),
      controller.triggerShutdown('SIGINT'),
      controller.triggerShutdown('SIGTERM'),
    ]);

    expect(closeCallCount).toBe(1);
    expect(onShutdown).toHaveBeenCalledTimes(1);
    expect(exitFn).toHaveBeenCalledTimes(1);
    expect(exitFn).toHaveBeenCalledWith(0);
  });

  it('should dynamically resolve server via getter function', async () => {
    let dynamicServer: GracefulServer | null = null;
    const mockClose = vi.fn((cb) => cb?.());

    const exitFn = vi.fn();
    const controller = setupGracefulShutdown({
      server: () => dynamicServer,
      autoRegister: false,
      exitFn,
    });

    // Server is assigned dynamically after controller creation
    dynamicServer = {
      close: mockClose,
    };

    await controller.triggerShutdown('SIGTERM');

    expect(mockClose).toHaveBeenCalledTimes(1);
    expect(exitFn).toHaveBeenCalledWith(0);
  });

  it('should register and unregister process signal listeners cleanly', () => {
    const processOnSpy = vi.spyOn(process, 'on');
    const processRemoveSpy = vi.spyOn(process, 'removeListener');

    const controller = setupGracefulShutdown({
      signals: ['SIGTERM', 'SIGINT'],
      autoRegister: false,
    });

    controller.register();
    expect(processOnSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
    expect(processOnSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));

    controller.unregister();
    expect(processRemoveSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
    expect(processRemoveSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));

    processOnSpy.mockRestore();
    processRemoveSpy.mockRestore();
  });
});
