import { describe, expect, it } from 'vitest';

import {
  maxSpendableSats,
  selectCoinsLargestFirst,
  type Utxo,
} from '../index';

describe('selectCoinsLargestFirst', () => {
  it('selects the largest viable UTXO first and returns explicit change', () => {
    const utxos = [
      utxo('11', 0, 50_000),
      utxo('22', 0, 120_000),
      utxo('33', 0, 80_000),
    ];

    const result = selectCoinsLargestFirst({
      utxos,
      targetSats: 100_000,
      feeRateSatsPerVByte: 2,
    });

    expect(result).toMatchObject({
      ok: true,
      feeSats: 348,
      changeSats: 19_652,
      vbytes: 174,
    });
    if (result.ok) {
      expect(result.selected.map((entry) => entry.txid)).toEqual(['22'.repeat(32)]);
    }
  });

  it('folds sub-dust remainders into the fee by dropping the change output', () => {
    const result = selectCoinsLargestFirst({
      utxos: [utxo('44', 0, 10_000)],
      targetSats: 9_700,
      feeRateSatsPerVByte: 1,
    });

    expect(result).toEqual({
      ok: true,
      selected: [utxo('44', 0, 10_000)],
      feeSats: 300,
      changeSats: 0,
      vbytes: 143,
    });
  });

  it('returns typed failure results instead of throwing', () => {
    expect(
      selectCoinsLargestFirst({
        utxos: [],
        targetSats: 1_000,
        feeRateSatsPerVByte: 1,
      }),
    ).toEqual({ ok: false, reason: 'EMPTY_UTXOS', available: 0, required: 1_000 });

    expect(
      selectCoinsLargestFirst({
        utxos: [utxo('55', 0, 1_000)],
        targetSats: 10_000,
        feeRateSatsPerVByte: 1,
      }),
    ).toMatchObject({ ok: false, reason: 'INSUFFICIENT_FUNDS' });
  });
});

describe('maxSpendableSats', () => {
  it('matches the no-change topology accepted by coin selection', () => {
    const utxos = [utxo('66', 0, 10_000), utxo('77', 1, 30_000)];
    const amount = maxSpendableSats({ utxos, feeRateSatsPerVByte: 1 });

    expect(amount).toBe(39_747);
    expect(
      selectCoinsLargestFirst({
        utxos,
        targetSats: amount,
        feeRateSatsPerVByte: 1,
      }),
    ).toMatchObject({ ok: true, feeSats: 253, changeSats: 0 });
  });
});

function utxo(prefix: string, vout: number, valueSats: number): Utxo {
  return {
    txid: prefix.repeat(32),
    vout,
    valueSats,
    chain: 0,
    index: vout,
  };
}
