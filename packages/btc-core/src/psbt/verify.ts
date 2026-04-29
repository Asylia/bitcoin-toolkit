/**
 * Post-flight signature verification for PSBT v2 partial sigs.
 *
 * The hardware-wallet flow for `wsh(sortedmulti(...))` has one
 * fragile failure mode that only surfaces at broadcast time:
 * **wrong attribution**. The wallet asks the device to sign for
 * cosigner X, the device — for whatever reason (wrong passphrase
 * active, stale session, user-managed multi-seed setup) — actually
 * signs with cosigner Y's key, the wallet stores the resulting
 * signature under cosigner X's pubkey in `PSBT_IN_PARTIAL_SIG`, and
 * `CHECKMULTISIG` later rejects it with NULLFAIL because the bytes
 * don't verify against the claimed pubkey.
 *
 * This module exposes a small "trust but verify" surface so the
 * adapter can validate any *fresh* signature it just received before
 * persisting it:
 *
 *   - {@link computeBip143SighashAll} — the BIP-143 / SegWit v0
 *     sighash for SIGHASH_ALL on one PSBT input. Pure function over
 *     the inspected PSBT and the input index; needs nothing more
 *     than what `inspectPsbtV2` already exposes.
 *   - {@link verifySegwitV0SignatureAgainstPubkey} — quick yes/no
 *     check: did this signature really come from this pubkey on this
 *     PSBT input?
 *   - {@link findSegwitV0SignatureOwner} — try every candidate
 *     pubkey and return the one the signature was actually made
 *     with, or `null` when none of them match. The trezor adapter
 *     uses this to *re-attribute* a signature when the user picked
 *     the wrong cosigner row but the device signed with another
 *     vault cosigner anyway.
 *
 * Verification is single-EC-point arithmetic — cheap. Doing it
 * after every device call is the sturdy guarantee that no broken
 * partial sig ever lands in the proposal store.
 */
import { Buffer } from 'buffer';
import * as ecc from '@bitcoinerlab/secp256k1';
import { sha256 } from '@noble/hashes/sha2.js';

import { reverseTxidHex } from './build';
import { inspectPsbtV2, type InspectedPsbt } from './inspect';

/** Errors raised by the verification helpers. */
export class PsbtVerifyError extends Error {
  override readonly name = 'PsbtVerifyError';
}

/**
 * Recompute the BIP-143 SIGHASH_ALL preimage hash for one input of a
 * PSBT v2. Mirrors the `Transaction.hashForWitnessV0` algorithm in
 * `bitcoinjs-lib` but works directly off the typed view that
 * `inspectPsbtV2` returns — no v0 conversion, no extra bitcoinjs
 * round trip. The amount, witness script, prev outpoints, sequence
 * vector, output vector, version and locktime all come straight
 * from the PSBT.
 *
 * Throws {@link PsbtVerifyError} if the input index is out of
 * range or the PSBT is missing data the algorithm needs.
 */
