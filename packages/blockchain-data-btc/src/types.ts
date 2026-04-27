/**
 * Public types for `@asylia/blockchain-data-btc`.
 *
 * The package's job is to give every consumer the same canonical
 * shapes (`NormalizedAddressBalance`, `NormalizedUtxo`,
 * `NormalizedTransaction`) regardless of which upstream provider
 * answered. Callers should never have to pattern-match on a
 * provider-specific JSON envelope.
 */

/**
 * Identifier for one upstream chain-data or rates provider.
 *
 * Used as the rate-limiter / priority-list key and (when `devMode` is
 * on) as the `provider` echo in responses for debugging which API
 * actually answered a given request.
 *
 * The set is split into four tiers by intent, not by network address:
 *
 *   - **Esplora-shaped public APIs** (`MEMPOOL_SPACE`,
 *     `BLOCKSTREAM_INFO`, `MEMPOOL_EMZY`, `MEMPOOL_BISQ`,
 *     `BITCOIN_TWENTYONE`) — same wire shape, different operators /
 *     IP pools. Stack them in the priority list to multiply the free
 *     rate-limit budget without changing any client code.
 *   - **Distinct public APIs** (`BLOCKCHAIN_DOT_COM`, `BLOCKCYPHER`)
 *     — different shape, different infrastructure. Used as
 *     diversification on top of Esplora.
 *   - **Rates-only providers** (`COINBASE`, `COINGECKO`, `KRAKEN`)
 *     — never participate in chain-data reads / broadcast; only
 *     declare the `read-fiat-rates` role and exist purely to
 *     diversify the BTC → fiat snapshot chain.
 *   - **Edge fallback** (`EDGE_FALLBACK`) — last-resort proxy through
 *     a server-side endpoint that holds the paid Blockstream API key.
 *     Sits at the tail of the priority list so it only carries
 *     traffic when every free provider is rate-limited or down.
 */
export enum ProviderId {
  /** `https://mempool.space/api` — Esplora, free public + optional paid. */
  MEMPOOL_SPACE = 'MEMPOOL_SPACE',
  /** `https://blockstream.info/api` — Esplora, free anonymous + optional Basic. */
  BLOCKSTREAM_INFO = 'BLOCKSTREAM_INFO',
  /** `https://mempool.emzy.de/api` — community Esplora mirror (Germany). */
  MEMPOOL_EMZY = 'MEMPOOL_EMZY',
  /** `https://mempool.bisq.services/api` — Bisq community Esplora mirror. */
  MEMPOOL_BISQ = 'MEMPOOL_BISQ',
  /** `https://mempool.bitcoin-21.org/api` — Bitcoin-21 community mirror. */
  BITCOIN_TWENTYONE = 'BITCOIN_TWENTYONE',
  /** `https://blockchain.info` — supports native batch (`/multiaddr`). */
  BLOCKCHAIN_DOT_COM = 'BLOCKCHAIN_DOT_COM',
  /** `https://api.blockcypher.com/v1/btc/main` — distinct infra. */
  BLOCKCYPHER = 'BLOCKCYPHER',
  /** `https://api.coinbase.com/v2/exchange-rates?currency=BTC` — rates-only. */
  COINBASE = 'COINBASE',
  /** `https://api.coingecko.com/api/v3/simple/price` — rates-only. */
  COINGECKO = 'COINGECKO',
  /** `https://api.kraken.com/0/public/Ticker` — rates-only. */
  KRAKEN = 'KRAKEN',
  /**
   * Server-side fallback that proxies a single chain-data call through
   * a consumer-supplied `invoke` callback. Wired up at construction
   * time with a closure that talks to whichever backend holds the
   * paid Blockstream API key (typically a Supabase Edge Function).
   * The package itself stays runtime-agnostic.
   */
  EDGE_FALLBACK = 'EDGE_FALLBACK',
}

/**
 * Set of capabilities a provider implementation declares. The service
 * priority walk skips a provider whose interface does not implement
 * the requested role, instead of throwing on a missing method.
 *
 * `read-fiat-rates` covers BTC → fiat spot conversion. It is split
 * from the other read roles because most chain-data providers do not
 * speak it natively (only Mempool.space and Blockchain.com today),
 * and a couple of dedicated rates-only providers (Coinbase, CoinGecko,
 * Kraken) participate in this role *exclusively*. The role lets the
 * priority walker stack chain-data and rates-only providers in the
 * same list without forcing every implementation to declare the
 * read-balance / read-utxos / etc. methods it does not support.
 */
export type ProviderRole =
  | 'read-balance'
  | 'read-utxos'
  | 'read-txs'
  | 'read-tip'
  | 'read-raw-tx'
  | 'read-fiat-rates'
  | 'broadcast';

