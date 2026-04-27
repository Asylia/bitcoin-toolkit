/**
 * Two-tier request cache: in-flight coalescer + settled TTL store.
 *
 * Two pieces of state, both keyed by a stable string the caller
 * supplies:
 *
 *   1. **In-flight cache.** Holds the unresolved Promise for the
 *      duration of the round-trip. If two callers ask for the same
 *      key while the first one is still in flight, the second
 *      adopts the first's Promise — exactly one HTTP call goes out
 *      regardless of how many components mounted at the same moment.
 *
 *   2. **Settled cache.** When the in-flight Promise resolves, the
 *      result is moved into a TTL-bounded settled store. Subsequent
 *      callers within the TTL window receive the cached value
 *      directly (no Promise factory invocation). After the TTL
 *      expires the entry is dropped on the next access; the next
 *      caller after that pays for a fresh fetch.
 *
 * The TTL store is *opt-in* — the caller passes `ttlMs` per call.
 * Pass `0` (or omit it) to skip the settled cache entirely; useful
 * for write paths like `broadcastTransaction` where memoising a
 * success would cause "already in mempool" replays.
 *
 * Failed Promises are never cached: a thrown error evicts the key
 * from both caches so the next caller triggers a fresh attempt.
 */
type SettledEntry<T> = {
  value: T;
  expiresAt: number;
};

export type RequestCacheOptions = {
  /**
   * Ignore the settled TTL value for this call while still joining an
   * already-running in-flight request for the same key. This is the
   * right shape for manual refresh buttons: the operator gets fresh
   * data when no fetch is running, but a click cannot duplicate a
   * request that is already on the wire.
   */
  bypassSettled?: boolean;
};

export class RequestCache {
  private readonly inflight: Map<string, Promise<unknown>> = new Map();
  private readonly settled: Map<string, SettledEntry<unknown>> = new Map();

  /**
   * Return the cached or in-flight result for `key` if available,
   * otherwise call `factory()` and cache its result for `ttlMs`
   * milliseconds (when `ttlMs > 0`).
   *
   * Settled lookups beat in-flight lookups: once a value is in the
   * TTL store, callers do not even create a new Promise.
   */
  getOrCreate<T>(
    key: string,
    factory: () => Promise<T>,
    ttlMs: number = 0,
    options: RequestCacheOptions = {},
  ): Promise<T> {
    if (options.bypassSettled) {
      this.settled.delete(key);
    }

    if (ttlMs > 0 && !options.bypassSettled) {
      const cached = this.settled.get(key);
      if (cached !== undefined) {
        if (cached.expiresAt > Date.now()) {
          return Promise.resolve(cached.value as T);
        }
        // Expired — fall through to refresh.
        this.settled.delete(key);
      }
    }

    const existing = this.inflight.get(key);
    if (existing !== undefined) return existing as Promise<T>;

    const promise = factory()
      .then((result) => {
        this.inflight.delete(key);
        if (ttlMs > 0) {
          this.settled.set(key, { value: result, expiresAt: Date.now() + ttlMs });
        }
        return result;
      })
      .catch((error) => {
        this.inflight.delete(key);
        // Failures are never memoised — drop any stale settled entry
        // so the next caller starts from a clean slate.
        this.settled.delete(key);
        throw error;
      });

    this.inflight.set(key, promise);
    return promise;
  }

  /** Forget a single key in both stores. Pending Promises still resolve normally. */
  clear(key: string): void {
    this.inflight.delete(key);
    this.settled.delete(key);
  }

  /** Forget every key in both stores. Pending Promises still resolve normally. */
  clearAll(): void {
    this.inflight.clear();
    this.settled.clear();
  }

  /** Number of in-flight Promises currently coalesced. */
  inflightSize(): number {
    return this.inflight.size;
  }

  /** Number of settled entries currently held in the TTL store. */
  settledSize(): number {
    return this.settled.size;
  }

  /** Probe both stores; returns true if a hit (in-flight or live TTL) exists. */
  has(key: string): boolean {
    if (this.inflight.has(key)) return true;
    const cached = this.settled.get(key);
    if (cached === undefined) return false;
    if (cached.expiresAt <= Date.now()) {
      this.settled.delete(key);
      return false;
    }
    return true;
  }

  /**
   * Best-effort housekeeping: drop settled entries whose TTL has
   * elapsed. Cheap to call on a periodic timer in long-lived
   * processes; the lazy lookup eviction in `getOrCreate` covers the
   * common case for short-lived sessions.
   */
  pruneExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.settled) {
      if (entry.expiresAt <= now) this.settled.delete(key);
    }
  }
}
