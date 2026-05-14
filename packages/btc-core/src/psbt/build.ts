/**
 * PSBT v2 builder for `wsh(sortedmulti(...))` Asylia vaults.
 *
 * Builds a fully-typed unsigned PSBT (PSBT v2 / BIP-370) that:
 *   - References the supplied UTXOs as `PSBT_IN_WITNESS_UTXO` inputs.
 *   - Carries the full `(witnessScript, bip32Derivation[])` block per
 *     input so any conformant hardware wallet can verify the script
 *     against its registered xpubs and sign without further context.
 *   - Adds the recipient outputs verbatim and, when present, the
 *     change output with its own `(witnessScript, bip32Derivation[])`
 *     block so devices can render change as "returning to my own
 *     vault" instead of as an unknown external recipient.
 *
 * The builder does no coin selection, fee estimation, or dust check
 * itself — those decisions belong upstream (see
 * `selectCoinsLargestFirst`). It mechanically assembles whatever
 * inputs / outputs the caller hands in and validates that the
 * arithmetic is balanced (no negative fee).
 *
 * The output is the canonical base64 PSBT v2 payload; pair it with
 * a hardware-wallet adapter to collect signatures, and with the
 * combiner role of `@caravan/psbt` to merge multiple signed copies
 * into a fully-signed PSBT before finalising and broadcasting.
 */
import { Buffer } from 'node:buffer';
import { PsbtV2 } from '@caravan/psbt';
import { address as bitcoinAddress, payments, Transaction } from 'bitcoinjs-lib';
import type { BIP32Interface } from 'bip32';

import { bip32 } from '../crypto/ecc';
import { toCanonicalXpub } from '../descriptor/normalize';
import { networkOf } from '../network';
import type { DescriptorKey } from '../types';
import { PsbtBuildError } from './errors';
import { reverseTxidHex } from './txid';
import type {
  BuildWshSortedMultiPsbtInput,
  BuildWshSortedMultiPsbtResult,
  ChangeOutput,
  Recipient,
  Utxo,
} from './types';

/**
 * Below this many satoshis a P2WSH output is considered dust and
 * generally rejected by the network. We only use it as a
 * *non-blocking* sanity check against recipient amounts; coin
 * selection is responsible for not creating dust change.
 */
const DUST_THRESHOLD_SATS = 546;

/**
 * BIP125 opt-in RBF sequence. `0xfffffffd` keeps nLockTime usable and
 * marks every newly built wallet transaction as replaceable by fee.
 */
const DEFAULT_INPUT_SEQUENCE = 0xfffffffd;

/**
 * Build the full PSBT v2 base64 payload for a `wsh(sortedmulti(...))`
 * spend. Throws {@link PsbtBuildError} on any input validation
 * failure (no UTXOs, malformed address, dust output, negative fee, …).
 */
