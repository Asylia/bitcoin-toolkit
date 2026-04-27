/**
 * Kraken rates provider.
 *
 * Talks to `https://api.kraken.com/0/public/Ticker`. Kraken is a
 * top-tier exchange with a generous public market-data API: anonymous
 * traffic gets a "Tier 0" budget of roughly one call per second on
 * the public endpoints, which is overkill for a once-a-minute fiat
 * snapshot.
 *
 * Implements the rates-only `read-fiat-rates` role exclusively.
 * Kraken's pair naming is a mix of legacy `XXBTZUSD` / `XXBTZEUR`
 * shapes and modern `XBTCHF` shapes — see {@link mapKrakenTicker}
 * for the full mapping table.
 */
import type { ProviderThrottle } from '../rate-limiter';
import {
  ProviderId,
  ProviderRateLimitError,
  type FiatRatesSnapshot,
  type ProviderRole,
} from '../types';
import {
  krakenPairListFor,
  mapKrakenTicker,
  type KrakenTickerResponse,
} from '../mappers/fiat-rates';
import { parseRetryAfterMs } from '../utils';
import { debugLog } from '../log';
import type { Provider } from './base';

export interface KrakenProviderConfig {
  /** When `true` the provider logs every request URL. */
  devMode?: boolean;
  /** Throttle deadline per HTTP call. Defaults to `4000` ms. */
  throttleWaitMs?: number;
}

export class KrakenProvider implements Provider {
  /** Rates-only — no chain-data roles, no broadcast. */
  readonly roles: readonly ProviderRole[] = ['read-fiat-rates'];

  private readonly baseUrl = 'https://api.kraken.com/0/public';
  private readonly devMode: boolean;
  private readonly throttleWaitMs: number;
  private throttle: ProviderThrottle | null = null;

  constructor(config: KrakenProviderConfig = {}) {
    this.devMode = config.devMode ?? false;
    this.throttleWaitMs = config.throttleWaitMs ?? 4_000;
  }

  bindThrottle(throttle: ProviderThrottle): void {
    this.throttle = throttle;
  }

  private async fetchOk(url: string): Promise<Response> {
    if (this.throttle) {
      const ok = await this.throttle.acquire(this.throttleWaitMs);
      if (!ok) {
        throw new ProviderRateLimitError(
          `Kraken throttle: no permit within ${this.throttleWaitMs}ms.`,
          0,
        );
      }
    }
    try {
      debugLog(this.devMode, `[KRAKEN] GET ${url}`);
      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
      });
      if (response.status === 429 || response.status === 403) {
        const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
        if (this.throttle) this.throttle.tripCooldown(retryAfterMs ?? undefined);
        throw new ProviderRateLimitError(
          `Kraken returned ${response.status} (rate-limited).`,
          retryAfterMs ?? 0,
        );
      }
      return response;
    } finally {
      this.throttle?.release();
    }
  }

  async fetchFiatRates(
    currencies: readonly string[],
  ): Promise<FiatRatesSnapshot> {
    const pairList = krakenPairListFor(currencies);
    if (pairList.length === 0) {
      throw new Error('Kraken: no recognised pairs for the requested currencies.');
    }
    const url = `${this.baseUrl}/Ticker?pair=${encodeURIComponent(pairList)}`;
    const response = await this.fetchOk(url);
    if (!response.ok) {
      const body = this.devMode ? await response.clone().text() : '';
      debugLog(this.devMode, `[KRAKEN] ${response.status} body: ${body}`);
      throw new Error(`Kraken /Ticker returned ${response.status}.`);
    }
    const raw = (await response.json()) as KrakenTickerResponse;
    // Kraken returns a 200 with an `error: ["…"]` array on payload
    // problems (unknown pair, malformed query, etc.) — surface that
    // as a regular Error so the service walker rotates instead of
    // happily caching an empty `result`.
    if (Array.isArray(raw.error) && raw.error.length > 0) {
      throw new Error(`Kraken /Ticker error: ${raw.error.join('; ')}`);
    }
    const rates = mapKrakenTicker(raw, currencies);
    if (Object.keys(rates).length === 0) {
      throw new Error(
        `Kraken /Ticker returned no rates for the requested currencies: ${currencies.join(', ')}`,
      );
    }
    return {
      source: ProviderId.KRAKEN,
      rates,
      // The /Ticker response does not echo a wall-clock timestamp;
      // using the fetch instant keeps the cached snapshot honest
      // about when we observed the value.
      fetchedAt: new Date().toISOString(),
    };
  }
}
