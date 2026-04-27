/**
 * Provider configuration: the priority list the service walks down on
 * each request and the per-provider throttling budgets the in-memory
 * gate enforces.
 *
 * Defaults target the **anonymous public tiers** of every supported
 * provider so the service works with zero credentials. The numbers
 * below are conservative on purpose:
 *
 *   - `minIntervalMs` and `maxConcurrent` together cap the *peak*
 *     burst rate the SDK can aim at one upstream. They are the
 *     primary defence against tripping a public provider's burst
 *     limiter (the cause of immediate 429s when the SDK fans out).
 *   - `requests` + `per` cap the *sustained* rate over a rolling
 *     window. They protect against long-running flows (e.g. the
 *     gap-limit walker on a vault with hundreds of historic
 *     addresses) that would otherwise stay under the burst limit
 *     yet still exhaust the documented hourly / minute budgets.
 *   - `coolDownMs` is the baseline cooldown applied when a provider
 *     answers with HTTP 429 / 403 *without* an explicit `Retry-After`
 *     header. The gate honours an explicit hint when one is present.
 *
 * When a provider gets paid credentials, lift its budget at
 * construction time via the consumer-supplied config.
 */
import { ProviderId } from './types';

/**
 * Throttling budget for one provider. The {@link RateLimiterService}
 * gate only releases a permit when *all four* limits are satisfied:
 * the sliding window has spare capacity, the in-flight slot is open,
 * the minimum inter-request interval has elapsed, and the explicit
 * cooldown (if any) has expired.
 */
export interface ProviderRateLimit {
  /** Max number of requests inside the sliding window. */
  requests: number;
  /** Window length in milliseconds. */
  per: number;
  /** Minimum gap between consecutive request *releases* in ms. */
  minIntervalMs: number;
  /** Max in-flight requests at any given moment. */
  maxConcurrent: number;
  /** Default cooldown applied on a 429/403 without `Retry-After`. */
  coolDownMs: number;
}

/**
 * Service-wide configuration.
 *
 * `priority` decides the failover order: the first provider that has
 * spare rate budget and is not in cooldown is tried, and on failure
 * the next one inherits the request. `rateLimits` declares the
 * throttling budget per provider.
 */
export interface ProviderConfig {
  priority: ProviderId[];
  rateLimits: Record<ProviderId, ProviderRateLimit>;
}

/**
 * Default priority for client-first chain-data queries.
 *
 * Order rationale:
 *
 *   1. **mempool.space** — fastest, well-funded operator.
 *   2. **blockstream.info** — Esplora reference deployment, high uptime.
 *   3. **mempool.emzy.de** — community Esplora mirror (Germany).
 *   4. **mempool.bisq.services** — Bisq community Esplora mirror.
 *   5. **mempool.bitcoin-21.org** — Bitcoin-21 community mirror.
 *   6. **blockchain.com** — distinct shape; useful precisely because
 *      its `/multiaddr` batch endpoint returns N addresses in one
 *      round-trip.
 *   7. **Blockcypher** — distinct infrastructure, free anonymous tier.
 *   8. **coinbase / coingecko / kraken** — rates-only providers; they
 *      never serve chain-data reads or broadcasts but participate in
 *      the priority walk for `read-fiat-rates`. Order picked from
 *      most reliable / lowest perceived latency to most rate-limited.
 *   9. **EDGE_FALLBACK** — last resort, paid Blockstream behind a
 *      consumer-supplied proxy.
 */
