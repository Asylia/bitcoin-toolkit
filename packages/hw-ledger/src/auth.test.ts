import { Buffer } from 'buffer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const appClient = {
    getExtendedPubkey: vi.fn(),
    getWalletAddress: vi.fn(),
    signMessage: vi.fn(),
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
    DefaultWalletPolicy: vi.fn(function DefaultWalletPolicy(
      descriptorTemplate: string,
      key: string,
    ) {
      return { descriptorTemplate, key };
    }),
    readAppMetadata: vi.fn(),
    readFingerprint: vi.fn(),
    emitSyntheticLedgerEvent: vi.fn(),
    openLedgerTransport: vi.fn(),
    closeLedgerTransport: vi.fn(),
  };
});

vi.mock('@ledgerhq/ledger-bitcoin', () => ({
  AppClient: mocks.AppClient,
  DefaultWalletPolicy: mocks.DefaultWalletPolicy,
}));

vi.mock('./app', () => ({
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

import { signAuthChallengeWithLedger } from './auth';

const FINGERPRINT = 'deadbeef';
const AUTH_PATH = "m/84'/0'/0'/0/0";
const AUTH_ROOT = "m/84'/0'/0'";
const AUTH_ROOT_BODY = "84'/0'/0'";
const MESSAGE = 'Asylia login\nNonce: test';

describe('signAuthChallengeWithLedger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.appClient.getExtendedPubkey.mockResolvedValue('xpub-auth-root');
    mocks.appClient.getWalletAddress.mockResolvedValue('bc1qledgerauthaddress');
    mocks.appClient.signMessage.mockResolvedValue('ledger-signature');
    mocks.readAppMetadata.mockResolvedValue({
      ok: true,
      data: { appName: 'Bitcoin', appVersion: '2.2.3' },
    });
    mocks.readFingerprint.mockResolvedValue({ ok: true, data: FINGERPRINT });
    mocks.openLedgerTransport.mockResolvedValue({ ok: true, data: mocks.transport });
    mocks.closeLedgerTransport.mockResolvedValue(undefined);
  });

  it('rejects malformed auth paths before opening transport', async () => {
    await expect(
      signAuthChallengeWithLedger({ authPath: "m/84'/0'/0'/0'", message: MESSAGE }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'invalid_path' } });
    await expect(
      signAuthChallengeWithLedger({ authPath: 'not-a-path', message: MESSAGE }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'invalid_path' } });

    expect(mocks.openLedgerTransport).not.toHaveBeenCalled();
  });

  it('short-circuits transport, app metadata, and fingerprint failures', async () => {
    mocks.openLedgerTransport.mockResolvedValueOnce({
      ok: false,
      error: { code: 'transport_unavailable', message: 'no ledger' },
    });
    await expect(input()).resolves.toMatchObject({
      ok: false,
      error: { code: 'transport_unavailable' },
    });

    mocks.readAppMetadata.mockResolvedValueOnce({
      ok: false,
      error: { code: 'wrong_app', message: 'open Bitcoin' },
    });
    await expect(input()).resolves.toMatchObject({
      ok: false,
      error: { code: 'wrong_app' },
    });
    expect(mocks.closeLedgerTransport).toHaveBeenCalledWith(mocks.transport);

    mocks.readFingerprint.mockResolvedValueOnce({
      ok: false,
      error: { code: 'unknown', message: 'fingerprint failed' },
    });
    await expect(input()).resolves.toMatchObject({
      ok: false,
      error: { code: 'unknown' },
    });
    expect(mocks.closeLedgerTransport).toHaveBeenCalledTimes(2);
  });

  it('derives the Ledger auth address, signs the challenge, and closes transport', async () => {
    const result = await input();

    expect(result).toEqual({
      ok: true,
      data: {
        address: 'bc1qledgerauthaddress',
        signature: 'ledger-signature',
        message: MESSAGE,
      },
    });
    expect(mocks.openLedgerTransport).toHaveBeenCalledWith({ transport: 'auto' });
    expect(mocks.appClient.getExtendedPubkey).toHaveBeenCalledWith(AUTH_ROOT, false);
    expect(mocks.DefaultWalletPolicy).toHaveBeenCalledWith(
      'wpkh(@0/**)',
      `[${FINGERPRINT}/${AUTH_ROOT_BODY}]xpub-auth-root`,
    );
    expect(mocks.appClient.getWalletAddress).toHaveBeenCalledWith(
      expect.objectContaining({
        descriptorTemplate: 'wpkh(@0/**)',
        key: `[${FINGERPRINT}/${AUTH_ROOT_BODY}]xpub-auth-root`,
      }),
      null,
      0,
      0,
      false,
    );
    expect(mocks.appClient.signMessage).toHaveBeenCalledWith(
      expect.any(Buffer),
      AUTH_PATH,
    );
    const [messageBuffer] = mocks.appClient.signMessage.mock.calls[0]!;
    expect(Buffer.isBuffer(messageBuffer)).toBe(true);
    expect((messageBuffer as Buffer).toString('utf8')).toBe(MESSAGE);
    expect(mocks.emitSyntheticLedgerEvent).toHaveBeenCalledWith({
      phase: 'awaiting_button',
      intent: 'Sign login challenge',
    });
    expect(mocks.closeLedgerTransport).toHaveBeenCalledWith(mocks.transport);
  });

  it('passes an explicit Bluetooth transport preference through', async () => {
    await signAuthChallengeWithLedger({
      authPath: AUTH_PATH,
      message: MESSAGE,
      transport: 'webble',
    });

    expect(mocks.openLedgerTransport).toHaveBeenCalledWith({
      transport: 'webble',
    });
  });

  it('normalises SDK failures from xpub, address, and message signing calls', async () => {
    mocks.appClient.getExtendedPubkey.mockRejectedValueOnce(new Error('device locked'));
    await expect(input()).resolves.toMatchObject({ ok: false });

    mocks.appClient.getWalletAddress.mockRejectedValueOnce(new Error('wrong app'));
    await expect(input()).resolves.toMatchObject({ ok: false });

    mocks.appClient.signMessage.mockRejectedValueOnce(new Error('user rejected on device'));
    await expect(input()).resolves.toMatchObject({ ok: false });

    expect(mocks.closeLedgerTransport).toHaveBeenCalledTimes(3);
  });

  it('rejects empty address or signature payloads and still closes transport', async () => {
    mocks.appClient.getWalletAddress.mockResolvedValueOnce(' ');
    await expect(input()).resolves.toMatchObject({
      ok: false,
      error: { code: 'descriptor_unavailable' },
    });

    mocks.appClient.signMessage.mockResolvedValueOnce(' ');
    await expect(input()).resolves.toMatchObject({
      ok: false,
      error: { code: 'unknown' },
    });

    expect(mocks.closeLedgerTransport).toHaveBeenCalledTimes(2);
  });
});

function input() {
  return signAuthChallengeWithLedger({
    authPath: AUTH_PATH,
    message: MESSAGE,
  });
}
