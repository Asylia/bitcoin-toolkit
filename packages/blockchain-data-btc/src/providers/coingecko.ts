/**
 * CoinGecko rates provider.
 *
 * Talks to `https://api.coingecko.com/api/v3/simple/price`. The free
 * public tier accepts anonymous traffic with permissive CORS but
 * carries a tight rate budget (officially 5-15 req/min depending on
 * region). For the once-a-minute cron use case this is plenty; for
 * any client-side flow this provider should sit deep in the priority
 * list so the SDK never bursts against it.
 *
 * Implements the rates-only `read-fiat-rates` role exclusively. The
 * endpoint accepts a `vs_currencies=` filter so only the requested
 * currencies are returned; the mapper still uppercases keys (the
 * upstream returns them lower-cased).
 */
import type { ProviderThrottle } from '../rate-limiter';
import {
  ProviderId,
  ProviderRateLimitError,
  type FiatRatesSnapshot,
  type ProviderRole,
} from '../types';
import {
  mapCoinGeckoSimplePrice,
  type CoinGeckoSimplePriceResponse,
} from '../mappers/fiat-rates';
import { parseRetryAfterMs } from '../utils';
import { debugLog } from '../log';
import type { Provider } from './base';

export interface CoinGeckoProviderConfig {
  /**
   * Optional CoinGecko Pro API key. When supplied, requests go to
   * `https://pro-api.coingecko.com/api/v3` with the `x-cg-pro-api-key`
   * header attached, lifting the anonymous rate ceiling. The free
   * public path is used otherwise.
   */
  apiKey?: string;
  /** When `true` the provider logs every request URL. */
  devMode?: boolean;
  /** Throttle deadline per HTTP call. Defaults to `4000` ms. */
  throttleWaitMs?: number;
}

export class CoinGeckoProvider implements Provider {
  /** Rates-only — no chain-data roles, no broadcast. */
  readonly roles: readonly ProviderRole[] = ['read-fiat-rates'];

  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly devMode: boolean;
  private readonly throttleWaitMs: number;
  private throttle: ProviderThrottle | null = null;

  constructor(config: CoinGeckoProviderConfig = {}) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.apiKey
      ? 'https://pro-api.coingecko.com/api/v3'
      : 'https://api.coingecko.com/api/v3';
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
          `CoinGecko throttle: no permit within ${this.throttleWaitMs}ms.`,
          0,
        );
      }
    }
    try {
      debugLog(this.devMode, `[COINGECKO] GET ${url}`);
      const headers: Record<string, string> = {
        Accept: 'application/json',
      };
      if (this.apiKey) headers['x-cg-pro-api-key'] = this.apiKey;
      const response = await fetch(url, { headers });
      if (response.status === 429 || response.status === 403) {
        const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
        if (this.throttle) this.throttle.tripCooldown(retryAfterMs ?? undefined);
        throw new ProviderRateLimitError(
          `CoinGecko returned ${response.status} (rate-limited).`,
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
    // CoinGecko's `vs_currencies=` parameter is comma-separated and
    // lower-case. Normalising at the boundary lets the caller pass
    // `["USD","EUR"]` with whatever case is convenient.
    const csvCurrencies = currencies
      .map((code) => code.trim().toLowerCase())
      .filter((code) => code.length > 0)
      .join(',');
    if (csvCurrencies.length === 0) {
      throw new Error('CoinGecko: no currencies requested.');
    }
    const url = `${this.baseUrl}/simple/price?ids=bitcoin&vs_currencies=${encodeURIComponent(csvCurrencies)}`;
    const response = await this.fetchOk(url);
    if (!response.ok) {
      const body = this.devMode ? await response.clone().text() : '';
      debugLog(this.devMode, `[COINGECKO] ${response.status} body: ${body}`);
      throw new Error(`CoinGecko /simple/price returned ${response.status}.`);
    }
    const raw = (await response.json()) as CoinGeckoSimplePriceResponse;
    const rates = mapCoinGeckoSimplePrice(raw, currencies);
    if (Object.keys(rates).length === 0) {
      throw new Error(
        `CoinGecko /simple/price returned no rates for the requested currencies: ${currencies.join(', ')}`,
      );
    }
    return {
      source: ProviderId.COINGECKO,
      rates,
      // CoinGecko's free /simple/price endpoint does not include a
      // server timestamp; using the fetch wall-clock keeps the
      // cached snapshot's `fetched_at` honest about when *we*
      // observed the value.
      fetchedAt: new Date().toISOString(),
    };
  }
}