/**
 * Provider-agnostic balance snapshot for one Bitcoin address.
 *
 *   - `balance_sats` is the *confirmed* on-chain balance (UTXO sum
 *     of outputs already mined into a block). Esplora-shaped providers
 *     compute it as `chain_stats.funded_txo_sum
 *     - chain_stats.spent_txo_sum`. Blockchain.com cannot expose a
 *     confirmed-only figure cleanly so it returns its `final_balance`
 *     (confirmed + mempool combined) — see `mapBlockchainDotCom` for
 *     the documented caveat.
 *   - `pending_sats` is the *unconfirmed* net inflow currently sitting
 *     in the mempool, clamped at zero so an unconfirmed outgoing spend
 *     never produces a negative number consumers would have to special
 *     case. Esplora providers populate it from `mempool_stats`;
 *     Blockchain.com cannot and reports `0`.
 */
export type NormalizedAddressBalance = {
  /** Bitcoin address (any format: P2PKH, P2SH, P2WPKH, P2WSH, P2TR). */
  address: string;
  /** Confirmed balance in satoshis (1 BTC = 100,000,000 sats). */
  balance_sats: number;
  /** Net unconfirmed inflow in satoshis (clamped at zero). */
  pending_sats: number;
  /** Total received over the address's confirmed history, in satoshis. */
  total_received_sats: number;
  /** Lifetime number of confirmed transactions involving the address. */
  tx_count: number;
};

/**
 * One unspent transaction output. The shape is the intersection of
 * what the supported providers expose:
 *
 *   - `txid`, `vout`, `valueSats` — universal across every provider.
 *   - `address` — added by the service after the fact (the upstream
 *     APIs do not always echo it back) so the caller can map a UTXO
 *     back to the script it pays to without re-deriving.
 *   - `confirmed` + `blockHeight` — set by Esplora-shaped providers
 *     when the UTXO has been mined; mempool UTXOs report
 *     `confirmed: false` and `blockHeight: null`.
 */
export type NormalizedUtxo = {
  txid: string;
  vout: number;
  valueSats: number;
  address: string;
  confirmed: boolean;
  blockHeight: number | null;
};

/**
 * Per-address bucket of unspent outputs returned by
 * {@link NormalizedUtxo}-shaped providers. The service hands the
 * caller one bucket per requested address, in the same order, so the
 * consumer can zip the result back onto its `(chain, index)` mapping
 * without bookkeeping.
 */
export type AddressUtxos = {
  address: string;
  utxos: NormalizedUtxo[];
};

/** Aggregated multi-address response of {@link AddressUtxos}. */
export type MultiAddressUtxosResponse = {
  results: AddressUtxos[];
  summary: {
    address_count: number;
    utxo_count: number;
    total_value_sats: number;
  };
  /** Provider that ultimately served the request. Dev-mode only. */
  provider?: ProviderId;
  /** Per-attempt provider trace. Dev-mode only. */
  dev_info?: DevInfo;
};

/**
 * One input of a {@link NormalizedTransaction}. Carries only the
 * fields the wallet actually needs to compute per-vault aggregates:
 * the address being spent (so we can decide whether the input was
 * "ours") and the value being spent.
 *
 * `address` is `null` for non-standard scripts the upstream provider
 * cannot decode (e.g. exotic taproot annexes, malformed scripts).
 * Callers should treat such inputs as "external" since they do not
 * match any address in the vault's derivation window.
 */
export type NormalizedTransactionVin = {
  address: string | null;
  valueSats: number;
};

/**
 * One output of a {@link NormalizedTransaction}. Same shape as
 * {@link NormalizedTransactionVin}; `address` is also `null` for
 * `OP_RETURN` outputs and other non-standard scripts.
 */
export type NormalizedTransactionVout = {
  address: string | null;
  valueSats: number;
};

/**
 * Provider-agnostic Bitcoin transaction shape. Carries every field
 * the wallet needs to compute per-vault aggregates (direction, net
 * amount, fee, counterparties) without round-tripping back to the
 * raw provider payload.
 *
 * `status.blockTime` is normalised to an ISO 8601 string so the SPA
 * can render it directly without re-parsing the upstream Unix
 * timestamp. Mempool entries report `confirmed: false`,
 * `blockHeight: null`, `blockTime: null`.
 */
export type NormalizedTransaction = {
  txid: string;
  vin: NormalizedTransactionVin[];
  vout: NormalizedTransactionVout[];
  /** Total transaction fee in satoshis. */
  feeSats: number;
  /** Virtual size in vbytes (weight / 4). */
  vbytes: number;
  status: {
    confirmed: boolean;
    blockHeight: number | null;
    /** ISO 8601 timestamp from `block_time`, or `null` while in mempool. */
    blockTime: string | null;
  };
};

/** Per-address bucket of transactions, mirrors {@link AddressUtxos}. */
export type AddressTransactions = {
  address: string;
  transactions: NormalizedTransaction[];
};

/** Aggregated multi-address response of {@link AddressTransactions}. */
export type MultiAddressTransactionsResponse = {
  results: AddressTransactions[];
  summary: {
    address_count: number;
    /** Total tx-bucket entries across every address (with duplicates). */
    transaction_count: number;
  };
  provider?: ProviderId;
  dev_info?: DevInfo;
};

