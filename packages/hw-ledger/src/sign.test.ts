import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const appClient = {
    signPsbt: vi.fn(),
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
    addPartialSignaturesToPsbt: vi.fn(),
    inspectPsbtV2: vi.fn(),
    verifySegwitV0SignatureAgainstPubkey: vi.fn(),
    buildDeviceInfo: vi.fn(),
    readAppMetadata: vi.fn(),
    readFingerprint: vi.fn(),
    buildLedgerWalletPolicyForDevice: vi.fn(),
    openLedgerTransport: vi.fn(),
    closeLedgerTransport: vi.fn(),
    emitSyntheticLedgerEvent: vi.fn(),
  };
});

vi.mock('@ledgerhq/ledger-bitcoin', () => ({
  AppClient: mocks.AppClient,
}));

vi.mock('@asylia/btc-core', () => ({
  addPartialSignaturesToPsbt: mocks.addPartialSignaturesToPsbt,
  inspectPsbtV2: mocks.inspectPsbtV2,
  PsbtInspectError: class PsbtInspectError extends Error {},
  verifySegwitV0SignatureAgainstPubkey: mocks.verifySegwitV0SignatureAgainstPubkey,
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

import { signWshSortedMultiPsbt } from './sign';
import type { SignPsbtInput } from './types';

const FINGERPRINT = 'deadbeef';
const OTHER_FINGERPRINT = 'baddcafe';
const FINGERPRINT_BYTES = Uint8Array.from([0xde, 0xad, 0xbe, 0xef]);
const OTHER_FINGERPRINT_BYTES = Uint8Array.from([0xba, 0xdd, 0xca, 0xfe]);
const PUBKEY = Uint8Array.from([0x02, ...Array.from({ length: 32 }, (_, i) => i + 1)]);
const OTHER_PUBKEY = Uint8Array.from([0x03, ...Array.from({ length: 32 }, (_, i) => i + 1)]);
const DER_SIGNATURE = Uint8Array.from([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x02]);
const SIGNATURE_WITH_SIGHASH = Uint8Array.from([...DER_SIGNATURE, 0x01]);

describe('signWshSortedMultiPsbt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.appClient.signPsbt.mockResolvedValue([
      [0, { pubkey: PUBKEY, signature: SIGNATURE_WITH_SIGHASH }],
    ]);
    mocks.addPartialSignaturesToPsbt.mockReturnValue('signed-psbt');
    mocks.inspectPsbtV2.mockReturnValue(inspectedPsbt());
    mocks.verifySegwitV0SignatureAgainstPubkey.mockReturnValue(true);
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
        policyId: '11'.repeat(32),
      },
    });
    mocks.openLedgerTransport.mockResolvedValue({ ok: true, data: mocks.transport });
    mocks.closeLedgerTransport.mockResolvedValue(undefined);
  });

  it('rejects unsupported script types and malformed fingerprints before opening transport', async () => {
    const unsupported = await signWshSortedMultiPsbt({
      ...input(),
      scriptType: 'p2sh-p2wsh' as never,
    });
    const malformed = await signWshSortedMultiPsbt({
      ...input(),
      signerFingerprint: 'not-a-fp',
    });

    expect(unsupported).toMatchObject({ ok: false, error: { code: 'invalid_path' } });
    expect(malformed).toMatchObject({ ok: false, error: { code: 'invalid_path' } });
    expect(mocks.openLedgerTransport).not.toHaveBeenCalled();
  });

  it('rejects policy id mismatches and invalid policy HMAC values before opening transport', async () => {
    const mismatch = await signWshSortedMultiPsbt({
      ...input(),
      policyId: '22'.repeat(32),
    });
    const invalidHmac = await signWshSortedMultiPsbt({
      ...input(),
      policyHmac: 'not-hex',
    });

    expect(mismatch).toMatchObject({
      ok: false,
      error: { code: 'descriptor_unavailable' },
    });
    expect(invalidHmac).toMatchObject({
      ok: false,
      error: { code: 'descriptor_unavailable' },
    });
    expect(mocks.openLedgerTransport).not.toHaveBeenCalled();
  });

  it('rejects PSBTs that have no inputs for the selected signer', async () => {
    mocks.inspectPsbtV2.mockReturnValue(
      inspectedPsbt({
        bip32Derivation: [{ masterFingerprint: OTHER_FINGERPRINT_BYTES, pubkey: OTHER_PUBKEY }],
      }),
    );

    const result = await signWshSortedMultiPsbt(input());

    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_path' } });
    expect(mocks.openLedgerTransport).not.toHaveBeenCalled();
  });

  it('short-circuits policy and transport failures before device signing', async () => {
    mocks.buildLedgerWalletPolicyForDevice.mockReturnValueOnce({
      ok: false,
      error: { code: 'descriptor_unavailable', message: 'bad policy' },
    });
    await expect(signWshSortedMultiPsbt(input())).resolves.toMatchObject({
      ok: false,
      error: { code: 'descriptor_unavailable' },
    });
    expect(mocks.openLedgerTransport).not.toHaveBeenCalled();

    mocks.buildLedgerWalletPolicyForDevice.mockReturnValue({
      ok: true,
      data: {
        policy: { name: 'policy' },
        policyId: '11'.repeat(32),
      },
    });
    mocks.openLedgerTransport.mockResolvedValueOnce({
      ok: false,
      error: { code: 'transport_unavailable', message: 'no device' },
    });
    await expect(signWshSortedMultiPsbt(input())).resolves.toMatchObject({
      ok: false,
      error: { code: 'transport_unavailable' },
    });
    expect(mocks.appClient.signPsbt).not.toHaveBeenCalled();
  });

  it('closes transport when app metadata or fingerprint reads fail', async () => {
    mocks.readAppMetadata.mockResolvedValueOnce({
      ok: false,
      error: { code: 'wrong_app', message: 'open Bitcoin' },
    });
    await expect(signWshSortedMultiPsbt(input())).resolves.toMatchObject({
      ok: false,
      error: { code: 'wrong_app' },
    });
    expect(mocks.closeLedgerTransport).toHaveBeenCalledWith(mocks.transport);

    mocks.readFingerprint.mockResolvedValueOnce({
      ok: false,
      error: { code: 'unknown', message: 'fingerprint failed' },
    });
    await expect(signWshSortedMultiPsbt(input())).resolves.toMatchObject({
      ok: false,
      error: { code: 'unknown' },
    });
    expect(mocks.closeLedgerTransport).toHaveBeenCalledTimes(2);
  });

  it('closes the transport when the connected Ledger fingerprint is wrong', async () => {
    mocks.readFingerprint.mockResolvedValue({ ok: true, data: OTHER_FINGERPRINT });

    const result = await signWshSortedMultiPsbt(input());

    expect(result).toMatchObject({ ok: false, error: { code: 'wrong_device' } });
    expect(mocks.closeLedgerTransport).toHaveBeenCalledWith(mocks.transport);
  });

  it('rejects malformed signatures returned by the Ledger app', async () => {
    mocks.appClient.signPsbt.mockResolvedValue([
      [99, { pubkey: PUBKEY, signature: SIGNATURE_WITH_SIGHASH }],
    ]);
    await expect(signWshSortedMultiPsbt(input())).resolves.toMatchObject({
      ok: false,
      error: { code: 'unknown' },
    });

    mocks.appClient.signPsbt.mockResolvedValue([
      [0, { pubkey: OTHER_PUBKEY, signature: SIGNATURE_WITH_SIGHASH }],
    ]);
    await expect(signWshSortedMultiPsbt(input())).resolves.toMatchObject({
      ok: false,
      error: { code: 'unknown' },
    });

    mocks.appClient.signPsbt.mockResolvedValue([
      [0, { pubkey: PUBKEY, signature: SIGNATURE_WITH_SIGHASH }],
    ]);
    mocks.inspectPsbtV2.mockReturnValue(
      inspectedPsbt({
        bip32Derivation: [{ masterFingerprint: OTHER_FINGERPRINT_BYTES, pubkey: PUBKEY }],
      }),
    );
    await expect(signWshSortedMultiPsbt(input())).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_path' },
    });

    mocks.inspectPsbtV2.mockReturnValue(inspectedPsbt());
    mocks.verifySegwitV0SignatureAgainstPubkey.mockReturnValue(false);
    await expect(signWshSortedMultiPsbt(input())).resolves.toMatchObject({
      ok: false,
      error: { code: 'unknown' },
    });
  });

  it('handles device signing rejection, empty approvals, and merge failures', async () => {
    mocks.appClient.signPsbt.mockRejectedValueOnce(new Error('user rejected on device'));
    await expect(signWshSortedMultiPsbt(input())).resolves.toMatchObject({
      ok: false,
    });

    mocks.appClient.signPsbt.mockResolvedValueOnce([]);
    await expect(signWshSortedMultiPsbt(input())).resolves.toMatchObject({
      ok: false,
      error: { code: 'unknown' },
    });

    mocks.addPartialSignaturesToPsbt.mockImplementationOnce(() => {
      throw new Error('merge failed');
    });
    await expect(signWshSortedMultiPsbt(input())).resolves.toMatchObject({
      ok: false,
      error: { code: 'unknown' },
    });
  });

  it('signs multiple inputs and accepts omitted policy ids and normalised fingerprints', async () => {
    mocks.inspectPsbtV2.mockReturnValue({
      inputs: [
        { bip32Derivation: [{ masterFingerprint: FINGERPRINT_BYTES, pubkey: PUBKEY }] },
        { bip32Derivation: [{ masterFingerprint: FINGERPRINT_BYTES, pubkey: PUBKEY }] },
      ],
    });
    mocks.appClient.signPsbt.mockResolvedValueOnce([
      [0, { pubkey: PUBKEY, signature: SIGNATURE_WITH_SIGHASH }],
      [1, { pubkey: PUBKEY, signature: SIGNATURE_WITH_SIGHASH }],
    ]);

    const result = await signWshSortedMultiPsbt({
      ...input(),
      signerFingerprint: '  DEADBEEF  ',
      policyId: undefined,
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        signedInputCount: 2,
        requestedFingerprint: FINGERPRINT,
      },
    });
    expect(mocks.addPartialSignaturesToPsbt).toHaveBeenCalledWith('unsigned-psbt', [
      { inputIndex: 0, pubkey: PUBKEY, signature: DER_SIGNATURE },
      { inputIndex: 1, pubkey: PUBKEY, signature: DER_SIGNATURE },
    ]);
  });

  it('merges verified Ledger signatures and returns the signing identity', async () => {
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
    expect(mocks.AppClient).toHaveBeenCalledWith(mocks.transport);
    expect(mocks.appClient.signPsbt).toHaveBeenCalledWith(
      'unsigned-psbt',
      { name: 'policy' },
      Buffer.from('aa'.repeat(32), 'hex'),
      expect.any(Function),
    );
    expect(mocks.verifySegwitV0SignatureAgainstPubkey).toHaveBeenCalledWith(
      expect.any(Object),
      0,
      PUBKEY,
      DER_SIGNATURE,
    );
    expect(mocks.addPartialSignaturesToPsbt).toHaveBeenCalledWith('unsigned-psbt', [
      { inputIndex: 0, pubkey: PUBKEY, signature: DER_SIGNATURE },
    ]);
    expect(mocks.closeLedgerTransport).toHaveBeenCalledWith(mocks.transport);
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
    policyHmac: 'aa'.repeat(32),
    policyId: '11'.repeat(32),
  };
}

function inspectedPsbt(
  options: {
    bip32Derivation?: Array<{ masterFingerprint: Uint8Array; pubkey: Uint8Array }>;
  } = {},
) {
  return {
    inputs: [
      {
        bip32Derivation:
          options.bip32Derivation ?? [{ masterFingerprint: FINGERPRINT_BYTES, pubkey: PUBKEY }],
      },
    ],
  };
}
