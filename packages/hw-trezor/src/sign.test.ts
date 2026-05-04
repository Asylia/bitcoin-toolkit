import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  addPartialSignaturesToPsbt: vi.fn(),
  addressFromScript: vi.fn(),
  bip32PathToAddressN: vi.fn(),
  findSegwitV0SignatureOwner: vi.fn(),
  inspectPsbtV2: vi.fn(),
  verifySegwitV0SignatureAgainstPubkey: vi.fn(),
  buildTrezorCosignerNodes: vi.fn(),
  buildTrezorMultisigBlock: vi.fn(),
  signTransaction: vi.fn(),
}));

vi.mock('@asylia/btc-core', () => ({
  addPartialSignaturesToPsbt: mocks.addPartialSignaturesToPsbt,
  addressFromScript: mocks.addressFromScript,
  bip32PathToAddressN: mocks.bip32PathToAddressN,
  findSegwitV0SignatureOwner: mocks.findSegwitV0SignatureOwner,
  inspectPsbtV2: mocks.inspectPsbtV2,
  PsbtInspectError: class PsbtInspectError extends Error {},
  verifySegwitV0SignatureAgainstPubkey: mocks.verifySegwitV0SignatureAgainstPubkey,
}));

vi.mock('./multisig', () => ({
  buildTrezorCosignerNodes: mocks.buildTrezorCosignerNodes,
  buildTrezorMultisigBlock: mocks.buildTrezorMultisigBlock,
}));

vi.mock('./sdk', () => ({
  TrezorConnect: {
    signTransaction: mocks.signTransaction,
  },
}));

import { signWshSortedMultiPsbt } from './sign';
import type { SignPsbtInput } from './sign';

type GlobalWithProcess = typeof globalThis & {
  process?: { env?: Record<string, string | undefined> };
};

const FINGERPRINT = 'deadbeef';
const OTHER_FINGERPRINT = 'baddcafe';
const FINGERPRINT_BYTES = Uint8Array.from([0xde, 0xad, 0xbe, 0xef]);
const OTHER_FINGERPRINT_BYTES = Uint8Array.from([0xba, 0xdd, 0xca, 0xfe]);
const PUBKEY = Uint8Array.from([0x02, ...Array.from({ length: 32 }, (_, i) => i + 1)]);
const OTHER_PUBKEY = Uint8Array.from([0x03, ...Array.from({ length: 32 }, (_, i) => i + 1)]);
const TXID = '11'.repeat(32);
const PUBKEY_HEX = '02' + Array.from({ length: 32 }, (_, i) => (i + 1).toString(16).padStart(2, '0')).join('');

let originalDebugEnv: string | undefined;

