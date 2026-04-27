/**
 * PSBT v2 inspection & partial-signature combiner.
 *
 * `@asylia/btc-core` already builds PSBT v2 payloads from scratch
 * (`psbt/build.ts`). This module covers the *other* direction: reading
 * an existing PSBT v2 string into a structured, hardware-adapter-
 * friendly shape and merging fresh partial signatures back in.
 *
 * Both helpers stay framework- and signer-agnostic. They turn raw
 * `@caravan/psbt` getters (which return PSBT keys/values as hex
 * strings) into typed `Uint8Array` blocks plus already-parsed BIP-32
 * derivation paths so a hardware-wallet adapter never has to
 * re-implement low-level PSBT decoding.
 *
 * What the inspect helper exposes per input:
 *
 *   - `txid`, `vout`, `sequence` — outpoint + nSequence as a single
 *     bundle so an adapter can build its own `TxInput` structure.
 *   - `valueSats`, `scriptPubKey` — extracted from the witness UTXO
 *     (`PSBT_IN_WITNESS_UTXO`); satoshi amounts are returned as plain
 *     `number` because every realistic value sits well below
 *     `Number.MAX_SAFE_INTEGER`.
 *   - `witnessScript` — the multisig redeem script the input pays to.
 *   - `bip32Derivation` — every cosigner's `(pubkey, masterFingerprint,
 *     path)` triple. `path` is rebuilt as a BIP-32 string (e.g.
 *     `m/48'/0'/0'/2'/0/5`) so adapters can derive an `address_n`
 *     array without re-parsing the raw bytes.
 *   - `partialSigs` — every partial signature already attached to the
 *     input (raw bytes, sighash byte included if present) with the
 *     pubkey it belongs to.
 *
 * Outputs are inspected the same way: amount, script, optional
 * witness script + bip32Derivation when the output represents change
 * back to the vault.
 *
 * The combiner helper is the dual of {@link inspectPsbtV2}. It accepts
 * `(inputIndex, pubkey, signature)` triples and writes them into the
 * PSBT's `PSBT_IN_PARTIAL_SIG` map, automatically appending the
 * `SIGHASH_ALL` byte (0x01) — Asylia signs every spend with the
 * default sighash, which matches what the BIP-380 sortedmulti
 * descriptor expects when the output is finalised.
 */
import { Buffer } from 'buffer';
import { PsbtV2 } from '@caravan/psbt';
import { address as bitcoinAddress } from 'bitcoinjs-lib';

import { networkOf } from '../network';
import type { BitcoinNetwork } from '../types';
import { reverseTxidHex } from './build';

/** Errors raised by the inspect / combine helpers. */
export class PsbtInspectError extends Error {
  override readonly name = 'PsbtInspectError';
}

/** One `(pubkey, masterFingerprint, path)` triple from a PSBT map. */
export type PsbtBip32Derivation = {
  /** 33-byte compressed cosigner pubkey at the input/output's `(chain, index)` slot. */
  pubkey: Uint8Array;
  /** 4-byte BIP-380 master fingerprint of the cosigner's root key. */
  masterFingerprint: Uint8Array;
  /**
   * BIP-32 derivation path as a printable string with leading `m/`.
   * Example: `m/48'/0'/0'/2'/0/5`. Hardened components use the
   * canonical `'` notation regardless of how they were originally
   * encoded.
   */
  path: string;
};

/** One partial signature already collected on a PSBT input. */
export type PsbtPartialSig = {
  /** 33-byte compressed pubkey the signature belongs to. */
  pubkey: Uint8Array;
  /**
   * Raw signature bytes exactly as stored in the PSBT — for the BIP
   * standard sighash this is `<DER>0x01`. The combiner helper writes
   * back the same encoding.
   */
  signature: Uint8Array;
};

/** Inspected PSBT v2 input. */
export type InspectedPsbtInput = {
  /**
   * Big-endian (display) txid — the form block explorers and Bitcoin
   * RPC print, suitable as `Trezor.prev_hash` and for direct
   * comparison against `Utxo.txid`. The PSBT itself stores the txid
   * in little-endian internal order; this view reverses it back so
   * adapters never need to handle the byte-order subtlety.
   */
  txid: string;
  vout: number;
  valueSats: number;
  scriptPubKey: Uint8Array;
  witnessScript: Uint8Array;
  bip32Derivation: readonly PsbtBip32Derivation[];
  partialSigs: readonly PsbtPartialSig[];
  /** Explicit nSequence value, or `null` when the PSBT did not set one. */
  sequence: number | null;
};

