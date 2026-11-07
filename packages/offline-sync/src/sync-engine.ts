import {
  INetworkDetector,
  ISyncRemoteAdapter,
  IOutboxStorage,
  OutboxMutation,
  SyncEngineOptions,
  SyncPushResult,
} from './types';

// ==========================================
// DEFAULT NETWORK DETECTOR
// ==========================================

export class DefaultNetworkDetector implements INetworkDetector {
  private online = true;
  private listeners = new Set<(online: boolean) => void>();
  private pingUrl?: string;
  private pingTimeoutMs: number;

  constructor(options?: { pingUrl?: string; pingTimeoutMs?: number; initialOnline?: boolean }) {
    this.pingUrl = options?.pingUrl;
    this.pingTimeoutMs = options?.pingTimeoutMs ?? 3000;

    if (options?.initialOnline !== undefined) {
      this.online = options.initialOnline;
    } else if (typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean') {
      this.online = navigator.onLine;
    } else {
      this.online = true;
    }

    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('online', () => this.handleStatusChange(true));
      window.addEventListener('offline', () => this.handleStatusChange(false));
    }
  }

  private handleStatusChange(isOnline: boolean): void {
    if (this.online !== isOnline) {
      this.online = isOnline;
      this.notifyListeners();
    }
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.online);
      } catch {
        // Suppress listener error
      }
    }
  }

  async isOnline(): Promise<boolean> {
    // Only check navigator.onLine if it is an explicit boolean (Browser)
    if (typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean') {
      if (!navigator.onLine) {
        this.online = false;
        return false;
      }
    }

    if (!this.pingUrl) {
      return this.online;
    }

    try {
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timeoutId = controller
        ? setTimeout(() => controller.abort(), this.pingTimeoutMs)
        : null;

      const res = await fetch(this.pingUrl, {
        method: 'HEAD',
        cache: 'no-store',
        signal: controller ? controller.signal : undefined,
      });

      if (timeoutId) clearTimeout(timeoutId);
      const isUp = res.ok;
      this.handleStatusChange(isUp);
      return isUp;
    } catch {
      this.handleStatusChange(false);
      return false;
    }
  }

  subscribe(callback: (online: boolean) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  /**
   * For testing or manual override.
   */
  setOnline(status: boolean): void {
    this.handleStatusChange(status);
  }
}

// ==========================================
// SYNC ENGINE WORKER
// ==========================================

export class SyncEngine {
  private storage: IOutboxStorage;
  private remote: ISyncRemoteAdapter;
  private networkDetector: INetworkDetector;
  private batchSize: number;
  private syncIntervalMs: number;
  private initialBackoffMs: number;
  private maxBackoffMs: number;
  private backoffMultiplier: number;
  private maxRetries: number;

  private isRunning = false;
  private isSyncing = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribeNetwork?: () => void;

  private onSyncStart?: () => void;
  private onSyncComplete?: (results: SyncPushResult[]) => void;
  private onError?: (error: Error) => void;
  private onConflict?: (conflict: { mutation: OutboxMutation; serverVersion?: number }) => void;

  constructor(options: SyncEngineOptions) {
    this.storage = options.storage;
    this.remote = options.remote;
    this.networkDetector = options.networkDetector ?? new DefaultNetworkDetector();
    this.batchSize = options.batchSize ?? 20;
    this.syncIntervalMs = options.syncIntervalMs ?? 5000;
    this.initialBackoffMs = options.initialBackoffMs ?? 1000;
    this.maxBackoffMs = options.maxBackoffMs ?? 30000;
    this.backoffMultiplier = options.backoffMultiplier ?? 2;
    this.maxRetries = options.maxRetries ?? 5;

    this.onSyncStart = options.onSyncStart;
    this.onSyncComplete = options.onSyncComplete;
    this.onError = options.onError;
    this.onConflict = options.onConflict;

    if (options.autoStart) {
      this.start();
    }
  }

