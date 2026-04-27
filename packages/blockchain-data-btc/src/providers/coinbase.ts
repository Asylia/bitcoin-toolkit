/**
 * Coinbase rates provider.
 *
 * Talks to `https://api.coinbase.com/v2/exchange-rates?currency=BTC`.
 * The endpoint is free, anonymous, and returns BTC → fiat rates for
 * every fiat currency Coinbase tracks (160+ entries) in a single
 * round trip. Rates are decimal *strings* in the response, which the
 * mapper coerces to numbers.
 *
 * Implements the rates-only `read-fiat-rates` role exclusively. The
 * provider is added to the priority list to diversify the fiat
 * snapshot chain alongside Mempool.space and Blockchain.com — when
 * those two upstreams have a bad day, Coinbase is on completely
 * unrelated infrastructure (their primary public API gateway, not a
 * Bitcoin-data operator) and almost certainly still answers.
 */
import type { ProviderThrottle } from '../rate-limiter';
import {
  ProviderId,
  ProviderRateLimitError,
  type FiatRatesSnapshot,
  type ProviderRole,
} from '../types';
import {
  mapCoinbaseExchangeRates,
  type CoinbaseExchangeRatesResponse,
} from '../mappers/fiat-rates';
import { parseRetryAfterMs } from '../utils';
import { debugLog } from '../log';
import type { Provider } from './base';

export interface CoinbaseProviderConfig {
  /** When `true` the provider logs every request URL. */
  devMode?: boolean;
  /** Throttle deadline per HTTP call. Defaults to `4000` ms. */
  throttleWaitMs?: number;
}

export class CoinbaseProvider implements Provider {
  /** Rates-only — no chain-data roles, no broadcast. */
  readonly roles: readonly ProviderRole[] = ['read-fiat-rates'];

  private readonly baseUrl = 'https://api.coinbase.com/v2';
  private readonly devMode: boolean;
  private readonly throttleWaitMs: number;
  private throttle: ProviderThrottle | null = null;

  constructor(config: CoinbaseProviderConfig = {}) {
    this.devMode = config.devMode ?? false;
    this.throttleWaitMs = config.throttleWaitMs ?? 4_000;
  }

  bindThrottle(throttle: ProviderThrottle): void {
    this.throttle = throttle;
  }

  /**
   * One throttled HTTP call. Acquires a permit from the gate, fires
   * the fetch, releases on completion or error. Throws
   * {@link ProviderRateLimitError} on 429 / 403 (or on a throttle
   * deadline elapsing) so the service walks to the next provider.
   */
  private async fetchOk(url: string): Promise<Response> {
    if (this.throttle) {
      const ok = await this.throttle.acquire(this.throttleWaitMs);
      if (!ok) {
        throw new ProviderRateLimitError(
          `Coinbase throttle: no permit within ${this.throttleWaitMs}ms.`,
          0,
        );
      }
    }
    try {
      debugLog(this.devMode, `[COINBASE] GET ${url}`);
      const response = await fetch(url, {
        headers: {
          Accept: 'application/json',
          // Coinbase's CDN occasionally serves a different envelope
          // when no `User-Agent` is supplied (an HTML interstitial
          // instead of JSON). A generic identifier sidesteps that.
          'User-Agent': 'asylia-blockchain-data-btc',
        },
      });
      if (response.status === 429 || response.status === 403) {
        const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
        if (this.throttle) this.throttle.tripCooldown(retryAfterMs ?? undefined);
        throw new ProviderRateLimitError(
          `Coinbase returned ${response.status} (rate-limited).`,
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
    const url = `${this.baseUrl}/exchange-rates?currency=BTC`;
    const response = await this.fetchOk(url);
    if (!response.ok) {
      const body = this.devMode ? await response.clone().text() : '';
      debugLog(this.devMode, `[COINBASE] ${response.status} body: ${body}`);
      throw new Error(`Coinbase /exchange-rates returned ${response.status}.`);
    }
    const raw = (await response.json()) as CoinbaseExchangeRatesResponse;
    const rates = mapCoinbaseExchangeRates(raw, currencies);
    if (Object.keys(rates).length === 0) {
      throw new Error(
        `Coinbase /exchange-rates returned no rates for the requested currencies: ${currencies.join(', ')}`,
      );
    }
    return {
      source: ProviderId.COINBASE,
      rates,
      // The exchange-rates endpoint does not echo a snapshot
      // timestamp; the fetch wall-clock is the closest honest
      // approximation we can give the caller.
      fetchedAt: new Date().toISOString(),
    };
  }
}