export const defaultProviderConfig: ProviderConfig = {
  priority: [
    ProviderId.MEMPOOL_SPACE,
    ProviderId.BLOCKSTREAM_INFO,
    ProviderId.MEMPOOL_EMZY,
    ProviderId.MEMPOOL_BISQ,
    ProviderId.BITCOIN_TWENTYONE,
    ProviderId.BLOCKCHAIN_DOT_COM,
    ProviderId.BLOCKCYPHER,
    ProviderId.COINBASE,
    ProviderId.COINGECKO,
    ProviderId.KRAKEN,
    ProviderId.EDGE_FALLBACK,
  ],
  rateLimits: {
    // Esplora-shaped providers — empirically tolerate ~3-5 req/s
    // anonymous before tripping their burst limiter. We aim much
    // lower so we never push them and rely on stacking five Esplora
    // mirrors to multiply the *aggregate* throughput.
    [ProviderId.MEMPOOL_SPACE]: {
      requests: 30,
      per: 60_000,
      minIntervalMs: 350,
      maxConcurrent: 2,
      coolDownMs: 60_000,
    },
    [ProviderId.BLOCKSTREAM_INFO]: {
      requests: 30,
      per: 60_000,
      minIntervalMs: 350,
      maxConcurrent: 2,
      coolDownMs: 60_000,
    },
    [ProviderId.MEMPOOL_EMZY]: {
      requests: 20,
      per: 60_000,
      minIntervalMs: 500,
      maxConcurrent: 1,
      coolDownMs: 60_000,
    },
    [ProviderId.MEMPOOL_BISQ]: {
      requests: 20,
      per: 60_000,
      minIntervalMs: 500,
      maxConcurrent: 1,
      coolDownMs: 60_000,
    },
    [ProviderId.BITCOIN_TWENTYONE]: {
      requests: 20,
      per: 60_000,
      minIntervalMs: 500,
      maxConcurrent: 1,
      coolDownMs: 60_000,
    },
    // Blockchain.com publishes ~30 req/min. The batch endpoint
    // collapses many addresses into one HTTP call, so we can keep
    // the per-call rate low.
    [ProviderId.BLOCKCHAIN_DOT_COM]: {
      requests: 20,
      per: 60_000,
      minIntervalMs: 350,
      maxConcurrent: 2,
      coolDownMs: 60_000,
    },
    // Blockcypher: documented free tier is 3 req/s + 100 req/h.
    // Stay well below both ceilings.
    [ProviderId.BLOCKCYPHER]: {
      requests: 100,
      per: 60 * 60_000,
      minIntervalMs: 500,
      maxConcurrent: 1,
      coolDownMs: 5 * 60_000,
    },
    // Coinbase: the public market-data API is generous (well over
    // one req/s anonymously), but rates-only callers have no reason
    // to burst — the snapshot is per-minute, anything more is wasted.
    [ProviderId.COINBASE]: {
      requests: 30,
      per: 60_000,
      minIntervalMs: 500,
      maxConcurrent: 1,
      coolDownMs: 60_000,
    },
    // CoinGecko free tier: 5-15 req/min depending on region; stay
    // well under that so a busy debug session does not get the IP
    // banned for the day. A paid `apiKey` lifts both ceilings.
    [ProviderId.COINGECKO]: {
      requests: 5,
      per: 60_000,
      minIntervalMs: 1_000,
      maxConcurrent: 1,
      coolDownMs: 60_000,
    },
    // Kraken: anonymous public market data tolerates roughly 1 req/s
    // (Tier 0). Per-minute snapshot fits comfortably.
    [ProviderId.KRAKEN]: {
      requests: 30,
      per: 60_000,
      minIntervalMs: 1_000,
      maxConcurrent: 1,
      coolDownMs: 60_000,
    },
    // Edge fallback: very tight by design. Anything above a couple
    // of calls per minute means every public provider is failing —
    // hammering the paid endpoint will not solve that.
    [ProviderId.EDGE_FALLBACK]: {
      requests: 30,
      per: 60_000,
      minIntervalMs: 250,
      maxConcurrent: 2,
      coolDownMs: 30_000,
    },
  },
};

/** Look up the throttling budget for a single provider. */
export function getProviderRateLimit(
  providerId: ProviderId,
  config: ProviderConfig = defaultProviderConfig,
): ProviderRateLimit {
  return config.rateLimits[providerId];
}
