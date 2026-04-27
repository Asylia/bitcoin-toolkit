/**
 * Blockcypher provider.
 *
 * Talks to `https://api.blockcypher.com/v1/btc/main`. Free anonymous
 * tier is documented as 3 req/s and 100 req/h; passing a free `token`
 * raises that ceiling. The provider runs in the browser without
 * credentials by default.
 *
 * Why include this on top of the Esplora providers:
 *
 *   - **Distinct infrastructure.** When every Esplora deployment has
 *     a bad day at once (the operators pull a coordinated upgrade,
 *     a CDN incident hits them all), Blockcypher is on completely
 *     unrelated hardware and is unaffected.
 *   - **Clean confirmed/pending split.** `balance` + `unconfirmed_balance`
 *     map onto our canonical shape without the Blockchain.com
 *     mempool-collapsed caveat.
 *   - **Per-address tx history.** `/addrs/{address}/full` returns up
 *     to 50 transactions per call with input + output addresses
 *     decoded server-side, so we do not have to script-decode locally.
 *
 * Every HTTP call goes through the per-provider {@link ProviderThrottle}
 * (injected via {@link Provider.bindThrottle}) so the SDK never
 * fans out N parallel requests just because a multi-address walker
 * had N addresses to fetch.
 */
import type { ProviderThrottle } from '../rate-limiter';
import type {
  AddressTransactions,
  AddressUtxos,
  NormalizedAddressBalance,
  NormalizedTransaction,
  NormalizedUtxo,
  ProviderRole,
} from '../types';
import { ProviderRateLimitError } from '../types';
import {
  type BlockcypherAddressFullResponse,
  type BlockcypherAddressResponse,
  type BlockcypherBalanceResponse,
  mapBlockcypherBalance,
  mapBlockcypherTransaction,
  mapBlockcypherUtxo,
} from '../mappers/blockcypher';
import { pMap, parseRetryAfterMs } from '../utils';
import { debugLog } from '../log';
import type { Provider } from './base';

export interface BlockcypherProviderConfig {
  /** Optional Blockcypher API token. Lifts the anonymous rate ceiling. */
  token?: string;
  /**
   * Bounded concurrency ceiling for multi-address fanouts. Defaults
   * to `1` so the gate's own concurrency cap is the source of truth
   * — combined they guarantee we never burst even on the free tier.
   */
  concurrency?: number;
  /** When `true` the provider logs every request URL. */
  devMode?: boolean;
  /** Throttle deadline per HTTP call. Defaults to `4000` ms. */
  throttleWaitMs?: number;
}

export class BlockcypherProvider implements Provider {
  readonly roles: readonly ProviderRole[] = [
    'read-balance',
    'read-utxos',
    'read-txs',
    'read-tip',
    'broadcast',
  ];

  private readonly baseUrl = 'https://api.blockcypher.com/v1/btc/main';
  private readonly token: string | undefined;
  private readonly concurrency: number;
  private readonly devMode: boolean;
  private readonly throttleWaitMs: number;
  private throttle: ProviderThrottle | null = null;

  constructor(config: BlockcypherProviderConfig = {}) {
    this.token = config.token;
    this.concurrency = config.concurrency ?? 1;
    this.devMode = config.devMode ?? false;
    this.throttleWaitMs = config.throttleWaitMs ?? 4_000;
  }

  bindThrottle(throttle: ProviderThrottle): void {
    this.throttle = throttle;
  }

  /**
   * Append the optional `token` query string to a URL. Blockcypher
   * uses query-string auth rather than a header, so every endpoint
   * has to thread the parameter through.
   */
  private withToken(url: string): string {
    if (!this.token) return url;
    return url + (url.includes('?') ? '&' : '?') + `token=${this.token}`;
  }