  /**
   * Starts the automatic sync loop and network change listener.
   */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    this.timer = setInterval(() => {
      this.syncNow().catch((err) => {
        this.onError?.(err instanceof Error ? err : new Error(String(err)));
      });
    }, this.syncIntervalMs);

    this.unsubscribeNetwork = this.networkDetector.subscribe((online) => {
      if (online) {
        // Trigger immediate sync on reconnect
        this.syncNow().catch((err) => {
          this.onError?.(err instanceof Error ? err : new Error(String(err)));
        });
      }
    });
  }

  /**
   * Stops the background sync loop.
   */
  stop(): void {
    this.isRunning = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.unsubscribeNetwork) {
      this.unsubscribeNetwork();
      this.unsubscribeNetwork = undefined;
    }
  }

  /**
   * Calculates exponential backoff delay based on retry attempt count.
   */
  calculateBackoff(retryCount: number): number {
    const rawDelay = this.initialBackoffMs * Math.pow(this.backoffMultiplier, retryCount);
    const cappedDelay = Math.min(rawDelay, this.maxBackoffMs);
    // Add 10% jitter to prevent thundering herd
    const jitter = cappedDelay * 0.1 * Math.random();
    return Math.floor(cappedDelay + jitter);
  }

  /**
   * Executes a single batch sync push.
   */
  async syncNow(): Promise<SyncPushResult[]> {
    if (this.isSyncing) return [];

    const online = await this.networkDetector.isOnline();
    if (!online) {
      return [];
    }

    this.isSyncing = true;
    this.onSyncStart?.();

    try {
      const pending = await this.storage.getPending(this.batchSize);
      if (pending.length === 0) {
        this.isSyncing = false;
        return [];
      }

      // Mark batch as SYNCING to prevent duplicate delivery
      const batchIds = pending.map((m) => m.id);
      const now = Date.now();
      for (const id of batchIds) {
        await this.storage.update(id, {
          status: 'SYNCING',
          lastAttemptAt: now,
        });
      }

      let results: SyncPushResult[] = [];
      try {
        results = await this.remote.push(pending);
      } catch (pushErr) {
        // Push level network or server error: fail the whole batch with retry
        const errMessage = pushErr instanceof Error ? pushErr.message : String(pushErr);
        for (const mutation of pending) {
          const newRetry = mutation.retryCount + 1;
          const terminal = newRetry >= this.maxRetries;
          await this.storage.update(mutation.id, {
            status: terminal ? 'FAILED' : 'PENDING',
            retryCount: newRetry,
            error: errMessage,
          });
        }
        throw pushErr;
      }

      // Process individual mutation results
      const resultMap = new Map<string, SyncPushResult>();
      for (const res of results) {
        resultMap.set(res.mutationId, res);
      }

      for (const mutation of pending) {
        const res = resultMap.get(mutation.id);
        if (!res) {
          // If remote adapter didn't return a status for this item, keep pending
          await this.storage.update(mutation.id, { status: 'PENDING' });
          continue;
        }

        if (res.conflict) {
          this.onConflict?.({ mutation, serverVersion: res.serverVersion });
        }

        if (res.success) {
          await this.storage.update(mutation.id, {
            status: 'SYNCED',
            version: res.serverVersion,
            error: undefined,
          });
        } else {
          const newRetry = mutation.retryCount + 1;
          const terminal = newRetry >= this.maxRetries;
          await this.storage.update(mutation.id, {
            status: terminal ? 'FAILED' : 'PENDING',
            retryCount: newRetry,
            error: res.error ?? 'Remote sync failed',
          });
        }
      }

      this.onSyncComplete?.(results);
      return results;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.onError?.(error);
      return [];
    } finally {
      this.isSyncing = false;
    }
  }

  getStatus(): { isRunning: boolean; isSyncing: boolean } {
    return {
      isRunning: this.isRunning,
      isSyncing: this.isSyncing,
    };
  }
}
