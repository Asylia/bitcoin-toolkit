import bs58check from 'bs58check';
import type { DescriptorKey, PsbtBip32Derivation } from '@asylia/btc-core';
import { describe, expect, it } from 'vitest';

import {
  buildTrezorCosignerNodes,
  buildTrezorMultisigBlock,
  parseXpubToHDNode,
} from './multisig';

describe('parseXpubToHDNode', () => {
  it('decodes BIP-32 extended public keys into Trezor HD-node fields', () => {
    const node = parseXpubToHDNode(makeXpub(7));

    expect(node).toMatchObject({
      depth: 4,
      fingerprint: 0xaabbcc07,
      child_num: 0x80000007,
    });
    expect(node.chain_code).toHaveLength(64);
    expect(node.public_key).toHaveLength(66);
  });

  it('rejects malformed xpub values', () => {
    expect(() => parseXpubToHDNode('not-base58check')).toThrow('base58check');
    expect(() => parseXpubToHDNode(bs58check.encode(new Uint8Array(77)))).toThrow(
      'unexpected length',
    );
  });
});

describe('buildTrezorMultisigBlock', () => {
  it('builds lexicographic multisig metadata and strips sighash bytes from signatures', () => {
    const keys: DescriptorKey[] = [
      { fingerprint: 'aabbcc01', derivationPath: "48'/0'/0'/2'", xpub: makeXpub(1) },
      { fingerprint: 'aabbcc02', derivationPath: "48'/0'/0'/2'", xpub: makeXpub(2) },
    ];
    const pubkey = new Uint8Array([0x02, ...Array.from({ length: 32 }, (_, index) => index)]);
    const bip32Derivation: PsbtBip32Derivation[] = [
      {
        masterFingerprint: Uint8Array.from([0xaa, 0xbb, 0xcc, 0x01]),
        pubkey,
        path: "m/48'/0'/0'/2'/0/5",
      },
    ];

    const block = buildTrezorMultisigBlock({
      cosignerNodes: buildTrezorCosignerNodes(keys),
      requiredSignatures: 2,
      chain: 0,
      index: 5,
      bip32Derivation,
      existingPartialSigs: [
        {
          pubkey,
          signature: Uint8Array.from([0x30, 0x44, 0x01]),
        },
      ],
    });

    expect(block).toMatchObject({
      m: 2,
      pubkeys_order: 1,
      signatures: ['3044', ''],
    });
    expect(block.pubkeys.map((entry) => entry.address_n)).toEqual([
      [0, 5],
      [0, 5],
    ]);
  });

  it('places existing signatures in the matching cosigner slot by fingerprint and pubkey', () => {
    const keys: DescriptorKey[] = [
      { fingerprint: 'AABBCC01', derivationPath: "48'/0'/0'/2'", xpub: makeXpub(1) },
      { fingerprint: 'AABBCC02', derivationPath: "48'/0'/0'/2'", xpub: makeXpub(2) },
    ];
    const firstPubkey = new Uint8Array([0x02, ...Array.from({ length: 32 }, (_, index) => index)]);
    const secondPubkey = new Uint8Array([
      0x03,
      ...Array.from({ length: 32 }, (_, index) => index + 1),
    ]);
    const block = buildTrezorMultisigBlock({
      cosignerNodes: buildTrezorCosignerNodes(keys),
      requiredSignatures: 2,
      chain: 1,
      index: 7,
      bip32Derivation: [
        {
          masterFingerprint: Uint8Array.from([0xaa, 0xbb, 0xcc, 0x01]),
          pubkey: firstPubkey,
          path: "m/48'/0'/0'/2'/1/7",
        },
        {
          masterFingerprint: Uint8Array.from([0xaa, 0xbb, 0xcc, 0x02]),
          pubkey: secondPubkey,
          path: "m/48'/0'/0'/2'/1/7",
        },
      ],
      existingPartialSigs: [
        {
          pubkey: secondPubkey,
          signature: Uint8Array.from([0x30, 0x45, 0x01]),
        },
      ],
    });

    expect(block.signatures).toEqual(['', '3045']);
    expect(block.pubkeys.map((entry) => entry.address_n)).toEqual([
      [1, 7],
      [1, 7],
    ]);
  });

  it('leaves a signature slot empty when the partial signature pubkey does not match', () => {
    const keys: DescriptorKey[] = [
      { fingerprint: 'aabbcc01', derivationPath: "48'/0'/0'/2'", xpub: makeXpub(1) },
    ];
    const block = buildTrezorMultisigBlock({
      cosignerNodes: buildTrezorCosignerNodes(keys),
      requiredSignatures: 1,
      chain: 0,
      index: 0,
      bip32Derivation: [
        {
          masterFingerprint: Uint8Array.from([0xaa, 0xbb, 0xcc, 0x01]),
          pubkey: Uint8Array.from([0x02, ...Array.from({ length: 32 }, (_, index) => index)]),
          path: "m/48'/0'/0'/2'/0/0",
        },
      ],
      existingPartialSigs: [
        {
          pubkey: Uint8Array.from([0x03, ...Array.from({ length: 32 }, (_, index) => index)]),
          signature: Uint8Array.from([0x30, 0x44, 0x01]),
        },
      ],
    });

    expect(block.signatures).toEqual(['']);
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
