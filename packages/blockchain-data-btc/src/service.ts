/**
 * `BlockchainDataService` — the package's single public façade.
 *
 * Walks the configured priority list on every request: for each
 * provider in order, checks the rate-limit budget + cooldown, then
 * calls the provider and returns the first success. A provider that
 * throws or is rate-limited is silently skipped; if every provider
 * fails the service throws `NO_PROVIDER_AVAILABLE` so callers can
 * surface a graceful "all upstreams down" error.
 *
 * Concurrent requests for the same address (or the same set of
 * addresses, regardless of order) share a single Promise via the
 * `RequestCache`, so a Vue dashboard mounting six components that
 * each ask for the same vault spends exactly one upstream call.
 *
 * Designed to run identically in browsers, Deno (Supabase Edge
 * Functions), and Node — the only runtime requirements are the
 * `fetch` global and `Promise`.
 */
import type { Provider } from './providers/base';
import { RateLimiterService } from './rate-limiter';
import { RequestCache } from './request-cache';
import {
  defaultProviderConfig,
  type ProviderConfig,
  type ProviderRateLimit,
} from './config';
import {
  ProviderId,
  ProviderConfigurationError,
  ProviderRateLimitError,
  type AddressTransactions,
  type AddressUtxos,
  type BroadcastTransactionResponse,
  type FiatRatesSnapshot,
  type MultiAddressResponse,
  type MultiAddressTransactionsResponse,
  type MultiAddressUtxosResponse,
  type ProviderRole,
  type RawTransactionResponse,
  type SingleAddressResponse,
} from './types';
import { debugError, debugLog } from './log';

export type BlockchainDataMetricEvent =
  | {
      event: 'request_started';
      providerId: ProviderId;
      role: ProviderRole;
      operation: string;
      timestamp: number;
    }
  | {
      event: 'request_succeeded';
      providerId: ProviderId;
      role: ProviderRole;
      operation: string;
      durationMs: number;
    }
  | {
      event: 'rate_limit_hit';
      providerId: ProviderId;
      role: ProviderRole;
      operation: string;
      durationMs: number;
      retryAfterMs: number;
    }
  | {
      event: 'provider_configuration_error';
      providerId: ProviderId;
      role: ProviderRole;
      operation: string;
      durationMs: number;
      status?: number;
      errorName: string;
    }
  | {
      event: 'provider_failed';
      providerId: ProviderId;
      role: ProviderRole;
      operation: string;
      durationMs: number;
      errorName: string;
    }
  | {
      event: 'provider_skipped';
      providerId: ProviderId;
      role: ProviderRole;
      operation: string;
      reason: 'unsupported' | 'rate_limited';
      waitMs?: number;
    }
  | {
      event: 'walk_exhausted';
      role: ProviderRole;
      operation: string;
      errorName?: string;
    };

/** Service configuration. */
export interface BlockchainDataServiceConfig {
  /**
   * Concrete provider instances to register, keyed by `ProviderId`.
   * A missing entry means the provider does **not** participate in
   * the priority walk at all — the package never auto-instantiates
   * anything, so the consumer controls which credentials and which
   * runtime knobs each provider gets.
   */
  providers: Partial<Record<ProviderId, Provider>>;
  /** Override the default failover order. */
  priority?: ProviderId[];
  /** Override the default per-provider rate-limit budgets. */
  rateLimits?: Record<ProviderId, ProviderRateLimit>;
  /** Surface provider trace + extra logs. Off in production. */
  devMode?: boolean;
  /** Coalesce concurrent identical requests. Default `true`. */
  enableDeduplication?: boolean;
  /** Optional production-safe telemetry hook for provider walks. */
  metrics?: (event: BlockchainDataMetricEvent) => void;
}

/**
 * Diagnostic record built up during a single failover walk. Used to
 * surface the trail of attempted providers in `dev_info`, and as the
 * source for the final error message when every provider failed.
 */
type WalkAttempt = {
  providerId: ProviderId;
  outcome: 'rate-limited' | 'unsupported' | 'error' | 'success';
  error?: Error;
};

