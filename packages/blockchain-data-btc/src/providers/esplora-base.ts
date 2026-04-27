/**
 * Shared HTTP transport for every Esplora-shaped provider
 * (Blockstream.info, Mempool.space, and the community mirrors). They
 * all expose the same `/api/address/...` surface so the only
 * difference between concrete implementations is the `baseUrl` and
 * which auth header (if any) gets attached.
 *
 * Centralising the transport here keeps the provider files thin —
 * they end up declaring "what URL", "what auth", and the runtime does
 * the rest including:
 *
 *   - **Throttling.** Every HTTP call goes through the
 *     {@link ProviderThrottle} the service injects via
 *     {@link Provider.bindThrottle}. The gate enforces the
 *     per-provider min-interval, concurrency cap, sliding window,
 *     and explicit cooldown — the SDK can never burst N parallel
 *     requests to the same upstream just because a multi-address
 *     walker had N addresses to fetch.
 *   - **429 / 403 detection.** The class throws
 *     {@link ProviderRateLimitError} so the throttle trips an
 *     explicit cooldown instead of just counting the failure as a
 *     generic error, AND the service walker rotates to the next
 *     provider for follow-up calls.
 *   - **`Retry-After` parsing.** Honoured by the throttle when
 *     present.
 *   - **Bounded-concurrency fanout** for multi-address calls. The
 *     concurrency knob still exists for callers that want to dial it
 *     up when a paid tier raises the burst cap, but the default is
 *     `1` (sequential) so a fresh wallet without paid credentials
 *     never accidentally floods a public upstream.
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
  type EsploraAddressResponse,
  type EsploraTransaction,
  type EsploraUtxo,
  mapEsploraAddress,
  mapEsploraTransaction,
  mapEsploraUtxo,
} from '../mappers/esplora';
import { pMap, parseRetryAfterMs } from '../utils';
import { debugLog } from '../log';
import type { Provider } from './base';

/**
 * Construction-time configuration shared by every Esplora-shaped
 * provider. Concrete implementations pre-fill the immutable bits
 * (`baseUrl`, `displayName`) and forward the configurable bits
 * (`headers`, `devMode`) from their own constructors.
 */
export interface EsploraProviderConfig {
  /** Base URL with no trailing slash. Example: `https://mempool.space/api`. */
  readonly baseUrl: string;
  /**
   * Human-friendly tag for log messages. Convention is to match the
   * `ProviderId` enum value for the implementation that wraps this
   * base, so log lines such as `[BLOCKSTREAM_INFO] GET ...` line up
   * with the `provider` field in dev-mode responses.
   */
  readonly displayName: string;
  /**
   * Bounded concurrency ceiling for the in-process fanout step of
   * multi-address calls. Defaults to `1` (sequential) — combined
   * with the per-provider gate's own `maxConcurrent` cap this is
   * deliberately low so the SDK never bursts even if the consumer
   * asks for a wide window. Lift it only when a paid tier raises
   * the upstream's burst budget.
   */
  readonly concurrency?: number;
  /** Extra HTTP headers attached to every request (e.g. auth). */
  readonly headers?: Record<string, string>;
  /** Log every outgoing request URL when `true`. */
  readonly devMode?: boolean;
  /**
   * How long an HTTP call waits for a permit from the throttle
   * before bailing with `ProviderRateLimitError`. The service walker
   * catches the error and rotates to the next provider, so a long
   * deadline pessimises the user's perceived latency. Defaults to
   * `4000` ms — enough to absorb a normal min-interval wait without
   * giving up too early on a healthy provider.
   */
  readonly throttleWaitMs?: number;
}

/**
 * Concrete Esplora-shaped provider. Used directly via subclassing or
 * by the generic mirror provider that just hands in a different
 * `baseUrl`.
 */
export class EsploraBaseProvider implements Provider {
  /** Esplora supports every read role and broadcast. */
  readonly roles: readonly ProviderRole[] = [
    'read-balance',
    'read-utxos',
    'read-txs',
    'read-tip',
    'read-raw-tx',
    'broadcast',
  ];

  protected readonly baseUrl: string;
  protected readonly displayName: string;
  protected readonly concurrency: number;
  protected readonly headers: Record<string, string>;
  protected readonly devMode: boolean;
  protected readonly throttleWaitMs: number;
  protected throttle: ProviderThrottle | null = null;

  constructor(config: EsploraProviderConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.displayName = config.displayName;
    this.concurrency = config.concurrency ?? 1;
    this.headers = config.headers ?? {};
    this.devMode = config.devMode ?? false;
    this.throttleWaitMs = config.throttleWaitMs ?? 4_000;
  }

  bindThrottle(throttle: ProviderThrottle): void {
    this.throttle = throttle;
  }