/** Inspected PSBT v2 output. */
export type InspectedPsbtOutput = {
  amountSats: number;
  scriptPubKey: Uint8Array;
  /** Present when the output is a P2WSH change back to the vault. */
  witnessScript: Uint8Array | null;
  bip32Derivation: readonly PsbtBip32Derivation[];
};

/** Full inspected view of a PSBT v2 payload. */
export type InspectedPsbt = {
  /** Bitcoin transaction version. Asylia always builds v2 (BIP-370). */
  txVersion: number;
  /** Fallback locktime advertised by the PSBT, or `null`. */
  fallbackLocktime: number | null;
  inputs: readonly InspectedPsbtInput[];
  outputs: readonly InspectedPsbtOutput[];
};

/**
 * Decode a base64 PSBT v2 payload into a typed view that adapters
 * can iterate over without touching `@caravan/psbt` directly.
 */
export function inspectPsbtV2(psbtBase64: string): InspectedPsbt {
  const psbt = parseOrThrow(psbtBase64);

  const txids = psbt.PSBT_IN_PREVIOUS_TXID;
  const vouts = psbt.PSBT_IN_OUTPUT_INDEX;
  const witnessUtxos = psbt.PSBT_IN_WITNESS_UTXO;
  const witnessScripts = psbt.PSBT_IN_WITNESS_SCRIPT;
  const bip32InAll = psbt.PSBT_IN_BIP32_DERIVATION;
  const partialSigsAll = psbt.PSBT_IN_PARTIAL_SIG;
  const sequences = psbt.PSBT_IN_SEQUENCE;

  if (txids.length !== vouts.length) {
    throw new PsbtInspectError(
      `Input count mismatch: ${txids.length} txids vs ${vouts.length} vouts.`,
    );
  }

  const inputs: InspectedPsbtInput[] = [];
  for (let i = 0; i < txids.length; i += 1) {
    const txid = txids[i];
    const vout = vouts[i];
    if (typeof txid !== 'string' || typeof vout !== 'number') {
      throw new PsbtInspectError(`Input ${i}: outpoint missing.`);
    }

    const witnessUtxoHex = witnessUtxos[i];
    if (!witnessUtxoHex) {
      throw new PsbtInspectError(
        `Input ${i}: PSBT_IN_WITNESS_UTXO is missing — Asylia only spends SegWit (P2WSH) inputs.`,
      );
    }
    const { amountSats, scriptPubKey } = parseWitnessUtxo(witnessUtxoHex);

    const witnessScriptHex = witnessScripts[i];
    if (!witnessScriptHex) {
      throw new PsbtInspectError(
        `Input ${i}: PSBT_IN_WITNESS_SCRIPT is missing — cannot sign a P2WSH input without its redeem script.`,
      );
    }

    inputs.push({
      txid: reverseTxidHex(txid),
      vout,
      valueSats: amountSats,
      scriptPubKey,
      witnessScript: hexToBytes(witnessScriptHex),
      // Inputs use PSBT_IN_BIP32_DERIVATION (keytype 0x06).
      bip32Derivation: parseBip32DerivationList(bip32InAll[i] ?? [], 0x06),
      partialSigs: parsePartialSigList(partialSigsAll[i] ?? []),
      sequence: sequences[i] ?? null,
    });
  }

  const amounts = psbt.PSBT_OUT_AMOUNT;
  const scripts = psbt.PSBT_OUT_SCRIPT;
  const outWitnessScripts = psbt.PSBT_OUT_WITNESS_SCRIPT;
  const bip32OutAll = normaliseOutputBip32Maps(
    psbt.PSBT_OUT_BIP32_DERIVATION,
    amounts.length,
  );

  if (amounts.length !== scripts.length) {
    throw new PsbtInspectError(
      `Output count mismatch: ${amounts.length} amounts vs ${scripts.length} scripts.`,
    );
  }

  const outputs: InspectedPsbtOutput[] = [];
  for (let i = 0; i < amounts.length; i += 1) {
    const amount = amounts[i];
    const script = scripts[i];
    if (amount === undefined || script === undefined) {
      throw new PsbtInspectError(`Output ${i}: amount or script missing.`);
    }
    outputs.push({
      amountSats: Number(amount),
      scriptPubKey: hexToBytes(script),
      witnessScript: outWitnessScripts[i] ? hexToBytes(outWitnessScripts[i]!) : null,
      // Outputs use PSBT_OUT_BIP32_DERIVATION (keytype 0x02), not the
      // input keytype 0x06 — getting these crossed throws
      // `PsbtInspectError: bip32Derivation: unexpected key type 0x02`
      // the moment a transaction includes a change output (the only
      // case where outputs carry bip32Derivation entries at all).
      bip32Derivation: parseBip32DerivationList(bip32OutAll[i] ?? [], 0x02),
    });
  }

  return {
    txVersion: psbt.PSBT_GLOBAL_TX_VERSION,
    fallbackLocktime: psbt.PSBT_GLOBAL_FALLBACK_LOCKTIME,
    inputs,
    outputs,
  };
}

