/**
 * Mappers for the BTC → fiat spot rate providers.
 *
 * Each upstream natively returns rates in a slightly different shape:
 *
 *   - **Mempool.space** — flat object `{ time, USD, EUR, GBP, ... }`
 *     with rates as numbers and `time` as a Unix epoch (seconds).
 *   - **Blockchain.com /ticker** — nested object
 *     `{ USD: { 15m, last, buy, sell, symbol }, EUR: { … }, … }` with
 *     rates as numbers under `last`.
 *   - **Coinbase /exchange-rates** — `{ data: { currency: "BTC",
 *     rates: { USD: "64500.00", EUR: "60500.00", … } } }` with rates
 *     as decimal *strings*.
 *   - **CoinGecko /simple/price** — `{ bitcoin: { usd, eur, gbp, … } }`
 *     with rates as numbers and lower-cased currency keys.
 *   - **Kraken /Ticker** — `{ result: { XBTCHF: { c: ["…","…"], … },
 *     XXBTZUSD: { c: […], … } } }` with rates as decimal strings under
 *     `c[0]` (the most recent close); Kraken prefixes "X"/"Z" on its
 *     historical fiat assets so USD/EUR/GBP appear as `XXBTZUSD`,
 *     `XXBTZEUR`, `XXBTZGBP` while CHF / newer pairs use the plain
 *     `XBTCHF` shape.
 *
 * Every mapper returns the same canonical
 * `{ <ISO 4217 upper-case>: number }` shape so the
 * `BlockchainDataService` and the consumer never have to pattern-match
 * on which provider answered.
 */

/**
 * Coerce a raw value (number or numeric-like string) into a
 * strictly-positive finite number. Returns `null` on anything that
 * does not parse cleanly so the caller can drop the entry instead of
 * silently inserting `0` or `NaN` into the rate map.
 */
function toPositiveNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

/**
 * Project a multi-currency rate map down to the requested ISO codes.
 *
 * Both inputs are normalised to upper-case ASCII before the lookup so
 * callers can request `"usd"` and an upstream that returns `"USD"`
 * collapses onto the same key. Currencies the upstream does not
 * cover are dropped from the result rather than reported as zero —
 * the service walker treats an empty intersection as a provider
 * miss and rotates to the next entry in the priority list.
 */
function projectRequested(
  rates: Readonly<Record<string, number>>,
  requested: readonly string[],
): Record<string, number> {
  const wantSet = new Set<string>(requested.map((code) => code.toUpperCase()));
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(rates)) {
    if (wantSet.has(key.toUpperCase())) result[key.toUpperCase()] = value;
  }
  return result;
}

// =============================================================================
// Mempool.space
// =============================================================================

/**
 * Wire shape of `GET https://mempool.space/api/v1/prices`. Every
 * non-`time` numeric key is a fiat code → BTC price mapping.
 */
export type MempoolSpacePricesResponse = {
  /** Unix epoch (seconds) of the snapshot. */
  time?: number;
  [currency: string]: number | undefined;
};

export function mapMempoolSpacePrices(
  response: MempoolSpacePricesResponse,
  requested: readonly string[],
): Record<string, number> {
  const flat: Record<string, number> = {};
  for (const [key, value] of Object.entries(response)) {
    if (key === 'time') continue;
    const numeric = toPositiveNumber(value);
    if (numeric === null) continue;
    flat[key.toUpperCase()] = numeric;
  }
  return projectRequested(flat, requested);
}

/** Pull the snapshot timestamp out of the Mempool.space envelope. */
export function isoFromMempoolSpace(
  response: MempoolSpacePricesResponse,
): string {
  if (typeof response.time === 'number' && Number.isFinite(response.time)) {
    return new Date(response.time * 1_000).toISOString();
  }
  return new Date().toISOString();
}

// =============================================================================
// Blockchain.com /ticker
// =============================================================================

/** One row of `GET https://blockchain.info/ticker`. */
export type BlockchainDotComTickerEntry = {
  '15m'?: number;
  last?: number;
  buy?: number;
  sell?: number;
  symbol?: string;
};

/** Wire shape of `GET https://blockchain.info/ticker`. */
export type BlockchainDotComTickerResponse = Record<
  string,
  BlockchainDotComTickerEntry
>;

export function mapBlockchainDotComTicker(
  response: BlockchainDotComTickerResponse,
  requested: readonly string[],
): Record<string, number> {
  const flat: Record<string, number> = {};
  for (const [key, entry] of Object.entries(response)) {
    if (!entry || typeof entry !== 'object') continue;
    const candidate = toPositiveNumber(entry.last) ?? toPositiveNumber(entry['15m']);
    if (candidate === null) continue;
    flat[key.toUpperCase()] = candidate;
  }
  return projectRequested(flat, requested);
}

