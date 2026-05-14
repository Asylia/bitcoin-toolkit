/**
 * Esplora-shaped response DTOs and the mapping functions that collapse
 * each one onto the package-internal canonical shapes
 * (`NormalizedAddressBalance`, `NormalizedUtxo`,
 * `NormalizedTransaction`).
 *
 * Mempool.space, Blockstream.info and the various community Esplora
 * mirrors share the exact same wire shape, so the mapping is
 * byte-identical and reused by every Esplora-shaped provider.
 */
import type {
  NormalizedAddressBalance,
  NormalizedTransaction,
  NormalizedUtxo,
} from '../types';

/**
 * Esplora-shaped chain stats block. The on-chain balance is
 * `funded - spent`; the API never exposes that subtraction directly so
 * the mapper does it here.
 */
export interface EsploraChainStats {
  funded_txo_sum: number;
  spent_txo_sum: number;
  tx_count: number;
}

/**
 * Esplora-shaped mempool stats block. Same fields as
 * {@link EsploraChainStats} but scoped to unconfirmed activity.
 * Returned alongside `chain_stats` on every Esplora address fetch so
 * the mapper can surface confirmed and pending values from a single
 * round-trip.
 */
export interface EsploraMempoolStats {
  funded_txo_sum: number;
  spent_txo_sum: number;
  tx_count: number;
}

/** Esplora `/address/{addr}` envelope. */
export interface EsploraAddressResponse {
  address: string;
  chain_stats: EsploraChainStats;
  mempool_stats?: EsploraMempoolStats;
}

/** Esplora `/address/{addr}/utxo` element. */
export interface EsploraUtxo {
  txid: string;
  vout: number;
  value: number;
  status: {
    confirmed: boolean;
    block_height?: number;
    block_hash?: string;
    block_time?: number;
  };
}

/** One element of an Esplora `/address/:addr/txs` response. */
export interface EsploraTransaction {
  txid: string;
  version: number;
  locktime: number;
  vin: Array<{
    txid: string;
    vout: number;
    /**
     * Coinbase inputs and a handful of pathological provider
     * responses can omit `prevout`. The mapper treats those as
     * "no address, no value" so the rest of the pipeline never
     * crashes on a missing field.
     */
    prevout: {
      scriptpubkey: string;
      scriptpubkey_address?: string;
      scriptpubkey_type?: string;
      value: number;
    } | null;
    is_coinbase?: boolean;
    sequence?: number;
  }>;
  vout: Array<{
    scriptpubkey: string;
    scriptpubkey_address?: string;
    scriptpubkey_type?: string;
    value: number;
  }>;
  size: number;
  weight: number;
  fee: number;
  status: {
    confirmed: boolean;
    block_height?: number;
    block_hash?: string;
    block_time?: number;
  };
}

/**
 * Map an Esplora address response onto the canonical
 * {@link NormalizedAddressBalance}.
 *
 * `chain_stats` carries confirmed history; `mempool_stats` carries the
 * unconfirmed view. Pending is the signed `funded - spent` mempool
 * delta. Negative values are important: they are how an unconfirmed
 * outgoing spend removes a confirmed input from the wallet-level total
 * before the transaction is mined.
 */
export function mapEsploraAddress(
  data: EsploraAddressResponse,
): NormalizedAddressBalance {
  const mempoolFunded = data.mempool_stats?.funded_txo_sum ?? 0;
  const mempoolSpent = data.mempool_stats?.spent_txo_sum ?? 0;
  const mempoolTxCount = data.mempool_stats?.tx_count ?? 0;
  const pending = mempoolFunded - mempoolSpent;
  return {
    address: data.address,
    balance_sats: data.chain_stats.funded_txo_sum - data.chain_stats.spent_txo_sum,
    pending_sats: pending,
    total_received_sats: data.chain_stats.funded_txo_sum + mempoolFunded,
    tx_count: data.chain_stats.tx_count + mempoolTxCount,
  };
}

/** Map one Esplora UTXO row onto the canonical {@link NormalizedUtxo}. */
export function mapEsploraUtxo(address: string, raw: EsploraUtxo): NormalizedUtxo {
  return {
    txid: raw.txid,
    vout: raw.vout,
    valueSats: raw.value,
    address,
    confirmed: raw.status.confirmed === true,
    blockHeight: raw.status.block_height ?? null,
  };
}

/**
 * Map an Esplora transaction onto the provider-agnostic
 * {@link NormalizedTransaction} shape. Only the fields the wallet
 * needs are retained — verbose `scriptpubkey_asm`, witness stacks,
 * and signature scripts are dropped because every consumer either
 * re-fetches or links to the upstream explorer for those.
 *
 * Vbyte is computed locally as `weight / 4` so the value stays stable
 * across providers (Esplora exposes both, Mempool.space sometimes
 * omits one or the other on legacy txs).
 */
export function mapEsploraTransaction(raw: EsploraTransaction): NormalizedTransaction {
  const blockTime = raw.status.block_time
    ? new Date(raw.status.block_time * 1000).toISOString()
    : null;

  return {
    txid: raw.txid,
    feeSats: raw.fee,
    vbytes: Math.ceil(raw.weight / 4),
    status: {
      confirmed: raw.status.confirmed === true,
      blockHeight: raw.status.block_height ?? null,
      blockTime,
    },
    vin: raw.vin.map((entry) => ({
      address: entry.prevout?.scriptpubkey_address ?? null,
      valueSats: entry.prevout?.value ?? 0,
    })),
    vout: raw.vout.map((entry) => ({
      address: entry.scriptpubkey_address ?? null,
      valueSats: entry.value,
    })),
  };
}