export function buildWshSortedMultiPsbt(
  input: BuildWshSortedMultiPsbtInput,
): BuildWshSortedMultiPsbtResult {
  const { vault, utxos, recipients, change } = input;

  // ----- input validation -------------------------------------------------

  if (vault.keys.length === 0) {
    throw new PsbtBuildError('At least one cosigning key is required.');
  }
  if (
    vault.requiredSignatures < 1 ||
    vault.requiredSignatures > vault.keys.length
  ) {
    throw new PsbtBuildError(
      `Required signatures must be between 1 and ${vault.keys.length}.`,
    );
  }
  if (utxos.length === 0) {
    throw new PsbtBuildError('At least one UTXO must be supplied.');
  }
  if (recipients.length === 0) {
    throw new PsbtBuildError('At least one recipient is required.');
  }

  const network = networkOf(vault.network);

  // Resolve every cosigner's chain-level BIP-32 node up front.
  // Re-deriving per UTXO from the same parsed xpub is cheap, so we
  // cache the parsed `BIP32Interface` per cosigner index keyed on
  // chain (0 receive, 1 change).
  const parsedKeys = vault.keys.map((key, idx) => {
    const xpub = toCanonicalXpub(key.xpub.trim());
    if (xpub === null) {
      throw new PsbtBuildError(
        `Cosigner #${idx + 1}: extended public key is not valid base58check.`,
      );
    }
    let node: BIP32Interface;
    try {
      node = bip32().fromBase58(xpub, network);
    } catch (cause) {
      throw new PsbtBuildError(
        `Cosigner #${idx + 1}: failed to parse extended public key (${(cause as Error).message}).`,
      );
    }
    return {
      key,
      node,
      receiveNode: node.derive(0),
      changeNode: node.derive(1),
    };
  });

  // ----- assembly ---------------------------------------------------------

  const psbt = new PsbtV2();
  // BIP-370 requires tx version >= 2; the constructor sets it but we
  // re-set defensively in case the upstream default changes.
  psbt.PSBT_GLOBAL_TX_VERSION = 2;
  psbt.PSBT_GLOBAL_FALLBACK_LOCKTIME = 0;

  let totalInputSats = 0;
  for (const utxo of utxos) {
    if (utxo.valueSats <= 0) {
      throw new PsbtBuildError(
        `UTXO ${utxo.txid}:${utxo.vout} has non-positive value (${utxo.valueSats} sats).`,
      );
    }
    if (utxo.chain !== 0 && utxo.chain !== 1) {
      throw new PsbtBuildError(
        `UTXO ${utxo.txid}:${utxo.vout} has invalid chain ${utxo.chain as number}.`,
      );
    }

    const slot = derivePsbtSlot(parsedKeys, vault.requiredSignatures, network, utxo.chain, utxo.index);

    const nonWitnessUtxo = utxo.previousTxHex
      ? fundingTransactionBuffer(utxo, slot.scriptPubKey)
      : undefined;

    psbt.addInput({
      // BIP-370: PSBT_IN_PREVIOUS_TXID stores the txid in the
      // little-endian "internal" order that Bitcoin uses on the wire,
      // i.e. the byte-reversal of the big-endian txid that explorers
      // and `Utxo.txid` expose. `@caravan/psbt` writes whatever bytes
      // we hand it verbatim, and the v0 conversion later feeds those
      // bytes straight into `bitcoinjs-lib`'s `Transaction.addInput`
      // (which also stores `hash` in internal order). Without the
      // reversal here, the broadcasted raw tx ends up referencing
      // `reverse(utxo.txid)` and every node rejects it as
      // `bad-txns-inputs-missingorspent`.
      previousTxId: reverseTxidHex(utxo.txid),
      outputIndex: utxo.vout,
      sequence: DEFAULT_INPUT_SEQUENCE,
      witnessUtxo: {
        amount: utxo.valueSats,
        script: slot.scriptPubKey,
      },
      ...(nonWitnessUtxo ? { nonWitnessUtxo } : {}),
      witnessScript: slot.witnessScript,
      bip32Derivation: slot.bip32Derivation,
    });
    totalInputSats += utxo.valueSats;
  }

  let totalOutputSats = 0;
  for (const recipient of recipients) {
    assertRecipient(recipient);
    const script = scriptForExternalAddress(recipient.address, network);
    psbt.addOutput({
      amount: recipient.amountSats,
      script,
    });
    totalOutputSats += recipient.amountSats;
  }

  if (change) {
    assertChange(change);
    const slot = derivePsbtSlot(
      parsedKeys,
      vault.requiredSignatures,
      network,
      change.chain,
      change.index,
    );
    // Address echo guards against a mismatch between the change
    // address the caller computed and the script the builder would
    // actually pay to. Without this check a buggy caller could
    // accidentally hand the change to a different vault.
    if (slot.address !== change.address) {
      throw new PsbtBuildError(
        `Change address mismatch: expected ${slot.address}, got ${change.address}.`,
      );
    }
    psbt.addOutput({
      amount: change.amountSats,
      script: slot.scriptPubKey,
      witnessScript: slot.witnessScript,
      bip32Derivation: slot.bip32Derivation,
    });
    totalOutputSats += change.amountSats;
  }

  const feeSats = totalInputSats - totalOutputSats;
  if (feeSats < 0) {
    throw new PsbtBuildError(
      `Outputs (${totalOutputSats} sats) exceed inputs (${totalInputSats} sats); fee would be negative.`,
    );
  }

  return {
    psbtBase64: psbt.serialize('base64'),
    totalInputSats,
    totalOutputSats,
    feeSats,
    inputCount: utxos.length,
    outputCount: recipients.length + (change ? 1 : 0),
  };
}

