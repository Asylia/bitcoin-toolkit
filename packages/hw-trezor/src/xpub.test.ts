import bs58check from 'bs58check';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  TrezorConnect: {
    getFeatures: vi.fn(),
    getPublicKey: vi.fn(),
  },
}));

vi.mock('./sdk', () => ({
  TrezorConnect: mocks.TrezorConnect,
}));

describe('exportTrezorRoot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.TrezorConnect.getFeatures.mockResolvedValue({
      success: true,
      payload: {
        internal_model: 'T3T1',
        major_version: 2,
        minor_version: 8,
        patch_version: 7,
        label: 'Treasury signer',
        device_id: 'device-1',
      },
    });
    mocks.TrezorConnect.getPublicKey.mockResolvedValue({
      success: true,
      payload: {
        xpub: makeXpub(1),
        xpubSegwit: 'zpub-placeholder',
        serializedPath: "m/48'/0'/0'/2'",
        depth: 4,
        childNum: 0x80000002,
        fingerprint: 0xaabbccdd,
        descriptor: `wpkh([D34DB33F/48'/0'/0'/2']${makeXpub(1)}/0/*)#checksum`,
      },
    });
  });

  it('normalises device metadata and master fingerprint from the descriptor', async () => {
    const { exportTrezorRoot } = await import('./xpub');

    const result = await exportTrezorRoot({
      derivationPath: "m/48'/0'/0'/2'",
      scriptType: 'p2wsh',
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        masterFingerprint: 'd34db33f',
        derivationPath: "m/48'/0'/0'/2'",
        scriptType: 'p2wsh',
        xpubMultisig: expect.stringMatching(/^Zpub/),
        device: {
          label: 'Treasury signer',
          model: 'Trezor Safe 5',
          internalModel: 'T3T1',
          firmware: '2.8.7',
        },
      },
    });
    expect(mocks.TrezorConnect.getPublicKey).toHaveBeenCalledWith({
      path: "m/48'/0'/0'/2'",
      coin: 'btc',
      scriptType: 'SPENDWITNESS',
    });
  });

  it('rejects malformed paths and stub feature responses before xpub export', async () => {
    const { exportTrezorRoot } = await import('./xpub');

    await expect(exportTrezorRoot({
      derivationPath: '48/not/a/path',
      scriptType: 'p2wsh',
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_path' },
    });
    expect(mocks.TrezorConnect.getFeatures).not.toHaveBeenCalled();

    mocks.TrezorConnect.getFeatures.mockResolvedValueOnce({
      success: true,
      payload: {
        internal_model: 'UNKNOWN',
        major_version: 0,
        minor_version: 0,
        patch_version: 0,
        label: '',
        device_id: null,
      },
    });

    await expect(exportTrezorRoot({
      derivationPath: "m/48'/0'/0'/2'",
      scriptType: 'p2wsh',
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'device_locked' },
    });
    expect(mocks.TrezorConnect.getPublicKey).not.toHaveBeenCalled();
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
