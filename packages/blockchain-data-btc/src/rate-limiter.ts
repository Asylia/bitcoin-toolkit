/**
 * In-memory throttling gate for chain-data providers.
 *
 * The gate combines four orthogonal limits per provider:
 *
 *   1. **Sliding window** — at most `requests` calls inside any
 *      rolling `per` milliseconds. Protects against long-running
 *      flows exhausting the upstream's documented sustained budget.
 *   2. **Concurrency cap** — at most `maxConcurrent` in-flight calls
 *      at any given moment. Stops the SDK from fanning out N parallel
 *      requests to the same upstream just because a multi-address
 *      walker had N addresses to fetch.
 *   3. **Min interval** — at least `minIntervalMs` between two
 *      consecutive *releases*. The primary defence against tripping
 *      a public provider's burst limiter (which is what causes the
 *      immediate 429 storm when an unthrottled SDK fans out).
 *   4. **Explicit cooldown** — when an upstream returns
 *      `ProviderRateLimitError` the gate is shut for at least the
 *      `Retry-After` value (or the configured `coolDownMs` baseline
 *      when no header is present).
 *
 * Callers acquire a permit (with a `maxWaitMs` deadline so the
 * service walker can quickly bail to the next provider) and *must*
 * call `release` when the HTTP round-trip finishes — including on
 * error, so the slot does not leak. The {@link ProviderThrottle}
 * helper bundles both calls into a single object for cleaner provider
 * code.
 *
 * Caveat for stateless serverless runtimes: the gate is in-memory.
 * A cold Edge Function invocation starts with an empty state. For
 * client-side use this is irrelevant — the same instance lives for
 * the whole tab session.
 */
import {
  defaultProviderConfig,
  getProviderRateLimit,
  type ProviderConfig,
} from './config';
import { ProviderId } from './types';

/**
 * Internal per-provider gate state. Each provider has exactly one
 * record allocated lazily on first access; the map never shrinks.
 */
type ProviderState = {
  inFlight: number;
  lastReleaseAt: number;
  cooldownUntil: number;
  requestTimestamps: number[];
  waiters: Waiter[];
  /** Pending dispatch timer scheduled by `setTimeout`, for cancellation. */
  dispatchTimer: ReturnType<typeof setTimeout> | null;
};

/**
 * One queued caller waiting for a permit. The deadline timer is held
 * on the ticket so it can be cancelled the moment the caller is
 * dispatched, avoiding the "ghost timeout" problem where a permit
 * gets handed out and then the deadline fires anyway.
 */
type Waiter = {
  resolve: (ok: boolean) => void;
  deadline: ReturnType<typeof setTimeout>;
};

/**
 * Convenience wrapper handed to provider implementations. Lets a
 * provider call `await throttle.acquire()` / `throttle.release()`
 * without having to remember its own `ProviderId`.
 */
export class ProviderThrottle {
  constructor(
    private readonly limiter: RateLimiterService,
    private readonly providerId: ProviderId,
  ) {}

  /**
   * Wait for a permit, up to `maxWaitMs` milliseconds. Returns
   * `true` if the permit was acquired (caller MUST call
   * `release()`), `false` if the deadline elapsed without a permit
   * being available.
   */
  acquire(maxWaitMs?: number): Promise<boolean> {
    return this.limiter.acquire(this.providerId, maxWaitMs);
  }

  /** Release a previously acquired permit. Always paired with `acquire`. */
  release(): void {
    this.limiter.release(this.providerId);
  }

  /** Trip an explicit cooldown after a 429/403 from this provider. */
  tripCooldown(retryAfterMs?: number): void {
    this.limiter.tripCooldown(this.providerId, retryAfterMs);
  }
}

export class RateLimiterService {
  private readonly states: Map<ProviderId, ProviderState> = new Map();
  private readonly config: ProviderConfig;

  constructor(config: ProviderConfig = defaultProviderConfig) {
    this.config = config;
  }

  // ---------------------------------------------------------------------------
  // Public API — synchronous probes (used by the service's failover walk)
  // ---------------------------------------------------------------------------

