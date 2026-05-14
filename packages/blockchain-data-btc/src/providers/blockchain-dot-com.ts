/**
 * Blockchain.com provider.
 *
 * Talks to `https://blockchain.info`. The unique selling point versus
 * the Esplora providers is the native batch endpoint
 * `/multiaddr?active=addr1|addr2|...`, which returns every requested
 * address in a single round-trip. That makes it the fastest path for a
 * fresh window of 20+ addresses (the typical first sync of a vault).
 *
 * Limitations:
 *
 *   - `final_balance` is *confirmed + mempool combined*, no clean
 *     split. The mapper reports `pending_sats: 0` and folds the
 *     mempool delta into `balance_sats`. The default priority keeps
 *     this provider behind every Esplora option for that reason.
 *   - No clean per-address transaction history endpoint, so
 *     `fetchTransactions` is intentionally absent — the failover
 *     skips this provider for the `read-txs` role.
 *
 * Every HTTP call goes through the per-provider {@link ProviderThrottle}
 * (injected via {@link Provider.bindThrottle}) so the SDK never
 * fans out N parallel requests just because a multi-address walker
 * had N addresses to fetch.
 */
import type { ProviderThrottle } from '../rate-limiter';
import type {
  AddressUtxos,
  FiatRatesSnapshot,
  NormalizedAddressBalance,
  ProviderRole,
} from '../types';
import { ProviderConfigurationError, ProviderId, ProviderRateLimitError } from '../types';
import {
  type BlockchainDotComResponse,
  type BlockchainDotComUnspentResponse,
  mapBlockchainDotCom,
  mapBlockchainDotComUnspent,
} from '../mappers/blockchain-com';
import {
  mapBlockchainDotComTicker,
  type BlockchainDotComTickerResponse,
} from '../mappers/fiat-rates';
import { pMap, parseRetryAfterMs } from '../utils';
import { debugLog } from '../log';
import type { Provider } from './base';

export interface BlockchainDotComProviderConfig {
  apiKey?: string;
  /**
   * Bounded concurrency ceiling for the per-address `/unspent`
   * fanout. Defaults to `1` (sequential) so a fresh wallet without
   * paid credentials never bursts.
   */
  concurrency?: number;
  /** When `true` the provider logs every request URL. */
  devMode?: boolean;
  /** Throttle deadline per HTTP call. Defaults to `4000` ms. */
  throttleWaitMs?: number;
}

export class BlockchainDotComProvider implements Provider {
  /** Balance + UTXO + broadcast + fiat rates. No txs, no tip. */
  readonly roles: readonly ProviderRole[] = [
    'read-balance',
    'read-utxos',
    'read-fiat-rates',
    'broadcast',
  ];

  /**
   * `/multiaddr?active=addr1|addr2|...` returns N balances in one
   * HTTP round trip. The service hoists this provider to the front
   * of the priority list whenever a multi-address `getMulti` call
   * lands so the SDK never burns N round trips against an Esplora
   * upstream that would otherwise need to fan out internally.
   */
  readonly bulkCapable = true;

  private readonly baseUrl = 'https://blockchain.info';
  private readonly apiKey: string | undefined;
  private readonly concurrency: number;
  private readonly devMode: boolean;
  private readonly throttleWaitMs: number;
  private throttle: ProviderThrottle | null = null;

  constructor(config: BlockchainDotComProviderConfig = {}) {
    this.apiKey = config.apiKey;
    this.concurrency = config.concurrency ?? 1;
    this.devMode = config.devMode ?? false;
    this.throttleWaitMs = config.throttleWaitMs ?? 4_000;
  }

  bindThrottle(throttle: ProviderThrottle): void {
    this.throttle = throttle;
  }

