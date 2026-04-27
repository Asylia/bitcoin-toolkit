/**
 * BIP-380 descriptor checksum.
 *
 * Output script descriptors carry an 8-character checksum after a `#`
 * separator (`...descriptor#checksum`). The checksum protects against
 * single-character typos in the descriptor body so a receiving wallet
 * never silently constructs the wrong script.
 *
 * The algorithm is a BCH polynomial code over GF(32^2). Reference
 * implementations:
 *
 *   - Bitcoin Core: src/script/descriptor.cpp `DescriptorChecksum`
 *   - BIP text: https://github.com/bitcoin/bips/blob/master/bip-0380.mediawiki
 *
 * The implementation below is a faithful TypeScript port of the
 * Bitcoin Core C++ reference. It is intentionally short and free of
 * dependencies so the audit can review it line by line against the
 * specification.
 */

/**
 * Bech32-style alphabet used for both the input symbol mapping and the
 * checksum output. The 32 characters are arranged so that two
 * frequently-confused glyphs (`b`/`6`, `i`/`l`, `1`/`I`, `o`/`0`) live
 * far apart in the alphabet, giving the BCH code maximum distance for
 * the most common transcription errors.
 */
const CHECKSUM_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

/**
 * Set of characters allowed inside the descriptor body itself. Anything
 * outside this set short-circuits to "invalid" so the checksum cannot be
 * computed for a malformed descriptor (matches the C++ reference).
 *
 * The set is the union of the BIP-380 base alphabet, the operator
 * characters (`(`, `)`, `,`, `*`, `'`, `h`, `/`, `:`, `<`, `>`, `;`),
 * the lowercase + uppercase Latin letters used in script tags
 * (`wsh`, `sortedmulti`, `xpub`, `Zpub`, …), digits, the BIP-389 multipath
 * separators (`<` `;` `>`), and the `[` `]` brackets that wrap key-origin
 * blocks.
 */
const INPUT_CHARSET =
  '0123456789()[],\'/*abcdefgh@:$%{}' +
  'IJKLMNOPQRSTUVWXYZ&+-.;<=>?!^_|~' +
  'ijklmnopqrstuvwxyzABCDEFGH`#"\\ ';

/**
 * Polymod step. The five generator constants come straight from the
 * Bitcoin Core reference implementation; each bit of the carry-out
 * activates a different generator, and the resulting BCH code over
 * GF(32^2) is what gives the checksum its error-detection
 * guarantees.
 *
 * The 40-bit working state is held in a `bigint` so the high-order bits
 * survive the left shift below — JavaScript `number` is only 53 bits of
 * mantissa and the shift would silently lose precision around symbol
 * count ~8.
 */
function polymodStep(c: bigint, value: number): bigint {
  const c0 = c >> 35n;
  let next = ((c & 0x7ffffffffn) << 5n) ^ BigInt(value);
  if ((c0 & 1n) !== 0n) next ^= 0xf5dee51989n;
  if ((c0 & 2n) !== 0n) next ^= 0xa9fdca3312n;
  if ((c0 & 4n) !== 0n) next ^= 0x1bab10e32dn;
  if ((c0 & 8n) !== 0n) next ^= 0x3706b1677an;
  if ((c0 & 16n) !== 0n) next ^= 0x644d626ffdn;
  return next;
}

/**
 * Compute the BIP-380 checksum for the body of a descriptor (the part
 * before `#`).
 *
 * Returns `null` when the input contains characters outside the BIP-380
 * input alphabet, so the caller can surface a precise error rather than
 * persisting a checksummed-but-invalid descriptor.
 */
export function descriptorChecksum(descriptor: string): string | null {
  let c = 1n;
  let cls = 0;
  let clscount = 0;

  for (const ch of descriptor) {
    const pos = INPUT_CHARSET.indexOf(ch);
    if (pos === -1) return null;
    c = polymodStep(c, pos & 31);
    cls = cls * 3 + (pos >> 5);
    clscount += 1;
    if (clscount === 3) {
      c = polymodStep(c, cls);
      cls = 0;
      clscount = 0;
    }
  }
  if (clscount > 0) c = polymodStep(c, cls);

  // 8 zero symbols flush the polynomial state through the BCH window.
  for (let j = 0; j < 8; j += 1) c = polymodStep(c, 0);
  c ^= 1n;

  let result = '';
  for (let j = 0; j < 8; j += 1) {
    const shift = BigInt(5 * (7 - j));
    const idx = Number((c >> shift) & 31n);
    result += CHECKSUM_CHARSET.charAt(idx);
  }
  return result;
}

/**
 * Convenience helper: append `#checksum` to a descriptor body. Throws
 * when the body cannot be checksummed (caller-side bug; never user
 * input by the time this is called).
 */
export function withChecksum(descriptorBody: string): string {
  const sum = descriptorChecksum(descriptorBody);
  if (sum === null) {
    throw new Error(
      'Cannot compute descriptor checksum: descriptor body contains invalid characters.',
    );
  }
  return `${descriptorBody}#${sum}`;
}
