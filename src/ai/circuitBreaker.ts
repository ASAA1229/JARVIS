/**
 * Per-provider circuit breaker. closed -> open after N consecutive counted failures;
 * open -> half-open after the cooldown (one probe allowed); a success closes it.
 */
export type BreakerState = 'closed' | 'open' | 'half-open';

export interface BreakerOptions {
  failureThreshold: number;
  openMs: number;
}

export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;
  private probing = false;

  constructor(private options: BreakerOptions, private readonly now: () => number = Date.now) {}

  configure(options: BreakerOptions): void {
    this.options = options;
  }

  state(): BreakerState {
    if (this.openedAt === null) return 'closed';
    return this.now() - this.openedAt >= this.options.openMs ? 'half-open' : 'open';
  }

  /** True when a call may be attempted. In half-open only one probe at a time is let through. */
  canAttempt(): boolean {
    const state = this.state();
    if (state === 'closed') return true;
    if (state === 'open') return false;
    if (this.probing) return false;
    this.probing = true;
    return true;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.openedAt = null;
    this.probing = false;
  }

  recordFailure(): void {
    this.probing = false;
    this.failures += 1;
    if (this.openedAt !== null || this.failures >= this.options.failureThreshold) this.openedAt = this.now();
  }

  /** A probe that ended without a verdict (e.g. skipped); lets the next caller probe. */
  releaseProbe(): void {
    this.probing = false;
  }

  snapshot(): { state: BreakerState; consecutiveFailures: number; retryInSeconds?: number } {
    const state = this.state();
    return {
      state,
      consecutiveFailures: this.failures,
      ...(state === 'open' && this.openedAt !== null ? { retryInSeconds: Math.max(1, Math.ceil((this.openedAt + this.options.openMs - this.now()) / 1000)) } : {}),
    };
  }
}
