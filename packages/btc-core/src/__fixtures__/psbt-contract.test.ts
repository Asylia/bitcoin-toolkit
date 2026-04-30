import { Buffer } from 'buffer';
import { describe, expect, it } from 'vitest';

import {
  finaliseAndExtractTransaction,
  inspectPsbtV2,
  PsbtFinaliseError,
  verifySegwitV0SignatureAgainstPubkey,
} from '../index';
import { makeSyntheticBitcoinFixture } from './bitcoin';

describe('PSBT cross-package contract fixture', () => {
  it('models build -> hardware signatures -> merge -> finalise with stable txid output', () => {
    const fixture = makeSyntheticBitcoinFixture();

    expect(() => finaliseAndExtractTransaction(fixture.unsignedPsbtBase64)).toThrow(
      PsbtFinaliseError,
    );
    expect(() => finaliseAndExtractTransaction(fixture.oneSignaturePsbtBase64)).toThrow(
      PsbtFinaliseError,
    );

    const final = finaliseAndExtractTransaction(fixture.thresholdSignedPsbtBase64);
    expect(final).toMatchObject({
      hex: fixture.finalRawTxHex,
      txid: fixture.finalTxid,
    });
  });

  it('keeps signature ownership and sighash validity explicit at the package boundary', () => {
    const fixture = makeSyntheticBitcoinFixture();
    const inspected = inspectPsbtV2(fixture.oneSignaturePsbtBase64);
    const input = inspected.inputs[0]!;
    const signature = input.partialSigs[0]!;
    const wrongPubkey = input.bip32Derivation.find((entry) =>
      Buffer.from(entry.pubkey).toString('hex') !== Buffer.from(signature.pubkey).toString('hex'),
    )!.pubkey;
    const invalidSighash = Uint8Array.from(signature.signature);
    invalidSighash[5] = invalidSighash[5]! ^ 0x01;

    expect(verifySegwitV0SignatureAgainstPubkey(inspected, 0, signature.pubkey, signature.signature))
      .toBe(true);
    expect(verifySegwitV0SignatureAgainstPubkey(inspected, 0, wrongPubkey, signature.signature))
      .toBe(false);
    expect(verifySegwitV0SignatureAgainstPubkey(inspected, 0, signature.pubkey, invalidSighash))
      .toBe(false);
  });
});