export class BlockchainDataService {
  private readonly providers: Map<ProviderId, Provider>;
  private readonly rateLimiter: RateLimiterService;
  private readonly requestCache: RequestCache | null;
  private readonly priority: ProviderId[];
  private readonly devMode: boolean;
  private readonly metrics: ((event: BlockchainDataMetricEvent) => void) | null;

  constructor(config: BlockchainDataServiceConfig) {
    const {
      providers,
      priority,
      rateLimits,
      devMode = false,
      enableDeduplication = true,
      metrics,
    } = config;

    const providerConfig: ProviderConfig = {
      priority: priority ?? defaultProviderConfig.priority,
      rateLimits: rateLimits ?? defaultProviderConfig.rateLimits,
    };

    this.priority = providerConfig.priority;
    this.devMode = devMode;
    this.metrics = metrics ?? null;
    this.requestCache = enableDeduplication ? new RequestCache() : null;
    this.rateLimiter = new RateLimiterService(providerConfig);

    this.providers = new Map<ProviderId, Provider>();
    for (const [id, provider] of Object.entries(providers)) {
      if (provider) this.attachProvider(id as ProviderId, provider);
    }
  }

  /**
   * Register a provider and inject its throttle so every HTTP round
   * trip the provider makes is gated by the service's rate limiter.
   * Idempotent — re-attaching a provider just re-binds the throttle
   * (used by `setProvider` for test stubs).
   */
  private attachProvider(providerId: ProviderId, provider: Provider): void {
    if (provider.bindThrottle) {
      provider.bindThrottle(this.rateLimiter.getThrottle(providerId));
    }
    this.providers.set(providerId, provider);
  }

  // ---------------------------------------------------------------------------
  // Cache keys
  // ---------------------------------------------------------------------------

  private singleKey(address: string): string {
    return `single:${address}`;
  }
  private multiKey(addresses: readonly string[]): string {
    return `multi:${[...addresses].sort().join(',')}`;
  }
  private utxosKey(addresses: readonly string[]): string {
    return `utxos:${[...addresses].sort().join(',')}`;
  }
  private txsKey(addresses: readonly string[]): string {
    return `txs:${[...addresses].sort().join(',')}`;
  }
  private rawTxKey(txid: string): string {
    return `raw-tx:${txid.toLowerCase()}`;
  }
  private fiatRatesKey(currencies: readonly string[]): string {
    // Currency codes are case-insensitive at the API boundary; sort
    // and uppercase so callers passing `["usd","EUR"]` and `["EUR","USD"]`
    // collapse onto the same cache key.
    return `fiat:${[...currencies].map((c) => c.toUpperCase()).sort().join(',')}`;
  }

  private canonicalAddresses(addresses: readonly string[]): string[] {
    return [...addresses].sort();
  }

  // ---------------------------------------------------------------------------
  // Generic walker
  // ---------------------------------------------------------------------------

  /**
   * Maximum delay (ms) the walker tolerates a provider being
   * "warming up" before hopping to the next one. Anything below this
   * is short enough that waiting is cheaper than the round-trip cost
   * of switching providers; anything above means the upstream is
   * effectively unavailable for this call and the next provider is
   * a better bet.
   */
  private static readonly WALK_TOLERATED_WAIT_MS = 1_500;

  /**
   * TTL applied to settled results in the request cache. Picked per
   * method so a frequently-changing balance can age out quickly while
   * a relatively static tip height is reused for longer.
   *
   * The cache is the single biggest defence against the "two
   * composables fetch the same thing in parallel and one finishes
   * just before the other starts" scenario: the second caller hits
   * the settled store and pays nothing.
   */
  private static readonly TTL = {
    BALANCE_MS: 30_000,
    UTXOS_MS: 30_000,
    TXS_MS: 60_000,
    TIP_MS: 60_000,
    RAW_TX_MS: 24 * 60 * 60 * 1000,
    /**
     * Fiat rates change second-to-second on volatile days but the
     * cron-driven server cache only refreshes once a minute, so
     * burning round-trips on top of that is wasteful. A 30s in-tab
     * dedupe window is short enough that two consumers asking for
     * the same currency set within a render cycle still see the
     * same cached snapshot.
     */
    FIAT_RATES_MS: 30_000,
  } as const;