  /**
   * Cheap read-only probe: would `acquire(providerId, 0)` succeed
   * right now? Used by the priority walker to skip providers that
   * are rate-limited without paying for the awaitable acquire.
   */
  canMakeRequest(providerId: ProviderId): boolean {
    return this.timeUntilAvailable(providerId) === 0;
  }

  /**
   * Number of milliseconds until the provider could plausibly serve a
   * request. `0` means "right now". Used internally by acquire and
   * exposed for dev tooling.
   */
  timeUntilAvailable(providerId: ProviderId): number {
    const state = this.getOrCreateState(providerId);
    const limit = getProviderRateLimit(providerId, this.config);
    const now = Date.now();

    // Cooldown: hard gate.
    if (state.cooldownUntil > now) {
      return state.cooldownUntil - now;
    }
    // In-flight cap: cannot estimate when a slot will free up
    // synchronously, so report a conservative ~50ms tick.
    if (state.inFlight >= limit.maxConcurrent) {
      return 50;
    }
    // Min interval since last release.
    const intervalRemaining = state.lastReleaseAt + limit.minIntervalMs - now;
    if (intervalRemaining > 0) return intervalRemaining;
    // Sliding window: count entries inside the window.
    const windowStart = now - limit.per;
    const valid = state.requestTimestamps.filter((ts) => ts > windowStart);
    if (valid.length >= limit.requests) {
      const oldest = valid[0]!;
      return Math.max(0, oldest + limit.per - now);
    }
    return 0;
  }

  /**
   * Current cooldown remaining (`0` when not cooled down). Useful
   * for dev surfaces.
   */
  getCooldownRemainingMs(providerId: ProviderId): number {
    const state = this.states.get(providerId);
    if (!state) return 0;
    return Math.max(0, state.cooldownUntil - Date.now());
  }

  /** Sliding-window request count inside the active period. */
  getCurrentRequestCount(providerId: ProviderId): number {
    const state = this.states.get(providerId);
    if (!state) return 0;
    const limit = getProviderRateLimit(providerId, this.config);
    const windowStart = Date.now() - limit.per;
    return state.requestTimestamps.filter((ts) => ts > windowStart).length;
  }

  /** In-flight request count for one provider. */
  getInFlight(providerId: ProviderId): number {
    return this.states.get(providerId)?.inFlight ?? 0;
  }

  // ---------------------------------------------------------------------------
  // Public API — awaitable gate (used by provider HTTP wrappers)
  // ---------------------------------------------------------------------------

  /**
   * Wait for a permit, up to `maxWaitMs` milliseconds (default
   * `Infinity`). Returns `true` if the permit was granted (caller
   * MUST follow with `release()` once the HTTP round-trip finishes,
   * even on error), `false` if the deadline elapsed.
   *
   * The gate is FIFO inside a single provider: the first waiter to
   * call `acquire` is the first to receive a permit when one becomes
   * available.
   */
  acquire(providerId: ProviderId, maxWaitMs: number = Infinity): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const state = this.getOrCreateState(providerId);

      // Fast path: a permit is available right now.
      if (this.tryClaimPermit(providerId, state)) {
        resolve(true);
        return;
      }

