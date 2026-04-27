/**
 * Mempool.space provider.
 *
 * Talks to `https://mempool.space/api`. The free tier accepts
 * anonymous browser traffic with permissive CORS; a paid `apiKey` is
 * forwarded as a Bearer token when supplied (mostly relevant for
 * server-side callers).
 *
 * Extends the shared Esplora transport with the `read-fiat-rates`
 * role: Mempool.space is the only Esplora-shaped operator that
 * exposes a `/v1/prices` endpoint, so the rates capability is
 * declared here rather than on `EsploraBaseProvider` (which would
 * incorrectly advertise it on every community mirror that does NOT
 * implement it).
 */
import {
  isoFromMempoolSpace,
  mapMempoolSpacePrices,
  type MempoolSpacePricesResponse,
} from '../mappers/fiat-rates';
import {
  ProviderId,
  type FiatRatesSnapshot,
  type ProviderRole,
} from '../types';
import { EsploraBaseProvider } from './esplora-base';

export interface MempoolSpaceProviderConfig {
  /** Optional Bearer-token API key (paid tier). */
  apiKey?: string;
  /** When `true` the provider logs every request URL. */
  devMode?: boolean;
}

export class MempoolSpaceProvider extends EsploraBaseProvider {
  /**
   * Mempool.space supports every Esplora read role, broadcast, and
   * the rates-only `read-fiat-rates` role via `/v1/prices`. The
   * explicit list overrides the base-class default so the service
   * priority walker only consults this provider for `read-fiat-rates`
   * (and not the community mirrors that share the base transport
   * but lack the price endpoint).
   */
  override readonly roles: readonly ProviderRole[] = [
    'read-balance',
    'read-utxos',
    'read-txs',
    'read-tip',
    'read-fiat-rates',
    'broadcast',
  ];

  constructor(config: MempoolSpaceProviderConfig = {}) {
    const headers: Record<string, string> = {};
    if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`;
    super({
      baseUrl: 'https://mempool.space/api',
      displayName: 'MEMPOOL_SPACE',
      headers,
      ...(config.devMode !== undefined && { devMode: config.devMode }),
    });
  }

  /**
   * Fetch BTC → fiat rates for the requested ISO 4217 currency codes
   * via `GET /v1/prices`. The endpoint always returns every currency
   * Mempool.space tracks (USD, EUR, GBP, CAD, CHF, AUD, JPY) plus a
   * snapshot timestamp; the mapper projects the response down to the
   * requested codes and uppercases everything so the caller never
   * has to worry about case mismatches.
   *
   * Throws when none of the requested currencies are present in the
   * response so the service walker rotates to the next provider
   * instead of returning an empty `rates` map a downstream
   * `pickRate` would silently treat as zero.
   */
  async fetchFiatRates(
    currencies: readonly string[],
  ): Promise<FiatRatesSnapshot> {
    const response = await this.request('/v1/prices');
    const raw = (await response.json()) as MempoolSpacePricesResponse;
    const rates = mapMempoolSpacePrices(raw, currencies);
    if (Object.keys(rates).length === 0) {
      throw new Error(
        `Mempool.space /v1/prices returned no rates for the requested currencies: ${currencies.join(', ')}`,
      );
    }
    return {
      source: ProviderId.MEMPOOL_SPACE,
      rates,
      fetchedAt: isoFromMempoolSpace(raw),
    };
  }
}
