import { Buffer } from 'buffer';
import { describe, expect, it } from 'vitest';

import { makeSyntheticBitcoinFixture } from '../__fixtures__/bitcoin';
import { inspectPsbtV2 } from './inspect';
import {
  computeBip143SighashAll,
  findSegwitV0SignatureOwner,
  findSegwitV0SignatureOwnerForPsbt,
  PsbtVerifyError,
  verifySegwitV0SignatureAgainstPubkey,
} from './verify';

describe('PSBT SegWit v0 signature verification', () => {
  it('guards BIP-143 sighash computation against invalid input indexes', () => {
    const fixture = makeSyntheticBitcoinFixture();
    const inspected = inspectPsbtV2(fixture.unsignedPsbtBase64);

    expect(() => computeBip143SighashAll(inspected, -1)).toThrow(PsbtVerifyError);
    expect(() => computeBip143SighashAll(inspected, inspected.inputs.length)).toThrow(PsbtVerifyError);
  });

  it('finds the actual signer among candidate pubkeys and returns null for non-owners', () => {
    const fixture = makeSyntheticBitcoinFixture();
    const inspected = inspectPsbtV2(fixture.oneSignaturePsbtBase64);
    const input = inspected.inputs[0]!;
    const signature = input.partialSigs[0]!;
    const wrongPubkeys = input.bip32Derivation
      .map((entry) => entry.pubkey)
      .filter((pubkey) => !bytesEqual(pubkey, signature.pubkey));

    expect(findSegwitV0SignatureOwner(inspected, 0, signature.signature, wrongPubkeys))
      .toBeNull();
    expect(
      findSegwitV0SignatureOwner(
        inspected,
        0,
        signature.signature,
        [wrongPubkeys[0]!, signature.pubkey],
      ),
    ).toBe(signature.pubkey);
    expect(
      findSegwitV0SignatureOwnerForPsbt(
        fixture.oneSignaturePsbtBase64,
        0,
        signature.signature,
        [signature.pubkey],
      ),
    ).toBe(signature.pubkey);
  });

  it('rejects malformed signatures, wrong pubkeys, and non-standard sighash bytes', () => {
    const fixture = makeSyntheticBitcoinFixture();
    const inspected = inspectPsbtV2(fixture.oneSignaturePsbtBase64);
    const input = inspected.inputs[0]!;
    const signature = input.partialSigs[0]!;
    const wrongPubkey = input.bip32Derivation.find((entry) =>
      !bytesEqual(entry.pubkey, signature.pubkey),
    )!.pubkey;
    const nonStandardSighash = Buffer.concat([
      Buffer.from(signature.signature),
      Buffer.from([0x02]),
    ]);

    expect(verifySegwitV0SignatureAgainstPubkey(inspected, 0, signature.pubkey, signature.signature))
      .toBe(true);
    expect(verifySegwitV0SignatureAgainstPubkey(inspected, 0, wrongPubkey, signature.signature))
      .toBe(false);
    expect(verifySegwitV0SignatureAgainstPubkey(inspected, 0, signature.pubkey, Uint8Array.from([1, 2, 3])))
      .toBe(false);
    expect(verifySegwitV0SignatureAgainstPubkey(inspected, 99, signature.pubkey, signature.signature))
      .toBe(false);
    expect(verifySegwitV0SignatureAgainstPubkey(inspected, 0, signature.pubkey, nonStandardSighash))
      .toBe(false);
  });
});

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.from(a).equals(Buffer.from(b));
}
