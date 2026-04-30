import { describe, expect, it } from 'vitest';

import { descriptorChecksum, withChecksum } from './checksum';
import { makeSyntheticBitcoinFixture } from '../__fixtures__/bitcoin';

describe('descriptor checksum', () => {
  it('round-trips stable descriptor bodies and detects single-character edits', () => {
    const fixture = makeSyntheticBitcoinFixture();
    const [body, checksum] = fixture.descriptor.split('#');

    expect(body).toBeTruthy();
    expect(checksum).toHaveLength(8);
    expect(descriptorChecksum(body!)).toBe(checksum);
    expect(withChecksum(body!)).toBe(fixture.descriptor);

    const typo = body!.replace('sortedmulti', 'sortedmultj');
    expect(descriptorChecksum(typo)).not.toBe(checksum);
  });

  it('rejects descriptor bodies with characters outside the BIP-380 alphabet', () => {
    expect(descriptorChecksum('wsh(sortedmulti(2,\n))')).toBeNull();
  });
});
