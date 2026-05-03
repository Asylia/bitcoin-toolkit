<p align="center">
  <img src="../../apps/wallet/resources/logo.svg" alt="Asylia" width="96" />
</p>

# @asylia/blockchain-data-btc

Normalized Bitcoin chain-data and market-data SDK for the Asylia self-custody
platform. One `BlockchainDataService` fronts multiple upstream providers and
returns stable TypeScript shapes for balances, UTXOs, transactions, raw funding
transactions, fiat rates, block height, and broadcast results.

The package is runtime-light and framework-agnostic. It is designed to run in
browsers, Deno/Supabase Edge Functions, and Node 18+ using Web `fetch` APIs.

Keywords: Bitcoin chain data, Mempool.space, Blockstream, Esplora, Blockchain.com,
Blockcypher, UTXO API, Bitcoin broadcast, fiat rates, rate limiting, failover,
request deduplication, TypeScript wallet SDK.

## Maintainer And Support

`@asylia/blockchain-data-btc` is maintained by
[Asylian21](https://github.com/Asylian21).

> **Support Asylia Bitcoin tooling**
>
> If this work helps your wallet, audit, integration, or research, you can
> support ongoing development with a Bitcoin donation:
> `bc1qrdchup8497xz0972v35q4nr0fx5egghf0z23c3`

## Status

`0.1.0`. The package ships the active Asylia chain-data provider stack. The
public API can still change while the toolkit is in the `0.x` release line.

## Installation

```bash
npm install @asylia/blockchain-data-btc
```

## Why This Package Exists

Wallet code should not care which upstream answered a chain-data request. It
needs a deterministic API that:

- returns the same response shape across providers,
- survives outages and rate limits by rotating through a priority list,
- cools down providers that return 429/403 responses,
- coalesces identical concurrent requests,
- avoids duplicate provider spend during manual refreshes,
- can be reused from the browser, server-side fallbacks, tests, and future
  mobile tooling.

## Provider Architecture

The Asylia wallet can read chain data directly from the browser and escalate to
a caller-owned edge fallback only when needed:

```text
BlockchainDataService
├─ MempoolSpaceProvider          read, raw tx, broadcast
├─ BlockstreamInfoProvider       read, raw tx, broadcast
├─ EsploraMirrorProvider         read, raw tx, broadcast
├─ BlockchainDotComProvider      balance, UTXO, broadcast
├─ BlockcypherProvider           balance, UTXO, txs, tip, broadcast
├─ CoinbaseProvider              fiat BTC rates
├─ CoinGeckoProvider             fiat BTC rates
├─ KrakenProvider                fiat BTC rates
└─ EdgeFallbackProvider          caller-supplied server/edge escape hatch
```

`EdgeFallbackProvider` accepts an `invoke({ op, args })` callback. That keeps the
SDK free of Supabase, Vercel, HTTP route, or RPC assumptions while still letting
the wallet call a server-side endpoint that owns paid provider credentials.

## Privacy Note

When used directly in a browser, the upstream provider that answers a request
can see the user's IP address and the queried addresses. Asylia accepts this for
the default web wallet because it improves latency, keeps the app static, and
lets several public providers absorb normal load. Operators with stricter
address-set privacy requirements should run their own Esplora endpoint behind a
privacy gateway and register it through `EsploraMirrorProvider` or an edge
fallback.

## Quick Start

```ts
import {
  BlockchainDataService,
  BlockcypherProvider,
  BlockchainDotComProvider,
  BlockstreamInfoProvider,
  EdgeFallbackProvider,
  EsploraMirrorProvider,
  MempoolSpaceProvider,
  ProviderId,
} from '@asylia/blockchain-data-btc';

const chainData = new BlockchainDataService({
  providers: {
    [ProviderId.MEMPOOL_SPACE]: new MempoolSpaceProvider(),
    [ProviderId.BLOCKSTREAM_INFO]: new BlockstreamInfoProvider(),
    [ProviderId.MEMPOOL_EMZY]: new EsploraMirrorProvider({
      baseUrl: 'https://mempool.emzy.de/api',
      displayName: 'MEMPOOL_EMZY',
    }),
    [ProviderId.BLOCKCHAIN_DOT_COM]: new BlockchainDotComProvider(),
    [ProviderId.BLOCKCYPHER]: new BlockcypherProvider(),
    [ProviderId.EDGE_FALLBACK]: new EdgeFallbackProvider({
      invoke: (payload) => callMyServerSideFallback(payload),
    }),
  },
  devMode: true,
});

const balance = await chainData.getSingle('bc1q...');
const multi = await chainData.getMulti(['bc1q...', 'bc1q...']);
const utxos = await chainData.getUtxos(['bc1q...']);
const transactions = await chainData.getTransactions(['bc1q...']);
const rawFundingTx = await chainData.getRawTransaction('f'.repeat(64));
const tip = await chainData.getTipHeight();
const broadcast = await chainData.broadcastTransaction(rawTxHex, expectedTxid);
```

`balance_sats` is confirmed balance. `pending_sats` is net unconfirmed inflow
clamped at zero when the provider can expose it cleanly.

## Public API

| Export | Purpose |
| --- | --- |
| `BlockchainDataService` | Main facade. Construct once per tab/process. |
| `ProviderId` | Stable provider identifiers used in config, logging, and dev info. |
| `ProviderRole` | Capability tags such as read balance, UTXO, raw tx, broadcast, fiat, or tip. |
| `ProviderRateLimitError` | Marker error used to trip provider cooldowns. |
| `NormalizedAddressBalance`, `NormalizedUtxo`, `NormalizedTransaction` | Canonical chain-data shapes returned across providers. |
| `SingleAddressResponse`, `MultiAddressResponse`, `MultiAddressUtxosResponse`, `MultiAddressTransactionsResponse`, `RawTransactionResponse`, `BroadcastTransactionResponse`, `FiatRatesSnapshot` | Service response contracts. |
| `defaultProviderConfig`, `getProviderRateLimit` | Defaults and rate-limit helpers. |
| `RateLimiterService`, `RequestCache` | Lower-level primitives exposed for tests and custom runtimes. |
| `MempoolSpaceProvider`, `BlockstreamInfoProvider`, `EsploraMirrorProvider`, `BlockchainDotComProvider`, `BlockcypherProvider`, `CoinbaseProvider`, `CoinGeckoProvider`, `KrakenProvider`, `EdgeFallbackProvider` | Built-in provider implementations. |
| `Provider` | Interface for custom upstream integrations. |

## Failover Behavior

For every service call, the SDK walks the configured provider priority order:

1. Skip providers that do not support the requested role.
2. Skip providers whose sliding-window budget is exhausted.
3. Skip providers in an explicit cooldown window.
4. Call the next eligible provider.
5. Return the normalized response on success.
6. On a `ProviderRateLimitError`, honor `Retry-After` when available and try the
   next provider.
7. On ordinary upstream failure, record the attempt and continue.
8. Throw `NO_PROVIDER_AVAILABLE` only after every eligible provider fails.

When `devMode: true`, responses include `dev_info.data_providers_used` so
operators can see which upstreams were attempted.

## Request Deduplication

Identical concurrent requests share one in-flight Promise:

```ts
const first = chainData.getSingle('bc1q...');
const second = chainData.getSingle('bc1q...');
const [a, b] = await Promise.all([first, second]);
// One provider request, two callers.
```

Settled results are cached for short method-specific TTL windows. Passing
`{ force: true }` bypasses the settled TTL entry but still joins an already
running request for the same key, so manual refreshes cannot double-spend
provider budget.

Multi-address methods are order-safe: calls with the same address set share one
provider request even when callers pass addresses in different orders, and the
result is realigned to each caller's original order.

## Serverless Rate-Limit Caveat

The bundled `RateLimiterService` is in-memory. In stateless serverless
environments each cold invocation starts with a clean budget, so the limiter
protects only bursts within one warm container. Pair it with a durable debounce,
lease, or `last_synced_at` row when correctness must span invocations.

In the Asylia wallet, the limiter lives for the user's tab session and is paired
with Supabase sync-state rows so multiple tabs do not all refresh the same vault
at once.

## Testing

Inject a provider stub to make tests deterministic:

```ts
import { ProviderId, type Provider } from '@asylia/blockchain-data-btc';

const stub: Provider = {
  fetchSingle: async (address) => ({
    address,
    balance_sats: 100_000,
    pending_sats: 0,
    total_received_sats: 100_000,
    tx_count: 1,
  }),
};

chainData.setProvider(ProviderId.BLOCKSTREAM_INFO, stub);
```

```bash
yarn workspace @asylia/blockchain-data-btc type-check
yarn workspace @asylia/blockchain-data-btc test
```

## Related Packages

- [`@asylia/btc-core`](../btc-core) - descriptors, address derivation, PSBTs,
  signatures, and coin selection.
- [`@asylia/hw-trezor`](../hw-trezor) - Trezor adapter.
- [`@asylia/hw-ledger`](../hw-ledger) - Ledger adapter.

## License

MIT - see [`LICENSE`](./LICENSE).
