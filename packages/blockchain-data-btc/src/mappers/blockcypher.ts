/**
 * Blockcypher response DTOs and mappers.
 *
 * Blockcypher exposes Bitcoin chain-data at
 * `https://api.blockcypher.com/v1/btc/main`. The shape diverges from
 * Esplora and Blockchain.com — UTXOs and txs are nested under the
 * same `/addrs/{address}/full` envelope, and balances live in
 * `/addrs/{address}/balance`.
 *
 * Pending vs confirmed split is exposed cleanly via `balance` (mined)
 * + `unconfirmed_balance` (mempool), so this provider can act as a
 * full-fidelity backup for the Esplora providers.
 */
import type {
  NormalizedAddressBalance,
  NormalizedTransaction,
  NormalizedUtxo,
} from '../types';

/**
 * `/addrs/{address}/balance` envelope.
 *
 * Field names map straightforwardly onto our canonical shape:
 *
 *   - `balance` — confirmed UTXO sum, in satoshis.
 *   - `unconfirmed_balance` — signed net mempool delta. Can be
 *     **negative** when an outgoing spend is in flight, and that sign
 *     must be preserved so wallet-level totals subtract spent inputs
 *     before confirmation.
 *   - `total_received` — lifetime confirmed receipts.
 *   - `n_tx` — lifetime confirmed transaction count for the address.
 */
export interface BlockcypherBalanceResponse {
  address: string;
  balance: number;
  unconfirmed_balance: number;
  total_received: number;
  n_tx: number;
  unconfirmed_n_tx: number;
}

/** One unspent reference inside `/addrs/{address}` `txrefs[]`. */
export interface BlockcypherTxRef {
  tx_hash: string;
  tx_input_n: number;
  tx_output_n: number;
  value: number;
  confirmed?: string;
  block_height?: number;
  spent?: boolean;
  confirmations?: number;
}

/**
 * `/addrs/{address}` (unspent-only mode `?unspentOnly=true`) envelope.
 *
 * Blockcypher returns every UTXO in two parallel arrays: confirmed
 * UTXOs in `txrefs` and unconfirmed UTXOs in `unconfirmed_txrefs`.
 * The mapper concatenates and sorts both into one flat list per
 * address, which matches the Esplora `/utxo` shape every other
 * provider in the package returns.
 */
export interface BlockcypherAddressResponse {
  address: string;
  txrefs?: BlockcypherTxRef[];
  unconfirmed_txrefs?: BlockcypherTxRef[];
}

/** Per-input row inside a Blockcypher transaction. */
export interface BlockcypherTxInput {
  prev_hash?: string;
  output_index?: number;
  output_value?: number;
  /** Always a single-element array for standard scripts; empty for coinbase. */
  addresses?: string[];
}

/** Per-output row inside a Blockcypher transaction. */
export interface BlockcypherTxOutput {
  value: number;
  addresses?: string[];
  script_type?: string;
}

/** `/addrs/{address}/full` transaction envelope. */
export interface BlockcypherTransaction {
  hash: string;
  block_height?: number;
  confirmed?: string;
  /** Some responses use `received` for mempool entries. */
  received?: string;
  fees: number;
  size: number;
  vsize?: number;
  /** `block_height === -1` is Blockcypher's mempool sentinel. */
  inputs: BlockcypherTxInput[];
  outputs: BlockcypherTxOutput[];
}

/** `/addrs/{address}/full` envelope. */
export interface BlockcypherAddressFullResponse {
  address: string;
  txs?: BlockcypherTransaction[];
}

/**
 * Map a Blockcypher balance envelope onto the canonical
 * {@link NormalizedAddressBalance}. `unconfirmed_balance` is already
 * a signed net mempool delta, so it is preserved verbatim.
 */
export function mapBlockcypherBalance(
  data: BlockcypherBalanceResponse,
): NormalizedAddressBalance {
  return {
    address: data.address,
    balance_sats: data.balance,
    pending_sats: data.unconfirmed_balance,
    total_received_sats: data.total_received,
    tx_count: data.n_tx,
  };
}

/**
 * Map a Blockcypher `txref` row onto the canonical
 * {@link NormalizedUtxo}. `block_height` is missing from mempool
 * entries (or set to `-1`); both are normalised to `null`.
 */
export function mapBlockcypherUtxo(
  address: string,
  raw: BlockcypherTxRef,
  fromMempool: boolean,
): NormalizedUtxo {
  const blockHeight = raw.block_height !== undefined && raw.block_height >= 0
    ? raw.block_height
    : null;
  return {
    txid: raw.tx_hash,
    vout: raw.tx_output_n,
    valueSats: raw.value,
    address,
    confirmed: !fromMempool && blockHeight !== null,
    blockHeight,
  };
}

/**
 * Map a Blockcypher transaction envelope onto the canonical
 * {@link NormalizedTransaction}. Vbyte uses Blockcypher's `vsize` when
 * present and falls back to `Math.ceil(size * 4 / 4)` (i.e. the raw
 * size) for legacy responses without a witness-aware figure.
 */
export function mapBlockcypherTransaction(
  raw: BlockcypherTransaction,
): NormalizedTransaction {
  const blockHeight = raw.block_height !== undefined && raw.block_height >= 0
    ? raw.block_height
    : null;
  const blockTime = blockHeight !== null && raw.confirmed
    ? new Date(raw.confirmed).toISOString()
    : null;

  return {
    txid: raw.hash,
    feeSats: raw.fees,
    vbytes: raw.vsize ?? raw.size,
    status: {
      confirmed: blockHeight !== null,
      blockHeight,
      blockTime,
    },
    vin: raw.inputs.map((input) => ({
      address: input.addresses?.[0] ?? null,
      valueSats: input.output_value ?? 0,
    })),
    vout: raw.outputs.map((output) => ({
      address: output.addresses?.[0] ?? null,
      valueSats: output.value,
    })),
  };
}
