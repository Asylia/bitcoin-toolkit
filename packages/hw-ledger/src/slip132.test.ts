import bs58check from 'bs58check';
import { describe, expect, it } from 'vitest';

import { xpubToMultisigZpub } from './slip132';

describe('xpubToMultisigZpub', () => {
  it('re-encodes BIP-32-shaped keys with the P2WSH multisig Zpub version bytes', () => {
    const xpub = makeXpub(1);
    const zpub = xpubToMultisigZpub(xpub);

    expect(zpub).not.toBeNull();
    expect(zpub?.startsWith('Zpub')).toBe(true);
    expect(Array.from(bs58check.decode(zpub!).slice(0, 4))).toEqual([
      0x02,
      0xaa,
      0x7e,
      0xd3,
    ]);
    expect(Array.from(bs58check.decode(zpub!).slice(4))).toEqual(
      Array.from(bs58check.decode(xpub).slice(4)),
    );
  });

  it('returns null for malformed extended public keys', () => {
    expect(xpubToMultisigZpub('not-base58check')).toBeNull();
  });
});

function makeXpub(seed: number): string {
  const payload = new Uint8Array(78);
  payload.set([0x04, 0x88, 0xb2, 0x1e], 0);
  payload[4] = 4;
  payload.set([0xaa, 0xbb, 0xcc, seed], 5);
  new DataView(payload.buffer).setUint32(9, 0x80000000 + seed, false);
  for (let i = 13; i < 45; i += 1) payload[i] = (seed + i) & 0xff;
  payload[45] = seed % 2 === 0 ? 0x02 : 0x03;
  for (let i = 46; i < 78; i += 1) payload[i] = (seed * 3 + i) & 0xff;
  return bs58check.encode(payload);
}
