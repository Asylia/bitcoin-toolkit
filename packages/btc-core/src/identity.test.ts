import { Buffer } from 'node:buffer';
import bs58check from 'bs58check';
import { describe, expect, it } from 'vitest';

import { makeSyntheticBitcoinFixture } from './__fixtures__/bitcoin';
import {
  vaultIdentityKey,
  VaultIdentityError,
  type DescriptorKey,
  type VaultIdentityInput,
} from './index';

describe('vaultIdentityKey', () => {
  it('builds the same identity for reordered, trimmed, SLIP-132-normalised keys', () => {
    const fixture = makeSyntheticBitcoinFixture();
    const baseline = makeInput(fixture.descriptors);
    const decoratedKeys = [...fixture.descriptors]
      .reverse()
      .map((key, index): DescriptorKey => ({
        ...key,
        fingerprint: ` ${key.fingerprint.toUpperCase()} `,
        derivationPath: index === 0 ? 'm/48h/0h/0h/2h' : key.derivationPath,
        xpub: index === 1 ? ` ${fixture.zpubs[1]!} ` : key.xpub,
      }));

    expect(vaultIdentityKey(makeInput(decoratedKeys))).toBe(vaultIdentityKey(baseline));
  });

  it('treats the default script policy as explicit wsh-sortedmulti', () => {
    const fixture = makeSyntheticBitcoinFixture();
    const baseline = makeInput(fixture.descriptors);

    expect(vaultIdentityKey(baseline)).toBe(
      vaultIdentityKey({ ...baseline, scriptPolicy: 'wsh-sortedmulti' }),
    );
  });

  it.each([
    [
      'empty key set',
      () => ({ ...makeInput([]), totalKeys: 0, requiredSignatures: 1 }),
      'At least one cosigning key is required.',
    ],
    [
      'mismatched totalKeys',
      () => ({ ...makeFixtureInput(), totalKeys: 2 }),
      'totalKeys (2) does not match keys.length (3).',
    ],
    [
      'zero threshold',
      () => ({ ...makeFixtureInput(), requiredSignatures: 0 }),
      'requiredSignatures must be an integer between 1 and 3 (got 0).',
    ],
    [
      'threshold above key count',
      () => ({ ...makeFixtureInput(), requiredSignatures: 4 }),
      'requiredSignatures must be an integer between 1 and 3 (got 4).',
    ],
    [
      'fractional threshold',
      () => ({ ...makeFixtureInput(), requiredSignatures: 1.5 }),
      'requiredSignatures must be an integer between 1 and 3 (got 1.5).',
    ],
    [
      'invalid fingerprint',
      () => replaceKey(0, { fingerprint: 'zzzzzzzz' }),
      'Key #1: fingerprint must be 8 hex characters.',
    ],
    [
      'unsupported derivation root',
      () => replaceKey(0, { derivationPath: "m/48'/1'/0'/2'" }),
      'Key #1: derivation path must be m/48',
    ],
    [
      'testnet extended public key',
      () => replaceKey(0, { xpub: toTestnetXpub(makeFixtureInput().keys[0]!.xpub) }),
      'Key #1: extended public key is for the Bitcoin testnet',
    ],
    [
      'duplicate cosigner origin',
      () => {
        const input = makeFixtureInput();
        return {
          ...input,
          keys: [
            input.keys[0]!,
            {
              ...input.keys[1]!,
              fingerprint: input.keys[0]!.fingerprint,
              derivationPath: 'm/48h/0h/0h/2h',
            },
            input.keys[2]!,
          ],
        };
      },
      'Duplicate cosigner',
    ],
  ])('rejects %s', (_name, buildInput, expectedMessage) => {
    expect(() => vaultIdentityKey(buildInput())).toThrow(VaultIdentityError);
    expect(() => vaultIdentityKey(buildInput())).toThrow(expectedMessage);
  });
});

function makeFixtureInput(): VaultIdentityInput {
  const fixture = makeSyntheticBitcoinFixture();
  return makeInput(fixture.descriptors);
}

function makeInput(keys: readonly DescriptorKey[]): VaultIdentityInput {
  return {
    requiredSignatures: 2,
    totalKeys: keys.length,
    keys,
  };
}

function replaceKey(index: number, overrides: Partial<DescriptorKey>): VaultIdentityInput {
  const input = makeFixtureInput();
  return {
    ...input,
    keys: input.keys.map((key, keyIndex) =>
      keyIndex === index ? { ...key, ...overrides } : key,
    ),
  };
}

function toTestnetXpub(xpub: string): string {
  const decoded = bs58check.decode(xpub);
  return bs58check.encode(
    Buffer.concat([Buffer.from([0x04, 0x35, 0x87, 0xcf]), Buffer.from(decoded).subarray(4)]),
  );
}