describe('signWshSortedMultiPsbt', () => {
  beforeEach(() => {
    originalDebugEnv = (globalThis as GlobalWithProcess).process?.env?.ASYLIA_HW_DEBUG;
    if ((globalThis as GlobalWithProcess).process?.env) {
      (globalThis as GlobalWithProcess).process!.env!.ASYLIA_HW_DEBUG = undefined;
    }
    vi.clearAllMocks();
    mocks.addPartialSignaturesToPsbt.mockReturnValue('signed-psbt');
    mocks.addressFromScript.mockReturnValue('bc1qrecipient');
    mocks.bip32PathToAddressN.mockImplementation((path: string) => pathToAddressN(path));
    mocks.findSegwitV0SignatureOwner.mockReturnValue(null);
    mocks.inspectPsbtV2.mockReturnValue(inspectedPsbt());
    mocks.verifySegwitV0SignatureAgainstPubkey.mockReturnValue(true);
    mocks.buildTrezorCosignerNodes.mockImplementation((keys: SignPsbtInput['vault']['keys']) =>
      keys.map((key, index) => ({
        key,
        node: {
          depth: 4,
          child_num: 0x80000000 + index,
        },
      })),
    );
    mocks.buildTrezorMultisigBlock.mockReturnValue({ m: 2, pubkeys: [], signatures: [] });
    mocks.signTransaction.mockResolvedValue({
      success: true,
      payload: {
        signatures: ['30440220'],
        serializedTx: '00',
      },
    });
  });

  afterEach(() => {
    if ((globalThis as GlobalWithProcess).process?.env) {
      (globalThis as GlobalWithProcess).process!.env!.ASYLIA_HW_DEBUG = originalDebugEnv;
    }
    vi.restoreAllMocks();
  });

  it('rejects malformed signing requests before calling Trezor Connect', async () => {
    await expect(
      signWshSortedMultiPsbt({ ...input(), scriptType: 'p2sh-p2wsh' as never }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'invalid_path' } });
    await expect(
      signWshSortedMultiPsbt({ ...input(), signerFingerprint: 'nope' }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'invalid_path' } });
    await expect(
      signWshSortedMultiPsbt({ ...input(), vault: { ...input().vault, keys: [] } }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'invalid_path' } });
    await expect(
      signWshSortedMultiPsbt({
        ...input(),
        vault: { ...input().vault, requiredSignatures: 3 },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'invalid_path' } });

    expect(mocks.signTransaction).not.toHaveBeenCalled();
  });

  it('rejects PSBT inspection failures and unknown cosigners', async () => {
    mocks.inspectPsbtV2.mockImplementationOnce(() => {
      throw new Error('bad psbt');
    });
    await expect(signWshSortedMultiPsbt(input())).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_path' },
    });

    await expect(
      signWshSortedMultiPsbt({ ...input(), signerFingerprint: 'ffffffff' }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'invalid_path' } });
    expect(mocks.signTransaction).not.toHaveBeenCalled();
  });

  it('rejects cosigner node build failures before calling Trezor Connect', async () => {
    mocks.buildTrezorCosignerNodes.mockImplementationOnce(() => {
      throw new Error('Cosigner xpub is not valid base58check');
    });

    await expect(signWshSortedMultiPsbt(input())).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_path' },
    });
    expect(mocks.signTransaction).not.toHaveBeenCalled();
  });

  it('sends PSBT version, locktime, inputs and outputs to Trezor Connect', async () => {
    const result = await signWshSortedMultiPsbt(input());

    expect(result).toMatchObject({ ok: true });
    expect(mocks.signTransaction).toHaveBeenCalledWith({
      coin: 'btc',
      version: 2,
      locktime: 500,
      inputs: [
        expect.objectContaining({
          prev_hash: '11'.repeat(32),
          prev_index: 1,
          amount: 100_000,
          sequence: 0xfffffffe,
          script_type: 'SPENDWITNESS',
          address_n: [...pathToAddressN("m/48'/0'/0'/2'"), 0, 5],
        }),
      ],
      outputs: [
        {
          address: 'bc1qrecipient',
          amount: 90_000,
          script_type: 'PAYTOADDRESS',
        },
      ],
    });
  });

  it('keeps runtime debug signing logs free of spend graph material', async () => {
    if ((globalThis as GlobalWithProcess).process?.env) {
      (globalThis as GlobalWithProcess).process!.env!.ASYLIA_HW_DEBUG = '1';
    }
    const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(signWshSortedMultiPsbt(input())).resolves.toMatchObject({ ok: true });

    const renderedLogs = JSON.stringify([
      ...consoleInfo.mock.calls,
      ...consoleWarn.mock.calls,
      ...consoleError.mock.calls,
    ]);
    expect(renderedLogs).not.toContain(TXID);
    expect(renderedLogs).not.toContain('100000');
    expect(renderedLogs).not.toContain('90000');
    expect(renderedLogs).not.toContain('bc1qrecipient');
    expect(renderedLogs).not.toContain(FINGERPRINT);
    expect(renderedLogs).not.toContain(OTHER_FINGERPRINT);
    expect(renderedLogs).not.toContain("m/48'/0'/0'/2'");
    expect(renderedLogs).not.toContain('xpub-a');
    expect(renderedLogs).not.toContain('xpub-b');
    expect(renderedLogs).not.toContain(PUBKEY_HEX);
    expect(renderedLogs).not.toContain('30440220');
    expect(renderedLogs).not.toContain('signatureLengths');
  });

  it('maps vault change outputs as PAYTOWITNESS with multisig metadata', async () => {
    mocks.inspectPsbtV2.mockReturnValue({
      ...inspectedPsbt(),
      outputs: [
        {
          amountSats: 8_000,
          scriptPubKey: Uint8Array.from([0, 32, 1]),
          witnessScript: Uint8Array.from([1, 2, 3]),
          bip32Derivation: [
            {
              masterFingerprint: FINGERPRINT_BYTES,
              pubkey: PUBKEY,
              path: "m/48'/0'/0'/2'/1/7",
            },
          ],
        },
      ],
    });

    await expect(signWshSortedMultiPsbt(input())).resolves.toMatchObject({ ok: true });

    expect(mocks.signTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        outputs: [
          {
            address_n: [...pathToAddressN("m/48'/0'/0'/2'"), 1, 7],
            amount: 8_000,
            script_type: 'PAYTOWITNESS',
            multisig: { m: 2, pubkeys: [], signatures: [] },
          },
        ],
      }),
    );
  });

  it('normalises Trezor failures and rejects signature count mismatches', async () => {
    mocks.signTransaction.mockResolvedValueOnce({
      success: false,
      payload: { code: 'Method_Cancel', error: 'cancelled' },
    });
    await expect(signWshSortedMultiPsbt(input())).resolves.toMatchObject({
      ok: false,
      error: { code: 'cancelled' },
    });

    mocks.signTransaction.mockResolvedValueOnce({
      success: true,
      payload: { signatures: [] },
    });
    await expect(signWshSortedMultiPsbt(input())).resolves.toMatchObject({
      ok: false,
      error: { code: 'unknown' },
    });
  });

  it('normalises thrown signing and merge failures', async () => {
    mocks.signTransaction.mockRejectedValueOnce(new Error('popup crashed'));
    await expect(signWshSortedMultiPsbt(input())).resolves.toMatchObject({ ok: false });

    mocks.addPartialSignaturesToPsbt.mockImplementationOnce(() => {
      throw new Error('merge failed');
    });
    await expect(signWshSortedMultiPsbt(input())).resolves.toMatchObject({
      ok: false,
      error: { code: 'unknown' },
    });
  });

  it('rejects empty or unowned signatures before merging them', async () => {
    mocks.signTransaction.mockResolvedValueOnce({
      success: true,
      payload: { signatures: [''] },
    });
    await expect(signWshSortedMultiPsbt(input())).resolves.toMatchObject({
      ok: false,
      error: { code: 'unknown' },
    });

    mocks.verifySegwitV0SignatureAgainstPubkey.mockReturnValueOnce(false);
    mocks.findSegwitV0SignatureOwner.mockReturnValueOnce(null);
    await expect(signWshSortedMultiPsbt(input())).resolves.toMatchObject({
      ok: false,
      error: { code: 'unknown' },
    });

    expect(mocks.addPartialSignaturesToPsbt).not.toHaveBeenCalled();
  });

  it('merges verified signatures without pivoting when the requested pubkey owns them', async () => {
    const result = await signWshSortedMultiPsbt(input());

    expect(result).toEqual({
      ok: true,
      data: {
        psbtBase64: 'signed-psbt',
        signedInputCount: 1,
        requestedFingerprint: FINGERPRINT,
        signedAsFingerprint: FINGERPRINT,
        pivoted: false,
      },
    });
    expect(mocks.verifySegwitV0SignatureAgainstPubkey).toHaveBeenCalledWith(
      expect.any(Object),
      0,
      PUBKEY,
      Uint8Array.from([0x30, 0x44, 0x02, 0x20, 0x01]),
    );
    expect(mocks.addPartialSignaturesToPsbt).toHaveBeenCalledWith('unsigned-psbt', [
      {
        inputIndex: 0,
        pubkey: PUBKEY,
        signature: Uint8Array.from([0x30, 0x44, 0x02, 0x20]),
      },
    ]);
  });

  it('re-attributes a valid signature to another vault cosigner when needed', async () => {
    mocks.inspectPsbtV2.mockReturnValue(
      inspectedPsbt({
        bip32Derivation: [
          {
            masterFingerprint: FINGERPRINT_BYTES,
            pubkey: PUBKEY,
            path: "m/48'/0'/0'/2'/0/5",
          },
          {
            masterFingerprint: OTHER_FINGERPRINT_BYTES,
            pubkey: OTHER_PUBKEY,
            path: "m/48'/0'/0'/2'/0/5",
          },
        ],
      }),
    );
    mocks.verifySegwitV0SignatureAgainstPubkey.mockReturnValue(false);
    mocks.findSegwitV0SignatureOwner.mockReturnValue(OTHER_PUBKEY);

    const result = await signWshSortedMultiPsbt(input());

    expect(result).toMatchObject({
      ok: true,
      data: {
        requestedFingerprint: FINGERPRINT,
        signedAsFingerprint: OTHER_FINGERPRINT,
        pivoted: true,
      },
    });
    expect(mocks.addPartialSignaturesToPsbt).toHaveBeenCalledWith('unsigned-psbt', [
      expect.objectContaining({ pubkey: OTHER_PUBKEY }),
    ]);
  });

  it('merges signatures for multiple signable inputs', async () => {
    mocks.inspectPsbtV2.mockReturnValue({
      ...inspectedPsbt(),
      inputs: [
        inspectedPsbt().inputs[0],
        {
          ...inspectedPsbt().inputs[0],
          txid: '22'.repeat(32),
          vout: 0,
          bip32Derivation: [
            {
              masterFingerprint: FINGERPRINT_BYTES,
              pubkey: PUBKEY,
              path: "m/48'/0'/0'/2'/0/6",
            },
          ],
        },
      ],
    });
    mocks.signTransaction.mockResolvedValueOnce({
      success: true,
      payload: {
        signatures: ['30440220', '30450220'],
      },
    });

    const result = await signWshSortedMultiPsbt(input());

    expect(result).toMatchObject({
      ok: true,
      data: { signedInputCount: 2 },
    });
    expect(mocks.addPartialSignaturesToPsbt).toHaveBeenCalledWith('unsigned-psbt', [
      expect.objectContaining({ inputIndex: 0 }),
      expect.objectContaining({ inputIndex: 1 }),
    ]);
  });
});

function input(): SignPsbtInput {
  return {
    psbtBase64: 'unsigned-psbt',
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
  };
}

function inspectedPsbt(
  options: {
    bip32Derivation?: Array<{
      masterFingerprint: Uint8Array;
      pubkey: Uint8Array;
      path: string;
    }>;
  } = {},
) {
  return {
    txVersion: 2,
    fallbackLocktime: 500,
    inputs: [
      {
        txid: '11'.repeat(32),
        vout: 1,
        valueSats: 100_000,
        sequence: 0xfffffffe,
        witnessScript: Uint8Array.from([1, 2, 3]),
        partialSigs: [],
        bip32Derivation:
          options.bip32Derivation ??
          [
            {
              masterFingerprint: FINGERPRINT_BYTES,
              pubkey: PUBKEY,
              path: "m/48'/0'/0'/2'/0/5",
            },
          ],
      },
    ],
    outputs: [
      {
        amountSats: 90_000,
        scriptPubKey: Uint8Array.from([0, 20, 1]),
        witnessScript: null,
        bip32Derivation: [],
      },
    ],
  };
}

function pathToAddressN(path: string): number[] {
  if (path === "m/48'/0'/0'/2'") return [0x80000030, 0x80000000, 0x80000000, 0x80000002];
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
