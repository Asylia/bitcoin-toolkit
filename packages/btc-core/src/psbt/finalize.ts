/**
 * PSBT v2 finaliser + transaction extractor.
 *
 * Two short helpers that complete the signing saga so a fully-signed
 * proposal can be turned into a raw network-broadcastable Bitcoin
 * transaction:
 *
 *   - {@link countPsbtSigners} — return the number of distinct
 *     cosigners (by master fingerprint) that have attached at least
 *     one partial signature anywhere on the PSBT. The wallet UI uses
 *     this to flip a proposal into "ready to broadcast" without
 *     trusting an out-of-band lifecycle column.
 *   - {@link finaliseAndExtractTransaction} — convert PSBT v2 →
 *     PSBT v0 → bitcoinjs-lib `Psbt`, run the Input Finaliser +
 *     Transaction Extractor roles, and return the canonical hex
 *     payload a Bitcoin node would accept on `sendrawtransaction`.
 *
 * Both helpers are framework-agnostic and side-effect free; they can
 * be reused by the wallet SPA, a CLI, or future server tooling.
 */
import { Buffer } from 'buffer';
import { PsbtV2 } from '@caravan/psbt';
import { Psbt as BitcoinJsPsbt } from 'bitcoinjs-lib';

import { networkOf } from '../network';
import type { BitcoinNetwork } from '../types';
import { inspectPsbtV2, PsbtInspectError } from './inspect';

/** Errors raised by the finalise / extract helpers. */
export class PsbtFinaliseError extends Error {
  override readonly name = 'PsbtFinaliseError';
}

/**
 * Count the distinct cosigners that have attached at least one
 * partial signature to the PSBT.
 *
 * Identity is keyed off the BIP-32 master fingerprint surfaced by the
 * input's `bip32Derivation` block: the same value `V1_SignKeys`
 * stores per cosigner. A signer that has signed every input is
 * counted exactly once; a signer with no partial sigs anywhere is
 * not counted at all.
 *
 * Returns `0` (not throws) when the PSBT cannot be parsed, so the UI
 * can keep rendering a "0 of N" progress badge instead of going blank
 * on an unexpected payload.
 */
export function countPsbtSigners(psbtBase64: string): number {
  return collectSignerFingerprints(psbtBase64).size;
}

/**
 * Return the set of master fingerprints (lower-case hex, no `0x`
 * prefix) of every cosigner that has attached at least one partial
 * signature anywhere on the PSBT. Useful for the wallet to flag the
 * "Signed" / "Pending" status per cosigner row.
 *
 * Same fault-tolerance as {@link countPsbtSigners} — an unparsable
 * payload returns an empty set instead of throwing.
 */
export function collectSignerFingerprints(
  psbtBase64: string,
): ReadonlySet<string> {
  let inspected;
  try {
    inspected = inspectPsbtV2(psbtBase64);
  } catch (cause) {
    if (!(cause instanceof PsbtInspectError)) throw cause;
    return new Set<string>();
  }
  const fingerprints = new Set<string>();
  for (const input of inspected.inputs) {
    for (const sig of input.partialSigs) {
      const owner = input.bip32Derivation.find((entry) =>
        bytesEqual(entry.pubkey, sig.pubkey),
      );
      if (!owner) continue;
      fingerprints.add(bytesToHex(owner.masterFingerprint));
    }
  }
  return fingerprints;
}

/**
 * Convert a fully-signed PSBT v2 base64 payload into the raw network
 * transaction hex a Bitcoin node will accept on its
 * `sendrawtransaction` RPC (or the public broadcast endpoints
 * exposed by Mempool.space, Blockstream.info, Blockchain.com).
 *
 * The pipeline is:
 *
 *   1. Parse the PSBT v2 with `@caravan/psbt`.
 *   2. Re-encode it as PSBT v0 base64 (`PsbtV2.toV0`) — bitcoinjs-lib
 *      only speaks v0 today.
 *   3. Hand the v0 payload to bitcoinjs-lib's `Psbt`, run
 *      `finalizeAllInputs` (combiner + finaliser roles) and then
 *      `extractTransaction()` (extractor role).
 *   4. Serialise the resulting `Transaction` to hex.
 *
 * Throws {@link PsbtFinaliseError} on a malformed payload, an
 * incomplete signature set, or any failure surfaced by the
 * underlying finaliser (e.g. invalid signature). The original PSBT
 * is left untouched.
 */
export function finaliseAndExtractTransaction(
  psbtBase64: string,
  network: BitcoinNetwork = 'mainnet',
): { hex: string; txid: string; vbytes: number } {
  let psbtV2: PsbtV2;
  try {
    psbtV2 = new PsbtV2(psbtBase64);
  } catch (cause) {
    throw new PsbtFinaliseError(
      `Could not parse PSBT v2 payload (${(cause as Error).message}).`,
    );
  }

  let psbtV0Base64: string;
  try {
    psbtV0Base64 = psbtV2.toV0('base64');
  } catch (cause) {
    throw new PsbtFinaliseError(
      `Could not convert PSBT v2 → v0 (${(cause as Error).message}).`,
    );
  }

  let psbt: BitcoinJsPsbt;
  try {
    psbt = BitcoinJsPsbt.fromBase64(psbtV0Base64, { network: networkOf(network) });
  } catch (cause) {
    throw new PsbtFinaliseError(
      `bitcoinjs-lib refused the converted PSBT v0 payload (${(cause as Error).message}).`,
    );
  }

  try {
    psbt.finalizeAllInputs();
  } catch (cause) {
    throw new PsbtFinaliseError(
      `Could not finalise PSBT inputs (${(cause as Error).message}).`,
    );
  }

  let tx;
  try {
    tx = psbt.extractTransaction();
  } catch (cause) {
    throw new PsbtFinaliseError(
      `Could not extract the final transaction (${(cause as Error).message}).`,
    );
  }

  return {
    hex: bytesToHex(tx.toBuffer() as unknown as Uint8Array),
    txid: tx.getId(),
    vbytes: tx.virtualSize(),
  };
}

// =============================================================================
// Internals
// =============================================================================

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += (bytes[i] ?? 0).toString(16).padStart(2, '0');
  }
  return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// `Buffer` is imported only to keep the bundler happy when it walks
// the dependency graph — bitcoinjs-lib pulls it in transitively but
// some bundlers prefer to see an explicit reference here. Discarding
// the import would risk a cold-start "Buffer is not defined" in
// browsers without a polyfill.
void Buffer;
