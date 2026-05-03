import { Buffer } from 'node:buffer';
import bs58check from 'bs58check';
import { describe, expect, it } from 'vitest';

import { makeSyntheticBitcoinFixture } from '../__fixtures__/bitcoin';
import {
  ASYLIA_BIP48_P2WSH_ROOT,
  canonicalizeAsyliaBip48Root,
  canonicalizeDerivationPath,
  describeNonMainnetXpub,
  detectExtendedPubkeyNetwork,
  isAsyliaBip48Root,
  isDerivationPathBody,
  isFingerprint,
  requireAsyliaBip48Root,
  stripMasterPrefix,
  toCanonicalXpub,
} from '../index';

describe('descriptor normalisation helpers', () => {
  it('normalises BIP-32 path notation without changing semantics', () => {
    expect(stripMasterPrefix("m/48h/0h/0h/2h")).toBe("48h/0h/0h/2h");
    expect(stripMasterPrefix('M')).toBe('');
    expect(canonicalizeDerivationPath("48h/0h/0h/2h/0/15")).toBe("48'/0'/0'/2'/0/15");
  });

  it('validates origin fingerprints and derivation path bodies', () => {
    expect(isFingerprint('deadbeef')).toBe(true);
    expect(isFingerprint('DEADBEEF')).toBe(false);
    expect(isDerivationPathBody('')).toBe(true);
    expect(isDerivationPathBody('0')).toBe(true);
    expect(isDerivationPathBody("48'/0'/0'/2'")).toBe(true);
    expect(isDerivationPathBody('48h/0h/0h/2h')).toBe(true);
    expect(isDerivationPathBody('48//0')).toBe(false);
    expect(isDerivationPathBody('m/48/0')).toBe(false);
    expect(isDerivationPathBody('48/')).toBe(false);
  });

  it('recognises only the Asylia BIP-48 mainnet P2WSH root', () => {
    expect(ASYLIA_BIP48_P2WSH_ROOT).toBe("48'/0'/0'/2'");
    expect(canonicalizeAsyliaBip48Root("m/48h/0h/0h/2h")).toBe(
      ASYLIA_BIP48_P2WSH_ROOT,
    );
    expect(isAsyliaBip48Root("48'/0'/0'/2'")).toBe(true);
    expect(isAsyliaBip48Root("48'/1'/0'/2'")).toBe(false);
    expect(isAsyliaBip48Root("48'/0'/1'/2'")).toBe(false);
    expect(isAsyliaBip48Root('')).toBe(false);
  });

  it('enforces the strict Asylia BIP-48 root through one shared guard', () => {
    class CustomRootError extends Error {}

    expect(requireAsyliaBip48Root("m/48h/0h/0h/2h", 'signer')).toBe(
      ASYLIA_BIP48_P2WSH_ROOT,
    );
    expect(() =>
      requireAsyliaBip48Root('', 'signer', (message) => new CustomRootError(message)),
    ).toThrow(CustomRootError);
    expect(() => requireAsyliaBip48Root('', 'signer')).toThrow(
      /48'\/0'\/0'\/2'/,
    );
  });

  it('renders targeted import errors for non-mainnet xpubs', () => {
    expect(describeNonMainnetXpub('mainnet', 'signer')).toBeNull();
    expect(describeNonMainnetXpub('testnet', 'signer')).toContain('testnet');
    expect(describeNonMainnetXpub('invalid', 'signer')).toContain('base58check');
  });

  it('detects and canonicalises every supported mainnet SLIP-132 xpub prefix', () => {
    const xpub = makeSyntheticBitcoinFixture().descriptors[0]!.xpub;
    const variants = [
      xpub,
      reencodeExtendedPubkey(xpub, [0x04, 0x9d, 0x7c, 0xb2]), // ypub
      reencodeExtendedPubkey(xpub, [0x04, 0xb2, 0x47, 0x46]), // zpub
      reencodeExtendedPubkey(xpub, [0x02, 0x95, 0xb4, 0x3f]), // Ypub
      reencodeExtendedPubkey(xpub, [0x02, 0xaa, 0x7e, 0xd3]), // Zpub
    ];

    for (const variant of variants) {
      expect(detectExtendedPubkeyNetwork(variant)).toBe('mainnet');
      expect(toCanonicalXpub(variant)).toBe(xpub);
      expect(decodedPayload(variant)).toEqual(decodedPayload(xpub));
    }
  });

  it('rejects testnet, unknown, and malformed extended public keys during canonicalisation', () => {
    const xpub = makeSyntheticBitcoinFixture().descriptors[0]!.xpub;
    const testnetVariants = [
      reencodeExtendedPubkey(xpub, [0x04, 0x35, 0x87, 0xcf]), // tpub
      reencodeExtendedPubkey(xpub, [0x04, 0x4a, 0x52, 0x62]), // upub
      reencodeExtendedPubkey(xpub, [0x04, 0x5f, 0x1c, 0xf6]), // vpub
      reencodeExtendedPubkey(xpub, [0x02, 0x42, 0x89, 0xef]), // Upub
      reencodeExtendedPubkey(xpub, [0x02, 0x57, 0x54, 0x83]), // Vpub
    ];
    const unknown = reencodeExtendedPubkey(xpub, [0x01, 0x02, 0x03, 0x04]);

    for (const variant of testnetVariants) {
      expect(detectExtendedPubkeyNetwork(variant)).toBe('testnet');
      expect(toCanonicalXpub(variant)).toBeNull();
    }
    expect(detectExtendedPubkeyNetwork(unknown)).toBe('unknown');
    expect(toCanonicalXpub(unknown)).toBeNull();
    expect(detectExtendedPubkeyNetwork('not-base58check')).toBe('invalid');
    expect(toCanonicalXpub('not-base58check')).toBeNull();
  });
});

function reencodeExtendedPubkey(xpub: string, version: readonly number[]): string {
  const decoded = bs58check.decode(xpub);
  return bs58check.encode(
    Buffer.concat([Buffer.from(version), Buffer.from(decoded).subarray(4)]),
  );
}

function decodedPayload(extendedPublicKey: string): Buffer {
  return Buffer.from(bs58check.decode(extendedPublicKey)).subarray(4);
}
