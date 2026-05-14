/**
 * Edge fallback provider.
 *
 * Runtime-agnostic provider that forwards chain-data calls to a
 * server-side endpoint holding the paid Blockstream API key. Consumers
 * choose where it sits in their priority list: the package default
 * keeps it as a last-resort fallback, while the wallet can promote it
 * to the primary path when a paid plan is configured.
 *
 * Zero coupling to any specific runtime: the caller passes an
 * `invoke({ op, args })` callback at construction time. The wallet
 * binds it to `supabase.functions.invoke('btc-chain-fallback', { body
 * })`; a Node tester binds it to a local mock; a future Capacitor
 * shell can bind it to a Tauri command. The provider does not import
 * `@supabase/supabase-js`, `node:http`, or anything else opinionated.
 */
import type { ProviderThrottle } from '../rate-limiter';
import type {
  AddressTransactions,
  AddressUtxos,
  FiatRatesSnapshot,
  NormalizedAddressBalance,
  NormalizedTransaction,
  NormalizedUtxo,
  ProviderRole,
} from '../types';
import { ProviderConfigurationError, ProviderRateLimitError } from '../types';
import { debugLog } from '../log';
import type { Provider } from './base';

/**
 * Discriminated wire shape passed to the consumer-supplied
 * {@link EdgeFallbackProviderConfig.invoke} callback. Every
 * chain-data role has an explicit op so the server side can route
 * each one to the right Blockstream path without parsing args.
 */
export type EdgeFallbackOp =
  | { op: 'balance'; addresses: string[] }
  | { op: 'utxos'; addresses: string[] }
  | { op: 'txs'; addresses: string[] }
  | { op: 'tip' }
  | { op: 'raw-tx'; txid: string }
  | { op: 'fiat-rates'; currencies: string[] }
  | { op: 'broadcast'; rawTxHex: string };

/** Response envelope shape per op. */
export type EdgeFallbackResponse =
  | { op: 'balance'; balances: NormalizedAddressBalance[] }
  | { op: 'utxos'; results: AddressUtxos[] }
  | { op: 'txs'; results: AddressTransactions[] }
  | { op: 'tip'; height: number }
  | { op: 'raw-tx'; txid: string; rawTxHex: string }
  | { op: 'fiat-rates'; snapshot: FiatRatesSnapshot }
  | { op: 'broadcast'; txid: string };

/**
 * Outcome the consumer's invoke callback returns. Mirrors the shape
 * of `supabase.functions.invoke()` so wiring the SPA up is one line.
 *
 * On a successful call: `{ data, error: null }`.
 * On a rate-limited backend (HTTP 429 from the proxy): set
 * `error.status === 429` so this provider can rethrow as
 * {@link ProviderRateLimitError} and the service trips a cooldown.
 */
export type EdgeFallbackInvokeResult = {
  data: EdgeFallbackResponse | null;
  error: { message: string; status?: number; retryAfterMs?: number } | null;
};

/** Construction-time configuration. */
export interface EdgeFallbackProviderConfig {
  /**
   * Forward one operation to the server side. The promise must
   * resolve to {@link EdgeFallbackInvokeResult}; rejecting is also
   * supported but the rejection's message is the only thing the
   * service can surface to the user.
   */
  invoke(payload: EdgeFallbackOp): Promise<EdgeFallbackInvokeResult>;
  /**
   * Set of capabilities the underlying server endpoint actually
   * implements. Defaults to "everything" — override to opt out of an
   * op (e.g. when the server only proxies balance + tip and broadcast
   * goes elsewhere). Skipping a role keeps that op out of the
   * failover walk for this provider.
   */
  roles?: readonly ProviderRole[];
  /** When `true` log every dispatch. */
  devMode?: boolean;
  /** Throttle deadline per dispatch. Defaults to `5000` ms. */
  throttleWaitMs?: number;
}

const DEFAULT_ROLES: readonly ProviderRole[] = [
  'read-balance',
  'read-utxos',
  'read-txs',
  'read-tip',
  'read-raw-tx',
  'broadcast',
];

export class EdgeFallbackProvider implements Provider {
  readonly roles: readonly ProviderRole[];

  private readonly invoke: EdgeFallbackProviderConfig['invoke'];
  private readonly devMode: boolean;
  private readonly throttleWaitMs: number;
  private throttle: ProviderThrottle | null = null;

  constructor(config: EdgeFallbackProviderConfig) {
    this.invoke = config.invoke;
    this.roles = config.roles ?? DEFAULT_ROLES;
    this.devMode = config.devMode ?? false;
    this.throttleWaitMs = config.throttleWaitMs ?? 5_000;
  }

  bindThrottle(throttle: ProviderThrottle): void {
    this.throttle = throttle;
  }

  /**
   * Issue a single op against the server endpoint and translate its
   * envelope into a runtime exception when the upstream signalled
   * rate-limiting. Other errors bubble as plain `Error`.
   *
   * Wrapped in the per-provider throttle so the SDK never bursts at
   * the paid Blockstream tier — the gate's `minIntervalMs` keeps the
   * outgoing rate well under the upstream's burst limiter.
   */
  private async dispatch<T extends EdgeFallbackResponse>(payload: EdgeFallbackOp): Promise<T> {
    if (this.throttle) {
      const ok = await this.throttle.acquire(this.throttleWaitMs);
      if (!ok) {
        throw new ProviderRateLimitError(
          `Edge fallback throttle: no permit within ${this.throttleWaitMs}ms.`,
          0,
        );
      }
    }
    try {
      debugLog(this.devMode, `[EDGE_FALLBACK] dispatch ${payload.op}`);
      let result: EdgeFallbackInvokeResult;
      try {
        result = await this.invoke(payload);
      } catch (cause) {
        throw cause instanceof Error
          ? cause
          : new Error(`Edge fallback invocation failed: ${String(cause)}`);
      }

      if (result.error) {
        if (result.error.status === 429) {
          if (this.throttle) this.throttle.tripCooldown(result.error.retryAfterMs);
          throw new ProviderRateLimitError(
            result.error.message,
            result.error.retryAfterMs ?? 0,
          );
        }
        if (result.error.status === 403) {
          throw new ProviderConfigurationError(result.error.message, 403);
        }
        throw new Error(result.error.message);
      }
      if (!result.data || result.data.op !== payload.op) {
        throw new Error(
          `Edge fallback returned an unexpected envelope (expected op=${payload.op}).`,
        );
      }
      return result.data as T;
    } finally {
      this.throttle?.release();
    }
  }