/** One signature to merge into a PSBT through {@link addPartialSignaturesToPsbt}. */
export type PartialSignatureToAdd = {
  /** Index of the PSBT input the signature belongs to. */
  inputIndex: number;
  /** 33-byte compressed pubkey that produced the signature. */
  pubkey: Uint8Array;
  /**
   * DER-encoded signature bytes WITHOUT the trailing sighash byte.
   * The combiner appends `0x01` (SIGHASH_ALL) before storing the
   * keypair so the resulting PSBT round-trips through every standard
   * finaliser.
   */
  signature: Uint8Array;
};

/**
 * Merge a batch of partial signatures into a PSBT v2 payload. The
 * input PSBT is left untouched; a fresh base64 string with the new
 * `PSBT_IN_PARTIAL_SIG` entries is returned.
 *
 * Throws {@link PsbtInspectError} on a malformed payload, an
 * out-of-range `inputIndex`, or any failure raised by the underlying
 * `PsbtV2.addPartialSig` (e.g. trying to add a duplicate signature
 * for the same pubkey).
 */
export function addPartialSignaturesToPsbt(
  psbtBase64: string,
  signatures: readonly PartialSignatureToAdd[],
): string {
  const psbt = parseOrThrow(psbtBase64);
  const inputCount = psbt.PSBT_IN_PREVIOUS_TXID.length;

  for (const sig of signatures) {
    if (
      !Number.isInteger(sig.inputIndex) ||
      sig.inputIndex < 0 ||
      sig.inputIndex >= inputCount
    ) {
      throw new PsbtInspectError(
        `Partial signature targets non-existent input index ${sig.inputIndex} (PSBT has ${inputCount} inputs).`,
      );
    }
    if (sig.pubkey.length !== 33) {
      throw new PsbtInspectError(
        `Partial signature pubkey must be 33 bytes (got ${sig.pubkey.length}).`,
      );
    }
    if (sig.signature.length === 0) {
      throw new PsbtInspectError(
        `Partial signature for input ${sig.inputIndex} is empty.`,
      );
    }

    const sighashed = new Uint8Array(sig.signature.length + 1);
    sighashed.set(sig.signature, 0);
    sighashed[sig.signature.length] = 0x01;

    try {
      psbt.addPartialSig(
        sig.inputIndex,
        Buffer.from(sig.pubkey),
        Buffer.from(sighashed),
      );
    } catch (cause) {
      throw new PsbtInspectError(
        `Could not attach partial signature to input ${sig.inputIndex}: ${(cause as Error).message}`,
      );
    }
  }
  return psbt.serialize('base64');
}

/**
 * Decode a `scriptPubKey` back into the standard mainnet bech32 /
 * base58 address. Used by hardware adapters that have to render an
 * outgoing recipient on the device — the PSBT carries the script,
 * the device speaks addresses.
 *
 * Returns `null` for non-standard scripts so the caller can decide
 * how to handle them (typically: refuse to sign).
 */
export function addressFromScript(
  script: Uint8Array,
  network: BitcoinNetwork,
): string | null {
  try {
    return bitcoinAddress.fromOutputScript(Buffer.from(script), networkOf(network));
  } catch {
    return null;
  }
}

/**
 * Convert a printable BIP-32 path (`m/48'/0'/0'/2'/0/5`) into the
 * `address_n` array Trezor / Ledger devices expect (`[0x80000030,
 * 0x80000000, 0x80000000, 0x80000002, 0, 5]`). Hardened components
 * accept either `'` or `h`/`H` notation.
 */
