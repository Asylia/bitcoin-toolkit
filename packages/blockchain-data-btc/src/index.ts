/**
 * `@asylia/blockchain-data-btc` — Asylia's chain-data SDK.
 *
 * One narrow surface (`BlockchainDataService`) fronts a stack of
 * Bitcoin chain-data providers — Mempool.space, Blockstream.info,
 * three Esplora community mirrors, Blockchain.com, Blockcypher, plus
 * a runtime-agnostic Edge fallback hook — and returns the same
 * canonical shapes (`NormalizedAddressBalance`, `NormalizedUtxo`,
 * `NormalizedTransaction`) regardless of which one answered.
 * Failover, rate limiting, 429-aware cooldowns, and concurrent-request
 * deduplication are all built in so the consumer never has to reason
 * about provider specifics.
 *
 * Runtime targets: browsers (with `fetch`), Deno (Supabase Edge
 * Functions), and Node 18+. The package has zero runtime dependencies
 * and uses only the Web `fetch` and `btoa` globals.
 *
 * License: MIT — this package is part of Asylia's auditable
 * open-source layer alongside `@asylia/btc-core` and `@asylia/hw-*`.
 */

export {
  ProviderId,
  ProviderConfigurationError,
  ProviderRateLimitError,
  type AddressTransactions,
  type AddressUtxos,
  type BroadcastTransactionResponse,
  type DevInfo,
  type FiatRatesSnapshot,
  type MultiAddressResponse,
  type MultiAddressTransactionsResponse,
  type MultiAddressUtxosResponse,
  type NormalizedAddressBalance,
  type NormalizedTransaction,
  type NormalizedTransactionVin,
  type NormalizedTransactionVout,
  type NormalizedUtxo,
  type ProviderRole,
  type RawTransactionResponse,
  type SingleAddressResponse,
} from './types';

export {
  defaultProviderConfig,
  getProviderRateLimit,
  type ProviderConfig,
  type ProviderRateLimit,
} from './config';

export { RateLimiterService } from './rate-limiter';
export { RequestCache } from './request-cache';

export type { Provider } from './providers/base';
export {
  EsploraBaseProvider,
  type EsploraProviderConfig,
} from './providers/esplora-base';
export {
  BlockstreamInfoProvider,
  type BlockstreamInfoProviderConfig,
} from './providers/blockstream-info';
export {
  MempoolSpaceProvider,
  type MempoolSpaceProviderConfig,
} from './providers/mempool-space';
export {
  EsploraMirrorProvider,
  type EsploraMirrorProviderConfig,
} from './providers/esplora-mirror';
export {
  BlockchainDotComProvider,
  type BlockchainDotComProviderConfig,
} from './providers/blockchain-dot-com';
export {
  BlockcypherProvider,
  type BlockcypherProviderConfig,
} from './providers/blockcypher';
export {
  CoinbaseProvider,
  type CoinbaseProviderConfig,
} from './providers/coinbase';
export {
  CoinGeckoProvider,
  type CoinGeckoProviderConfig,
} from './providers/coingecko';
export {
  KrakenProvider,
  type KrakenProviderConfig,
} from './providers/kraken';
export {
  EdgeFallbackProvider,
  type EdgeFallbackInvokeResult,
  type EdgeFallbackOp,
  type EdgeFallbackProviderConfig,
  type EdgeFallbackResponse,
} from './providers/edge-fallback';

export {
  BlockchainDataService,
  type BlockchainDataMetricEvent,
  type BlockchainDataServiceConfig,
} from './service';

import packageJson from '../package.json' with { type: 'json' };

export const ASYLIA_BLOCKCHAIN_DATA_BTC_VERSION = packageJson.version;
export { pMap } from './utils';