  async fetchSingle(address: string): Promise<NormalizedAddressBalance> {
    const result = await this.dispatch<Extract<EdgeFallbackResponse, { op: 'balance' }>>({
      op: 'balance',
      addresses: [address],
    });
    const single = result.balances[0];
    if (!single) throw new Error('Edge fallback returned no balance for address.');
    return single;
  }

  async fetchMulti(
    addresses: readonly string[],
  ): Promise<NormalizedAddressBalance[]> {
    const result = await this.dispatch<Extract<EdgeFallbackResponse, { op: 'balance' }>>({
      op: 'balance',
      addresses: [...addresses],
    });
    if (result.balances.length !== addresses.length) {
      throw new Error(
        `Edge fallback returned ${result.balances.length} balances, expected ${addresses.length}.`,
      );
    }
    return result.balances;
  }

  async fetchUtxos(addresses: readonly string[]): Promise<AddressUtxos[]> {
    const result = await this.dispatch<Extract<EdgeFallbackResponse, { op: 'utxos' }>>({
      op: 'utxos',
      addresses: [...addresses],
    });
    if (result.results.length !== addresses.length) {
      throw new Error(
        `Edge fallback returned UTXO buckets for ${result.results.length} addresses, expected ${addresses.length}.`,
      );
    }
    // Re-attach the address field on each utxo just in case the
    // server emitted them without it (defensive — the proxy fills it
    // in, but normalising here lets the package own the contract).
    return alignBucketsByAddress(addresses, result.results, 'UTXO').map((bucket) => {
      const address = bucket.address;
      const utxos: NormalizedUtxo[] = bucket.utxos.map((u) => ({ ...u, address }));
      return { address, utxos };
    });
  }

  async fetchTransactions(
    addresses: readonly string[],
  ): Promise<AddressTransactions[]> {
    const result = await this.dispatch<Extract<EdgeFallbackResponse, { op: 'txs' }>>({
      op: 'txs',
      addresses: [...addresses],
    });
    if (result.results.length !== addresses.length) {
      throw new Error(
        `Edge fallback returned tx buckets for ${result.results.length} addresses, expected ${addresses.length}.`,
      );
    }
    return alignBucketsByAddress(addresses, result.results, 'tx').map((bucket) => {
      const address = bucket.address;
      const transactions: NormalizedTransaction[] = bucket.transactions;
      return { address, transactions };
    });
  }

  async fetchTipHeight(): Promise<number> {
    const result = await this.dispatch<Extract<EdgeFallbackResponse, { op: 'tip' }>>({ op: 'tip' });
    if (typeof result.height !== 'number' || !Number.isFinite(result.height)) {
      throw new Error('Edge fallback returned an invalid tip height.');
    }
    return result.height;
  }

  async fetchRawTransaction(txid: string): Promise<string> {
    const result = await this.dispatch<Extract<EdgeFallbackResponse, { op: 'raw-tx' }>>({
      op: 'raw-tx',
      txid,
    });
    if (result.txid.toLowerCase() !== txid.toLowerCase()) {
      throw new Error(`Edge fallback returned raw tx for ${result.txid}, expected ${txid}.`);
    }
    return result.rawTxHex;
  }

  async fetchFiatRates(
    currencies: readonly string[],
  ): Promise<FiatRatesSnapshot> {
    const result = await this.dispatch<
      Extract<EdgeFallbackResponse, { op: 'fiat-rates' }>
    >({ op: 'fiat-rates', currencies: [...currencies] });
    const snapshot = result.snapshot;
    if (
      !snapshot
      || typeof snapshot !== 'object'
      || !snapshot.rates
      || typeof snapshot.rates !== 'object'
      || Object.keys(snapshot.rates).length === 0
    ) {
      throw new Error('Edge fallback returned an empty fiat rates snapshot.');
    }
    return snapshot;
  }

  async broadcastTransaction(rawTxHex: string): Promise<string> {
    const result = await this.dispatch<Extract<EdgeFallbackResponse, { op: 'broadcast' }>>({
      op: 'broadcast',
      rawTxHex,
    });
    if (!/^[0-9a-f]{64}$/i.test(result.txid)) {
      throw new Error(`Edge fallback returned a non-txid: ${result.txid.slice(0, 120)}`);
    }
    return result.txid;
  }
}

function alignBucketsByAddress<T extends { address: string }>(
  addresses: readonly string[],
  buckets: readonly T[],
  label: string,
): T[] {
  const byAddress = new Map<string, T>();
  for (const bucket of buckets) {
    if (byAddress.has(bucket.address)) {
      throw new Error(`Edge fallback returned duplicate ${label} bucket for ${bucket.address}.`);
    }
    byAddress.set(bucket.address, bucket);
  }
  return addresses.map((address) => {
    const bucket = byAddress.get(address);
    if (!bucket) {
      throw new Error(`Edge fallback returned no ${label} bucket for ${address}.`);
    }
    return bucket;
  });
}
