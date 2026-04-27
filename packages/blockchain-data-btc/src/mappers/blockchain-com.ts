/**
 * Blockchain.com response DTOs and mappers.
 *
 * Two endpoints are wired up:
 *
 *   - `/multiaddr` — native batch endpoint that returns N addresses
 *     in one round-trip. The unique selling point of this provider —
 *     used as a fast first-load path for many-address windows.
 *   - `/unspent?active=<addr>` — per-address UTXO list. Mapping back
 *     to addresses requires a fanout (one HTTP call per address)
 *     because the response carries raw scripts, not addresses.
 */
import type {
  NormalizedAddressBalance,
  NormalizedUtxo,
} from '../types';

/** One address row in the Blockchain.com `/multiaddr` envelope. */
export interface BlockchainDotComAddress {
  address: string;
  final_balance: number;
  total_received: number;
  n_tx: number;
}

/** Top-level Blockchain.com `/multiaddr` envelope. */
export interface BlockchainDotComResponse {
  addresses: BlockchainDotComAddress[];
}

/** Blockchain.com `/unspent` output element. */
export interface BlockchainDotComUnspent {
  tx_hash_big_endian: string;
  tx_hash?: string;
  tx_output_n: number;
  value: number;
  confirmations: number;
  script: string;
}

/** Blockchain.com `/unspent` envelope. */
export interface BlockchainDotComUnspentResponse {
  unspent_outputs: BlockchainDotComUnspent[];
}

/**
 * Map a Blockchain.com `/multiaddr` address row.
 *
 * Caveat: the upstream `final_balance` field already includes mempool
 * activity and the API exposes no confirmed-only counterpart, so the
 * confirmed/pending split is *not* recoverable from this provider.
 * `pending_sats` is reported as `0` and `balance_sats` carries the
 * combined number — callers that need an accurate split must query an
 * Esplora-shaped provider instead.
 *
 * The default priority list keeps Blockchain.com behind every Esplora
 * provider precisely for this reason.
 */
export function mapBlockchainDotCom(
  data: BlockchainDotComAddress,
): NormalizedAddressBalance {
  return {
    address: data.address,
    balance_sats: data.final_balance,
    pending_sats: 0,
    total_received_sats: data.total_received,
    tx_count: data.n_tx,
  };
}

/**
 * Map one Blockchain.com `/unspent` row onto the canonical
 * {@link NormalizedUtxo}. Block height is not exposed by the
 * `/unspent` shape (only `confirmations`), so it stays `null`.
 */
export function mapBlockchainDotComUnspent(
  address: string,
  raw: BlockchainDotComUnspent,
): NormalizedUtxo {
  return {
    txid: raw.tx_hash_big_endian,
    vout: raw.tx_output_n,
    valueSats: raw.value,
    address,
    confirmed: raw.confirmations > 0,
    blockHeight: null,
  };
}