  private emitMetric(event: BlockchainDataMetricEvent): void {
    if (!this.metrics) return;
    try {
      this.metrics(event);
    } catch (cause) {
      debugError(this.devMode, '[BlockchainDataService] metrics callback failed:', cause);
    }
  }

  /**
   * Drive the priority walk for one role. Visits each provider that
   * declares the role in declared priority order. For each provider:
   *
   *   - If its throttle gate is open right now → use it immediately.
   *   - If it would be open within `WALK_TOLERATED_WAIT_MS` → use
   *     it; the provider's own HTTP wrapper awaits the permit.
   *   - Otherwise → skip to the next provider (rate-limited).
   *
   * On `ProviderRateLimitError` from the call itself the gate has
   * already tripped a cooldown (the provider's HTTP wrapper does
   * that on a 429 response or a throttle deadline), so the walker
   * just moves on. Other errors record the attempt and try the next
   * provider too.
   *
   * Rejects with `Error('NO_PROVIDER_AVAILABLE')` when the list is
   * exhausted, optionally suffixing the most recent provider error
   * for diagnostics.
   */
  private async walk<T>(
    role: ProviderRole,
    operation: string,
    callProvider: (provider: Provider) => Promise<T>,
  ): Promise<{ value: T; providerId: ProviderId; trail: WalkAttempt[] }> {
    const trail: WalkAttempt[] = [];
    let lastError: Error | null = null;

    for (const providerId of this.priority) {
      const provider = this.providers.get(providerId);
      if (!provider) continue;
      if (!supportsRole(provider, role)) {
        trail.push({ providerId, outcome: 'unsupported' });
        this.emitMetric({
          event: 'provider_skipped',
          providerId,
          role,
          operation,
          reason: 'unsupported',
        });
        continue;
      }
      const waitMs = this.rateLimiter.timeUntilAvailable(providerId);
      if (waitMs > BlockchainDataService.WALK_TOLERATED_WAIT_MS) {
        debugLog(
          this.devMode,
          `[BlockchainDataService] ${providerId} would wait ${waitMs}ms, skipping`,
        );
        trail.push({ providerId, outcome: 'rate-limited' });
        this.emitMetric({
          event: 'provider_skipped',
          providerId,
          role,
          operation,
          reason: 'rate_limited',
          waitMs,
        });
        continue;
      }

      const startedAt = Date.now();
      try {
        // The provider's HTTP wrapper does the actual `acquire` /
        // `release` on the gate; the walker only needs to verify the
        // wait is short enough to be worth trying.
        this.emitMetric({
          event: 'request_started',
          providerId,
          role,
          operation,
          timestamp: startedAt,
        });
        const value = await callProvider(provider);
        trail.push({ providerId, outcome: 'success' });
        this.emitMetric({
          event: 'request_succeeded',
          providerId,
          role,
          operation,
          durationMs: Date.now() - startedAt,
        });
        return { value, providerId, trail };
      } catch (cause) {
        const durationMs = Date.now() - startedAt;
        const err = cause instanceof Error ? cause : new Error(String(cause));
        lastError = err;
        if (cause instanceof ProviderRateLimitError) {
          // The provider already tripped its cooldown when it threw;
          // we just record the trail entry and move on.
          trail.push({ providerId, outcome: 'rate-limited', error: err });
          this.emitMetric({
            event: 'rate_limit_hit',
            providerId,
            role,
            operation,
            durationMs,
            retryAfterMs: cause.retryAfterMs,
          });
        } else if (cause instanceof ProviderConfigurationError) {
          trail.push({ providerId, outcome: 'error', error: err });
          this.emitMetric({
            event: 'provider_configuration_error',
            providerId,
            role,
            operation,
            durationMs,
            status: cause.status,
            errorName: err.name,
          });
        } else {
          trail.push({ providerId, outcome: 'error', error: err });
          this.emitMetric({
            event: 'provider_failed',
            providerId,
            role,
            operation,
            durationMs,
            errorName: err.name,
          });
        }
        debugError(this.devMode, `[BlockchainDataService] ${providerId} failed:`, cause);
      }
    }

    this.emitMetric({
      event: 'walk_exhausted',
      role,
      operation,
      errorName: lastError?.name,
    });
    throw new Error(
      lastError ? `NO_PROVIDER_AVAILABLE: ${lastError.message}` : 'NO_PROVIDER_AVAILABLE',
    );
  }

