/**
 * `wsh(sortedmulti(...))` descriptor builder.
 *
 * Asylia is native-SegWit P2WSH multisig only. This module assembles the
 * canonical BIP-380 / BIP-389 descriptor for that policy and emits the
 * checksummed string ready to persist or hand to other Bitcoin tooling.
 *
 * Wire shape:
 *
 *   wsh(
 *     sortedmulti(
 *       N,
 *       [fp1/48'/0'/0'/2']xpub.../<0;1>/*,
 *       [fp2/48'/0'/0'/2']xpub.../<0;1>/*,
 *       ...
 *     )
 *   )#checksum
 *
 * Notes:
 *
 * - `sortedmulti` (not plain `multi`): the on-chain script sorts the
 *   compressed pubkeys lexicographically before assembling the multisig
 *   redeem script. The participants therefore do not have to agree on
 *   an order and the same vault gives the same address regardless of
 *   the input ordering.
 * - `<0;1>/*` is the BIP-389 multipath suffix: a single descriptor
 *   covers both the receive (chain `0`) and change (chain `1`) branches.
 *   Older tooling that does not understand BIP-389 should consume the
 *   `receiveDescriptor` / `changeDescriptor` siblings instead, which
 *   carry the chain index inline (`/0/*` or `/1/*`).
 * - All keys are normalised to the universal `xpub` form before being
 *   embedded so the descriptor is canonical (no SLIP-132 prefix
 *   ambiguity).
 *
 * The builder validates inputs aggressively: an out-of-range threshold,
 * duplicate keys, malformed fingerprints, or unparseable xpubs all
 * throw `DescriptorBuildError` before any string formatting happens.
 */
import { withChecksum } from './checksum';
import {
  describeNonMainnetXpub,
  detectExtendedPubkeyNetwork,
  isDerivationPathBody,
  isFingerprint,
  requireAsyliaBip48Root,
  stripMasterPrefix,
  toCanonicalXpub,
} from './normalize';
import type { BuildWshSortedMultiInput, BuildWshSortedMultiResult } from '../types';

/**
 * Hard cap on the number of cosigning keys.
 *
 * Bitcoin Core enforces 16 keys for `multi`/`sortedmulti`, but
 * realistic vaults (and most hardware-wallet UIs) cap at 15 to leave
 * headroom for the operator's own threshold + script type byte budget.
 * Asylia keeps the same cap so descriptors built here remain accepted
 * by every downstream consumer.
 */
const MAX_KEYS = 15;

/** Errors raised by the descriptor builder. */
export class DescriptorBuildError extends Error {
  override readonly name = 'DescriptorBuildError';
}

/**
 * Build the canonical Asylia descriptor for a multisig vault and the two
 * BIP-389-free siblings used by older tooling.
 */
export function buildWshSortedMultiDescriptor(
  input: BuildWshSortedMultiInput,
): BuildWshSortedMultiResult {
  const total = input.keys.length;
  const threshold = input.requiredSignatures;

  if (total < 1 || total > MAX_KEYS) {
    throw new DescriptorBuildError(
      `Number of keys must be between 1 and ${MAX_KEYS} (got ${total}).`,
    );
  }
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > total) {
    throw new DescriptorBuildError(
      `Required signatures must be an integer between 1 and ${total} (got ${threshold}).`,
    );
  }

  // Pre-validate every key + collect the canonical encoding.
  const canonicalKeys = input.keys.map((key, index) => {
    const fp = key.fingerprint.trim().toLowerCase();
    if (!isFingerprint(fp)) {
      throw new DescriptorBuildError(
        `Key #${index + 1}: fingerprint must be 8 hex characters, got "${key.fingerprint}".`,
      );
    }
    const path = stripMasterPrefix(key.derivationPath);
    if (!isDerivationPathBody(path)) {
      throw new DescriptorBuildError(
        `Key #${index + 1}: derivation path "${key.derivationPath}" is malformed.`,
      );
    }
    const asyliaRoot = requireAsyliaBip48Root(
      path,
      `Key #${index + 1}`,
      (message) => new DescriptorBuildError(message),
    );
    // Network check first so a testnet xpub surfaces a precise
    // "testnet not supported" message instead of the generic
    // "not valid base58check" fallback.
    const xpubInput = key.xpub.trim();
    const network = detectExtendedPubkeyNetwork(xpubInput);
    if (network !== 'mainnet') {
      throw new DescriptorBuildError(
        describeNonMainnetXpub(network, `Key #${index + 1}`)!,
      );
    }
    const xpub = toCanonicalXpub(xpubInput);
    if (xpub === null) {
      // Unreachable in practice — `detectExtendedPubkeyNetwork` just
      // returned 'mainnet' so the canonical encode must succeed.
      // Surface a precise message anyway in case `bs58check` ever
      // adds a stricter post-check.
      throw new DescriptorBuildError(
        `Key #${index + 1}: extended public key could not be canonicalised.`,
      );
    }
    return { fingerprint: fp, pathBody: asyliaRoot, xpub };
  });

  // Reject duplicates. The BIP-380 identity of a key is the fingerprint
  // + derivation path; two rows with the same identity would collapse
  // into one signer once the descriptor is parsed, silently weakening
  // the policy.
  const seen = new Set<string>();
  for (const key of canonicalKeys) {
    const id = `${key.fingerprint}:${key.pathBody}`;
    if (seen.has(id)) {
      throw new DescriptorBuildError(
        `Duplicate key in vault (fingerprint=${key.fingerprint}, path=${key.pathBody || 'm'}).`,
      );
    }
    seen.add(id);
  }

  // Network is captured for future-proofing; only mainnet is supported
  // today and the SLIP-132 normalisation in `toCanonicalXpub` already
  // anchors the output to mainnet `xpub`.
  if (input.network !== 'mainnet') {
    throw new DescriptorBuildError(
      `Unsupported network: ${input.network as string}. Only "mainnet" is supported today.`,
    );
  }

  const renderKey = (
    key: (typeof canonicalKeys)[number],
    suffix: '/<0;1>/*' | '/0/*' | '/1/*',
  ): string => {
    const origin = key.pathBody.length > 0
      ? `[${key.fingerprint}/${key.pathBody}]`
      : `[${key.fingerprint}]`;
    return `${origin}${key.xpub}${suffix}`;
  };

  const wrap = (suffix: '/<0;1>/*' | '/0/*' | '/1/*'): string => {
    const keys = canonicalKeys.map((key) => renderKey(key, suffix)).join(',');
    return `wsh(sortedmulti(${threshold},${keys}))`;
  };

  return {
    descriptor: withChecksum(wrap('/<0;1>/*')),
    receiveDescriptor: withChecksum(wrap('/0/*')),
    changeDescriptor: withChecksum(wrap('/1/*')),
  };
}