  /**
   * One Esplora HTTP call, fully wrapped in the per-provider
   * throttle. Throws {@link ProviderRateLimitError} on:
   *
   *   - the throttle deadline elapsing without a permit, or
   *   - an explicit quota response (429, or 403 with `Retry-After`).
   *
   * Other non-OK statuses bubble as plain `Error` so the service
   * walks to the next provider without tripping a long cooldown on
   * this one.
   */
  protected async request(path: string, init?: RequestInit): Promise<Response> {
    if (this.throttle) {
      const ok = await this.throttle.acquire(this.throttleWaitMs);
      if (!ok) {
        // Failed to obtain a permit within the deadline. Treat the
        // same as an explicit rate-limit response so the service
        // skips to the next provider — but do *not* trip an
        // additional cooldown, because the gate already knows we
        // are over budget.
        throw new ProviderRateLimitError(
          `${this.displayName} throttle: no permit within ${this.throttleWaitMs}ms.`,
          0,
        );
      }
    }

    try {
      const url = `${this.baseUrl}${path}`;
      debugLog(this.devMode, `[${this.displayName}] ${init?.method ?? 'GET'} ${url}`);

      const response = await fetch(url, {
        ...init,
        headers: { ...this.headers, ...(init?.headers ?? {}) },
      });

      if (response.status === 429 || response.status === 403) {
        const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
        if (this.throttle) this.throttle.tripCooldown(retryAfterMs ?? undefined);
        throw new ProviderRateLimitError(
          `${this.displayName} returned ${response.status} (rate-limited).`,
          retryAfterMs ?? 0,
        );
      }
      if (!response.ok) {
        const body = this.devMode ? await response.clone().text() : '';
        debugLog(this.devMode, `[${this.displayName}] ${response.status} body: ${body}`);
        throw new Error(`${this.displayName} returned ${response.status}.`);
      }
      return response;
    } finally {
      this.throttle?.release();
    }
  }

  async fetchSingle(address: string): Promise<NormalizedAddressBalance> {
    const response = await this.request(`/address/${address}`);
    const data = (await response.json()) as EsploraAddressResponse;
    if (!data.chain_stats) {
      throw new Error(`Invalid ${this.displayName} response: missing chain_stats.`);
    }
    return mapEsploraAddress(data);
  }

  async fetchMulti(
    addresses: readonly string[],
  ): Promise<NormalizedAddressBalance[]> {
    return pMap(addresses, this.concurrency, (a) => this.fetchSingle(a));
  }

  async fetchUtxos(
    addresses: readonly string[],
  ): Promise<AddressUtxos[]> {
    return pMap(addresses, this.concurrency, async (address) => {
      const response = await this.request(`/address/${address}/utxo`);
      const raw = (await response.json()) as EsploraUtxo[];
      if (!Array.isArray(raw)) {
        throw new Error(
          `Invalid ${this.displayName} /utxo response: not an array.`,
        );
      }
      const utxos: NormalizedUtxo[] = raw.map((entry) => mapEsploraUtxo(address, entry));
      return { address, utxos };
    });
  }

  async fetchTransactions(
    addresses: readonly string[],
  ): Promise<AddressTransactions[]> {
    return pMap(addresses, this.concurrency, async (address) => {
      const response = await this.request(`/address/${address}/txs`);
      const raw = (await response.json()) as EsploraTransaction[];
      if (!Array.isArray(raw)) {
        throw new Error(
          `Invalid ${this.displayName} /txs response: not an array.`,
        );
      }
      const transactions: NormalizedTransaction[] = raw.map(mapEsploraTransaction);
      return { address, transactions };
    });
  }

  async fetchTipHeight(): Promise<number> {
    const response = await this.request('/blocks/tip/height');
    const text = (await response.text()).trim();
    const height = Number(text);
    if (!Number.isFinite(height) || height < 0) {
      throw new Error(`Invalid ${this.displayName} tip-height response: ${text}.`);
    }
    return height;
  }

  /**
   * Fetch the full funding transaction so PSBT builders can attach
   * `nonWitnessUtxo` for hardware wallets that refuse to fully trust a
   * standalone `witnessUtxo` amount/script pair.
   */
  async fetchRawTransaction(txid: string): Promise<string> {
    const response = await this.request(`/tx/${txid}/hex`);
    const body = (await response.text()).trim().toLowerCase();
    if (!/^[0-9a-f]+$/.test(body) || body.length % 2 !== 0) {
      throw new Error(
        `${this.displayName} /tx/${txid}/hex returned non-hex payload: ${body.slice(0, 120)}`,
      );
    }
    return body;
  }

  /**
   * Submit a fully-signed raw transaction through Esplora's
   * `POST /tx` endpoint. The body is raw transaction hex
   * (lower-case, no `0x` prefix); on success the provider returns
   * the network txid as plain text.
   */
  async broadcastTransaction(rawTxHex: string): Promise<string> {
    const response = await this.request('/tx', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: rawTxHex,
    });
    const body = (await response.text()).trim();
    if (!/^[0-9a-f]{64}$/i.test(body)) {
      throw new Error(
        `${this.displayName} /tx replied with a non-txid payload: ${body.slice(0, 120)}`,
      );
    }
    return body;
  }
}
