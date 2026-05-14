import { PsbtBuildError } from './errors.ts';

/**
 * Flip a 32-byte transaction id between its big-endian "display" form
 * and the little-endian "internal" form Bitcoin's wire format uses.
 */
export function reverseTxidHex(hex: string): string {
  if (typeof hex !== 'string' || hex.length !== 64 || !/^[0-9a-f]+$/i.test(hex)) {
    throw new PsbtBuildError(
      `Transaction id must be 64 lowercase hex characters (got ${typeof hex === 'string' ? `"${hex}"` : typeof hex}).`,
    );
  }
  let out = '';
  for (let i = hex.length; i > 0; i -= 2) {
    out += hex.slice(i - 2, i);
  }
  return out.toLowerCase();
}