  /**
   * One throttled HTTP call. Acquires a permit from the gate,
   * fires the fetch, releases on completion or error. Throws
   * {@link ProviderRateLimitError} on 429 (or on a throttle deadline
   * elapsing) and {@link ProviderConfigurationError} on 403 so auth /
   * account-policy failures are not masked as quota pressure.
   */
  private async fetchOk(url: string, init?: RequestInit): Promise<Response> {
    if (this.throttle) {
      const ok = await this.throttle.acquire(this.throttleWaitMs);
      if (!ok) {
        throw new ProviderRateLimitError(
          `Blockchain.com throttle: no permit within ${this.throttleWaitMs}ms.`,
          0,
        );
      }
    }
    try {
      debugLog(this.devMode, `[BLOCKCHAIN_DOT_COM] ${init?.method ?? 'GET'} ${url}`);
      const response = await fetch(url, init);
      if (response.status === 429) {
        const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
        if (this.throttle) this.throttle.tripCooldown(retryAfterMs ?? undefined);
        throw new ProviderRateLimitError(
          `Blockchain.com returned ${response.status} (rate-limited).`,
          retryAfterMs ?? 0,
        );
      }
      if (response.status === 403) {
        throw new ProviderConfigurationError(
          'Blockchain.com returned 403 (configuration or permission denied).',
          403,
        );
      }
      return response;
    } finally {
      this.throttle?.release();
    }
  }

  async fetchSingle(address: string): Promise<NormalizedAddressBalance> {
    const results = await this.fetchMulti([address]);
    const result = results[0];
    if (!result) throw new Error('Blockchain.com returned no result for address.');
    return result;
  }

  async fetchMulti(
    addresses: readonly string[],
  ): Promise<NormalizedAddressBalance[]> {
    const addressList = addresses.join('|');
    let url = `${this.baseUrl}/multiaddr?active=${addressList}`;
    if (this.apiKey) url += `&api_key=${this.apiKey}`;

    const response = await this.fetchOk(url);
    if (!response.ok) {
      const body = this.devMode ? await response.clone().text() : '';
      debugLog(this.devMode, `[BLOCKCHAIN_DOT_COM] ${response.status} body: ${body}`);
      throw new Error(`Blockchain.com returned ${response.status}.`);
    }

    const data = (await response.json()) as BlockchainDotComResponse;
    if (!data.addresses || !Array.isArray(data.addresses)) {
      throw new Error('Invalid Blockchain.com response: missing addresses[].');
    }
    if (data.addresses.length !== addresses.length) {
      throw new Error(
        `Blockchain.com returned ${data.addresses.length} addresses, expected ${addresses.length}.`,
      );
    }

    // CRITICAL: `/multiaddr` does NOT guarantee response order matches
    // the request order — empirically the API often re-orders the
    // `addresses[]` array (sometimes by recent activity, sometimes
    // alphabetically). Index-based mapping silently misattributes
    // balances to the wrong slots, which corrupts every downstream
    // step (the wallet's "active address" filter ends up flagging the
    // wrong slot, the next-receive-index walker bumps past addresses
    // that were never used, and `/txs` calls hit the wrong addresses).
    //
    // Build a lookup by the `address` field on each response row, then
    // walk the input list to produce a strictly index-aligned result.
    // The input/output sizes still have to match (already checked
    // above), so a missing input address in the response is treated
    // as an error rather than silently inserted as a zero balance.
    const byAddress = new Map<string, BlockchainDotComResponse['addresses'][number]>();
    for (const entry of data.addresses) byAddress.set(entry.address, entry);

    return addresses.map((addr) => {
      const entry = byAddress.get(addr);
      if (!entry) {
        throw new Error(`Blockchain.com response missing entry for address ${addr}.`);
      }
      return mapBlockchainDotCom(entry);
    });
  }

