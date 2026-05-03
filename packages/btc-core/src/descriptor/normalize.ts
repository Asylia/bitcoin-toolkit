/**
 * Extended public key normalisation utilities.
 *
 * Hardware wallets and import payloads can hand us extended public keys
 * encoded with one of several SLIP-132 prefixes (`xpub`, `Zpub`, `Ypub`,
 * `zpub`, `ypub`). The on-chain key material is identical across all
 * variants — only the four version bytes (and therefore the human-readable
 * prefix) change. Bitcoin descriptors expect the universal `xpub` form
 * (BIP-32 mainnet pubkey version `0x0488B21E`) so we re-version any other
 * SLIP-132 variant before embedding the key.
 *
 * Conversion is lossless (only the version bytes change). The helper
 * deliberately stays inside this package and avoids dragging in a
 * Bitcoin runtime — `bs58check` already validates and re-emits the
 * checksum, so a 4-byte slice + concat is everything that is left.
 *
 * NOTE: keep the implementation in lockstep with the equivalent helper
 * in `@asylia/hw-trezor/src/slip132.ts`. The two packages target
 * opposite directions (Trezor → Zpub for display; descriptor → xpub for
 * embedding) and must never disagree on the version bytes.
 */
import bs58check from 'bs58check';

/** SLIP-132 version-byte map for the BIP-32 mainnet `xpub` prefix. */
const XPUB_MAINNET_VERSION = new Uint8Array([0x04, 0x88, 0xb2, 0x1e]);

/** Asylia's only supported BIP-48 account root: mainnet native-SegWit multisig. */
export const ASYLIA_BIP48_P2WSH_ROOT = "48'/0'/0'/2'" as const;

/**
 * SLIP-132 mainnet extended public-key version bytes.
 *
 * Asylia accepts the entire mainnet family because hardware wallets
 * advertise different prefixes for the same on-chain key material:
 *
 *   - `xpub` — BIP-32 standard (`0x0488B21E`)
 *   - `ypub` — BIP-49 P2SH-P2WPKH (`0x049D7CB2`)
 *   - `zpub` — BIP-84 P2WPKH (`0x04B24746`)
 *   - `Ypub` — BIP-48 P2SH-P2WSH multisig (`0x0295B43F`)
 *   - `Zpub` — BIP-48 P2WSH multisig (`0x02AA7ED3`)
 *
 * The canonicalisation step in `toCanonicalXpub` re-versions any of
 * these onto the universal `xpub` prefix descriptors expect. Anything
 * not in this set (testnet, signet, regtest, exotic / unknown) is
 * rejected at the boundary so a wrong-network key cannot slip through
 * and silently produce mainnet addresses from testnet seeds.
 */
const MAINNET_PUBKEY_VERSIONS: ReadonlySet<number> = new Set([
  0x0488b21e,
  0x049d7cb2,
  0x04b24746,
  0x0295b43f,
  0x02aa7ed3,
]);

/**
 * SLIP-132 testnet extended public-key version bytes. Listed
 * explicitly so the parsers can surface a *targeted* "testnet not
 * supported" message instead of the generic "unknown SLIP-132 variant"
 * fallback.
 *
 *   - `tpub` — BIP-32 testnet (`0x043587CF`)
 *   - `upub` — BIP-49 testnet (`0x044A5262`)
 *   - `vpub` — BIP-84 testnet (`0x045F1CF6`)
 *   - `Upub` — BIP-48 P2SH-P2WSH multisig testnet (`0x024289EF`)
 *   - `Vpub` — BIP-48 P2WSH multisig testnet (`0x02575483`)
 */
const TESTNET_PUBKEY_VERSIONS: ReadonlySet<number> = new Set([
  0x043587cf,
  0x044a5262,
  0x045f1cf6,
  0x024289ef,
  0x02575483,
]);

/**
 * Outcome of {@link detectExtendedPubkeyNetwork}.
 *
 *   - `'mainnet'` — recognised mainnet SLIP-132 prefix; safe to
 *     embed in a descriptor after canonicalisation.
 *   - `'testnet'` — recognised testnet prefix; Asylia rejects.
 *   - `'unknown'` — decoded as base58check but the version bytes do
 *     not match any known SLIP-132 variant.
 *   - `'invalid'` — the input is not a well-formed base58check
 *     string at all.
 */
