/**
 * Public types for the PSBT builder.
 *
 * Kept narrow on purpose so the builder's API surface lines up 1:1
 * with the on-chain primitives an auditor would expect (UTXO,
 * recipient output, change output) — no Asylia-specific framing.
 */
import type { BitcoinNetwork, DescriptorKey } from '../types';

/** One unspent transaction output owned by the spending vault. */
export type Utxo = {
  /** Big-endian transaction id (the form Bitcoin RPC and explorers print). */
  txid: string;
  /** Output index inside the funding transaction. */
  vout: number;
  /** UTXO value in satoshis. */
  valueSats: number;
  /** Chain the UTXO was funded on (`0` receive, `1` change). */
  chain: 0 | 1;
  /** BIP-32 address index on the supplied chain. */
  index: number;
  /**
   * Full raw funding transaction hex. Optional so non-signing callers
   * can still model UTXOs, but send flows should provide it: hardware
   * wallets use it as `nonWitnessUtxo` to verify input amounts without
   * showing an "unverified inputs" warning.
   */
  previousTxHex?: string;
};

/** One on-chain payment to an external party. */
export type Recipient = {
  /** bech32 mainnet address. Validated by the builder before assembly. */
  address: string;
  /** Send amount in satoshis (must be > 0 and >= dust threshold). */
  amountSats: number;
};

/**
 * Change output back to the vault. Carries the chain + index the
 * change address was derived at so the builder can attach a
 * `bip32Derivation` block — that lets a hardware-wallet display the
 * change as "this output returns to me" rather than as an unknown
 * external recipient.
 */
export type ChangeOutput = {
  address: string;
  /** Always `1` for the change chain in BIP-48 multisig. */
  chain: 1;
  index: number;
  amountSats: number;
};

/** Inputs accepted by `buildWshSortedMultiPsbt`. */
export type BuildWshSortedMultiPsbtInput = {
  vault: {
    requiredSignatures: number;
    network: BitcoinNetwork;
    keys: readonly DescriptorKey[];
  };
  /**
   * Pre-selected UTXOs to spend. Coin selection happens upstream
   * (typically in the wallet app via `selectCoinsLargestFirst` or
   * a more sophisticated strategy) so this builder stays purely
   * mechanical.
   */
  utxos: readonly Utxo[];
  /**
   * One or more recipient outputs. Multiple recipients are supported
   * for batched sends; pass exactly one for the standard "send to a
   * single address" flow.
   */
  recipients: readonly Recipient[];
  /**
   * Change output back to the vault, or `null` when the spend is
   * exact and no change remains. The builder does not invent a
   * change output on its own — that decision belongs to coin
   * selection, which knows the dust threshold and fee budget.
   */
  change: ChangeOutput | null;
};

/** Output of `buildWshSortedMultiPsbt`. */
export type BuildWshSortedMultiPsbtResult = {
  /** PSBT v2 (BIP-370) serialised as a base64 string. */
  psbtBase64: string;
  /** Sum of every input's value in satoshis. */
  totalInputSats: number;
  /** Sum of every output's amount in satoshis (recipients + change). */
  totalOutputSats: number;
  /** Implicit fee in satoshis (`totalInputSats - totalOutputSats`). */
  feeSats: number;
  /** Number of inputs in the assembled transaction. */
  inputCount: number;
  /** Number of outputs in the assembled transaction. */
  outputCount: number;
};
