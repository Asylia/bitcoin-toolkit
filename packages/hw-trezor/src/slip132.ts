/**
 * SLIP-132 version-byte conversion.
 *
 * BIP-32 extended public keys are base58check-encoded. The first 4 bytes
 * of the decoded payload are the "version", which is overloaded by
 * SLIP-132 to encode the script type / wallet semantic the key is meant
 * for. The CRYPTOGRAPHIC KEY MATERIAL is identical across all variants —
 * only the four version bytes (and therefore the human-readable prefix)
 * change. Conversion is lossless.
 *
 *   xpub  0488B21E   generic BIP-32, no script semantic
 *   ypub  049D7CB2   P2SH-P2WPKH    (single-key nested SegWit)
 *   zpub  04B24746   P2WPKH         (single-key native SegWit)
 *   Ypub  0295B43F   P2WSH-P2SH     (multisig nested SegWit)
 *   Zpub  02AA7ED3   P2WSH          (multisig native SegWit)        ← Asylia
 *
 * Trezor's `getPublicKey` API has no `SPENDP2WSH` script type, so when
 * we ask for `SPENDWITNESS` (the closest native-SegWit option) the SDK
 * returns:
 *   - `xpub` in the universal `xpub` form, AND
 *   - `xpubSegwit` in the SINGLE-KEY `zpub` form (because that is what
 *     `SPENDWITNESS` semantically means in Trezor's API).
 *
 * Asylia uses the key in P2WSH multisig (`wsh(sortedmulti(...))`), so
 * the canonical SLIP-132 display prefix is `Zpub` (capital Z). This
 * helper performs the byte swap from any of the BIP-32-shaped prefixes
 * (xpub / zpub) into Zpub.
 *
 * The helper deliberately stays in this package and avoids dragging in
 * a full Bitcoin library — `bs58check` already validates and re-emits
 * the checksum, so a 4-byte slice + concat is everything that is left.
 */

import bs58check from 'bs58check';

/** SLIP-132 version bytes for native-SegWit P2WSH multisig (`Zpub`). */
const ZPUB_MULTISIG_VERSION = new Uint8Array([0x02, 0xaa, 0x7e, 0xd3]);

/**
 * Convert any BIP-32 base58check-encoded extended public key into the
 * SLIP-132 `Zpub` form used for P2WSH multisig display and export.
 *
 * The function validates the source by base58check-decoding it (which
 * checks the embedded SHA-256d checksum) and then re-encodes with the
 * Zpub version bytes. Anything that successfully decodes works — xpub,
 * ypub, zpub, Ypub, Zpub, tpub (testnet equivalent), … — so callers
 * never have to know which form they were handed.
 *
 * Returns `null` when the input cannot be base58check-decoded; the
 * caller should propagate that as a normalised adapter error rather
 * than persisting a potentially malformed value.
 */
export function xpubToMultisigZpub(extendedPublicKey: string): string | null {
  let decoded: Uint8Array;
  try {
    decoded = bs58check.decode(extendedPublicKey);
  } catch {
    return null;
  }

  if (decoded.length < 4) return null;

  // SLIP-132 swap: replace the first 4 bytes (version) with Zpub bytes,
  // keep the remaining 74 bytes (depth + parent fp + child num + chain
  // code + public key) untouched.
  const reversioned = new Uint8Array(decoded.length);
  reversioned.set(ZPUB_MULTISIG_VERSION, 0);
  reversioned.set(decoded.subarray(4), 4);

  return bs58check.encode(reversioned);
}