export type ExtendedPubkeyNetwork =
  | 'mainnet'
  | 'testnet'
  | 'unknown'
  | 'invalid';

/**
 * Inspect the version bytes of an extended public key and tell the
 * caller which network it belongs to. Pure / no IO — used at every
 * import boundary so a tpub never reaches the descriptor builder
 * disguised as an xpub.
 *
 * Implementation is byte-level on purpose: we do not depend on
 * `bitcoinjs-lib` parsing here so the helper stays usable in the
 * server-side import paths (Edge Functions, audit tooling) that do
 * not pull in the full Bitcoin runtime.
 */
export function detectExtendedPubkeyNetwork(
  extendedPublicKey: string,
): ExtendedPubkeyNetwork {
  let decoded: Uint8Array;
  try {
    decoded = bs58check.decode(extendedPublicKey.trim());
  } catch {
    return 'invalid';
  }
  if (decoded.length < 4) return 'invalid';

  // Read the 4-byte big-endian version header. `>>> 0` collapses the
  // result back into the unsigned-int32 range so set-membership
  // works regardless of how the most-significant bit is set on each
  // byte.
  const version =
    (((decoded[0] ?? 0) << 24) |
      ((decoded[1] ?? 0) << 16) |
      ((decoded[2] ?? 0) << 8) |
      (decoded[3] ?? 0)) >>>
    0;

  if (MAINNET_PUBKEY_VERSIONS.has(version)) return 'mainnet';
  if (TESTNET_PUBKEY_VERSIONS.has(version)) return 'testnet';
  return 'unknown';
}

/**
 * Re-encode any BIP-32 / SLIP-132 **mainnet** extended public key into
 * the universal `xpub` form descriptors expect.
 *
 * Returns `null` when the input is:
 *   - not a valid base58check string;
 *   - shorter than the 4 version bytes;
 *   - a recognised testnet variant (tpub / upub / vpub / Upub / Vpub);
 *   - any other unrecognised SLIP-132 prefix.
 *
 * The function is intentionally strict: silently re-versioning a
 * non-mainnet key onto an `xpub` prefix would produce a structurally
 * valid descriptor that derives **mainnet** addresses from key
 * material the operator only ever intended for testnet use. Callers
 * that need a richer error message (testnet vs unknown vs invalid
 * base58check) should pair this function with
 * {@link detectExtendedPubkeyNetwork}.
 */
export function toCanonicalXpub(extendedPublicKey: string): string | null {
  let decoded: Uint8Array;
  try {
    decoded = bs58check.decode(extendedPublicKey);
  } catch {
    return null;
  }
  if (decoded.length < 4) return null;

  if (detectExtendedPubkeyNetwork(extendedPublicKey) !== 'mainnet') {
    return null;
  }

  const reversioned = new Uint8Array(decoded.length);
  reversioned.set(XPUB_MAINNET_VERSION, 0);
  reversioned.set(decoded.subarray(4), 4);

  return bs58check.encode(reversioned);
}

/**
 * Render a precise, user-facing error message for a non-mainnet
 * extended public key. Centralised so every parser surfaces the same
 * wording for the same failure (testnet vs unknown vs invalid),
 * making the messages easier to scan in support transcripts and
 * audit logs.
 *
 * Returns `null` when `network` is `'mainnet'` so callers can use
 * the helper as a one-liner inside their own error class:
 *
 *   const message = describeNonMainnetXpub(network, label);
 *   if (message) throw new MyImportError(message);
 */
export function describeNonMainnetXpub(
  network: ExtendedPubkeyNetwork,
  label: string,
): string | null {
  switch (network) {
    case 'mainnet':
      return null;
    case 'testnet':
      return `${label}: extended public key is for the Bitcoin testnet (tpub/upub/vpub/Upub/Vpub). Asylia only supports mainnet.`;
    case 'unknown':
      return `${label}: extended public key has an unrecognised SLIP-132 version. Asylia accepts xpub/ypub/zpub/Ypub/Zpub on mainnet only.`;
    case 'invalid':
      return `${label}: extended public key is not valid base58check.`;
  }
}

/**
 * Strip the leading `m/` (or `m`) from a BIP-32 derivation path so the
 * result fits straight into a BIP-380 key-origin block.
 *
 * Both apostrophe (`48'`) and hardened-letter (`48h`) notations are
 * preserved verbatim — the descriptor parser accepts either.
 */