/** One UTXO outpoint extracted from a PSBT input. */
export type PsbtInputOutpoint = {
  /**
   * Big-endian (display) txid — the same form `Utxo.txid` uses, suitable
   * for direct comparison against UTXO listings from any explorer or
   * chain-data SDK. The PSBT itself stores the txid in little-endian
   * internal order; this reader reverses it back before returning.
   */
  txid: string;
  /** Output index inside the funding transaction. */
  vout: number;
};

/**
 * Read every input outpoint from a PSBT v2 base64 payload.
 *
 * Useful for the wallet-side "is this UTXO locked by a pending
 * proposal?" check — coin selection has to filter out outpoints
 * that another proposal has already claimed, otherwise both PSBTs
 * would target the same UTXO and one of them would be rejected at
 * broadcast time.
 *
 * The returned `txid` matches the hex string that was originally
 * passed into `addInput` (i.e. the form `Utxo.txid` carries on the
 * wallet side), so callers can compare against their `Utxo` list
 * without any byte reordering. Throws {@link PsbtBuildError} if the
 * payload is malformed or carries no inputs.
 */
export function extractPsbtInputs(
  psbtBase64: string,
): readonly PsbtInputOutpoint[] {
  let psbt: PsbtV2;
  try {
    psbt = new PsbtV2(psbtBase64);
  } catch (cause) {
    throw new PsbtBuildError(
      `Could not parse PSBT v2 payload (${(cause as Error).message}).`,
    );
  }
  const txids = psbt.PSBT_IN_PREVIOUS_TXID;
  const vouts = psbt.PSBT_IN_OUTPUT_INDEX;
  if (txids.length !== vouts.length) {
    throw new PsbtBuildError(
      `PSBT input count mismatch: ${txids.length} txids vs ${vouts.length} output indices.`,
    );
  }
  const outpoints: PsbtInputOutpoint[] = [];
  for (let i = 0; i < txids.length; i += 1) {
    const txid = txids[i];
    const vout = vouts[i];
    if (typeof txid !== 'string' || typeof vout !== 'number') {
      throw new PsbtBuildError(`Input ${i}: PSBT outpoint is malformed.`);
    }
    outpoints.push({ txid: reverseTxidHex(txid), vout });
  }
  return outpoints;
}

// =============================================================================
// Internals
// =============================================================================

type ParsedKey = {
  key: DescriptorKey;
  node: BIP32Interface;
  receiveNode: BIP32Interface;
  changeNode: BIP32Interface;
};

type Bip32DerivationEntry = {
  pubkey: Buffer;
  masterFingerprint: Buffer;
  path: string;
};

type PsbtSlot = {
  address: string;
  /** P2WSH locking script (`OP_0 OP_PUSHBYTES_32 sha256(witnessScript)`). */
  scriptPubKey: Buffer;
  /** The multisig redeem script (`p2ms.output`) hashed by the P2WSH wrapper. */
  witnessScript: Buffer;
  /**
   * Per-cosigner derivation block in PSBT-friendly Buffer form.
   * Mutable on the type level because `@caravan/psbt` accepts a
   * mutable array — semantically the builder still treats it as
   * immutable once constructed.
   */
  bip32Derivation: Bip32DerivationEntry[];
};

