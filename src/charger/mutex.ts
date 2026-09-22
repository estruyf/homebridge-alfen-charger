/**
 * A minimal FIFO mutex. Every request to the charger goes through one of these
 * so we never have two calls in flight: the Alfen HTTP API is single-session and
 * the Home Assistant integration reports the charger crashing under load.
 */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  /** Run `fn` once all previously queued work has settled. */
  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    // Keep the chain alive regardless of how `fn` settled, but do not leave an
    // unhandled rejection behind on the internal chain.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/**
 * Resolve after `ms` milliseconds.
 *
 * The timer is deliberately *not* unref'd: this is awaited in the middle of a
 * write-then-verify sequence, and an unref'd timer lets a short-lived process
 * such as the probe CLI exit between the write and the read-back.
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Exponential backoff with full jitter, used to stop the plugin hammering a
 * charger that is already unhappy.
 */
export class Backoff {
  private failures = 0;
  private blockedUntil = 0;

  constructor(
    private readonly baseMs: number = 5_000,
    private readonly maxMs: number = 5 * 60_000,
  ) {}

  /** Record a success and clear any pending backoff. */
  reset(): void {
    this.failures = 0;
    this.blockedUntil = 0;
  }

  /** Record a failure and return how long the caller should wait, in ms. */
  fail(now: number = Date.now()): number {
    this.failures += 1;
    const ceiling = Math.min(this.maxMs, this.baseMs * 2 ** (this.failures - 1));
    // Full jitter: pick uniformly from [base, ceiling] so several plugins or
    // retries never line up on the same instant.
    const wait = Math.round(this.baseMs + Math.random() * Math.max(0, ceiling - this.baseMs));
    this.blockedUntil = now + wait;
    return wait;
  }

  /** True while we should skip work entirely. */
  isBlocked(now: number = Date.now()): boolean {
    return now < this.blockedUntil;
  }

  /** Milliseconds remaining before work may resume. */
  remainingMs(now: number = Date.now()): number {
    return Math.max(0, this.blockedUntil - now);
  }

  get failureCount(): number {
    return this.failures;
  }
}
