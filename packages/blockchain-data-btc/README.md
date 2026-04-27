# @asylia/blockchain-data-btc

Asylia Bitcoin chain-data SDK — uniform `NormalizedAddressBalance` /
`NormalizedUtxo` / `NormalizedTransaction` API on top of seven
chain-data providers with priority-based failover, sliding-window rate
limiting, 429-aware cooldowns, and concurrent-request deduplication.

Designed to run unchanged in **browsers**, **Deno** (Supabase Edge
Functions), and **Node 18+**. The package has zero runtime
dependencies and uses only the Web `fetch` and `btoa` globals.

> **License:** MIT. This package is part of Asylia's auditable
> open-source layer alongside `@asylia/btc-core` and `@asylia/hw-*`.

## Why this package exists

Asylia needs a single, deterministic chain-data API that:

- Returns the **same shape** regardless of which upstream answered.
- Survives any single provider being down or rate-limited — even when
  a power user with many vaults exhausts the budget on the fastest
  provider, the SDK transparently rotates to the next one.
- Coalesces concurrent identical requests so a Vue dashboard mounting
  six components for the same vault does not fan out into six HTTP
  calls.
- Works **identically on the client and the server**, so the same
  code can be used from a browser SPA, a Supabase Edge Function, or a
  future Capacitor signer.

## Architecture

The Asylia wallet runs the SDK **client-side**: every chain-data call
originates in the browser. The provider chain is engineered so the
SDK can rotate across many free public APIs before reaching for a
paid endpoint:

```
SPA  →  BlockchainDataService
        ├─  1. mempool.space            (free Esplora)
        ├─  2. blockstream.info         (free Esplora; paid auth header optional)
        ├─  3. mempool.emzy.de mirror   (free Esplora)
        ├─  4. mempool.bisq.services    (free Esplora)
        ├─  5. mempool.bitcoin-21.org   (free Esplora)
        ├─  6. blockchain.com           (free, batch /multiaddr)
        ├─  7. Blockcypher              (free, distinct infra)
        └─  8. EdgeFallbackProvider     (last resort, paid Blockstream
                                          via consumer-supplied callback)
```

`EdgeFallbackProvider` is generic: the consumer hands in an
`invoke({ op, args })` callback at construction time, so the SDK
itself stays free of any framework or transport coupling. In the
Asylia wallet that callback maps onto a Supabase Edge Function that
holds the paid Blockstream credentials (the browser bundle never sees
them).

### Privacy implication

Reads from the browser expose the user's IP address and the full set
of derived vault addresses to the upstream provider that answers
each request. This is a deliberate trade-off:

- **Latency** — no Supabase edge round-trip.
- **Scale** — eight providers absorb load that one server-side path
  could not.
- **Operational simplicity** — the wallet is a static SPA; the
  server side only carries the payment-bearing fallback.

Operators that need address-set anonymity should run their own
Esplora deployment behind a privacy gateway (Tor / IPFS-style relay)
and register it via `EsploraMirrorProvider`.

## Installation

The package lives in the Asylia monorepo as a workspace package; no
install step is required:

```jsonc
// apps/wallet/package.json
{
  "dependencies": {
    "@asylia/blockchain-data-btc": "workspace:^"
  }
}
```

## Quick start

```ts
import {
  BlockchainDataService,
  BlockstreamInfoProvider,
  BlockchainDotComProvider,
  BlockcypherProvider,
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
    [ProviderId.MEMPOOL_BISQ]: new EsploraMirrorProvider({
      baseUrl: 'https://mempool.bisq.services/api',
      displayName: 'MEMPOOL_BISQ',
    }),
    [ProviderId.BITCOIN_TWENTYONE]: new EsploraMirrorProvider({
      baseUrl: 'https://mempool.bitcoin-21.org/api',
      displayName: 'BITCOIN_TWENTYONE',
    }),
    [ProviderId.BLOCKCHAIN_DOT_COM]: new BlockchainDotComProvider(),
    [ProviderId.BLOCKCYPHER]: new BlockcypherProvider(),
    [ProviderId.EDGE_FALLBACK]: new EdgeFallbackProvider({
      invoke: (payload) => myCallToServerSide(payload),
    }),
  },
});

const single = await chainData.getSingle('bc1q...');
console.log(single.balance_sats, single.pending_sats, single.tx_count);

const multi = await chainData.getMulti(['bc1q...', 'bc1q...']);
console.log(multi.summary.total_balance_sats);

const utxos = await chainData.getUtxos(['bc1q...']);
console.log(utxos.results[0].utxos.length);

const rawFundingTx = await chainData.getRawTransaction('f'.repeat(64));
console.log(rawFundingTx.rawTxHex.length);

const txs = await chainData.getTransactions(['bc1q...']);
console.log(txs.results[0].transactions.length);

const tip = await chainData.getTipHeight();

const broadcast = await chainData.broadcastTransaction(rawTxHex, expectedTxid);
console.log(broadcast.txid, broadcast.provider);
```

`balance_sats` is the **confirmed** UTXO sum. `pending_sats` is the
**net unconfirmed inflow** clamped at zero (Esplora and Blockcypher
populate it cleanly; Blockchain.com cannot expose a clean split and
reports `0`).

## Supported providers

