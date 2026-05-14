import { describe, expect, it } from 'vitest';

import {
  ASYLIA_SIGNER_AUTH_PATH,
  buildSignerAuthChallenge,
  signerXpubHash,
} from './auth-challenge';

describe('signer auth challenge', () => {
  it('builds the stable domain-separated message', () => {
    const challenge = buildSignerAuthChallenge({
      domain: 'Wallet.Asylia.IO',
      signerFingerprint: 'abcdef12',
      signerRootHash: 'a'.repeat(64),
      nonce: '0123456789abcdef',
      issuedAt: '2026-05-06T12:00:00.000Z',
      expiresAt: '2026-05-06T12:05:00.000Z',
    });

    expect(challenge.authPath).toBe(ASYLIA_SIGNER_AUTH_PATH);
    expect(challenge.message).toBe([
      'Asylia signer login',
      'Version: 1',
      'Domain: wallet.asylia.io',
      'Purpose: authenticate signer session',
      'Signer fingerprint: abcdef12',
      `Signer root hash: ${'a'.repeat(64)}`,
      `Auth path: ${ASYLIA_SIGNER_AUTH_PATH}`,
      'Nonce: 0123456789abcdef',
      'Issued at: 2026-05-06T12:00:00.000Z',
      'Expires at: 2026-05-06T12:05:00.000Z',
    ].join('\n'));
  });

  it('hashes normalized public roots without using fingerprint authority', () => {
    expect(
      signerXpubHash({
        network: 'MAINNET',
        derivationRoot: " m/48'/0'/0'/2' ",
        xpub: ' xpub-test ',
      }),
    ).toBe(
      signerXpubHash({
        network: 'mainnet',
        derivationRoot: "m/48'/0'/0'/2'",
        xpub: 'xpub-test',
      }),
    );
  });

  it('rejects malformed root hash and too-short nonce', () => {
    expect(() =>
      buildSignerAuthChallenge({
        domain: 'wallet.asylia.io',
        signerFingerprint: 'abcdef12',
        signerRootHash: 'abc',
        nonce: '0123456789abcdef',
        issuedAt: '2026-05-06T12:00:00.000Z',
        expiresAt: '2026-05-06T12:05:00.000Z',
      }),
    ).toThrow(/root hash/);

    expect(() =>
      buildSignerAuthChallenge({
        domain: 'wallet.asylia.io',
        signerFingerprint: 'abcdef12',
        signerRootHash: 'a'.repeat(64),
        nonce: 'short',
        issuedAt: '2026-05-06T12:00:00.000Z',
        expiresAt: '2026-05-06T12:05:00.000Z',
      }),
    ).toThrow(/nonce/);
  });
});