/**
 * Diagnostic block included in responses when `devMode` is enabled on
 * the service. Lists every provider that was attempted (in order) so a
 * developer can see when the failover kicked in.
 *
 * Never enabled in a production response — the field is gated by an
 * explicit `devMode` flag at service construction.
 */
export type DevInfo = {
  data_providers_used: ProviderId[];
};

/** Response payload of `BlockchainDataService.getMulti`. */
export type MultiAddressResponse = {
  /** One entry per requested address, in request order. */
  balances: NormalizedAddressBalance[];
  /** Aggregates over `balances` for one-shot UI consumption. */
  summary: {
    /** Sum of confirmed balances across every requested address. */
    total_balance_sats: number;
    /** Sum of unconfirmed (mempool) inflows across every address. */
    total_pending_sats: number;
    /** Sum of lifetime confirmed receipts across every address. */
    total_received_sats: number;
    address_count: number;
  };
  /** Provider that ultimately served the request. Dev-mode only. */
  provider?: ProviderId;
  /** Per-attempt provider trace. Dev-mode only. */
  dev_info?: DevInfo;
};

/** Response payload of `BlockchainDataService.getSingle`. */
export type SingleAddressResponse = NormalizedAddressBalance & {
  /** Provider that ultimately served the request. Dev-mode only. */
  provider?: ProviderId;
  /** Per-attempt provider trace. Dev-mode only. */
  dev_info?: DevInfo;
};

/**
 * Provider-agnostic BTC → fiat spot rate snapshot.
 *
 * One entry per ISO 4217 currency code. The `rate` is *fiat units per
 * whole BTC* (e.g. `64500` = 1 BTC = 64,500 USD), the same shape every
 * supported upstream natively returns, so consumers never have to
 * worry about reciprocal-rate confusion.
 *
 * Currency codes are upper-cased ASCII at the boundary so a provider
 * that returns `usd` (CoinGecko) and one that returns `USD`
 * (Mempool.space) collapse onto the same key in the response.
 *
 * The shape is intentionally a flat map rather than a fixed shape
 * (`{ usd, eur, gbp, chf }`): some providers return more currencies
 * than we ask for and a fixed shape would force the mappers to drop
 * data the caller might want to surface in the future.
 */
export type FiatRatesSnapshot = {
  /** Provider that ultimately served the snapshot. */
  source: ProviderId;
  /**
   * Map of `<ISO 4217 upper-case>` → `BTC price in that fiat`.
   * Always non-empty on success — providers that cannot deliver any
   * of the requested currencies throw rather than return an empty
   * map, so a downstream `pickRate(currency)` call cannot silently
   * fall back to zero.
   */
  rates: Readonly<Record<string, number>>;
  /**
   * ISO 8601 timestamp of the upstream snapshot. Falls back to the
   * fetch wall-clock when the provider does not include a timestamp
   * in its payload (Coinbase, CoinGecko).
   */
  fetchedAt: string;
};

/**
 * Outcome of `BlockchainDataService.broadcastTransaction`.
 *
 *   - `txid` — the network transaction id. The service guarantees this
 *     is always populated even when the underlying provider could not
 *     echo it back (Blockchain.com `/pushtx`); in that case it falls
 *     back to the caller-supplied `expectedTxid`.
 *   - `provider` — which provider actually accepted the broadcast.
 *     Always returned (not gated behind `devMode` like the read
 *     endpoints) because the caller surfaces "Broadcast via X" to the
 *     operator.
 */
export type BroadcastTransactionResponse = {
  txid: string;
  provider: ProviderId;
  /** Per-attempt provider trace, populated only in dev mode. */
  dev_info?: { providers_attempted: ProviderId[] };
};

/** Response payload for one raw transaction hex lookup. */
export type RawTransactionResponse = {
  /** Big-endian transaction id requested by the caller. */
  txid: string;
  /** Full raw transaction hex, lower-case, no `0x` prefix. */
  rawTxHex: string;
  /** Provider that ultimately served the request. Dev-mode only. */
  provider?: ProviderId;
  /** Per-attempt provider trace. Dev-mode only. */
  dev_info?: DevInfo;
};

/**
 * Marker thrown by providers when the upstream explicitly rate-limits
 * them (HTTP 429, or HTTP 403 with a quota-exceeded body, or any
 * `Retry-After` response). The service catches it, immediately marks
 * the provider as cooled-down for at least the suggested duration,
 * and walks to the next entry in the priority list.
 *
 * Other errors (timeouts, 5xx, malformed payload) bubble up as
 * generic `Error` and trigger a single-attempt failover without a
 * cooldown — the next refresh tick may succeed.
 */
export class ProviderRateLimitError extends Error {
  override readonly name = 'ProviderRateLimitError';
  /** Seconds to cool down (parsed from `Retry-After` if present). */
  readonly retryAfterMs: number;

  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.retryAfterMs = retryAfterMs;
  }
}
