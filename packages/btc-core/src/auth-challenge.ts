import { sha256 } from '@noble/hashes/sha256';

export const ASYLIA_SIGNER_AUTH_VERSION = 1 as const;
export const ASYLIA_SIGNER_AUTH_PURPOSE = 'authenticate signer session' as const;
export const ASYLIA_SIGNER_AUTH_PATH = "m/48'/0'/0'/2'/1000000/0" as const;

export type SignerAuthChallengeInput = {
  domain: string;
  signerFingerprint: string;
  signerRootHash: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  authPath?: string;
};

export type SignerAuthChallenge = {
  version: typeof ASYLIA_SIGNER_AUTH_VERSION;
  domain: string;
  purpose: typeof ASYLIA_SIGNER_AUTH_PURPOSE;
  signerFingerprint: string;
  signerRootHash: string;
  authPath: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  message: string;
};

const FINGERPRINT_PATTERN = /^[0-9a-f]{8}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

export class SignerAuthChallengeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignerAuthChallengeError';
  }
}

export function signerXpubHash(input: {
  network: string;
  derivationRoot: string;
  xpub: string;
}): string {
  return bytesToHex(
    sha256(new TextEncoder().encode([
      input.network.trim().toLowerCase(),
      input.derivationRoot.trim(),
      input.xpub.trim(),
    ].join('|'))),
  );
}

export function buildSignerAuthChallenge(
  input: SignerAuthChallengeInput,
): SignerAuthChallenge {
  const domain = input.domain.trim().toLowerCase();
  const signerFingerprint = input.signerFingerprint.trim().toLowerCase();
  const signerRootHash = input.signerRootHash.trim().toLowerCase();
  const authPath = input.authPath?.trim() || ASYLIA_SIGNER_AUTH_PATH;
  const nonce = input.nonce.trim();

  if (!domain) throw new SignerAuthChallengeError('domain is required');
  if (!FINGERPRINT_PATTERN.test(signerFingerprint)) {
    throw new SignerAuthChallengeError('signer fingerprint must be 8 lowercase hex characters');
  }
  if (!HASH_PATTERN.test(signerRootHash)) {
    throw new SignerAuthChallengeError('signer root hash must be 64 lowercase hex characters');
  }
  if (nonce.length < 16) {
    throw new SignerAuthChallengeError('nonce must contain at least 16 characters');
  }
  assertIsoTimestamp(input.issuedAt, 'issuedAt');
  assertIsoTimestamp(input.expiresAt, 'expiresAt');

  const challenge = {
    version: ASYLIA_SIGNER_AUTH_VERSION,
    domain,
    purpose: ASYLIA_SIGNER_AUTH_PURPOSE,
    signerFingerprint,
    signerRootHash,
    authPath,
    nonce,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
  };

  return {
    ...challenge,
    message: [
      'Asylia signer login',
      `Version: ${challenge.version}`,
      `Domain: ${challenge.domain}`,
      `Purpose: ${challenge.purpose}`,
      `Signer fingerprint: ${challenge.signerFingerprint}`,
      `Signer root hash: ${challenge.signerRootHash}`,
      `Auth path: ${challenge.authPath}`,
      `Nonce: ${challenge.nonce}`,
      `Issued at: ${challenge.issuedAt}`,
      `Expires at: ${challenge.expiresAt}`,
    ].join('\n'),
  };
}

function assertIsoTimestamp(value: string, field: string): void {
  if (!value || Number.isNaN(Date.parse(value))) {
    throw new SignerAuthChallengeError(`${field} must be an ISO timestamp`);
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