// =============================================================================
// Coinbase /exchange-rates
// =============================================================================

/** Wire shape of `GET https://api.coinbase.com/v2/exchange-rates?currency=BTC`. */
export type CoinbaseExchangeRatesResponse = {
  data?: {
    currency?: string;
    rates?: Record<string, string | number>;
  };
};

export function mapCoinbaseExchangeRates(
  response: CoinbaseExchangeRatesResponse,
  requested: readonly string[],
): Record<string, number> {
  const rates = response.data?.rates;
  if (!rates || typeof rates !== 'object') return {};
  const flat: Record<string, number> = {};
  for (const [key, value] of Object.entries(rates)) {
    const numeric = toPositiveNumber(value);
    if (numeric === null) continue;
    flat[key.toUpperCase()] = numeric;
  }
  return projectRequested(flat, requested);
}

// =============================================================================
// CoinGecko /simple/price
// =============================================================================

/** Wire shape of `GET https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=…`. */
export type CoinGeckoSimplePriceResponse = {
  bitcoin?: Record<string, number>;
};

export function mapCoinGeckoSimplePrice(
  response: CoinGeckoSimplePriceResponse,
  requested: readonly string[],
): Record<string, number> {
  const bucket = response.bitcoin;
  if (!bucket || typeof bucket !== 'object') return {};
  const flat: Record<string, number> = {};
  for (const [key, value] of Object.entries(bucket)) {
    const numeric = toPositiveNumber(value);
    if (numeric === null) continue;
    flat[key.toUpperCase()] = numeric;
  }
  return projectRequested(flat, requested);
}

// =============================================================================
// Kraken /Ticker
// =============================================================================

/** One ticker entry of `GET https://api.kraken.com/0/public/Ticker`. */
export type KrakenTickerEntry = {
  /**
   * Last trade closed: `[price, lot_volume]`. Both values are decimal
   * strings; the price is what we read for the spot rate.
   */
  c?: [string, string] | string[];
};

/** Wire shape of `GET https://api.kraken.com/0/public/Ticker?pair=…`. */
export type KrakenTickerResponse = {
  error?: string[];
  result?: Record<string, KrakenTickerEntry>;
};

/**
 * Kraken pairs use a mix of legacy and modern naming conventions:
 *
 *   - Legacy `XXBTZUSD` / `XXBTZEUR` / `XXBTZGBP` for the historical
 *     fiat assets (USD, EUR, GBP) — the leading `X` / `Z` are
 *     classification prefixes that pre-date Kraken's modern naming
 *     scheme.
 *   - Modern `XBT<CURR>` (`XBTCHF`, `XBTAUD`, `XBTJPY`, …) for newer
 *     pairs added after the rename.
 *
 * Kraken accepts the modern shape on the request side (`pair=XBTUSD`)
 * but echoes the legacy shape back in the response, which makes the
 * round-trip mapping non-obvious; the table below is the single
 * source of truth.
 */
const KRAKEN_PAIR_TO_CURRENCY: Readonly<Record<string, string>> = {
  XXBTZUSD: 'USD',
  XXBTZEUR: 'EUR',
  XXBTZGBP: 'GBP',
  XXBTZJPY: 'JPY',
  XXBTZCAD: 'CAD',
  XBTCHF: 'CHF',
  XBTAUD: 'AUD',
  XBTUSD: 'USD',
  XBTEUR: 'EUR',
  XBTGBP: 'GBP',
};

/**
 * Build the comma-separated `pair=` query value Kraken expects given
 * a list of ISO 4217 currency codes. Codes the table does not cover
 * are dropped silently — the caller will notice when the response
 * does not contain them.
 */
export function krakenPairListFor(currencies: readonly string[]): string {
  const seen = new Set<string>();
  const pairs: string[] = [];
  for (const code of currencies) {
    const upper = code.toUpperCase();
    const pair = `XBT${upper}`;
    if (seen.has(pair)) continue;
    seen.add(pair);
    pairs.push(pair);
  }
  return pairs.join(',');
}

export function mapKrakenTicker(
  response: KrakenTickerResponse,
  requested: readonly string[],
): Record<string, number> {
  const result = response.result;
  if (!result || typeof result !== 'object') return {};
  const flat: Record<string, number> = {};
  for (const [pair, entry] of Object.entries(result)) {
    const currency = KRAKEN_PAIR_TO_CURRENCY[pair];
    if (!currency) continue;
    const closeArray = entry?.c;
    const closePrice = Array.isArray(closeArray) ? closeArray[0] : undefined;
    const numeric = toPositiveNumber(closePrice);
    if (numeric === null) continue;
    flat[currency] = numeric;
  }
  return projectRequested(flat, requested);
}
