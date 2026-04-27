import { describe, expect, it } from 'vitest';

import {
  canonicalizeDerivationPath,
  describeNonMainnetXpub,
  isDerivationPathBody,
  isFingerprint,
  stripMasterPrefix,
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
    expect(isDerivationPathBody("48'/0'/0'/2'")).toBe(true);
    expect(isDerivationPathBody('48//0')).toBe(false);
  });

  it('renders targeted import errors for non-mainnet xpubs', () => {
    expect(describeNonMainnetXpub('mainnet', 'signer')).toBeNull();
    expect(describeNonMainnetXpub('testnet', 'signer')).toContain('testnet');
    expect(describeNonMainnetXpub('invalid', 'signer')).toContain('base58check');
  });
});