  private async fetchOk(url: string, init?: RequestInit): Promise<Response> {
    if (this.throttle) {
      const ok = await this.throttle.acquire(this.throttleWaitMs);
      if (!ok) {
        throw new ProviderRateLimitError(
          `Blockcypher throttle: no permit within ${this.throttleWaitMs}ms.`,
          0,
        );
      }
    }
    try {
      const finalUrl = this.withToken(url);
      debugLog(this.devMode, `[BLOCKCYPHER] ${init?.method ?? 'GET'} ${finalUrl}`);
      const response = await fetch(finalUrl, init);
      if (response.status === 429 || response.status === 403) {
        const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
        if (this.throttle) this.throttle.tripCooldown(retryAfterMs ?? undefined);
        throw new ProviderRateLimitError(
          `Blockcypher returned ${response.status} (rate-limited).`,
          retryAfterMs ?? 0,
        );
      }
      if (!response.ok) {
        const body = this.devMode ? await response.clone().text() : '';
        debugLog(this.devMode, `[BLOCKCYPHER] ${response.status} body: ${body}`);
        throw new Error(`Blockcypher returned ${response.status}.`);
      }
      return response;
    } finally {
      this.throttle?.release();
    }
  }

  async fetchSingle(address: string): Promise<NormalizedAddressBalance> {
    const response = await this.fetchOk(`${this.baseUrl}/addrs/${address}/balance`);
    const data = (await response.json()) as BlockcypherBalanceResponse;
    if (!data.address) {
      throw new Error('Invalid Blockcypher /balance response: missing address.');
    }
    return mapBlockcypherBalance(data);
  }

  async fetchMulti(
    addresses: readonly string[],
  ): Promise<NormalizedAddressBalance[]> {
    return pMap(addresses, this.concurrency, (a) => this.fetchSingle(a));
  }

  async fetchUtxos(addresses: readonly string[]): Promise<AddressUtxos[]> {
    return pMap(addresses, this.concurrency, async (address) => {
      const response = await this.fetchOk(
        `${this.baseUrl}/addrs/${address}?unspentOnly=true&includeScript=false`,
      );
      const data = (await response.json()) as BlockcypherAddressResponse;
      const confirmed = (data.txrefs ?? []).map((ref) => mapBlockcypherUtxo(address, ref, false));
      const pending = (data.unconfirmed_txrefs ?? []).map((ref) =>
        mapBlockcypherUtxo(address, ref, true),
      );
      const utxos: NormalizedUtxo[] = [...confirmed, ...pending];
      return { address, utxos };
    });
  }

  async fetchTransactions(
    addresses: readonly string[],
  ): Promise<AddressTransactions[]> {
    return pMap(addresses, this.concurrency, async (address) => {
      const response = await this.fetchOk(
        `${this.baseUrl}/addrs/${address}/full?limit=50`,
      );
      const data = (await response.json()) as BlockcypherAddressFullResponse;
      const txs: NormalizedTransaction[] = (data.txs ?? []).map(mapBlockcypherTransaction);
      return { address, transactions: txs };
    });
  }

  async fetchTipHeight(): Promise<number> {
    const response = await this.fetchOk(`${this.baseUrl}`);
    const data = (await response.json()) as { height?: number };
    if (typeof data.height !== 'number' || !Number.isFinite(data.height)) {
      throw new Error('Invalid Blockcypher tip-height response: missing height.');
    }
    return data.height;
  }

  /**
   * Submit a fully-signed raw transaction through Blockcypher's
   * `POST /txs/push` endpoint. Body is a JSON object `{ tx: <hex> }`;
   * response contains a `tx.hash` field with the network txid.
   */
  async broadcastTransaction(rawTxHex: string): Promise<string> {
    const response = await this.fetchOk(`${this.baseUrl}/txs/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tx: rawTxHex }),
    });
    const data = (await response.json()) as { tx?: { hash?: string } };
    const txid = data.tx?.hash;
    if (!txid || !/^[0-9a-f]{64}$/i.test(txid)) {
      throw new Error(
        `Blockcypher /txs/push replied without a txid: ${JSON.stringify(data).slice(0, 200)}`,
      );
    }
    return txid;
  }
}
