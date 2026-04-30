import { describe, expect, it } from 'vitest';

import { makeSyntheticBitcoinFixture } from '../__fixtures__/bitcoin';
import {
  buildWshSortedMultiDescriptor,
  DescriptorBuildError,
} from './multisig';

describe('buildWshSortedMultiDescriptor', () => {
  it('rejects unsafe multisig policy and key-set shapes', () => {
    const fixture = makeSyntheticBitcoinFixture();
    const keys = fixture.descriptors;

    expect(() =>
      buildWshSortedMultiDescriptor({
        requiredSignatures: 4,
        network: 'mainnet',
        keys,
      }),
    ).toThrow(DescriptorBuildError);

    expect(() =>
      buildWshSortedMultiDescriptor({
        requiredSignatures: 0,
        network: 'mainnet',
        keys,
      }),
    ).toThrow(DescriptorBuildError);

    expect(() =>
      buildWshSortedMultiDescriptor({
        requiredSignatures: 1,
        network: 'mainnet',
        keys: [],
      }),
    ).toThrow(DescriptorBuildError);
  });

  it('rejects duplicate key identities before rendering a descriptor', () => {
    const fixture = makeSyntheticBitcoinFixture();
    const duplicate = fixture.descriptors[0]!;

    expect(() =>
      buildWshSortedMultiDescriptor({
        requiredSignatures: 2,
        network: 'mainnet',
        keys: [duplicate, duplicate, fixture.descriptors[1]!],
      }),
    ).toThrow(/Duplicate key/);
  });

  it('rejects unsupported networks explicitly', () => {
    const fixture = makeSyntheticBitcoinFixture();

    expect(() =>
      buildWshSortedMultiDescriptor({
        requiredSignatures: 2,
        network: 'testnet' as 'mainnet',
        keys: fixture.descriptors,
      }),
    ).toThrow(/Unsupported network/);
  });
});