export function bip32PathToAddressN(path: string): number[] {
  const trimmed = path.trim();
  const body =
    trimmed === 'm' || trimmed === 'M'
      ? ''
      : trimmed.replace(/^m\//i, '');
  if (body === '') return [];
  const parts = body.split('/');
  return parts.map((part, i) => {
    const hardened = /['hH]$/.test(part);
    const raw = hardened ? part.slice(0, -1) : part;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0) {
      throw new PsbtInspectError(
        `Invalid BIP-32 path component "${part}" at position ${i + 1}.`,
      );
    }
    if (hardened) {
      // Force the high bit on while keeping the result in unsigned 32-bit
      // space — `0x80000000 | x` flips JS to a signed int otherwise.
      return ((value | 0x80000000) >>> 0);
    }
    return value;
  });
}

// =============================================================================
// Internals
// =============================================================================

function parseOrThrow(psbtBase64: string): PsbtV2 {
  try {
    return new PsbtV2(psbtBase64);
  } catch (cause) {
    throw new PsbtInspectError(
      `Could not parse PSBT v2 payload (${(cause as Error).message}).`,
    );
  }
}

function parseWitnessUtxo(hex: string): {
  amountSats: number;
  scriptPubKey: Uint8Array;
} {
  const bytes = hexToBytes(hex);
  if (bytes.length < 9) {
    throw new PsbtInspectError(`Truncated witness UTXO (${hex}).`);
  }
  const amount = readUInt64LE(bytes, 0);
  if (amount > Number.MAX_SAFE_INTEGER) {
    throw new PsbtInspectError(
      `Witness UTXO amount overflows JS safe integer (${amount}).`,
    );
  }
  const { value: scriptLen, length: lenBytes } = readVarInt(bytes, 8);
  const scriptStart = 8 + lenBytes;
  const scriptEnd = scriptStart + scriptLen;
  if (scriptEnd !== bytes.length) {
    throw new PsbtInspectError(
      `Witness UTXO has trailing bytes (expected ${scriptEnd}, got ${bytes.length}).`,
    );
  }
  return {
    amountSats: Number(amount),
    scriptPubKey: bytes.slice(scriptStart, scriptEnd),
  };
}

type RawKeyValue = { key: string; value: string | null };

/**
 * Parse one bip32 derivation map into the typed `(pubkey, fingerprint,
 * path)` triples. The `expectedKeyType` argument disambiguates
 * input maps (`PSBT_IN_BIP32_DERIVATION`, keytype `0x06`) from output
 * maps (`PSBT_OUT_BIP32_DERIVATION`, keytype `0x02`) — sharing one
 * helper between the two with a hardcoded keytype is what produced
 * the `unexpected key type 0x02 (expected 0x06)` regression on every
 * PSBT that carried a change output.
 */
function parseBip32DerivationList(
  entries: readonly RawKeyValue[],
  expectedKeyType: number,
): PsbtBip32Derivation[] {
  return entries.map((entry, i) => {
    if (entry.value === null) {
      throw new PsbtInspectError(`bip32Derivation entry ${i}: value is missing.`);
    }
    const pubkey = stripKeyTypeByte(
      entry.key,
      expectedKeyType,
      'bip32Derivation',
    );
    const { masterFingerprint, path } = parseBip32DerivationValue(entry.value);
    return { pubkey, masterFingerprint, path };
  });
}

function parsePartialSigList(
  entries: readonly RawKeyValue[],
): PsbtPartialSig[] {
  return entries.map((entry, i) => {
    if (entry.value === null) {
      throw new PsbtInspectError(`Partial signature ${i}: value is missing.`);
    }
    return {
      pubkey: stripKeyTypeByte(entry.key, 0x02, 'partialSig'),
      signature: hexToBytes(entry.value),
    };
  });
}

/**
 * The `PSBT_OUT_BIP32_DERIVATION` getter is typed as
 * `NonUniqueKeyTypeValue[] | NonUniqueKeyTypeValue[][]` because of how
 * the underlying map flattens single-output PSBTs. In practice every
 * output that holds bip32Derivation entries returns its own inner
 * array; this normaliser pads to `outputCount` so a per-output index
 * lookup stays trivial.
 */
function normaliseOutputBip32Maps(
  raw: RawKeyValue[] | RawKeyValue[][],
  outputCount: number,
): RawKeyValue[][] {
  if (!Array.isArray(raw)) return new Array(outputCount).fill([]);
  if (raw.length === 0) return new Array(outputCount).fill([]);
  // Empty PSBTs surface as `[]`. Otherwise each element either is an
  // inner array (`[{key,value}, ...]`) or — for the degenerate
  // single-output case — a single `{key,value}` row at the top level.
  const looksNested = Array.isArray(raw[0]);
  if (looksNested) {
    const nested = raw as RawKeyValue[][];
    if (nested.length >= outputCount) return nested;
    const padded = nested.slice();
    while (padded.length < outputCount) padded.push([]);
    return padded;
  }
  // Flat shape: treat every entry as belonging to output 0.
  const flat = raw as RawKeyValue[];
  const padded: RawKeyValue[][] = new Array(outputCount).fill(0).map(() => []);
  padded[0] = flat;
  return padded;
}

function stripKeyTypeByte(
  keyHex: string,
  expectedType: number,
  label: string,
): Uint8Array {
  const bytes = hexToBytes(keyHex);
  if (bytes.length === 0) {
    throw new PsbtInspectError(`${label}: empty PSBT key.`);
  }
  if (bytes[0] !== expectedType) {
    throw new PsbtInspectError(
      `${label}: unexpected key type 0x${bytes[0]!.toString(16).padStart(2, '0')} (expected 0x${expectedType.toString(16).padStart(2, '0')}).`,
    );
  }
  return bytes.slice(1);
}

function parseBip32DerivationValue(valueHex: string): {
  masterFingerprint: Uint8Array;
  path: string;
} {
  const value = hexToBytes(valueHex);
  if (value.length < 4) {
    throw new PsbtInspectError(`Malformed bip32 derivation value (${valueHex}).`);
  }
  if ((value.length - 4) % 4 !== 0) {
    throw new PsbtInspectError(
      `bip32 derivation path length ${value.length - 4} is not a multiple of 4 bytes.`,
    );
  }
  const masterFingerprint = value.slice(0, 4);
  const components: string[] = [];
  for (let offset = 4; offset < value.length; offset += 4) {
    const child = readUInt32LE(value, offset);
    if ((child & 0x80000000) !== 0) {
      const stripped = (child & 0x7fffffff) >>> 0;
      components.push(`${stripped}'`);
    } else {
      components.push(`${child}`);
    }
  }
  const path = components.length > 0 ? `m/${components.join('/')}` : 'm';
  return { masterFingerprint, path };
}

function hexToBytes(hex: string): Uint8Array {
  const normalised = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (normalised.length % 2 !== 0) {
    throw new PsbtInspectError(`Hex string of odd length (${normalised.length}).`);
  }
  const out = new Uint8Array(normalised.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    const byte = Number.parseInt(normalised.substr(i * 2, 2), 16);
    if (Number.isNaN(byte)) {
      throw new PsbtInspectError(`Invalid hex byte at offset ${i * 2}.`);
    }
    out[i] = byte;
  }
  return out;
}

function readUInt32LE(bytes: Uint8Array, offset: number): number {
  if (offset + 4 > bytes.length) {
    throw new PsbtInspectError(`Truncated uint32 at offset ${offset}.`);
  }
  return (
    ((bytes[offset]! |
      (bytes[offset + 1]! << 8) |
      (bytes[offset + 2]! << 16) |
      (bytes[offset + 3]! << 24)) >>>
      0)
  );
}

function readUInt64LE(bytes: Uint8Array, offset: number): number {
  if (offset + 8 > bytes.length) {
    throw new PsbtInspectError(`Truncated uint64 at offset ${offset}.`);
  }
  // Combine two uint32 halves — keeps the math in safe-integer space
  // for every realistic satoshi value (max 2.1 × 10^15 ≪ 2^53).
  const lo = readUInt32LE(bytes, offset);
  const hi = readUInt32LE(bytes, offset + 4);
  return hi * 0x1_0000_0000 + lo;
}

function readVarInt(
  bytes: Uint8Array,
  offset: number,
): { value: number; length: number } {
  if (offset >= bytes.length) {
    throw new PsbtInspectError(`Truncated varint at offset ${offset}.`);
  }
  const first = bytes[offset]!;
  if (first < 0xfd) return { value: first, length: 1 };
  if (first === 0xfd) {
    if (offset + 3 > bytes.length) {
      throw new PsbtInspectError(`Truncated 0xfd varint at offset ${offset}.`);
    }
    return { value: bytes[offset + 1]! | (bytes[offset + 2]! << 8), length: 3 };
  }
  if (first === 0xfe) {
    return { value: readUInt32LE(bytes, offset + 1), length: 5 };
  }
  // 0xff = 8-byte varint. We never see one in our PSBT shapes
  // (witnessUtxo scripts are tens of bytes, never ≥ 2^32) so we
  // refuse it to keep the surface tight.
  throw new PsbtInspectError(`Unsupported 0xff varint at offset ${offset}.`);
}
