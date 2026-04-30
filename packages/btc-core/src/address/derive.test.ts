import { describe, expect, it } from 'vitest';

import { makeSyntheticBitcoinFixture } from '../__fixtures__/bitcoin';
import {
  AddressDeriveError,
  deriveWshSortedMultiAddress,
  deriveWshSortedMultiAddressBatch,
} from './derive';

describe('deriveWshSortedMultiAddressBatch', () => {
  it('matches single-address derivation for every contiguous receive/change slot', () => {
    const fixture = makeSyntheticBitcoinFixture();

    for (const chain of [0, 1] as const) {
      const batch = deriveWshSortedMultiAddressBatch({
        requiredSignatures: fixture.requiredSignatures,
        keys: fixture.descriptors,
        network: 'mainnet',
        chain,
        startIndex: 2,
        count: 5,
      });

      expect(batch).toEqual(
        Array.from({ length: 5 }, (_, offset) => {
          const index = 2 + offset;
          return {
            chain,
            index,
            address: deriveWshSortedMultiAddress({
              requiredSignatures: fixture.requiredSignatures,
              keys: fixture.descriptors,
              network: 'mainnet',
              chain,
              index,
            }),
          };
        }),
      );
    }
  });

  it('rejects empty ranges and invalid boundaries loudly', () => {
    const fixture = makeSyntheticBitcoinFixture();

    expect(() =>
      deriveWshSortedMultiAddressBatch({
        requiredSignatures: fixture.requiredSignatures,
        keys: fixture.descriptors,
        network: 'mainnet',
        chain: 0,
        startIndex: 0,
        count: 0,
      }),
    ).toThrow(AddressDeriveError);

    expect(() =>
      deriveWshSortedMultiAddressBatch({
        requiredSignatures: fixture.requiredSignatures,
        keys: fixture.descriptors,
        network: 'mainnet',
        chain: 0,
        startIndex: -1,
        count: 1,
      }),
    ).toThrow(AddressDeriveError);
  });
});