      // Slow path: queue + deadline.
      const ticket: Waiter = {
        resolve,
        deadline: setTimeout(() => {
          const idx = state.waiters.indexOf(ticket);
          if (idx !== -1) state.waiters.splice(idx, 1);
          resolve(false);
        }, maxWaitMs === Infinity ? 2 ** 31 - 1 : Math.max(0, maxWaitMs)),
      };
      state.waiters.push(ticket);
      this.scheduleDispatch(providerId, state);
    });
  }

  /**
   * Release a previously acquired permit. Records the release
   * timestamp (for `minIntervalMs`) and frees the in-flight slot, then
   * schedules a dispatch tick so any waiter can be served when its
   * gate clears.
   */
  release(providerId: ProviderId): void {
    const state = this.states.get(providerId);
    if (!state) return;
    state.inFlight = Math.max(0, state.inFlight - 1);
    state.lastReleaseAt = Date.now();
    this.scheduleDispatch(providerId, state);
  }

  /**
   * Trip an explicit cooldown after the upstream answered 429 / 403.
   * Always extends the existing cooldown (never shortens it) so a
   * provider that issued a long `Retry-After` is honoured even if a
   * follow-up call would have suggested less.
   */
  tripCooldown(providerId: ProviderId, retryAfterMs?: number): void {
    const state = this.getOrCreateState(providerId);
    const baseline = getProviderRateLimit(providerId, this.config).coolDownMs;
    const ms = Math.max(retryAfterMs ?? 0, baseline);
    const deadline = Date.now() + ms;
    state.cooldownUntil = Math.max(state.cooldownUntil, deadline);
  }

  /**
   * Drop tracked state for one provider (or every provider if called
   * with no argument). Mostly useful in tests; calling this in
   * production immediately re-permits requests and may hammer the
   * upstream API.
   */
  reset(providerId?: ProviderId): void {
    const drop = (state: ProviderState): void => {
      for (const w of state.waiters) {
        clearTimeout(w.deadline);
        w.resolve(false);
      }
      state.waiters = [];
      if (state.dispatchTimer !== null) {
        clearTimeout(state.dispatchTimer);
        state.dispatchTimer = null;
      }
      state.inFlight = 0;
      state.lastReleaseAt = 0;
      state.cooldownUntil = 0;
      state.requestTimestamps = [];
    };
    if (providerId) {
      const state = this.states.get(providerId);
      if (state) drop(state);
      this.states.delete(providerId);
    } else {
      for (const state of this.states.values()) drop(state);
      this.states.clear();
    }
  }

  /** Get a {@link ProviderThrottle} bound to one provider id. */
  getThrottle(providerId: ProviderId): ProviderThrottle {
    return new ProviderThrottle(this, providerId);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private getOrCreateState(providerId: ProviderId): ProviderState {
    let state = this.states.get(providerId);
    if (state === undefined) {
      state = {
        inFlight: 0,
        lastReleaseAt: 0,
        cooldownUntil: 0,
        requestTimestamps: [],
        waiters: [],
        dispatchTimer: null,
      };
      this.states.set(providerId, state);
    }
    return state;
  }

  /**
   * Atomically claim a permit if all four limits allow. Updates the
   * in-flight count and records a sliding-window timestamp on
   * success. Returns `true` if the permit was claimed, `false` if any
   * limit blocked it.
   */
  private tryClaimPermit(providerId: ProviderId, state: ProviderState): boolean {
    const remaining = this.timeUntilAvailable(providerId);
    if (remaining > 0) return false;
    state.inFlight += 1;
    state.requestTimestamps.push(Date.now());
    // Trim stale timestamps so the array does not grow unbounded for
    // long-lived limiters.
    const limit = getProviderRateLimit(providerId, this.config);
    const windowStart = Date.now() - limit.per;
    state.requestTimestamps = state.requestTimestamps.filter((ts) => ts > windowStart);
    return true;
  }

  /**
   * Schedule a dispatch tick. The dispatch loop walks the waiter
   * queue and serves whoever is at the head as soon as the gate
   * allows. Coalesces multiple back-to-back schedules into a single
   * timer to avoid thrashing.
   */
  private scheduleDispatch(providerId: ProviderId, state: ProviderState): void {
    if (state.waiters.length === 0) return;
    if (state.dispatchTimer !== null) return;

    const tick = (): void => {
      state.dispatchTimer = null;
      // Serve as many waiters as the gate currently allows. Each
      // claimed permit increments `inFlight`, so the loop naturally
      // exits when the concurrency cap is reached.
      while (state.waiters.length > 0) {
        if (!this.tryClaimPermit(providerId, state)) break;
        const ticket = state.waiters.shift()!;
        clearTimeout(ticket.deadline);
        ticket.resolve(true);
      }
      // If there are still waiters, schedule another tick at the
      // earliest moment one of them could be served.
      if (state.waiters.length > 0) {
        const wait = Math.max(10, this.timeUntilAvailable(providerId));
        state.dispatchTimer = setTimeout(tick, wait);
      }
    };

    // Run on the next microtask so a release+immediate acquire pair
    // does not re-enter the loop synchronously.
    state.dispatchTimer = setTimeout(tick, 0);
  }
}
