import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const signMessage = vi.fn();
  return {
    trezorConnect: { signMessage } as { signMessage?: typeof signMessage },
    signMessage,
    signWshSortedMultiPsbt: vi.fn(),
    stripMasterPrefix: vi.fn((path: string) => path.replace(/^m\//, '')),
  };
});

vi.mock('./sdk', () => ({
  TrezorConnect: mocks.trezorConnect,
}));

vi.mock('./sign', () => ({
  signWshSortedMultiPsbt: mocks.signWshSortedMultiPsbt,
}));

vi.mock('@asylia/btc-core', () => ({
  stripMasterPrefix: mocks.stripMasterPrefix,
}));

import {
  signAuthChallengeWithTrezor,
  signAuthProofWithTrezor,
} from './auth';

describe('Trezor signer auth helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.trezorConnect.signMessage = mocks.signMessage;
    mocks.stripMasterPrefix.mockImplementation((path: string) => path.replace(/^m\//, ''));
    mocks.signMessage.mockResolvedValue({
      success: true,
      payload: {
        address: ' bc1qauthaddress ',
        signature: ' signed-message ',
      },
    });
    mocks.signWshSortedMultiPsbt.mockResolvedValue({
      ok: true,
      data: {
        psbtBase64: 'signed-proof-psbt',
        signedInputCount: 1,
      },
    });
  });

  it('signs the auth challenge message on the BIP84 auth key path', async () => {
    const result = await signAuthChallengeWithTrezor({
      authPath: " m/84'/0'/0'/0/0 ",
      message: '  Asylia signer login challenge  ',
    });

    expect(result).toEqual({
      ok: true,
      data: {
        address: 'bc1qauthaddress',
        signature: 'signed-message',
        message: 'Asylia signer login challenge',
      },
    });
    expect(mocks.signMessage).toHaveBeenCalledWith({
      path: "m/84'/0'/0'/0/0",
      message: 'Asylia signer login challenge',
      coin: 'btc',
    });
  });

  it('rejects missing path or message before calling the SDK', async () => {
    await expect(
      signAuthChallengeWithTrezor({ authPath: '', message: 'challenge' }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'invalid_path' } });
    await expect(
      signAuthChallengeWithTrezor({ authPath: "m/84'/0'/0'/0/0", message: '  ' }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'invalid_path' } });

    expect(mocks.signMessage).not.toHaveBeenCalled();
  });

  it('returns a stable adapter error when this Connect build cannot sign messages', async () => {
    delete mocks.trezorConnect.signMessage;

    await expect(
      signAuthChallengeWithTrezor({
        authPath: "m/84'/0'/0'/0/0",
        message: 'challenge',
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'unknown',
        cause: 'signMessage unavailable',
      },
    });
  });

  it('maps Trezor SDK failures and thrown errors through the adapter error contract', async () => {
    mocks.signMessage.mockResolvedValueOnce({
      success: false,
      payload: { code: 'Method_Cancel', error: 'Cancelled by user' },
    });

    await expect(
      signAuthChallengeWithTrezor({
        authPath: "m/84'/0'/0'/0/0",
        message: 'challenge',
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'cancelled' } });

    mocks.signMessage.mockRejectedValueOnce(new Error('Transport disconnected'));

    await expect(
      signAuthChallengeWithTrezor({
        authPath: "m/84'/0'/0'/0/0",
        message: 'challenge',
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'device_disconnected' } });
  });

  it('rejects empty SDK address or signature payloads', async () => {
    mocks.signMessage.mockResolvedValueOnce({
      success: true,
      payload: { address: ' ', signature: 'signed-message' },
    });

    await expect(
      signAuthChallengeWithTrezor({
        authPath: "m/84'/0'/0'/0/0",
        message: 'challenge',
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'unknown',
        cause: 'empty address or signature',
      },
    });

    mocks.signMessage.mockResolvedValueOnce({
      success: true,
      payload: { address: 'bc1qauthaddress', signature: ' ' },
    });

    await expect(
      signAuthChallengeWithTrezor({
        authPath: "m/84'/0'/0'/0/0",
        message: 'challenge',
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'unknown',
        cause: 'empty address or signature',
      },
    });
  });

  it('delegates signer proof PSBT signing to the multisig PSBT signer', async () => {
    const result = await signAuthProofWithTrezor({
      psbtBase64: ' proof-psbt ',
      fingerprint: ' DEADbeef ',
      derivationRoot: " m/48'/0'/0'/2' ",
      xpub: ' xpub-auth ',
    });

    expect(result).toEqual({
      ok: true,
      data: {
        proofPsbtBase64: 'signed-proof-psbt',
        signedInputCount: 1,
      },
    });
    expect(mocks.stripMasterPrefix).toHaveBeenCalledWith("m/48'/0'/0'/2'");
    expect(mocks.signWshSortedMultiPsbt).toHaveBeenCalledWith({
      psbtBase64: ' proof-psbt ',
      vault: {
        requiredSignatures: 1,
        keys: [{
          fingerprint: 'deadbeef',
          derivationPath: "48'/0'/0'/2'",
          xpub: 'xpub-auth',
        }],
        coin: 'btc',
      },
      signerFingerprint: 'deadbeef',
      scriptType: 'p2wsh',
    });
  });

  it('rejects malformed proof requests before delegating', async () => {
    await expect(
      signAuthProofWithTrezor({
        psbtBase64: '',
        fingerprint: 'deadbeef',
        derivationRoot: "m/48'/0'/0'/2'",
        xpub: 'xpub-auth',
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'invalid_path' } });

    expect(mocks.signWshSortedMultiPsbt).not.toHaveBeenCalled();
  });

  it('passes multisig signer failures back to callers unchanged', async () => {
    mocks.signWshSortedMultiPsbt.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'device_disconnected',
        message: 'Device disconnected.',
      },
    });

    await expect(
      signAuthProofWithTrezor({
        psbtBase64: 'proof-psbt',
        fingerprint: 'deadbeef',
        derivationRoot: "m/48'/0'/0'/2'",
        xpub: 'xpub-auth',
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'device_disconnected' },
    });
  });
});
