import { Buffer } from 'buffer';
import * as ecc from '@bitcoinerlab/secp256k1';
import { BIP32Factory } from 'bip32';
import { describe, expect, it } from 'vitest';

import {
  buildWshSortedMultiDescriptor,
  parseAsyliaVaultConfig,
  parseCaravanWalletConfig,
  parseDescriptorImport,
  parseSparrowWalletConfig,
  vaultIdentityKey,
  MultisigImportError,
  VaultIdentityError,
  type DescriptorKey,
  type ParsedMultisigImport,
} from '../index';

const bip32 = BIP32Factory(ecc);
const ACCOUNT_PATH = "m/48'/0'/0'/2'";
const DERIVATION_PATH = "48'/0'/0'/2'";

describe('multisig imports and identity', () => {
  it('keeps vault identity stable across cosigner ordering', () => {
    const keys = makeDescriptorKeys();
    const forward = vaultIdentityKey({
      requiredSignatures: 2,
      totalKeys: keys.length,
      keys,
    });
    const reversed = vaultIdentityKey({
      requiredSignatures: 2,
      totalKeys: keys.length,
      keys: [...keys].reverse(),
    });

    expect(reversed).toBe(forward);
    expect(() =>
      vaultIdentityKey({
        requiredSignatures: 2,
        totalKeys: keys.length,
        keys: [keys[0]!, keys[0]!, keys[2]!],
      }),
    ).toThrow(VaultIdentityError);
  });

  it('parses Bitcoin Core receive/change descriptors into the same vault shape', () => {
    const keys = makeDescriptorKeys();
    const descriptors = buildWshSortedMultiDescriptor({
      requiredSignatures: 2,
      keys,
      network: 'mainnet',
    });

    const parsed = parseDescriptorImport(JSON.stringify([
      { desc: descriptors.receiveDescriptor, internal: false, active: true },
      { desc: descriptors.changeDescriptor, internal: true, active: true },
    ]));

    expect(parsed).toMatchObject({
      name: 'Imported descriptor vault',
      scriptPolicy: 'wsh-sortedmulti',
      requiredSignatures: 2,
      totalKeys: 3,
      source: 'descriptor',
    });
    expect(parsed.signers.map((signer) => signer.fingerprint)).toEqual(
      keys.map((key) => key.fingerprint),
    );
  });

  it('rejects descriptor checksum and policy mismatches at the import boundary', () => {
    const keys = makeDescriptorKeys();
    const descriptors = buildWshSortedMultiDescriptor({
      requiredSignatures: 2,
      keys,
      network: 'mainnet',
    });

    expect(() => parseDescriptorImport(`${descriptors.descriptor.slice(0, -1)}x`)).toThrow(
      /checksum mismatch/,
    );
    expect(() =>
      parseDescriptorImport(descriptors.descriptor.split('#')[0]!.replace('sortedmulti', 'multi')),
    ).toThrow(/ordered multi/);
  });

  it('rejects descriptor imports without the Asylia BIP-48 root', () => {
    const keys = makeDescriptorKeys();
    const descriptors = buildWshSortedMultiDescriptor({
      requiredSignatures: 2,
      keys,
      network: 'mainnet',
    });
    const body = descriptors.descriptor.split('#')[0]!;

    expect(() => parseDescriptorImport(body.replace("[", "[deadbeef"))).toThrow(
      /format/,
    );
    expect(() => parseDescriptorImport(body.replace("/48'/0'/0'/2']", ']'))).toThrow(
      /48'\/0'\/0'\/2'/,
    );
    expect(() =>
      parseDescriptorImport(body.replace("/48'/0'/0'/2']", "/48'/0'/1'/2']")),
    ).toThrow(/48'\/0'\/0'\/2'/);
  });

  it('normalises Caravan wallet backups and rejects non-mainnet files', () => {
    const keys = makeDescriptorKeys();
    const parsed = parseCaravanWalletConfig(JSON.stringify(caravanConfig(keys)));

    expect(parsed).toMatchObject({
      name: 'Treasury',
      requiredSignatures: 2,
      totalKeys: 3,
      source: 'caravan',
    });
    expect(parsed.signers[0]).toMatchObject({
      name: 'Signer 1',
      device: 'trezor',
      derivationPath: DERIVATION_PATH,
    });

    expect(() =>
      parseCaravanWalletConfig(JSON.stringify({
        ...caravanConfig(keys),
        network: 'testnet',
      })),
    ).toThrow(MultisigImportError);

    expect(() =>
      parseCaravanWalletConfig(JSON.stringify({
        ...caravanConfig(keys),
        extendedPublicKeys: caravanConfig(keys).extendedPublicKeys.map((key, index) => ({
          ...key,
          bip32Path: index === 0 ? "m/48'/0'/1'/2'" : key.bip32Path,
        })),
      })),
    ).toThrow(/48'\/0'\/0'\/2'/);
  });

  it('normalises Sparrow wallet backups and rejects ordered multisig', () => {
    const keys = makeDescriptorKeys();
    const parsed = parseSparrowWalletConfig(JSON.stringify(sparrowConfig(keys)));

    expect(parsed).toMatchObject({
      name: 'Treasury',
      requiredSignatures: 2,
      totalKeys: 3,
      source: 'sparrow',
    });
    expect(parsed.signers[1]).toMatchObject({
      name: 'Signer 2',
      device: 'ledger',
      modelHint: 'LEDGER_NANO_X',
    });

    expect(() =>
      parseSparrowWalletConfig(JSON.stringify({
        ...sparrowConfig(keys),
        quorum: undefined,
        defaultPolicy: {
          type: 'WSH',
          miniscript: 'wsh(multi(2,@0/<0;1>/*,@1/<0;1>/*,@2/<0;1>/*))',
        },
      })),
    ).toThrow(/ordered `multi/);

    expect(() =>
      parseSparrowWalletConfig(JSON.stringify({
        ...sparrowConfig(keys),
        keystores: sparrowConfig(keys).keystores.map((key, index) => ({
          ...key,
          keyDerivation: {
            ...key.keyDerivation,
            derivationPath: index === 0 ? "m/48'/0'/1'/2'" : key.keyDerivation.derivationPath,
          },
        })),
      })),
    ).toThrow(/48'\/0'\/0'\/2'/);
  });

  it('parses native Asylia backups and falls back across providers', () => {
    const keys = makeDescriptorKeys();
    const descriptors = buildWshSortedMultiDescriptor({
      requiredSignatures: 2,
      keys,
      network: 'mainnet',
    });

    expect(parseAsyliaVaultConfig(JSON.stringify({
      name: 'Asylia Treasury',
      version: 1,
      providers: {
        caravan: caravanConfig(keys),
        descriptor: descriptors.descriptor,
      },
    }))).toMatchObject({
      name: 'Asylia Treasury',
      source: 'asylia',
      totalKeys: 3,
    });

    expect(parseAsyliaVaultConfig(JSON.stringify({
      name: 'Descriptor Only',
      version: '1',
      providers: {
        caravan: { broken: true },
        descriptor: { receiveDescriptor: descriptors.receiveDescriptor },
      },
    }))).toMatchObject({
      name: 'Descriptor Only',
      source: 'asylia',
      totalKeys: 3,
    });
  });

  it('computes the same vault identity across every supported import format', () => {
    const keys = makeDescriptorKeys();
    const descriptors = buildWshSortedMultiDescriptor({
      requiredSignatures: 2,
      keys,
      network: 'mainnet',
    });

    const imports = [
      parseCaravanWalletConfig(JSON.stringify(caravanConfig(keys))),
      parseSparrowWalletConfig(JSON.stringify(sparrowConfig(keys))),
      parseDescriptorImport(descriptors.descriptor),
      parseAsyliaVaultConfig(JSON.stringify({
        name: 'Asylia Treasury',
        version: 1,
        providers: {
          caravan: caravanConfig([...keys].reverse()),
          sparrow: sparrowConfig(keys),
          descriptor: descriptors.descriptor,
        },
      })),
    ];

    const identities = imports.map(identityFromImport);
    expect(new Set(identities).size).toBe(1);
  });
});

function makeDescriptorKeys(): DescriptorKey[] {
  return [11, 22, 33].map((byte) => {
    const root = bip32.fromSeed(Buffer.alloc(32, byte));
    const account = root.derivePath(ACCOUNT_PATH);
    return {
      fingerprint: fingerprintHex(root.fingerprint),
      derivationPath: DERIVATION_PATH,
      xpub: account.neutered().toBase58(),
    };
  });
}

function caravanConfig(keys: readonly DescriptorKey[]) {
  return {
    name: 'Treasury',
    addressType: 'P2WSH',
    network: 'mainnet',
    quorum: {
      requiredSigners: 2,
      totalSigners: keys.length,
    },
    extendedPublicKeys: keys.map((key, index) => ({
      name: `Signer ${index + 1}`,
      bip32Path: `m/${key.derivationPath}`,
      xfp: key.fingerprint,
      xpub: key.xpub,
      method: index === 1 ? 'ledger' : 'trezor',
    })),
  };
}

function sparrowConfig(keys: readonly DescriptorKey[]) {
  return {
    label: 'Treasury',
    policyType: 'MULTI',
    scriptType: 'P2WSH',
    quorum: { threshold: 2 },
    defaultPolicy: {
      type: 'WSH',
      miniscript: 'wsh(sortedmulti(2,@0/<0;1>/*,@1/<0;1>/*,@2/<0;1>/*))',
    },
    keystores: keys.map((key, index) => ({
      label: `Signer ${index + 1}`,
      walletType: index === 1 ? 'LEDGER_NANO_X' : 'TREZOR_SAFE_5',
      keyDerivation: {
        masterFingerprint: key.fingerprint,
        derivationPath: `m/${key.derivationPath}`,
      },
      extendedPublicKey: key.xpub,
    })),
  };
}

function identityFromImport(parsed: ParsedMultisigImport): string {
  return vaultIdentityKey({
    requiredSignatures: parsed.requiredSignatures,
    totalKeys: parsed.totalKeys,
    keys: parsed.signers.map((signer) => ({
      fingerprint: signer.fingerprint,
      derivationPath: signer.derivationPath,
      xpub: signer.xpub,
    })),
  });
}

function fingerprintHex(fingerprint: number | Uint8Array): string {
  if (fingerprint instanceof Uint8Array) {
    return Buffer.from(fingerprint).toString('hex');
  }
  const out = Buffer.allocUnsafe(4);
  out.writeUInt32BE(fingerprint >>> 0, 0);
  return out.toString('hex');
}
