/**
 * Vault identity (logical canonical key).
 *
 * The BIP-380 descriptor string is the on-chain identity of a vault: two
 * vaults sharing the same checksummed descriptor produce the same
 * addresses and the same on-chain footprint. PostgREST already enforces
 * this via a unique constraint on `(user_id, descriptor)`.
 *
 * Operators, however, work with a richer notion of "the same vault":
 *
 *   - The cosigner order is irrelevant. `wsh(sortedmulti(...))` sorts
 *     compressed pubkeys lexicographically before assembling the on-chain
 *     script, so two descriptors that list the same keys in different
 *     orders derive the *same* addresses but render as *different*
 *     descriptor strings. The DB-level uniqueness check on the literal
 *     descriptor would let those two slip through; the operator would
 *     end up with two cards on the dashboard pointing at the same vault.
 *   - Imports come from many tools (Caravan, Sparrow, our own export).
 *     Each tool serialises its keys in a slightly different order, so
 *     deduplication based on the verbatim descriptor would miss
 *     re-imports of an already-registered vault.
 *
 * `vaultIdentityKey` collapses those edge cases into a single string by:
 *
 *   1. Normalising every cosigner: SLIP-132 prefix → universal `xpub`,
 *      fingerprint to lowercase hex, derivation path stripped of the
 *      leading `m/`.
 *   2. Sorting the cosigner list deterministically (canonical xpub →
 *      fingerprint → path). The result is independent of the input
 *      order, which mirrors how `sortedmulti` actually produces
 *      addresses on-chain.
 *   3. Joining policy + script tag + sorted cosigners into a delimited
 *      string. The string is meant for equality comparison only — never
 *      parsed back, never embedded in a descriptor — so the format can
 *      stay short, human-readable, and dependency-free.
 *
 * Use at the boundary of every "create vault" path (manual flow + every
 * import format) so duplicate detection catches the operator before the
 * DB write fails with a generic unique-violation error.
 */
import {
  canonicalizeDerivationPath,
  describeNonMainnetXpub,
  detectExtendedPubkeyNetwork,
  requireAsyliaBip48Root,
  stripMasterPrefix,
  toCanonicalXpub,
} from './descriptor/normalize';
import type { DescriptorKey, ScriptPolicy } from './types';

/** Errors raised by {@link vaultIdentityKey}. */
export class VaultIdentityError extends Error {
  override readonly name = 'VaultIdentityError';
}

/**
 * Inputs accepted by {@link vaultIdentityKey}.
 *
 * Mirrors the create-vault payload so the same value the descriptor
 * builder consumes can be funnelled straight into the dedup check.
 */
export type VaultIdentityInput = {
  /** Threshold (`N` in `N-of-T`). */
  requiredSignatures: number;
  /** Total cosigning keys (`T`). Must equal `keys.length`. */
  totalKeys: number;
  /** Output script policy. Locked to `wsh-sortedmulti` today. */
  scriptPolicy?: ScriptPolicy;
  /**
   * Cosigning keys in any order. The function sorts internally so the
   * caller can pass them straight from the operator's selection or from
   * an imported wallet config without normalising first.
   */
  keys: readonly DescriptorKey[];
};

/**
 * Compute the canonical identity string for a multisig vault.
 *
 * Two vaults are considered logically identical when this function
 * returns the same string for both. Suitable for `Map`/`Set` keys, for
 * client-side dedup before a Supabase write, and for cross-format
 * comparisons (e.g. native create vs. Caravan import).
 *
 * Throws {@link VaultIdentityError} on validation failures so the
 * caller can surface a precise message instead of building a corrupt
 * identity string.
 */
export function vaultIdentityKey(input: VaultIdentityInput): string {
  const total = input.keys.length;
  if (total === 0) {
    throw new VaultIdentityError('At least one cosigning key is required.');
  }
  if (input.totalKeys !== total) {
    throw new VaultIdentityError(
      `totalKeys (${input.totalKeys}) does not match keys.length (${total}).`,
    );
  }
  if (
    !Number.isInteger(input.requiredSignatures) ||
    input.requiredSignatures < 1 ||
    input.requiredSignatures > total
  ) {
    throw new VaultIdentityError(
      `requiredSignatures must be an integer between 1 and ${total} (got ${input.requiredSignatures}).`,
    );
  }

  const normalised = input.keys.map((key, index) => {
    const fingerprint = key.fingerprint.trim().toLowerCase();
    if (!/^[0-9a-f]{8}$/.test(fingerprint)) {
      throw new VaultIdentityError(
        `Key #${index + 1}: fingerprint must be 8 hex characters.`,
      );
    }
    // Always compare paths in the apostrophe form so a vault stored
    // with `48'/0'/0'/2'` and a freshly-imported descriptor that uses
    // `48h/0h/0h/2h` collapse onto the same identity.
    const path = canonicalizeDerivationPath(stripMasterPrefix(key.derivationPath));
    const asyliaRoot = requireAsyliaBip48Root(
      path,
      `Key #${index + 1}`,
      (message) => new VaultIdentityError(message),
    );
    // Network check first so a testnet key surfaces a precise
    // "testnet not supported" identity error rather than collapsing
    // onto the mainnet identity space.
    const xpubInput = key.xpub.trim();
    const network = detectExtendedPubkeyNetwork(xpubInput);
    if (network !== 'mainnet') {
      throw new VaultIdentityError(
        describeNonMainnetXpub(network, `Key #${index + 1}`)!,
      );
    }
    const canonicalXpub = toCanonicalXpub(xpubInput);
    if (canonicalXpub === null) {
      throw new VaultIdentityError(
        `Key #${index + 1}: extended public key could not be canonicalised.`,
      );
    }
    return { fingerprint, path: asyliaRoot, xpub: canonicalXpub };
  });

  // Stable, comparator-defined sort. Sorting by the canonical xpub first
  // matches what `sortedmulti` does at script-assembly time so two
  // vaults whose only difference is the input ordering of cosigners
  // collapse onto the same identity.
  normalised.sort((a, b) => {
    if (a.xpub !== b.xpub) return a.xpub < b.xpub ? -1 : 1;
    if (a.fingerprint !== b.fingerprint) {
      return a.fingerprint < b.fingerprint ? -1 : 1;
    }
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return 0;
  });

  // Reject duplicate (fingerprint, path) pairs early. The descriptor
  // builder also catches these, but doing it here means the dedup
  // check never produces a misleading "duplicate vault" hit when the
  // real issue is a malformed key set.
  const seen = new Set<string>();
  for (const key of normalised) {
    const id = `${key.fingerprint}:${key.path}`;
    if (seen.has(id)) {
      throw new VaultIdentityError(
        `Duplicate cosigner (fingerprint=${key.fingerprint}, path=${key.path || 'm'}).`,
      );
    }
    seen.add(id);
  }

  const policy = input.scriptPolicy ?? 'wsh-sortedmulti';
  const keyParts = normalised
    .map((key) => `${key.fingerprint}#${key.path}#${key.xpub}`)
    .join(',');
  return `${policy}|${input.requiredSignatures}|${total}|${keyParts}`;
}
