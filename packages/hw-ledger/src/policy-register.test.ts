import bs58check from 'bs58check';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const appClient = {
    registerWallet: vi.fn(),
  };
  const transport = {
    close: vi.fn(),
    device: {
      productId: 0x5000,
      productName: 'Ledger Nano S Plus',
    },
  };
  const policyId = Uint8Array.from(Array.from({ length: 32 }, () => 0x11));
  return {
    appClient,
    transport,
    policyId,
    AppClient: vi.fn(function AppClient() {
      return appClient;
    }),
    WalletPolicy: vi.fn(function WalletPolicy(
      this: { getId: () => Uint8Array },
      _name: string,
      _template: string,
      _keys: string[],
    ) {
      this.getId = () => policyId;
    }),
    buildDeviceInfo: vi.fn(),
    readAppMetadata: vi.fn(),
    readFingerprint: vi.fn(),
    emitSyntheticLedgerEvent: vi.fn(),
    openLedgerTransport: vi.fn(),
    closeLedgerTransport: vi.fn(),
  };
});

vi.mock('@ledgerhq/ledger-bitcoin', () => ({
  AppClient: mocks.AppClient,
  WalletPolicy: mocks.WalletPolicy,
}));

vi.mock('./app', () => ({
  buildDeviceInfo: mocks.buildDeviceInfo,
  readAppMetadata: mocks.readAppMetadata,
  readFingerprint: mocks.readFingerprint,
}));

vi.mock('./events', () => ({
  emitSyntheticLedgerEvent: mocks.emitSyntheticLedgerEvent,
}));

vi.mock('./transport', () => ({
  closeLedgerTransport: mocks.closeLedgerTransport,
  openLedgerTransport: mocks.openLedgerTransport,
}));

import { registerLedgerWalletPolicy } from './policy';
import type { LedgerWalletPolicyInput } from './types';

const FINGERPRINT = 'deadbeef';
const OTHER_FINGERPRINT = 'baddcafe';

describe('registerLedgerWalletPolicy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.appClient.registerWallet.mockResolvedValue([
      mocks.policyId,
      Uint8Array.from(Array.from({ length: 32 }, () => 0xaa)),
    ]);
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
    mocks.openLedgerTransport.mockResolvedValue({ ok: true, data: mocks.transport });
    mocks.closeLedgerTransport.mockResolvedValue(undefined);
  });

  it('registers a policy and returns the policy HMAC as hex', async () => {
    const result = await registerLedgerWalletPolicy(input());

    expect(result).toMatchObject({
      ok: true,
      data: {
        policyId: '11'.repeat(32),
        policyHmac: 'aa'.repeat(32),
        registeredFingerprint: FINGERPRINT,
      },
    });
    expect(mocks.appClient.registerWallet).toHaveBeenCalledWith(expect.any(Object));
    expect(mocks.emitSyntheticLedgerEvent).toHaveBeenCalledWith({
      phase: 'awaiting_button',
      intent: 'Approve wallet policy',
    });
    expect(mocks.closeLedgerTransport).toHaveBeenCalledWith(mocks.transport);
  });

  it('rejects wrong devices and transport failures before registration', async () => {
    mocks.readFingerprint.mockResolvedValueOnce({ ok: true, data: OTHER_FINGERPRINT });

    await expect(registerLedgerWalletPolicy(input())).resolves.toMatchObject({
      ok: false,
      error: { code: 'wrong_device' },
    });
    expect(mocks.appClient.registerWallet).not.toHaveBeenCalled();
    expect(mocks.closeLedgerTransport).toHaveBeenCalledWith(mocks.transport);

    mocks.openLedgerTransport.mockResolvedValueOnce({
      ok: false,
      error: { code: 'transport_unavailable', message: 'no ledger' },
    });
    await expect(registerLedgerWalletPolicy(input())).resolves.toMatchObject({
      ok: false,
      error: { code: 'transport_unavailable' },
    });
  });

  it('maps registration failures and policy id mismatches', async () => {
    mocks.appClient.registerWallet.mockRejectedValueOnce(new Error('denied'));
    await expect(registerLedgerWalletPolicy(input())).resolves.toMatchObject({ ok: false });

    mocks.appClient.registerWallet.mockResolvedValueOnce([
      Uint8Array.from(Array.from({ length: 32 }, () => 0x22)),
      Uint8Array.from(Array.from({ length: 32 }, () => 0xaa)),
    ]);
    await expect(registerLedgerWalletPolicy(input())).resolves.toMatchObject({
      ok: false,
      error: { code: 'descriptor_unavailable' },
    });
  });
});

function input(): LedgerWalletPolicyInput {
  return {
    requiredSignatures: 2,
    targetFingerprint: FINGERPRINT,
    keys: [
      {
        fingerprint: FINGERPRINT,
        derivationPath: "m/48'/0'/0'/2'",
        xpub: makeXpub(1),
      },
      {
        fingerprint: OTHER_FINGERPRINT,
        derivationPath: "m/48'/0'/0'/2'",
        xpub: makeXpub(2),
      },
    ],
  };
}

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