export function computeBip143SighashAll(
  inspected: InspectedPsbt,
  inputIndex: number,
): Uint8Array {
  if (
    !Number.isInteger(inputIndex) ||
    inputIndex < 0 ||
    inputIndex >= inspected.inputs.length
  ) {
    throw new PsbtVerifyError(
      `Input index ${inputIndex} is out of range (PSBT has ${inspected.inputs.length} inputs).`,
    );
  }
  const target = inspected.inputs[inputIndex]!;

  const version = inspected.txVersion >>> 0;
  // PSBT v2 either ships a fallback locktime or treats it as 0.
  // Asylia builds always use 0 — mirror that here so a missing
  // value lines up with what bitcoinjs-lib would write into the
  // unsigned tx.
  const locktime = (inspected.fallbackLocktime ?? 0) >>> 0;

  // hashPrevouts = double-SHA256( concat( reverse(txid_le) + vout_le ) )
  // The PSBT inspector already returns txids in big-endian display
  // order, so we flip them back to LE here — that's what the network
  // serialises into the outpoint bytes the sighash hashes over.
  const prevoutsBuf = Buffer.concat(
    inspected.inputs.map((inp) =>
      Buffer.concat([
        Buffer.from(reverseTxidHex(inp.txid), 'hex'),
        u32le(inp.vout),
      ]),
    ),
  );
  const hashPrevouts = doubleSha256(prevoutsBuf);

  // hashSequence = double-SHA256( concat(seq_le for each input) )
  // SIGHASH_ALL hashes every input's sequence; missing sequence
  // values fall back to 0xffffffff (final).
  const sequenceBuf = Buffer.concat(
    inspected.inputs.map((inp) => u32le(inp.sequence ?? 0xffffffff)),
  );
  const hashSequence = doubleSha256(sequenceBuf);

  // hashOutputs = double-SHA256( concat(value_le + varint(scriptlen) + script) )
  const outputsBuf = Buffer.concat(
    inspected.outputs.map((out) =>
      Buffer.concat([
        u64le(out.amountSats),
        varint(out.scriptPubKey.length),
        Buffer.from(out.scriptPubKey),
      ]),
    ),
  );
  const hashOutputs = doubleSha256(outputsBuf);

  const outpoint = Buffer.concat([
    Buffer.from(reverseTxidHex(target.txid), 'hex'),
    u32le(target.vout),
  ]);
  const witnessScript = Buffer.from(target.witnessScript);
  const sequence = target.sequence ?? 0xffffffff;

  const preimage = Buffer.concat([
    u32le(version),
    hashPrevouts,
    hashSequence,
    outpoint,
    varint(witnessScript.length),
    witnessScript,
    u64le(target.valueSats),
    u32le(sequence),
    hashOutputs,
    u32le(locktime),
    u32le(0x01), // SIGHASH_ALL
  ]);
  return doubleSha256(preimage);
}

/**
 * Verify a single PSBT partial-sig keypair: does the supplied DER
 * signature, when made over this PSBT input's BIP-143 sighash, match
 * the supplied 33-byte compressed pubkey?
 *
 * `signatureBytes` may be either the raw DER signature or the PSBT
 * encoding `<DER>0x01` (with the trailing SIGHASH_ALL byte) — the
 * helper strips a trailing `0x01` byte if present. Returns `false`
 * for any malformed input rather than throwing, so the caller can
 * use it as a clean predicate inside iteration loops.
 */
export function verifySegwitV0SignatureAgainstPubkey(
  inspected: InspectedPsbt,
  inputIndex: number,
  pubkey: Uint8Array,
  signatureBytes: Uint8Array,
): boolean {
  if (pubkey.length !== 33) return false;
  let der = signatureBytes;
  if (
    der.length > 0 &&
    der[der.length - 1] === 0x01 &&
    !looksLikeDerSignature(der)
  ) {
    der = der.slice(0, -1);
  }
  let compact;
  try {
    compact = derSignatureToCompact(der);
  } catch {
    return false;
  }
  let sighash;
  try {
    sighash = computeBip143SighashAll(inspected, inputIndex);
  } catch {
    return false;
  }
  return ecc.verify(sighash, pubkey, compact);
}

/**
 * Try every candidate pubkey on a PSBT input until one verifies
 * against the supplied signature. Returns the matching pubkey
 * (`Uint8Array` reference from the input slice — `bytesEqual` is
 * the safe comparator) or `null` when none of them match.
 *
 * The trezor adapter uses this as its post-flight safety net: when
 * a freshly returned signature does not verify against the picked
 * cosigner's pubkey, the adapter feeds in every cosigner pubkey
 * that appears in this input's `bip32Derivation` block; if the sig
 * was made by *some* vault cosigner it gets re-attributed to the
 * correct slot, otherwise the adapter refuses the signature.
 */
export function findSegwitV0SignatureOwner(
  inspected: InspectedPsbt,
  inputIndex: number,
  signatureBytes: Uint8Array,
  candidatePubkeys: readonly Uint8Array[],
): Uint8Array | null {
  for (const candidate of candidatePubkeys) {
    if (
      verifySegwitV0SignatureAgainstPubkey(
        inspected,
        inputIndex,
        candidate,
        signatureBytes,
      )
    ) {
      return candidate;
    }
  }
  return null;
}

