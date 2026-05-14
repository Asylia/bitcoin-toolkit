/**
 * Address derivation for `wsh(sortedmulti(...))` vaults.
 *
 * Given the same key material the descriptor builder embeds in the
 * descriptor string, this module produces the on-chain receive / change
 * address for an arbitrary `(chain, index)` pair using the official
 * `bitcoinjs-lib` payment factories. We assemble the script in three
 * steps — exactly the steps any auditor can read off the BIP-380 spec:
 *
 *   1. Derive each cosigner's compressed public key at `chain/index`
 *      using a BIP-32 HD node built from the stored `xpub`.
 *   2. Sort the resulting public keys lexicographically (the
 *      `sortedmulti` part of the descriptor — this is what makes the
 *      address deterministic regardless of cosigner order).
 *   3. Wrap the sorted keys into a `p2ms` (multisig) redeem script and
 *      that into a `p2wsh` (native-SegWit witness script hash) payment
 *      to obtain the bech32 address.
 *
 * The function is pure: same inputs give the same address, no IO, no
 * device prompts. Auditors can verify the address output against
 * Bitcoin Core's `deriveaddresses` for the same descriptor as a
 * sanity check.
 */
import { payments } from 'bitcoinjs-lib';
import type { Payment } from 'bitcoinjs-lib';

import { bip32 } from '../crypto/ecc.ts';
import {
  describeNonMainnetXpub,
  detectExtendedPubkeyNetwork,
  toCanonicalXpub,
} from '../descriptor/normalize.ts';
import { networkOf } from '../network.ts';
import type {
  DeriveWshSortedMultiAddressBatchInput,
  DeriveWshSortedMultiAddressInput,
  WshSortedMultiAddressEntry,
} from '../types.ts';

/** Errors raised by address derivation. */
export class AddressDeriveError extends Error {
  override readonly name = 'AddressDeriveError';
}

/**
 * Full result of building one on-chain address for a vault.
 *
 * Carries the bitcoinjs-lib payment instances themselves (not just the
 * derived address string) so callers that need to inspect, audit, or
 * log the underlying scripts get them without re-deriving.
 *
 * Shape:
 *
 *   - `address`        — the bech32 P2WSH address actually paid to.
 *   - `p2wsh`          — the outer `bitcoin.payments.p2wsh` instance.
 *                        Holds the on-chain `output` (scriptPubKey),
 *                        the wrapped `redeem` script, and the address.
 *   - `p2ms`           — the inner `bitcoin.payments.p2ms` (sorted
 *                        multisig) instance. Holds `m`, the sorted
 *                        `pubkeys`, and the raw multisig `output`
 *                        (witness script).
 *   - `sortedPubkeys`  — the lexicographically sorted compressed
 *                        public keys actually fed into the multisig
 *                        builder. Same bytes as `p2ms.pubkeys` but
 *                        exposed at the top level for easy diffing
 *                        against the unsorted source order.
 *   - `chain` / `index`— echo of the path the address was derived at,
 *                        so a single log line tells you exactly which
 *                        receive / change slot you are looking at.
 */
export type WshSortedMultiInstance = {
  address: string;
  p2wsh: Payment;
  p2ms: Payment;
  sortedPubkeys: Uint8Array[];
  chain: 0 | 1;
  index: number;
};

/**
 * Build the full bitcoinjs-lib payment instance for one
 * `(chain, index)` slot of a `wsh(sortedmulti(...))` vault.
 *
 * Use this when you need the underlying scripts (audit logging, PSBT
 * construction, manual verification). For the common "I just need the
 * address string" case, prefer {@link deriveWshSortedMultiAddress}
 * which only returns the address.
 */