| Provider | Auth | Native batch | Roles |
|----------|------|--------------|-------|
| `MEMPOOL_SPACE` | Optional Bearer | No (fanout via `pMap`) | balance, utxos, txs, tip, raw tx, broadcast |
| `BLOCKSTREAM_INFO` | Optional `clientId` + `clientSecret` (Basic) | No (fanout via `pMap`) | balance, utxos, txs, tip, raw tx, broadcast |
| `MEMPOOL_EMZY` / `MEMPOOL_BISQ` / `BITCOIN_TWENTYONE` | Anonymous | No (fanout via `pMap`) | balance, utxos, txs, tip, raw tx, broadcast |
| `BLOCKCHAIN_DOT_COM` | Optional `apiKey` (query string) | Yes (`/multiaddr`) | balance, utxos, broadcast |
| `BLOCKCYPHER` | Optional free `token` | No (per-address fanout) | balance, utxos, txs, tip, broadcast |
| `EDGE_FALLBACK` | Caller-supplied `invoke` | Per the server-side endpoint | configurable via `roles` |

Override `priority` and `rateLimits` at construction to lift the
budgets when paid keys are configured.

## Failover behaviour

For each call (`getSingle`, `getMulti`, `getUtxos`,
`getTransactions`, `getTipHeight`, `getRawTransaction`,
`broadcastTransaction`):

1. Walk the configured priority list.
2. For each provider in order:
   - If the provider is missing the requested role → skip.
   - If the rate-limit budget is exhausted *or* the provider is in
     an explicit cooldown window → skip silently.
   - Otherwise call the provider.
   - On success → return the normalized response.
   - On `ProviderRateLimitError` (HTTP 429 / 403) → trip an explicit
     cooldown of `Retry-After` (or the provider's `coolDownMs`
     baseline if no header) and try the next provider.
   - On any other failure → record the attempt and try the next
     provider.
3. If every provider fails → throw `Error('NO_PROVIDER_AVAILABLE')`
   with the most recent upstream message attached.

When `devMode: true` the response carries a
`dev_info.data_providers_used` array listing the providers that were
attempted, which is useful when debugging which API actually
answered.

## Concurrent-request deduplication

By default identical concurrent requests are coalesced into one
in-flight Promise:

```ts
const a = chainData.getSingle('bc1q...');
const b = chainData.getSingle('bc1q...'); // same key → adopts `a`
const [ra, rb] = await Promise.all([a, b]);
// Exactly one HTTP request to the provider.
```

Pass `enableDeduplication: false` to opt out — useful in tests that
want to count requests directly.

Settled results are also cached for short method-specific TTL windows. Passing
`{ force: true }` bypasses only that settled TTL entry; it still joins an
already-running in-flight request for the same key so a manual refresh cannot
double-spend provider budget while a passive refresh is on the wire.

Multi-address methods (`getMulti`, `getUtxos`, `getTransactions`) use
order-safe cache reuse. Calls with the same address set share the same provider
request even if callers pass addresses in a different order, and the response is
realigned back to the caller's original order before it is returned.

## Rate-limit caveat for serverless runtimes

The bundled `RateLimiterService` is in-memory. In stateless
serverless environments (Supabase Edge Functions, Vercel functions,
AWS Lambda) each cold invocation starts with an empty window, so the
limiter only protects against bursts within one warm container. Pair
it with a server-authoritative debounce — for example a
`last_synced_at` row in Postgres — for cross-invocation correctness.

In the Asylia stack the in-memory limiter lives for the whole tab
session of a logged-in user, so the limiter is usually authoritative
on its own. The cross-tab debounce on `V1_VaultSyncState` exists for
the same vault opened in multiple tabs.

## Public surface

| Export | Purpose |
|--------|---------|
| `BlockchainDataService` | Main façade. Construct once per process / tab. |
| `ProviderId` | Enum of supported providers. |
| `ProviderRole` | Capability tag (`'read-balance'`, `'broadcast'`, …). |
| `ProviderRateLimitError` | Marker thrown by providers on 429/403. |
| `NormalizedAddressBalance`, `NormalizedUtxo`, `NormalizedTransaction` | Canonical shapes. |
| `SingleAddressResponse`, `MultiAddressResponse`, `MultiAddressUtxosResponse`, `MultiAddressTransactionsResponse`, `RawTransactionResponse`, `BroadcastTransactionResponse` | Service return types. |
| `defaultProviderConfig`, `getProviderRateLimit` | Defaults + helpers. |
| `RateLimiterService`, `RequestCache` | Exposed for custom backends and tests. |
| `EsploraBaseProvider` | Reusable Esplora-shaped HTTP transport. |
| `MempoolSpaceProvider`, `BlockstreamInfoProvider`, `EsploraMirrorProvider`, `BlockchainDotComProvider`, `BlockcypherProvider`, `EdgeFallbackProvider` | Concrete provider classes. |
| `Provider` | Provider interface — implement to plug in a custom upstream. |

## Testing

Inject a stub provider:

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
  fetchMulti: async (addresses) =>
    addresses.map((address) => ({
      address,
      balance_sats: 0,
      pending_sats: 0,
      total_received_sats: 0,
      tx_count: 0,
    })),
};

chainData.setProvider(ProviderId.BLOCKSTREAM_INFO, stub);
```

## Related

- [`@asylia/btc-core`](../btc-core) — descriptors, address derivation, PSBT helpers.
- [`@asylia/hw-trezor`](../hw-trezor), [`@asylia/hw-ledger`](../hw-ledger) — hardware adapters.
