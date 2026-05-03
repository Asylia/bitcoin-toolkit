import { Buffer } from 'node:buffer';
import bs58check from 'bs58check';
import { describe, expect, it } from 'vitest';

import { makeSyntheticBitcoinFixture } from '../__fixtures__/bitcoin';
import {
  buildWshSortedMultiDescriptor,
  DescriptorBuildError,
} from './multisig';

describe('buildWshSortedMultiDescriptor', () => {
  it('renders canonical multipath and branch descriptors from normalised key material', () => {
    const fixture = makeSyntheticBitcoinFixture();
    const [first, second, third] = fixture.descriptors;
    const zpub = reencodeExtendedPubkey(second!.xpub, [0x02, 0xaa, 0x7e, 0xd3]);

    const descriptors = buildWshSortedMultiDescriptor({
      requiredSignatures: 2,
      network: 'mainnet',
      keys: [
        { ...first!, fingerprint: first!.fingerprint.toUpperCase(), derivationPath: 'm/48h/0h/0h/2h' },
        { ...second!, xpub: zpub },
        third!,
      ],
    });

    const [body, checksum] = descriptors.descriptor.split('#');
    expect(checksum).toMatch(/^[02-9ac-hj-np-z]{8}$/);
    expect(body).toContain("wsh(sortedmulti(2,");
    expect(body).toContain(`[${first!.fingerprint}/48'/0'/0'/2']${first!.xpub}/<0;1>/*`);
    expect(body).toContain(`[${second!.fingerprint}/48'/0'/0'/2']${second!.xpub}/<0;1>/*`);
    expect(body).not.toContain(zpub);
    expect(descriptors.receiveDescriptor.split('#')[0]).toContain('/0/*');
    expect(descriptors.changeDescriptor.split('#')[0]).toContain('/1/*');
  });

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

  it('rejects descriptor keys outside the Asylia BIP-48 root', () => {
    const fixture = makeSyntheticBitcoinFixture();
    const [first, ...rest] = fixture.descriptors;

    expect(() =>
      buildWshSortedMultiDescriptor({
        requiredSignatures: 2,
        network: 'mainnet',
        keys: [
          { ...first!, derivationPath: "m/48'/0'/1'/2'" },
          ...rest,
        ],
      }),
    ).toThrow(/48'\/0'\/0'\/2'/);
  });
});

function reencodeExtendedPubkey(xpub: string, version: readonly number[]): string {
  const decoded = bs58check.decode(xpub);
  return bs58check.encode(
    Buffer.concat([Buffer.from(version), Buffer.from(decoded).subarray(4)]),
  );
}