  async fetchUtxos(addresses: readonly string[]): Promise<AddressUtxos[]> {
    // `/unspent?active=<pipe-separated>` is technically a batch
    // endpoint, but its response is one flat list with each UTXO
    // carrying the raw locking script and no address. Mapping a
    // P2WSH script back to its bech32 address would require
    // re-hashing the witness script per cosigner key. We side-step
    // that by issuing one request per address (still served by the
    // same `/unspent` endpoint), which keeps the address bucket
    // trivially attached. With at most a couple of dozen addresses
    // per refresh the round-trip cost is small compared to carrying
    // the address mapping through the rest of the pipeline.
    return pMap(addresses, this.concurrency, async (address) => {
      let url = `${this.baseUrl}/unspent?active=${address}`;
      if (this.apiKey) url += `&api_key=${this.apiKey}`;

      const response = await this.fetchOk(url);
      // 500 is what `/unspent` returns when the address has no
      // UTXOs ("No free outputs to spend"). Treat as an empty
      // bucket rather than as an error.
      if (response.status === 500) return { address, utxos: [] };
      if (!response.ok) {
        const body = this.devMode ? await response.clone().text() : '';
        debugLog(this.devMode, `[BLOCKCHAIN_DOT_COM] ${response.status} body: ${body}`);
        throw new Error(`Blockchain.com /unspent returned ${response.status}.`);
      }

      const data = (await response.json()) as BlockchainDotComUnspentResponse;
      if (!data.unspent_outputs || !Array.isArray(data.unspent_outputs)) {
        throw new Error(
          'Invalid Blockchain.com /unspent response: missing unspent_outputs[].',
        );
      }
      return {
        address,
        utxos: data.unspent_outputs.map((u) => mapBlockchainDotComUnspent(address, u)),
      };
    });
  }

  /**
   * Fetch BTC → fiat rates for the requested ISO 4217 currency codes
   * via `GET https://blockchain.info/ticker`. The endpoint returns
   * roughly thirty currencies in a single round trip; the mapper
   * projects the response down to the requested set and reads each
   * `last` field as the canonical spot price.
   *
   * Throws when none of the requested currencies are present in the
   * response so the service walker rotates to the next provider
   * instead of returning an empty `rates` map a downstream
   * `pickRate` would silently treat as zero.
   */
  async fetchFiatRates(
    currencies: readonly string[],
  ): Promise<FiatRatesSnapshot> {
    let url = `${this.baseUrl}/ticker`;
    if (this.apiKey) url += `?api_key=${this.apiKey}`;
    const response = await this.fetchOk(url);
    if (!response.ok) {
      const body = this.devMode ? await response.clone().text() : '';
      debugLog(this.devMode, `[BLOCKCHAIN_DOT_COM] ${response.status} body: ${body}`);
      throw new Error(`Blockchain.com /ticker returned ${response.status}.`);
    }
    const raw = (await response.json()) as BlockchainDotComTickerResponse;
    const rates = mapBlockchainDotComTicker(raw, currencies);
    if (Object.keys(rates).length === 0) {
      throw new Error(
        `Blockchain.com /ticker returned no rates for the requested currencies: ${currencies.join(', ')}`,
      );
    }
    return {
      source: ProviderId.BLOCKCHAIN_DOT_COM,
      rates,
      // The endpoint does not expose a server-side timestamp, so the
      // fetch wall-clock is the closest honest approximation.
      fetchedAt: new Date().toISOString(),
    };
  }

  /**
   * Submit a fully-signed raw transaction through Blockchain.com's
   * `/pushtx` endpoint. The wire shape diverges from Esplora:
   * form-urlencoded `tx=<hex>` body, free-form success line.
   *
   * Returns an empty string because the provider does not echo a
   * structured txid; the service façade fills in the missing value
   * from the caller-supplied canonical txid.
   */
  async broadcastTransaction(rawTxHex: string): Promise<string> {
    const url = `${this.baseUrl}/pushtx`;
    const params = new URLSearchParams();
    params.set('tx', rawTxHex);
    if (this.apiKey) params.set('api_key', this.apiKey);

    const response = await this.fetchOk(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(
        `Blockchain.com /pushtx returned ${response.status}: ${body.trim() || 'no body'}`,
      );
    }
    // Empty string is intentional — see the JSDoc above.
    return '';
  }
}
