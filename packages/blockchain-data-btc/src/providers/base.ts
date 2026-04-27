/**
 * Provider abstraction.
 *
 * Every concrete provider implementation conforms to this interface so
 * the service can swap them in by `ProviderId` without caring about
 * transport details. Methods other than `fetchSingle` / `fetchMulti`
 * are optional — providers that lack them are silently skipped by the
 * service when a caller asks for that role, instead of crashing.
 *
 * `roles` (read by the service via `provider.roles ?? defaults`) lets
 * a provider opt into a degraded set explicitly, which is useful when
 * an upstream technically supports an endpoint but its accuracy or
 * latency is so bad we never want to use it. The default — assume
 * every method that exists is supported — is the right answer for the
 * built-in providers.
 *
 * `bindThrottle` is called by the service exactly once at
 * construction time, before the provider is ever invoked. Providers
 * use the supplied {@link ProviderThrottle} to gate every HTTP round
 * trip — the gate enforces the per-provider min-interval, concurrency
 * cap, sliding window, and explicit cooldown documented in
 * `RateLimiterService`. Implementations that do not need throttling
 * (e.g. the in-process stub used in tests) may leave the method
 * undefined; the service treats that as "no throttling", which is
 * fine for a stub but never the right answer for a real upstream.
 */
import type { ProviderThrottle } from '../rate-limiter';
import type {
  AddressTransactions,
  AddressUtxos,
  FiatRatesSnapshot,
  NormalizedAddressBalance,
  ProviderRole,
} from '../types';

export interface Provider {
  /** Capabilities advertised by this implementation. */
  readonly roles?: readonly ProviderRole[];

  /**
   * Set to `true` when the provider exposes a true *batch* endpoint
   * for {@link Provider.fetchMulti} that returns N addresses in a
   * single HTTP round trip (Blockchain.com `/multiaddr` is the
   * archetypal example). The service hoists batch-capable providers
   * to the front of the priority list whenever it sees a
   * multi-address `getMulti` call so the SDK does not blindly fan
   * out N parallel requests against an Esplora endpoint when one
   * round trip would do.
   *
   * Defaults to `false` for providers that fan out internally
   * (Esplora, Blockcypher) — they participate in the priority walk
   * normally and only get hit when the batch-capable providers are
   * cooled down or unavailable.
   *
   * Single-address calls (`getSingle`, `addresses.length === 1`)
   * ignore this flag — there is nothing to batch and the upstream
   * may even be slower for a one-address `/multiaddr`.
   */
  readonly bulkCapable?: boolean;

  /**
   * Receive the per-provider throttle the service has reserved for
   * this implementation. Called once at registration time. Optional
   * so test stubs do not have to plumb it through.
   */
  bindThrottle?(throttle: ProviderThrottle): void;

  /**
   * Return the on-chain balance for a single address. Optional —
   * rates-only providers (Coinbase, CoinGecko, Kraken) do not
   * implement chain-data reads and naturally drop out of the
   * `read-balance` walk.
   */
  fetchSingle?(address: string): Promise<NormalizedAddressBalance>;

  /**
   * Return the on-chain balances for many addresses in one logical
   * call. Optional for the same reason as {@link Provider.fetchSingle}.
   * Implementations that only have a single-address endpoint are
   * expected to fan out internally (the shared
   * {@link EsploraBaseProvider} does this with bounded concurrency).
   */
  fetchMulti?(addresses: readonly string[]): Promise<NormalizedAddressBalance[]>;

  /**
   * Return the unspent outputs locked to each requested address. The
   * order of the returned `AddressUtxos[]` mirrors the order of
   * `addresses` so the caller can zip the result back without
   * bookkeeping.
   *
   * Optional because not every provider has to expose a clean
   * per-address UTXO list (Blockchain.com `/unspent` works, but
   * incurs one HTTP call per address).
   */
  fetchUtxos?(addresses: readonly string[]): Promise<AddressUtxos[]>;

  /**
   * Return the recent transactions touching each requested address.
   * Optional — Blockchain.com does not expose a clean per-address tx
   * history endpoint, so it stays balance/UTXO only. Providers that
   * omit the method fall out of the failover chain naturally.
   */
  fetchTransactions?(
    addresses: readonly string[],
  ): Promise<AddressTransactions[]>;

  /** Return the height of the current chain tip. Optional, same reason. */
  fetchTipHeight?(): Promise<number>;

  /**
   * Return the full raw transaction hex for a txid. Used when building
   * PSBT inputs with `nonWitnessUtxo`, which lets hardware wallets
   * verify the funding transaction instead of displaying an
   * "unverified inputs" warning.
   */
  fetchRawTransaction?(txid: string): Promise<string>;

  /**
   * Return a BTC → fiat spot snapshot covering each requested ISO
   * 4217 currency. Optional — most chain-data providers do not
   * expose a price endpoint (Esplora, Blockcypher); only Mempool.space
   * and Blockchain.com speak it natively, plus the dedicated
   * rates-only providers (Coinbase, CoinGecko, Kraken).
   *
   * Implementations should:
   *   - Honour the currency filter where the upstream supports it
   *     server-side (CoinGecko `vs_currencies`, Kraken pair list);
   *     for upstreams that always return every currency they support
   *     (Mempool.space, Blockchain.com /ticker, Coinbase
   *     /exchange-rates) the implementation just upper-cases the
   *     codes and projects the response down to the requested set.
   *   - Throw when the upstream cannot deliver *any* of the
   *     requested currencies, so the service walker rotates to the
   *     next provider instead of returning an empty `rates` map a
   *     downstream `pickRate` would silently treat as zero.
   *
   * The `currencies` parameter is `readonly string[]` rather than a
   * fixed enum so callers can request any code an upstream might
   * support without a package-level allowlist update.
   */
  fetchFiatRates?(currencies: readonly string[]): Promise<FiatRatesSnapshot>;

  /**
   * Submit a fully-signed raw transaction to the network. Returns the
   * network txid on success. Implementations that cannot echo the
   * txid (Blockchain.com `/pushtx`) may return an empty string; the
   * service façade fills in the missing value from the
   * caller-supplied canonical txid.
   */
  broadcastTransaction?(rawTxHex: string): Promise<string>;
}
