import bs58check from 'bs58check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildLedgerWalletPolicy } from './policy';

describe('buildLedgerWalletPolicy', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it('builds deterministic policy details without opening a device transport', () => {
    const firstXpub = makeXpub(1);
    const secondXpub = makeXpub(2);

    const result = buildLedgerWalletPolicy({
      requiredSignatures: 2,
      keys: [
        {
          fingerprint: 'BADDCAFE',
          derivationPath: "m/48h/0h/0h/2h",
          xpub: secondXpub,
        },
        {
          fingerprint: 'deadbeef',
          derivationPath: "m/48'/0'/0'/2'",
          xpub: firstXpub,
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.policyName).toMatch(/^Asylia 2-of-2 [0-9a-f]{8}$/);
    expect(result.data.descriptorTemplate).toBe('wsh(sortedmulti(2,@0/**,@1/**))');
    expect(result.data.policyId).toMatch(/^[0-9a-f]{64}$/);
    expect(result.data.keyInfo).toHaveLength(2);
    expect(result.data.keyInfo.join('\n')).toContain("[deadbeef/48'/0'/0'/2']");
    expect(result.data.keyInfo.join('\n')).toContain("[baddcafe/48'/0'/0'/2']");
  });

  it('rejects malformed signer fingerprints before building policy bytes', () => {
    const result = buildLedgerWalletPolicy({
      requiredSignatures: 1,
      keys: [
        {
          fingerprint: 'DEAD-BEEF',
          derivationPath: "m/48'/0'/0'/2'",
          xpub: makeXpub(3),
        },
      ],
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'descriptor_unavailable',
      },
    });
  });

  it('keeps the policy id stable when the same cosigners arrive in another order', () => {
    const keys = [
      {
        fingerprint: 'deadbeef',
        derivationPath: "m/48'/0'/0'/2'",
        xpub: makeXpub(1),
      },
      {
        fingerprint: 'baddcafe',
        derivationPath: "m/48h/0h/0h/2h",
        xpub: makeXpub(2),
      },
      {
        fingerprint: 'c001d00d',
        derivationPath: "48'/0'/0'/2'",
        xpub: makeXpub(3),
      },
    ];

    const first = buildLedgerWalletPolicy({ requiredSignatures: 2, keys });
    const second = buildLedgerWalletPolicy({
      requiredSignatures: 2,
      keys: [...keys].reverse(),
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.data.policyId).toBe(first.data.policyId);
    expect(second.data.keyInfo).toEqual(first.data.keyInfo);
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