/**
 * Derive everything PSBT v2 needs for one `(chain, index)` slot of
 * the vault. Mirrors {@link buildWshSortedMultiInstance} but adds the
 * cosigner→pubkey→derivation-path mapping a PSBT input or change
 * output requires.
 */
function derivePsbtSlot(
  parsedKeys: readonly ParsedKey[],
  requiredSignatures: number,
  network: ReturnType<typeof networkOf>,
  chain: 0 | 1,
  index: number,
): PsbtSlot {
  if (!Number.isInteger(index) || index < 0) {
    throw new PsbtBuildError(
      `Address index must be a non-negative integer (got ${index}).`,
    );
  }

  const cosignerPubkeys = parsedKeys.map((parsed) => {
    const branch = chain === 0 ? parsed.receiveNode : parsed.changeNode;
    const child = branch.derive(index);
    return {
      key: parsed.key,
      pubkey: child.publicKey as Uint8Array,
    };
  });

  // sortedmulti: the on-chain script orders the compressed pubkeys
  // lexicographically before assembly. `bitcoinjs-lib`'s `p2ms`
  // factory does NOT sort on its own, so we hand it the sorted set.
  const sortedPubkeys = cosignerPubkeys
    .map((c) => c.pubkey)
    .slice()
    .sort(compareBytes);

  const p2ms = payments.p2ms({
    m: requiredSignatures,
    pubkeys: sortedPubkeys,
    network,
  });
  const p2wsh = payments.p2wsh({ redeem: p2ms, network });

  if (!p2wsh.address || !p2wsh.output || !p2ms.output) {
    throw new PsbtBuildError(
      'bitcoinjs-lib returned a P2WSH payment with missing fields.',
    );
  }

  const witnessScript = Buffer.from(p2ms.output);
  const scriptPubKey = Buffer.from(p2wsh.output);

  // PSBT bip32Derivation expects every cosigner in the input's
  // unsorted order so the device can match the signature it produces
  // back to its registered key. We pass the cosigners as the
  // operator listed them at vault create time (parsedKeys order).
  const chainSegment = `${chain}/${index}`;
  const bip32Derivation = cosignerPubkeys.map((c) => {
    const root = stripLeadingMaster(c.key.derivationPath);
    const fullPath = root.length > 0 ? `m/${root}/${chainSegment}` : `m/${chainSegment}`;
    return {
      pubkey: Buffer.from(c.pubkey),
      masterFingerprint: parseFingerprint(c.key.fingerprint),
      path: fullPath,
    };
  });

  return {
    address: p2wsh.address,
    scriptPubKey,
    witnessScript,
    bip32Derivation,
  };
}

/**
 * Convert any external bech32/base58 address into the locking script
 * `bitcoinjs-lib` would pay to. Throws on a malformed or wrong-network
 * address — that prevents a typo in the recipient input from silently
 * producing an unspendable output.
 */
function scriptForExternalAddress(
  address: string,
  network: ReturnType<typeof networkOf>,
): Buffer {
  const trimmed = address.trim();
  if (trimmed.length === 0) {
    throw new PsbtBuildError('Recipient address must not be empty.');
  }
  try {
    return Buffer.from(bitcoinAddress.toOutputScript(trimmed, network));
  } catch (cause) {
    throw new PsbtBuildError(
      `Recipient address is not a valid Bitcoin address (${(cause as Error).message}).`,
    );
  }
}

