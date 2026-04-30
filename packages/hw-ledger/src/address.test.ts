import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const appClient = {
    getWalletAddress: vi.fn(),
  };
  const transport = {
    close: vi.fn(),
    device: {
      productId: 0x5000,
      productName: 'Ledger Nano S Plus',
    },
  };
  return {
    appClient,
    transport,
    AppClient: vi.fn(function AppClient() {
      return appClient;
    }),
    buildDeviceInfo: vi.fn(),
    readAppMetadata: vi.fn(),
    readFingerprint: vi.fn(),
    emitSyntheticLedgerEvent: vi.fn(),
    buildLedgerWalletPolicyForDevice: vi.fn(),
    openLedgerTransport: vi.fn(),
    closeLedgerTransport: vi.fn(),
  };
});

vi.mock('@ledgerhq/ledger-bitcoin', () => ({
  AppClient: mocks.AppClient,
}));

vi.mock('./app', () => ({
  buildDeviceInfo: mocks.buildDeviceInfo,
  readAppMetadata: mocks.readAppMetadata,
  readFingerprint: mocks.readFingerprint,
}));

vi.mock('./events', () => ({
  emitSyntheticLedgerEvent: mocks.emitSyntheticLedgerEvent,
}));

vi.mock('./policy', () => ({
  buildLedgerWalletPolicyForDevice: mocks.buildLedgerWalletPolicyForDevice,
}));

vi.mock('./transport', () => ({
  closeLedgerTransport: mocks.closeLedgerTransport,
  openLedgerTransport: mocks.openLedgerTransport,
}));

import { displayWshSortedMultiAddress } from './address';
import type { DisplayAddressInput } from './types';

const FINGERPRINT = 'deadbeef';
const OTHER_FINGERPRINT = 'baddcafe';
const POLICY_ID = '11'.repeat(32);
const POLICY_HMAC = 'aa'.repeat(32);

describe('displayWshSortedMultiAddress', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.appClient.getWalletAddress.mockResolvedValue('bc1qexpected');
    mocks.buildDeviceInfo.mockReturnValue({
      model: 'Ledger Nano S Plus',
      productId: 0x5000,
      appName: 'Bitcoin',
      appVersion: '2.2.3',
    });
    mocks.readAppMetadata.mockResolvedValue({
      ok: true,
      data: { appName: 'Bitcoin', appVersion: '2.2.3' },
    });
    mocks.readFingerprint.mockResolvedValue({ ok: true, data: FINGERPRINT });
    mocks.buildLedgerWalletPolicyForDevice.mockReturnValue({
      ok: true,
      data: {
        policy: { name: 'policy' },
        policyId: POLICY_ID,
      },
    });
    mocks.openLedgerTransport.mockResolvedValue({ ok: true, data: mocks.transport });
    mocks.closeLedgerTransport.mockResolvedValue(undefined);
  });

  it('validates address requests before opening transport', async () => {
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
      displayWshSortedMultiAddress({ ...input(), expectedAddress: '   ' }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'invalid_path' } });

    expect(mocks.openLedgerTransport).not.toHaveBeenCalled();
  });

  it('rejects policy id mismatches and invalid HMAC values before opening transport', async () => {
    await expect(
      displayWshSortedMultiAddress({ ...input(), policyId: '22'.repeat(32) }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'descriptor_unavailable' } });
    await expect(
      displayWshSortedMultiAddress({ ...input(), policyHmac: 'not-hex' }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'descriptor_unavailable' } });

    expect(mocks.openLedgerTransport).not.toHaveBeenCalled();
  });

  it('closes transport and rejects when the connected Ledger is not the selected signer', async () => {
    mocks.readFingerprint.mockResolvedValue({ ok: true, data: OTHER_FINGERPRINT });

    const result = await displayWshSortedMultiAddress(input());

    expect(result).toMatchObject({ ok: false, error: { code: 'wrong_device' } });
    expect(mocks.closeLedgerTransport).toHaveBeenCalledWith(mocks.transport);
  });

  it('rejects device-derived address mismatches', async () => {
    mocks.appClient.getWalletAddress.mockResolvedValue('bc1qother');

    const result = await displayWshSortedMultiAddress(input());

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'descriptor_unavailable' },
    });
    expect(mocks.closeLedgerTransport).toHaveBeenCalledWith(mocks.transport);
  });

  it('returns verified address metadata on success', async () => {
    const result = await displayWshSortedMultiAddress(input());

    expect(result).toEqual({
      ok: true,
      data: {
        address: 'bc1qexpected',
        expectedAddress: 'bc1qexpected',
        chain: 0,
        index: 7,
        signerFingerprint: FINGERPRINT,
        policyId: POLICY_ID,
        device: {
          model: 'Ledger Nano S Plus',
          productId: 0x5000,
          appName: 'Bitcoin',
          appVersion: '2.2.3',
        },
      },
    });
    expect(mocks.appClient.getWalletAddress).toHaveBeenCalledWith(
      { name: 'policy' },
      Buffer.from(POLICY_HMAC, 'hex'),
      0,
      7,
      true,
    );
    expect(mocks.emitSyntheticLedgerEvent).toHaveBeenCalledWith({
      phase: 'awaiting_button',
      intent: 'Verify receive address',
    });
    expect(mocks.closeLedgerTransport).toHaveBeenCalledWith(mocks.transport);
  });
});

function input(): DisplayAddressInput {
  return {
    vault: {
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
    },
    signerFingerprint: FINGERPRINT,
    policyHmac: POLICY_HMAC,
    policyId: POLICY_ID,
    chain: 0,
    index: 7,
    expectedAddress: 'bc1qexpected',
  };
}
