import bs58check from 'bs58check';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const appClient = {
    getExtendedPubkey: vi.fn(),
  };
  const transport = {
    close: vi.fn(),
    on: vi.fn(),
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

vi.mock('./transport', () => ({
  closeLedgerTransport: mocks.closeLedgerTransport,
  openLedgerTransport: mocks.openLedgerTransport,
}));

import { exportLedgerRoot } from './xpub';
import type { ExportRootInput } from './types';

const FINGERPRINT = 'deadbeef';

describe('exportLedgerRoot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.appClient.getExtendedPubkey.mockResolvedValue(makeXpub(1));
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

  it('rejects invalid derivation paths before opening transport', async () => {
    await expect(exportLedgerRoot({ ...input(), derivationPath: '48/not-valid' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_path' },
    });
    expect(mocks.openLedgerTransport).not.toHaveBeenCalled();
  });

  it('short-circuits transport, app metadata, and fingerprint failures', async () => {
    mocks.openLedgerTransport.mockResolvedValueOnce({
      ok: false,
      error: { code: 'transport_unavailable', message: 'no ledger' },
    });
    await expect(exportLedgerRoot(input())).resolves.toMatchObject({
      ok: false,
      error: { code: 'transport_unavailable' },
    });

    mocks.readAppMetadata.mockResolvedValueOnce({
      ok: false,
      error: { code: 'wrong_app', message: 'open Bitcoin' },
    });
    await expect(exportLedgerRoot(input())).resolves.toMatchObject({
      ok: false,
      error: { code: 'wrong_app' },
    });
    expect(mocks.closeLedgerTransport).toHaveBeenCalledWith(mocks.transport);

    mocks.readFingerprint.mockResolvedValueOnce({
      ok: false,
      error: { code: 'unknown', message: 'fingerprint failed' },
    });
    await expect(exportLedgerRoot(input())).resolves.toMatchObject({
      ok: false,
      error: { code: 'unknown' },
    });
    expect(mocks.closeLedgerTransport).toHaveBeenCalledTimes(2);
  });

  it('rejects unexpected xpub shapes and maps SDK errors', async () => {
    mocks.appClient.getExtendedPubkey.mockResolvedValueOnce(123);
    await expect(exportLedgerRoot(input())).resolves.toMatchObject({
      ok: false,
      error: { code: 'descriptor_unavailable' },
    });

    mocks.appClient.getExtendedPubkey.mockRejectedValueOnce(new Error('device locked'));
    await expect(exportLedgerRoot(input())).resolves.toMatchObject({ ok: false });
  });

  it('returns exported xpub metadata and wires disconnect events', async () => {
    const result = await exportLedgerRoot(input());

    expect(result).toMatchObject({
      ok: true,
      data: {
        masterFingerprint: FINGERPRINT,
        derivationPath: "m/48'/0'/0'/2'",
        scriptType: 'p2wsh',
        xpubMultisig: expect.stringMatching(/^Zpub/),
      },
    });
    expect(mocks.appClient.getExtendedPubkey).toHaveBeenCalledWith("m/48'/0'/0'/2'", true);
    expect(mocks.transport.on).toHaveBeenCalledWith('disconnect', expect.any(Function));
    const [, callback] = mocks.transport.on.mock.calls[0]!;
    callback(new Error('unplugged'));
    expect(mocks.emitSyntheticLedgerEvent).toHaveBeenCalledWith({
      phase: 'transport_error',
      message: 'unplugged',
    });
  });

  it('keeps the legacy xpub when multisig conversion fails', async () => {
    mocks.appClient.getExtendedPubkey.mockResolvedValueOnce('xpub-not-base58');

    await expect(exportLedgerRoot(input())).resolves.toMatchObject({
      ok: true,
      data: {
        xpub: 'xpub-not-base58',
        xpubMultisig: null,
      },
    });
  });
});

function input(): ExportRootInput {
  return {
    derivationPath: "m/48'/0'/0'/2'",
    scriptType: 'p2wsh',
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
