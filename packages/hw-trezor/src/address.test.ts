import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  bip32PathToAddressN: vi.fn(),
  buildTrezorCosignerNodes: vi.fn(),
  buildTrezorMultisigBlock: vi.fn(),
  getAddress: vi.fn(),
}));

vi.mock('@asylia/btc-core', () => ({
  bip32PathToAddressN: mocks.bip32PathToAddressN,
}));

vi.mock('./multisig', () => ({
  buildTrezorCosignerNodes: mocks.buildTrezorCosignerNodes,
  buildTrezorMultisigBlock: mocks.buildTrezorMultisigBlock,
}));

vi.mock('./sdk', () => ({
  TrezorConnect: {
    getAddress: mocks.getAddress,
  },
}));

import { displayWshSortedMultiAddress } from './address';
import type { DisplayAddressInput } from './types';

const FINGERPRINT = 'deadbeef';
const OTHER_FINGERPRINT = 'baddcafe';

describe('displayWshSortedMultiAddress', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.bip32PathToAddressN.mockImplementation((path: string) => pathToAddressN(path));
    mocks.buildTrezorCosignerNodes.mockImplementation((keys: DisplayAddressInput['keys']) =>
      keys.map((key) => ({ key, node: { depth: 4 } })),
    );
    mocks.buildTrezorMultisigBlock.mockReturnValue({ m: 2, pubkeys: [], signatures: [] });
    mocks.getAddress.mockResolvedValue({
      success: true,
      payload: {
        address: 'bc1qexpected',
        serializedPath: "m/48'/0'/0'/2'/1/9",
      },
    });
  });

  it('validates requests before calling the Trezor SDK', async () => {
    await expect(
      displayWshSortedMultiAddress({ ...input(), scriptType: 'p2sh-p2wsh' as never }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'invalid_path' } });
    await expect(
      displayWshSortedMultiAddress({ ...input(), signerFingerprint: 'not-a-fp' }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'invalid_path' } });
    await expect(
      displayWshSortedMultiAddress({ ...input(), chain: 2 as never }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'invalid_path' } });
    await expect(
      displayWshSortedMultiAddress({ ...input(), index: -1 }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'invalid_path' } });
    await expect(
      displayWshSortedMultiAddress({ ...input(), expectedAddress: '  ' }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'invalid_path' } });
    await expect(
      displayWshSortedMultiAddress({ ...input(), requiredSignatures: 3 }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'invalid_path' } });

    expect(mocks.getAddress).not.toHaveBeenCalled();
  });

  it('rejects requests for signers outside the vault', async () => {
    const result = await displayWshSortedMultiAddress({
      ...input(),
      signerFingerprint: 'ffffffff',
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_path' } });
    expect(mocks.getAddress).not.toHaveBeenCalled();
  });

  it('normalises cosigner and derivation parsing failures', async () => {
    mocks.buildTrezorCosignerNodes.mockImplementationOnce(() => {
      throw new Error('bad xpub');
    });
    await expect(displayWshSortedMultiAddress(input())).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_path' },
    });
    expect(mocks.getAddress).not.toHaveBeenCalled();

    mocks.bip32PathToAddressN.mockImplementationOnce(() => {
      throw new Error('bad path');
    });
    await expect(displayWshSortedMultiAddress(input())).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_path' },
    });
  });

  it('normalises Trezor SDK failures', async () => {
    mocks.getAddress.mockResolvedValue({
      success: false,
      payload: {
        code: 'Method_Cancel',
        error: 'cancelled',
      },
    });

    const result = await displayWshSortedMultiAddress(input());

    expect(result).toMatchObject({ ok: false, error: { code: 'cancelled' } });
  });

  it('normalises thrown Trezor SDK errors', async () => {
    mocks.getAddress.mockRejectedValue(new Error('popup closed'));

    await expect(displayWshSortedMultiAddress(input())).resolves.toMatchObject({
      ok: false,
    });
  });

  it('rejects address mismatches returned by the device', async () => {
    mocks.getAddress.mockResolvedValue({
      success: true,
      payload: { address: 'bc1qother' },
    });

    const result = await displayWshSortedMultiAddress(input());

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'descriptor_unavailable' },
    });
  });

  it('passes multisig metadata to Trezor and returns verified address data', async () => {
    const result = await displayWshSortedMultiAddress(input());

    expect(result).toEqual({
      ok: true,
      data: {
        address: 'bc1qexpected',
        expectedAddress: 'bc1qexpected',
        chain: 1,
        index: 9,
        signerFingerprint: FINGERPRINT,
      },
    });
    expect(mocks.getAddress).toHaveBeenCalledWith({
      path: "m/48'/0'/0'/2'/1/9",
      coin: 'btc',
      scriptType: 'SPENDWITNESS',
      showOnTrezor: true,
      address: 'bc1qexpected',
      multisig: { m: 2, pubkeys: [], signatures: [] },
    });
    expect(mocks.buildTrezorMultisigBlock).toHaveBeenCalledWith({
      cosignerNodes: expect.any(Array),
      requiredSignatures: 2,
      chain: 1,
      index: 9,
    });
  });
});

function input(): DisplayAddressInput {
  return {
    requiredSignatures: 2,
    keys: [
      {
        fingerprint: FINGERPRINT,
        derivationPath: "m/48'/0'/0'/2'",
        xpub: 'xpub-a',
      },
      {
        fingerprint: OTHER_FINGERPRINT,
        derivationPath: "m/48'/0'/0'/2'",
        xpub: 'xpub-b',
      },
    ],
    signerFingerprint: FINGERPRINT,
    chain: 1,
    index: 9,
    expectedAddress: 'bc1qexpected',
  };
}

function pathToAddressN(path: string): number[] {
  const parts = path
    .replace(/^m\//, '')
    .split('/')
    .filter(Boolean);
  return parts.map((part) => {
    const hardened = part.endsWith("'") || part.endsWith('h');
    const value = Number.parseInt(part.replace(/['h]/g, ''), 10);
    return hardened ? value + 0x80000000 : value;
  });
}