export function stripMasterPrefix(derivationPath: string): string {
  const trimmed = derivationPath.trim();
  if (trimmed === 'm' || trimmed === 'M') return '';
  if (trimmed.startsWith('m/')) return trimmed.slice(2);
  if (trimmed.startsWith('M/')) return trimmed.slice(2);
  return trimmed;
}

/**
 * Canonicalise a BIP-32 derivation path notation by collapsing the
 * hardened-letter form (`48h`) onto the apostrophe form (`48'`).
 *
 * Bitcoin Core's `getdescriptorinfo` and most descriptor-native tools
 * emit the `h` form; hardware wallet exports (Trezor, Ledger Live) and
 * our own UI use the `'` form. The on-chain semantics are identical —
 * BIP-32 `index | 0x80000000` either way — but string equality breaks
 * if the two forms mix in the same workspace, so the dedup check and
 * the registry lookup would each see two "different" paths for the
 * same hardened branch.
 *
 * Applied uniformly:
 *
 *   - by `vaultIdentityKey` before the keys are sorted, so two vaults
 *     that differ only in path notation collapse onto the same
 *     identity;
 *   - by every import parser before returning a `ParsedSigner`, so
 *     downstream code only ever sees the apostrophe form;
 *   - by the wallet's `findKeyByOrigin` on both sides of the lookup,
 *     so a registry row stored in either notation still matches a
 *     freshly-imported cosigner.
 *
 * The function is intentionally narrow: it only swaps `h` for `'` and
 * leaves every other character (digits, slashes, brackets, the body
 * itself) untouched. Apostrophes inside the input survive verbatim.
 */
export function canonicalizeDerivationPath(path: string): string {
  return path.replace(/h/g, "'");
}

/** Return the canonical Asylia BIP-48 root body, or `null` when it differs. */
export function canonicalizeAsyliaBip48Root(path: string): typeof ASYLIA_BIP48_P2WSH_ROOT | null {
  const canonical = canonicalizeDerivationPath(stripMasterPrefix(path).trim());
  return canonical === ASYLIA_BIP48_P2WSH_ROOT ? ASYLIA_BIP48_P2WSH_ROOT : null;
}

/** Validate that a path is exactly Asylia's mainnet BIP-48 P2WSH multisig root. */
export function isAsyliaBip48Root(path: string): boolean {
  return canonicalizeAsyliaBip48Root(path) !== null;
}

/** Render a consistent error for paths outside Asylia's supported account root. */
export function describeNonAsyliaBip48Root(label: string, path: string): string {
  const rendered = path.trim().length > 0 ? path : '(empty)';
  return `${label}: derivation path must be m/${ASYLIA_BIP48_P2WSH_ROOT} for Bitcoin mainnet native-SegWit multisig (got "${rendered}").`;
}

/**
 * Strict Asylia account-root guard shared by descriptor builders,
 * identity keys, and every import parser.
 *
 * Empty key-origin paths are rejected here: Asylia vault cosigners
 * must always be account-level BIP-48 mainnet native-SegWit multisig
 * roots, never bare master/root xpub origins.
 */
export function requireAsyliaBip48Root<ErrorType extends Error = Error>(
  path: string,
  label: string,
  makeError?: (message: string) => ErrorType,
): typeof ASYLIA_BIP48_P2WSH_ROOT {
  const asyliaRoot = canonicalizeAsyliaBip48Root(path);
  if (asyliaRoot !== null) return asyliaRoot;
  const message = describeNonAsyliaBip48Root(label, path);
  throw makeError ? makeError(message) : new Error(message);
}

/** Validate a master fingerprint as 8 lowercase hex characters. */
export function isFingerprint(value: string): boolean {
  return /^[0-9a-f]{8}$/.test(value);
}

/**
 * Validate a derivation path body (no leading `m/`). Accepts the same
 * shape as the database `V1_SignKeys.derivation_root_format` CHECK
 * constraint so a malformed value is caught before it reaches Postgres.
 *
 * The empty string is allowed — that represents a root key with no
 * additional derivation, which is a perfectly valid descriptor input.
 */
export function isDerivationPathBody(value: string): boolean {
  if (value === '') return true;
  return /^[0-9]+(['h])?(\/[0-9]+(['h])?)*$/.test(value);
}