/**
 * Convenience wrapper for callers that hold the raw PSBT base64
 * and don't want to inspect it themselves first. Identical
 * semantics to {@link findSegwitV0SignatureOwner}.
 */
export function findSegwitV0SignatureOwnerForPsbt(
  psbtBase64: string,
  inputIndex: number,
  signatureBytes: Uint8Array,
  candidatePubkeys: readonly Uint8Array[],
): Uint8Array | null {
  const inspected = inspectPsbtV2(psbtBase64);
  return findSegwitV0SignatureOwner(
    inspected,
    inputIndex,
    signatureBytes,
    candidatePubkeys,
  );
}

// =============================================================================
// Internals
// =============================================================================

function u32le(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value >>> 0, 0);
  return buf;
}

function u64le(value: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(value), 0);
  return buf;
}

function varint(value: number): Buffer {
  if (value < 0xfd) return Buffer.from([value]);
  if (value <= 0xffff) {
    const buf = Buffer.alloc(3);
    buf[0] = 0xfd;
    buf.writeUInt16LE(value, 1);
    return buf;
  }
  if (value <= 0xffff_ffff) {
    const buf = Buffer.alloc(5);
    buf[0] = 0xfe;
    buf.writeUInt32LE(value, 1);
    return buf;
  }
  // PSBT inputs / outputs never push >2^32 bytes through here, so
  // a 0xff varint would indicate a malformed payload upstream.
  throw new PsbtVerifyError(`varint value ${value} exceeds 32 bits.`);
}

function looksLikeDerSignature(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false;
  if (bytes[0] !== 0x30) return false;
  const sequenceLength = bytes[1];
  if (sequenceLength === undefined || sequenceLength + 2 !== bytes.length) {
    return false;
  }
  if (bytes[2] !== 0x02) return false;
  const rLength = bytes[3];
  if (rLength === undefined || rLength === 0) return false;
  const sTagIndex = 4 + rLength;
  if (sTagIndex + 2 > bytes.length) return false;
  if (bytes[sTagIndex] !== 0x02) return false;
  const sLength = bytes[sTagIndex + 1];
  if (sLength === undefined || sLength === 0) return false;
  return sTagIndex + 2 + sLength === bytes.length;
}

function doubleSha256(data: Buffer): Uint8Array {
  return sha256(sha256(data));
}

/**
 * Convert a DER-encoded ECDSA signature into the 64-byte (r ‖ s)
 * compact form that `@bitcoinerlab/secp256k1`'s `verify` expects.
 * Leading zero padding is stripped and missing bytes are zero-padded
 * back up to 32 bytes per scalar so a low-S signature with shorter
 * encoding still verifies.
 */
function derSignatureToCompact(der: Uint8Array): Uint8Array {
  if (der.length < 8 || der[0] !== 0x30) {
    throw new PsbtVerifyError('signature is not a DER sequence');
  }
  // Skip header byte + total-length byte.
  let offset = 2;
  if (der[offset] !== 0x02) {
    throw new PsbtVerifyError('expected r INTEGER tag');
  }
  offset += 1;
  const rLen = der[offset]!;
  offset += 1;
  let r = der.slice(offset, offset + rLen);
  offset += rLen;
  if (der[offset] !== 0x02) {
    throw new PsbtVerifyError('expected s INTEGER tag');
  }
  offset += 1;
  const sLen = der[offset]!;
  offset += 1;
  let s = der.slice(offset, offset + sLen);
  // Drop the optional leading 0x00 padding that DER adds when the
  // high bit of the first byte would otherwise mark the integer
  // as negative.
  if (r.length > 32) r = r.slice(r.length - 32);
  if (s.length > 32) s = s.slice(s.length - 32);
  if (r.length < 32) {
    const padded = new Uint8Array(32);
    padded.set(r, 32 - r.length);
    r = padded;
  }
  if (s.length < 32) {
    const padded = new Uint8Array(32);
    padded.set(s, 32 - s.length);
    s = padded;
  }
  const out = new Uint8Array(64);
  out.set(r, 0);
  out.set(s, 32);
  return out;
}