export function buildWshSortedMultiInstance(
  input: DeriveWshSortedMultiAddressInput,
): WshSortedMultiInstance {
  if (input.keys.length === 0) {
    throw new AddressDeriveError('At least one cosigning key is required.');
  }
  if (
    input.requiredSignatures < 1 ||
    input.requiredSignatures > input.keys.length
  ) {
    throw new AddressDeriveError(
      `Required signatures must be between 1 and ${input.keys.length}.`,
    );
  }
  if (!Number.isInteger(input.index) || input.index < 0) {
    throw new AddressDeriveError(
      `Address index must be a non-negative integer (got ${input.index}).`,
    );
  }
  if (input.chain !== 0 && input.chain !== 1) {
    throw new AddressDeriveError(
      `Chain must be 0 (receive) or 1 (change) (got ${input.chain as number}).`,
    );
  }

  const network = networkOf(input.network);
  const factory = bip32();

  const pubkeys: Uint8Array[] = input.keys.map((key, idx) => {
    const xpubInput = key.xpub.trim();
    const xpubNetwork = detectExtendedPubkeyNetwork(xpubInput);
    if (xpubNetwork !== 'mainnet') {
      throw new AddressDeriveError(
        describeNonMainnetXpub(xpubNetwork, `Key #${idx + 1}`)!,
      );
    }
    const xpub = toCanonicalXpub(xpubInput);
    if (xpub === null) {
      // Unreachable in practice — `detectExtendedPubkeyNetwork` just
      // returned 'mainnet' so canonicalisation must succeed. Keep
      // the explicit branch so a future bs58check upgrade that adds
      // additional checks fails loudly here instead of crashing
      // inside `factory.fromBase58`.
      throw new AddressDeriveError(
        `Key #${idx + 1}: extended public key could not be canonicalised.`,
      );
    }
    let node;
    try {
      node = factory.fromBase58(xpub, network);
    } catch (cause) {
      throw new AddressDeriveError(
        `Key #${idx + 1}: failed to parse extended public key (${(cause as Error).message}).`,
      );
    }
    const child = node.derive(input.chain).derive(input.index);
    // `bip32` exposes `publicKey` as `Uint8Array`; cast keeps the type
    // narrow for downstream consumers without depending on the
    // package's exported types.
    return child.publicKey as Uint8Array;
  });

  // sortedmulti: the descriptor sorts compressed public keys
  // lexicographically before assembling the multisig script. The
  // resulting on-chain script is therefore independent of the order in
  // which the operator listed the cosigners.
  const sortedPubkeys = sortPubkeysLex(pubkeys);

  const p2ms = payments.p2ms({
    m: input.requiredSignatures,
    pubkeys: sortedPubkeys,
    network,
  });

  const p2wsh = payments.p2wsh({
    redeem: p2ms,
    network,
  });

  if (!p2wsh.address) {
    // Unreachable in practice — `p2wsh` always populates `address`
    // when `redeem` and `network` are valid. Surface a precise error
    // anyway so a future bitcoinjs-lib upgrade that changes the
    // contract is caught immediately.
    throw new AddressDeriveError(
      'bitcoinjs-lib returned a P2WSH payment without an address.',
    );
  }

  return {
    address: p2wsh.address,
    p2wsh,
    p2ms,
    sortedPubkeys,
    chain: input.chain,
    index: input.index,
  };
}

/**
 * Convenience wrapper around {@link buildWshSortedMultiInstance} that
 * returns only the bech32 address. Use this when you don't need the
 * underlying scripts.
 */
export function deriveWshSortedMultiAddress(
  input: DeriveWshSortedMultiAddressInput,
): string {
  return buildWshSortedMultiInstance(input).address;
}

/**
 * Derive a contiguous range of `(chain, index)` addresses for a vault
 * in one call.
 *
 * Designed for the gap-limit walker that powers balance refresh and
 * "next unused address" lookups: instead of constructing the cosigner
 * BIP-32 nodes once per index, this builds them once per cosigner up
 * front and then derives `count` siblings from the same parent. For a
 * 20-slot window with three cosigners that is a 20× saving on the
 * (relatively expensive) `BIP32Factory.fromBase58` call.
 *
 * The returned entries are in ascending `index` order so the caller
 * can iterate top-down looking for the first unused slot without an
 * extra sort.
 */