  /** Extract the trail of providers that were actually consulted. */
  private trailToProviders(trail: WalkAttempt[]): ProviderId[] {
    return trail
      .filter((entry) => entry.outcome !== 'unsupported')
      .map((entry) => entry.providerId);
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  private async _getSingle(address: string): Promise<SingleAddressResponse> {
    const { value, providerId, trail } = await this.walk(
      'read-balance',
      'getSingle',
      (p) => {
        if (!p.fetchSingle) {
          throw new Error('Provider declared read-balance but has no fetchSingle method.');
        }
        return p.fetchSingle(address);
      },
    );
    const response: SingleAddressResponse = { ...value };
    if (this.devMode) {
      response.provider = providerId;
      response.dev_info = { data_providers_used: this.trailToProviders(trail) };
    }
    return response;
  }

  /**
   * Fetch the balance for one address.
   *
   * Throws `NO_PROVIDER_AVAILABLE` if every registered provider was
   * either rate-limited or failed.
   */
  async getSingle(
    address: string,
    options: { force?: boolean } = {},
  ): Promise<SingleAddressResponse> {
    if (this.requestCache) {
      const key = this.singleKey(address);
      return this.requestCache.getOrCreate(
        key,
        () => this._getSingle(address),
        BlockchainDataService.TTL.BALANCE_MS,
        { bypassSettled: options.force === true },
      );
    }
    return this._getSingle(address);
  }

  private async _getMulti(addresses: readonly string[]): Promise<MultiAddressResponse> {
    // Preserve configured provider priority. Esplora-shaped providers expose
    // mempool_stats that the wallet needs for unconfirmed-only activity; forcing
    // Blockchain.com `/multiaddr` ahead of them is faster but can hide mempool
    // transactions and make active addresses look unused.
    const { value, providerId, trail } = await this.walk(
      'read-balance',
      'getMulti',
      async (p) => {
        if (!p.fetchMulti) {
          throw new Error('Provider declared read-balance but has no fetchMulti method.');
        }
        const balances = await p.fetchMulti(addresses);
        if (balances.length !== addresses.length) {
          throw new Error(
            `Provider returned ${balances.length} addresses, expected ${addresses.length}.`,
          );
        }
        return balances;
      },
    );

    // Defensive re-alignment: every consumer downstream — the SPA's
    // gap-limit walker, the active-address filter for `/txs` lookups,
    // the next-receive-index heuristic — assumes `balances[i]` is the
    // balance of `addresses[i]`. A misbehaving provider that returns
    // entries in a different order silently corrupts every step.
    // Re-build the array from the canonical input order using each
    // entry's own `address` field as the join key.
    const balances = realignByAddress(addresses, value, (entry) => entry.address, 'balance');
    const summary = {
      total_balance_sats: balances.reduce((sum, b) => sum + b.balance_sats, 0),
      total_pending_sats: balances.reduce((sum, b) => sum + b.pending_sats, 0),
      total_received_sats: balances.reduce((sum, b) => sum + b.total_received_sats, 0),
      address_count: balances.length,
    };
    const response: MultiAddressResponse = { balances, summary };
    if (this.devMode) {
      response.provider = providerId;
      response.dev_info = { data_providers_used: this.trailToProviders(trail) };
    }
    return response;
  }

  /**
   * Fetch the balance for many addresses in one logical call.
   *
   * Providers with a native batch endpoint (Blockchain.com) issue a
   * single HTTP request; Esplora-shaped providers fan out internally.
   * Throws `NO_PROVIDER_AVAILABLE` if every registered provider was
   * either rate-limited or failed.
   */
  async getMulti(
    addresses: readonly string[],
    options: { force?: boolean } = {},
  ): Promise<MultiAddressResponse> {
    if (this.requestCache) {
      const key = this.multiKey(addresses);
      const canonicalAddresses = this.canonicalAddresses(addresses);
      const response = await this.requestCache.getOrCreate(
        key,
        () => this._getMulti(canonicalAddresses),
        BlockchainDataService.TTL.BALANCE_MS,
        { bypassSettled: options.force === true },
      );
      const balances = realignByAddress(
        addresses,
        response.balances,
        (entry) => entry.address,
        'balance',
      );
      return {
        ...response,
        balances,
        summary: {
          total_balance_sats: balances.reduce((sum, b) => sum + b.balance_sats, 0),
          total_pending_sats: balances.reduce((sum, b) => sum + b.pending_sats, 0),
          total_received_sats: balances.reduce((sum, b) => sum + b.total_received_sats, 0),
          address_count: balances.length,
        },
      };
    }
    return this._getMulti(addresses);
  }

  private async _getUtxos(
    addresses: readonly string[],
  ): Promise<MultiAddressUtxosResponse> {
    const { value, providerId, trail } = await this.walk('read-utxos', 'getUtxos', async (p) => {
      if (!p.fetchUtxos) {
        throw new Error('Provider declared read-utxos but has no fetchUtxos method.');
      }
      const results = await p.fetchUtxos(addresses);
      if (results.length !== addresses.length) {
        throw new Error(
          `Provider returned UTXO buckets for ${results.length} addresses, expected ${addresses.length}.`,
        );
      }
      return results;
    });

    // Same defensive re-alignment as `_getMulti` — see the comment
    // there for why the index-based assumption is dangerous.
    const results = realignByAddress(addresses, value, (entry) => entry.address, 'UTXO bucket');
    const utxoCount = results.reduce((sum, r) => sum + r.utxos.length, 0);
    const totalValueSats = results.reduce(
      (sum, r) => sum + r.utxos.reduce((s, u) => s + u.valueSats, 0),
      0,
    );
    const response: MultiAddressUtxosResponse = {
      results,
      summary: {
        address_count: addresses.length,
        utxo_count: utxoCount,
        total_value_sats: totalValueSats,
      },
    };
    if (this.devMode) {
      response.provider = providerId;
      response.dev_info = { data_providers_used: this.trailToProviders(trail) };
    }
    return response;
  }

  /**
   * Return the unspent outputs locked to each supplied address. Same
   * failover semantics as {@link getMulti}: walks the priority list,
   * skipping rate-limited or unsupported providers, returning the
   * first successful response.
   *
   * The returned `results` array has one entry per requested address
   * in the original order, so the consumer can zip it back onto its
   * `(chain, index)` mapping without bookkeeping.
   */
  async getUtxos(
    addresses: readonly string[],
    options: { force?: boolean } = {},
  ): Promise<MultiAddressUtxosResponse> {
    if (this.requestCache) {
      const key = this.utxosKey(addresses);
      const canonicalAddresses = this.canonicalAddresses(addresses);
      const response = await this.requestCache.getOrCreate(
        key,
        () => this._getUtxos(canonicalAddresses),
        BlockchainDataService.TTL.UTXOS_MS,
        { bypassSettled: options.force === true },
      );
      const results = realignByAddress(
        addresses,
        response.results,
        (entry) => entry.address,
        'UTXO bucket',
      );
      return {
        ...response,
        results,
        summary: {
          address_count: addresses.length,
          utxo_count: results.reduce((sum, r) => sum + r.utxos.length, 0),
          total_value_sats: results.reduce(
            (sum, r) => sum + r.utxos.reduce((inner, u) => inner + u.valueSats, 0),
            0,
          ),
        },
      };
    }
    return this._getUtxos(addresses);
  }

  private async _getRawTransaction(txid: string): Promise<RawTransactionResponse> {
    const canonicalTxid = canonicalTxidOrThrow(txid);
    const { value, providerId, trail } = await this.walk('read-raw-tx', 'getRawTransaction', async (p) => {
      if (!p.fetchRawTransaction) {
        throw new Error('Provider declared read-raw-tx but has no fetchRawTransaction method.');
      }
      const rawTxHex = (await p.fetchRawTransaction(canonicalTxid)).trim().toLowerCase();
      if (!/^[0-9a-f]+$/.test(rawTxHex) || rawTxHex.length % 2 !== 0) {
        throw new Error(`Provider returned non-hex raw transaction for ${canonicalTxid}.`);
      }
      return rawTxHex;
    });
    const response: RawTransactionResponse = {
      txid: canonicalTxid,
      rawTxHex: value,
    };
    if (this.devMode) {
      response.provider = providerId;
      response.dev_info = { data_providers_used: this.trailToProviders(trail) };
    }
    return response;
  }

  /**
   * Return the full raw transaction hex for a txid. Raw transactions are
   * immutable, so the settled cache keeps them far longer than balance
   * or UTXO snapshots.
   */
  async getRawTransaction(
    txid: string,
    options: { force?: boolean } = {},
  ): Promise<RawTransactionResponse> {
    const canonicalTxid = canonicalTxidOrThrow(txid);
    if (this.requestCache) {
      return this.requestCache.getOrCreate(
        this.rawTxKey(canonicalTxid),
        () => this._getRawTransaction(canonicalTxid),
        BlockchainDataService.TTL.RAW_TX_MS,
        { bypassSettled: options.force === true },
      );
    }
    return this._getRawTransaction(canonicalTxid);
  }

  private async _getTransactions(
    addresses: readonly string[],
  ): Promise<MultiAddressTransactionsResponse> {
    const { value, providerId, trail } = await this.walk('read-txs', 'getTransactions', async (p) => {
      if (!p.fetchTransactions) {
        throw new Error('Provider declared read-txs but has no fetchTransactions method.');
      }
      const results = await p.fetchTransactions(addresses);
      if (results.length !== addresses.length) {
        throw new Error(
          `Provider returned tx buckets for ${results.length} addresses, expected ${addresses.length}.`,
        );
      }
      return results;
    });

    // Same defensive re-alignment as `_getMulti` / `_getUtxos`.
    const results = realignByAddress(addresses, value, (entry) => entry.address, 'tx bucket');
    const transactionCount = results.reduce((sum, r) => sum + r.transactions.length, 0);
    const response: MultiAddressTransactionsResponse = {
      results,
      summary: {
        address_count: addresses.length,
        transaction_count: transactionCount,
      },
    };
    if (this.devMode) {
      response.provider = providerId;
      response.dev_info = { data_providers_used: this.trailToProviders(trail) };
    }
    return response;
  }

  /**
   * Return the recent transactions for each supplied address. Same
   * failover semantics as {@link getMulti} and {@link getUtxos}.
   *
   * Pagination depth is provider-dependent — Esplora returns every
   * mempool tx plus the most recent confirmed batch (~25 entries) per
   * address; Blockcypher returns up to 50. Callers needing the full
   * historical tail will need a deeper paginating endpoint.
   */
  async getTransactions(
    addresses: readonly string[],
    options: { force?: boolean } = {},
  ): Promise<MultiAddressTransactionsResponse> {
    if (this.requestCache) {
      const key = this.txsKey(addresses);
      const canonicalAddresses = this.canonicalAddresses(addresses);
      const response = await this.requestCache.getOrCreate(
        key,
        () => this._getTransactions(canonicalAddresses),
        BlockchainDataService.TTL.TXS_MS,
        { bypassSettled: options.force === true },
      );
      const results = realignByAddress(
        addresses,
        response.results,
        (entry) => entry.address,
        'tx bucket',
      );
      return {
        ...response,
        results,
        summary: {
          address_count: addresses.length,
          transaction_count: results.reduce((sum, r) => sum + r.transactions.length, 0),
        },
      };
    }
    return this._getTransactions(addresses);
  }

  private async _getTipHeight(): Promise<number> {
    const { value } = await this.walk('read-tip', 'getTipHeight', async (p) => {
      if (!p.fetchTipHeight) {
        throw new Error('Provider declared read-tip but has no fetchTipHeight method.');
      }
      return p.fetchTipHeight();
    });
    return value;
  }

  /**
   * Return the height of the current chain tip from the first
   * available provider. Used to compute a transaction's confirmation
   * count: `tip - block_height + 1`.
   */
  async getTipHeight(options: { force?: boolean } = {}): Promise<number> {
    if (this.requestCache) {
      return this.requestCache.getOrCreate(
        'tip-height',
        () => this._getTipHeight(),
        BlockchainDataService.TTL.TIP_MS,
        { bypassSettled: options.force === true },
      );
    }
    return this._getTipHeight();
  }

  // ---------------------------------------------------------------------------
  // Fiat rates
  // ---------------------------------------------------------------------------

  private async _getFiatRates(
    currencies: readonly string[],
  ): Promise<FiatRatesSnapshot> {
    const { value } = await this.walk('read-fiat-rates', 'getFiatRates', async (p) => {
      if (!p.fetchFiatRates) {
        throw new Error(
          'Provider declared read-fiat-rates but has no fetchFiatRates method.',
        );
      }
      const snapshot = await p.fetchFiatRates(currencies);
      if (!snapshot.rates || Object.keys(snapshot.rates).length === 0) {
        throw new Error(
          `Provider returned no fiat rates for the requested currencies: ${currencies.join(', ')}`,
        );
      }
      return snapshot;
    });
    return value;
  }

  /**
   * Return a BTC → fiat spot snapshot covering each requested ISO
   * 4217 currency. Same failover semantics as {@link getMulti}: walks
   * the priority list, skipping rate-limited or unsupported
   * providers, returning the first successful response.
   *
   * Designed for the once-a-minute server-side cron path; SPA
   * consumers normally subscribe to the cached snapshot in
   * `V1_BtcFiatRates` via Realtime instead of calling this directly,
   * so the rates do not get fetched per-tab.
   */
  async getFiatRates(
    currencies: readonly string[],
    options: { force?: boolean } = {},
  ): Promise<FiatRatesSnapshot> {
    if (currencies.length === 0) {
      throw new Error('At least one currency must be requested.');
    }
    if (this.requestCache) {
      const key = this.fiatRatesKey(currencies);
      return this.requestCache.getOrCreate(
        key,
        () => this._getFiatRates(currencies),
        BlockchainDataService.TTL.FIAT_RATES_MS,
        { bypassSettled: options.force === true },
      );
    }
    return this._getFiatRates(currencies);
  }

  // ---------------------------------------------------------------------------
  // Broadcast
  // ---------------------------------------------------------------------------

  /**
   * Submit a fully-signed raw transaction through the first provider
   * in the priority walk that supports the broadcast role.
   *
   * Broadcasts are intentionally **not** memoised through
   * `RequestCache`: a successful broadcast must not be replayed by a
   * concurrent caller (the second attempt would just trigger an
   * "already in mempool" rejection the operator would have to
   * debug), and a failed broadcast on one provider should re-issue a
   * fresh round-trip on the next.
   *
   * Throws `NO_PROVIDER_AVAILABLE` (with the last upstream error
   * message attached when one is available) if every provider that
   * supports the role was either rate-limited or rejected the
   * transaction.
   *
   * @param rawTxHex      Raw transaction hex (lower-case, no 0x prefix).
   * @param expectedTxid  Canonical txid the caller computed from the
   *                      raw bytes. Used as the response's txid when
   *                      the provider cannot echo one back
   *                      (Blockchain.com /pushtx) and as a sanity
   *                      check against the value Esplora providers
   *                      return.
   */
  async broadcastTransaction(
    rawTxHex: string,
    expectedTxid: string,
  ): Promise<BroadcastTransactionResponse> {
    const { value, providerId, trail } = await this.walk('broadcast', 'broadcastTransaction', async (p) => {
      if (!p.broadcastTransaction) {
        throw new Error('Provider declared broadcast but has no broadcastTransaction method.');
      }
      const echoed = await p.broadcastTransaction(rawTxHex);
      const txid = echoed.length > 0 ? echoed.toLowerCase() : expectedTxid;
      if (txid !== expectedTxid) {
        throw new Error(
          `Provider returned txid ${txid} but the local extractor produced ${expectedTxid}.`,
        );
      }
      return txid;
    });

    const response: BroadcastTransactionResponse = { txid: value, provider: providerId };
    if (this.devMode) {
      response.dev_info = { providers_attempted: this.trailToProviders(trail) };
    }
    return response;
  }

  // ---------------------------------------------------------------------------
  // Test / debug helpers
  // ---------------------------------------------------------------------------

  /**
   * Replace a registered provider with a stub. Test-only escape
   * hatch — also rebinds the throttle so a stub that does its own
   * HTTP work still goes through the gate.
   */
  setProvider(providerId: ProviderId, provider: Provider): void {
    this.attachProvider(providerId, provider);
  }

  /** Return the active rate-limiter for advanced tooling and tests. */
  getRateLimiter(): RateLimiterService {
    return this.rateLimiter;
  }

  /** Return the active request cache (or `null` when deduplication is off). */
  getRequestCache(): RequestCache | null {
    return this.requestCache;
  }

  /**
   * Snapshot of the configured priority list. Useful for dev surfaces
   * that want to render "we will try X then Y then Z".
   */
  getPriority(): readonly ProviderId[] {
    return this.priority;
  }
}

/**
 * Convenience response type re-export so consumers can refer to the
 * types they get back without reaching for `./types`. Strictly
 * additive; keeping it on the service file means autocompletion on
 * the service's methods leads straight to the right docstring.
 */
export type {
  AddressTransactions,
  AddressUtxos,
  BroadcastTransactionResponse,
  FiatRatesSnapshot,
  MultiAddressResponse,
  MultiAddressTransactionsResponse,
  MultiAddressUtxosResponse,
  RawTransactionResponse,
  SingleAddressResponse,
};

/**
 * Re-build a provider response array so its order matches the
 * caller-supplied `addresses` exactly, joining on each entry's own
 * `address` field instead of trusting positional alignment.
 *
 * Why this matters: every consumer downstream of `BlockchainDataService`
 * assumes `result[i]` is the data for `addresses[i]`. A provider that
 * silently re-orders its response (Blockchain.com `/multiaddr` is the
 * documented offender — the API returns rows in an internally chosen
 * order, not the order they were requested in) corrupts every step
 * built on that assumption: the gap-limit walker flags the wrong
 * slot, the active-address filter passes the wrong addresses through
 * to the `/txs` walker, and the next-receive-index heuristic bumps
 * past addresses that were never used.
 *
 * Throws (rather than silently inserting a zero entry) when an input
 * address is missing from the response — that means the provider
 * dropped data, which is a strictly bigger problem than a single
 * vault rendering wrong values.
 */
function realignByAddress<T>(
  addresses: readonly string[],
  entries: readonly T[],
  getAddress: (entry: T) => string,
  label: string,
): T[] {
  const byAddress = new Map<string, T>();
  for (const entry of entries) byAddress.set(getAddress(entry), entry);
  return addresses.map((addr) => {
    const entry = byAddress.get(addr);
    if (entry === undefined) {
      throw new Error(
        `Provider response missing ${label} for address ${addr}; cannot realign safely.`,
      );
    }
    return entry;
  });
}

function canonicalTxidOrThrow(txid: string): string {
  const canonical = txid.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(canonical)) {
    throw new Error(`Invalid txid: ${txid}`);
  }
  return canonical;
}

/**
 * Decide whether a provider supports the requested role. A provider
 * with no `roles` array participates in every role its method surface
 * implements (the historical default); a provider with an explicit
 * `roles` array opts in to that exact set.
 */
function supportsRole(provider: Provider, role: ProviderRole): boolean {
  const declared = provider.roles;
  if (declared !== undefined) return declared.includes(role);
  switch (role) {
    case 'read-balance':
      return typeof provider.fetchSingle === 'function'
        || typeof provider.fetchMulti === 'function';
    case 'read-utxos':
      return typeof provider.fetchUtxos === 'function';
    case 'read-txs':
      return typeof provider.fetchTransactions === 'function';
    case 'read-tip':
      return typeof provider.fetchTipHeight === 'function';
    case 'read-raw-tx':
      return typeof provider.fetchRawTransaction === 'function';
    case 'read-fiat-rates':
      return typeof provider.fetchFiatRates === 'function';
    case 'broadcast':
      return typeof provider.broadcastTransaction === 'function';
  }
}
