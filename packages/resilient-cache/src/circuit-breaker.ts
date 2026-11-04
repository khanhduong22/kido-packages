import type {
  CircuitBreakerOptions,
  CircuitBreakerStats,
  CircuitState,
} from './types';

export class CircuitBreakerOpenError extends Error {
  constructor(message = 'Circuit breaker is OPEN. Fast fail active.') {
    super(message);
    this.name = 'CircuitBreakerOpenError';
  }
}

export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private failureThreshold: number;
  private resetTimeoutMs: number;
  private successThreshold: number;
  private onStateChange?: (from: CircuitState, to: CircuitState) => void;

  private consecutiveFailures = 0;
  private consecutiveSuccesses = 0;
  private lastFailureTime: number | null = null;
  private totalExecutions = 0;
  private totalFailures = 0;
  private totalTrips = 0;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = Math.max(1, options.failureThreshold ?? 3);
    this.resetTimeoutMs = Math.max(1, options.resetTimeoutMs ?? 10_000);
    this.successThreshold = Math.max(1, options.successThreshold ?? 2);
    this.onStateChange = options.onStateChange;
  }

  public getState(): CircuitState {
    this.checkAutoTransition();
    return this.state;
  }

  public getStats(): CircuitBreakerStats {
    this.checkAutoTransition();
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      consecutiveSuccesses: this.consecutiveSuccesses,
      lastFailureTime: this.lastFailureTime,
      totalExecutions: this.totalExecutions,
      totalFailures: this.totalFailures,
      totalTrips: this.totalTrips,
    };
  }

  /**
   * Check if OPEN state has expired and should transition to HALF_OPEN
   */
  private checkAutoTransition(): void {
    if (this.state === 'OPEN' && this.lastFailureTime !== null) {
      const elapsed = Date.now() - this.lastFailureTime;
      if (elapsed >= this.resetTimeoutMs) {
        this.transitionTo('HALF_OPEN');
      }
    }
  }

  private transitionTo(newState: CircuitState): void {
    if (this.state === newState) return;
    const oldState = this.state;
    this.state = newState;

    if (newState === 'OPEN') {
      this.totalTrips++;
      this.lastFailureTime = Date.now();
      this.consecutiveSuccesses = 0;
    } else if (newState === 'HALF_OPEN') {
      this.consecutiveSuccesses = 0;
    } else if (newState === 'CLOSED') {
      this.consecutiveFailures = 0;
      this.consecutiveSuccesses = 0;
      this.lastFailureTime = null;
    }

    if (this.onStateChange) {
      try {
        this.onStateChange(oldState, newState);
      } catch {
        // Suppress hook error to preserve execution flow
      }
    }
  }

  public trip(): void {
    this.transitionTo('OPEN');
  }

  public reset(): void {
    this.transitionTo('CLOSED');
  }

  public recordSuccess(): void {
    this.checkAutoTransition();
    if (this.state === 'HALF_OPEN') {
      this.consecutiveSuccesses++;
      if (this.consecutiveSuccesses >= this.successThreshold) {
        this.transitionTo('CLOSED');
      }
    } else if (this.state === 'CLOSED') {
      this.consecutiveFailures = 0;
    }
  }

  public recordFailure(): void {
    this.checkAutoTransition();
    this.totalFailures++;
    this.consecutiveFailures++;
    this.lastFailureTime = Date.now();

    if (this.state === 'CLOSED') {
      if (this.consecutiveFailures >= this.failureThreshold) {
        this.transitionTo('OPEN');
      }
    } else if (this.state === 'HALF_OPEN') {
      this.transitionTo('OPEN');
    }
  }

  /**
   * Execute an async action protected by circuit breaker rules.
   * If the circuit is OPEN, execute the fallback without touching the action.
   */
  public async execute<R>(
    action: () => Promise<R>,
    fallback?: () => Promise<R>
  ): Promise<R> {
    this.totalExecutions++;
    this.checkAutoTransition();

    if (this.state === 'OPEN') {
      if (fallback) {
        return fallback();
      }
      throw new CircuitBreakerOpenError();
    }

    try {
      const result = await action();
      this.recordSuccess();
      return result;
    } catch (err) {
      this.recordFailure();
      if (fallback) {
        return fallback();
      }
      throw err;
    }
  }
}