export function deriveWshSortedMultiAddressBatch(
  input: DeriveWshSortedMultiAddressBatchInput,
): WshSortedMultiAddressEntry[] {
  if (input.keys.length === 0) {
    throw new AddressDeriveError('At least one cosigning key is required.');
  }
  if (
    input.requiredSignatures < 1 ||
    input.requiredSignatures > input.keys.length
  ) {
    throw new AddressDeriveError(
      `Required signatures must be between 1 and ${input.keys.length}.`,
    );
  }
  if (!Number.isInteger(input.startIndex) || input.startIndex < 0) {
    throw new AddressDeriveError(
      `Start index must be a non-negative integer (got ${input.startIndex}).`,
    );
  }
  if (!Number.isInteger(input.count) || input.count <= 0) {
    throw new AddressDeriveError(
      `Count must be a positive integer (got ${input.count}).`,
    );
  }
  if (input.chain !== 0 && input.chain !== 1) {
    throw new AddressDeriveError(
      `Chain must be 0 (receive) or 1 (change) (got ${input.chain as number}).`,
    );
  }

  const network = networkOf(input.network);
  const factory = bip32();

  // Build each cosigner's chain-level node once. Subsequent siblings
  // are then a single `derive(index)` step instead of a fresh xpub
  // parse + chain hop per address.
  const chainNodes = input.keys.map((key, idx) => {
    const xpubInput = key.xpub.trim();
    const xpubNetwork = detectExtendedPubkeyNetwork(xpubInput);
    if (xpubNetwork !== 'mainnet') {
      throw new AddressDeriveError(
        describeNonMainnetXpub(xpubNetwork, `Key #${idx + 1}`)!,
      );
    }
    const xpub = toCanonicalXpub(xpubInput);
    if (xpub === null) {
      throw new AddressDeriveError(
        `Key #${idx + 1}: extended public key could not be canonicalised.`,
      );
    }
    let node;
    try {
      node = factory.fromBase58(xpub, network);
    } catch (cause) {
      throw new AddressDeriveError(
        `Key #${idx + 1}: failed to parse extended public key (${(cause as Error).message}).`,
      );
    }
    return node.derive(input.chain);
  });

  const out: WshSortedMultiAddressEntry[] = new Array(input.count);
  for (let i = 0; i < input.count; i += 1) {
    const index = input.startIndex + i;

    const pubkeys = chainNodes.map(
      (chainNode) => chainNode.derive(index).publicKey as Uint8Array,
    );
    const sortedPubkeys = sortPubkeysLex(pubkeys);

    const p2ms = payments.p2ms({
      m: input.requiredSignatures,
      pubkeys: sortedPubkeys,
      network,
    });
    const p2wsh = payments.p2wsh({ redeem: p2ms, network });

    if (!p2wsh.address) {
      throw new AddressDeriveError(
        'bitcoinjs-lib returned a P2WSH payment without an address.',
      );
    }

    out[i] = { chain: input.chain, index, address: p2wsh.address };
  }
  return out;
}

/**
 * Stable lexicographic sort of compressed public keys. Mirrors the
 * `BIP67` ordering used by the on-chain `sortedmulti` opcode pattern,
 * which compares the raw 33-byte compressed pubkeys as unsigned byte
 * sequences (shorter wins on the first differing byte).
 *
 * Returns a fresh array; the input is never mutated.
 */
function sortPubkeysLex(pubkeys: readonly Uint8Array[]): Uint8Array[] {
  const copy = pubkeys.slice();
  copy.sort((a, b) => {
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i += 1) {
      const av = a[i] ?? 0;
      const bv = b[i] ?? 0;
      if (av !== bv) return av - bv;
    }
    return a.length - b.length;
  });
  return copy;
}
