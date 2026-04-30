import { Transaction } from 'bitcoinjs-lib';
import { describe, expect, it } from 'vitest';

import {
  collectSignerFingerprints,
  finaliseAndExtractTransaction,
  inspectPsbtV2,
} from '../index';
import { makeSyntheticBitcoinFixture, SYNTHETIC_FIXTURE_NOTICE } from './bitcoin';

describe('synthetic Bitcoin fixtures', () => {
  it('exposes deterministic descriptor, xpub/Zpub, PSBT, raw transaction, and txid data', () => {
    const fixture = makeSyntheticBitcoinFixture();

    expect(fixture.notice).toBe(SYNTHETIC_FIXTURE_NOTICE);
    expect(fixture.descriptor).toContain('wsh(sortedmulti(2,');
    expect(fixture.receiveDescriptor).toContain('/0/*');
    expect(fixture.changeDescriptor).toContain('/1/*');
    expect(fixture.descriptors).toHaveLength(3);
    expect(fixture.descriptors.every((key) => key.xpub.startsWith('xpub'))).toBe(true);
    expect(fixture.zpubs.every((key) => key.startsWith('Zpub'))).toBe(true);
    expect(inspectPsbtV2(fixture.unsignedPsbtBase64).inputs).toHaveLength(1);
    expect(collectSignerFingerprints(fixture.oneSignaturePsbtBase64).size).toBe(1);
    expect(collectSignerFingerprints(fixture.thresholdSignedPsbtBase64).size).toBe(2);

    const final = finaliseAndExtractTransaction(fixture.thresholdSignedPsbtBase64);
    expect(final).toMatchObject({
      hex: fixture.finalRawTxHex,
      txid: fixture.finalTxid,
    });
    expect(Transaction.fromHex(fixture.finalRawTxHex).getId()).toBe(fixture.finalTxid);
  });
});