function assertRecipient(recipient: Recipient): void {
  if (!Number.isFinite(recipient.amountSats) || recipient.amountSats <= 0) {
    throw new PsbtBuildError(
      `Recipient amount must be a positive integer (got ${recipient.amountSats}).`,
    );
  }
  if (!Number.isInteger(recipient.amountSats)) {
    throw new PsbtBuildError(
      `Recipient amount must be an integer satoshi count (got ${recipient.amountSats}).`,
    );
  }
  if (recipient.amountSats < DUST_THRESHOLD_SATS) {
    throw new PsbtBuildError(
      `Recipient amount ${recipient.amountSats} sats is below the dust threshold (${DUST_THRESHOLD_SATS} sats).`,
    );
  }
}

function assertChange(change: ChangeOutput): void {
  if (change.chain !== 1) {
    throw new PsbtBuildError(
      `Change output must use chain 1 (got ${change.chain as number}).`,
    );
  }
  if (!Number.isInteger(change.amountSats) || change.amountSats <= 0) {
    throw new PsbtBuildError(
      `Change amount must be a positive integer satoshi count (got ${change.amountSats}).`,
    );
  }
  if (change.amountSats < DUST_THRESHOLD_SATS) {
    throw new PsbtBuildError(
      `Change amount ${change.amountSats} sats is below the dust threshold; coin selection should drop the change instead.`,
    );
  }
}

function fundingTransactionBuffer(utxo: Utxo, expectedScript: Buffer): Buffer {
  const raw = utxo.previousTxHex?.trim().toLowerCase();
  if (!raw || !/^[0-9a-f]+$/.test(raw) || raw.length % 2 !== 0) {
    throw new PsbtBuildError(
      `UTXO ${utxo.txid}:${utxo.vout} has invalid previous transaction hex.`,
    );
  }
  const buffer = Buffer.from(raw, 'hex');
  let transaction: Transaction;
  try {
    transaction = Transaction.fromBuffer(new Uint8Array(buffer));
  } catch (cause) {
    throw new PsbtBuildError(
      `UTXO ${utxo.txid}:${utxo.vout} previous transaction could not be parsed (${(cause as Error).message}).`,
    );
  }
  const actualTxid = transaction.getId();
  if (actualTxid.toLowerCase() !== utxo.txid.toLowerCase()) {
    throw new PsbtBuildError(
      `UTXO ${utxo.txid}:${utxo.vout} previous transaction hex resolves to ${actualTxid}.`,
    );
  }
  if (utxo.vout < 0 || utxo.vout >= transaction.outs.length) {
    throw new PsbtBuildError(
      `UTXO ${utxo.txid}:${utxo.vout} is outside the previous transaction output set.`,
    );
  }
  const output = transaction.outs[utxo.vout]!;
  if (Number(output.value) !== utxo.valueSats) {
    throw new PsbtBuildError(
      `UTXO ${utxo.txid}:${utxo.vout} amount does not match the previous transaction output.`,
    );
  }
  if (!bytesEqual(output.script, new Uint8Array(expectedScript))) {
    throw new PsbtBuildError(
      `UTXO ${utxo.txid}:${utxo.vout} script does not match the derived vault script.`,
    );
  }
  return buffer;
}

function stripLeadingMaster(path: string): string {
  const trimmed = path.trim();
  if (trimmed === '' || trimmed === 'm' || trimmed === 'M') return '';
  if (trimmed.startsWith('m/') || trimmed.startsWith('M/')) return trimmed.slice(2);
  return trimmed;
}

/**
 * Convert an 8-character hex master fingerprint (the form `V1_SignKeys`
 * stores) into the 4-byte `Buffer` PSBT requires.
 */
function parseFingerprint(fingerprint: string): Buffer {
  const trimmed = fingerprint.trim().toLowerCase();
  if (!/^[0-9a-f]{8}$/.test(trimmed)) {
    throw new PsbtBuildError(
      `Master fingerprint must be 8 lowercase hex characters (got "${fingerprint}").`,
    );
  }
  return Buffer.from(trimmed, 'hex');
}

/** BIP-67 ordering: compare compressed pubkeys as unsigned byte sequences. */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return a.length - b.length;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export { PsbtBuildError, reverseTxidHex };
