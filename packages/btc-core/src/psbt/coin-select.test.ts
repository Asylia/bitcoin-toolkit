import { describe, expect, it } from 'vitest';

import {
  maxSpendableSats,
  selectCoinsLargestFirst,
  selectCoinsLargestFirstFixedFee,
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
      feeSats: 390,
      changeSats: 19_610,
      vbytes: 195,
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
      vbytes: 152,
    });
  });

  it('selects deterministically for equal-value UTXOs and does not mutate caller order', () => {
    const utxos = [
      utxo('cc', 1, 50_000),
      utxo('aa', 0, 50_000),
      utxo('bb', 0, 50_000),
    ];

    const result = selectCoinsLargestFirst({
      utxos,
      targetSats: 90_000,
      feeRateSatsPerVByte: 1,
    });

    expect(utxos.map((entry) => `${entry.txid}:${entry.vout}`)).toEqual([
      `${'cc'.repeat(32)}:1`,
      `${'aa'.repeat(32)}:0`,
      `${'bb'.repeat(32)}:0`,
    ]);
    expect(result).toMatchObject({
      ok: true,
      feeSats: 305,
      changeSats: 9_695,
      vbytes: 305,
    });
    if (result.ok) {
      expect(result.selected.map((entry) => entry.txid)).toEqual([
        'aa'.repeat(32),
        'bb'.repeat(32),
      ]);
    }
  });

  it('uses the no-change fallback when with-change fees barely miss', () => {
    const result = selectCoinsLargestFirst({
      utxos: [utxo('dd', 0, 10_000)],
      targetSats: 9_830,
      feeRateSatsPerVByte: 1,
    });

    expect(result).toEqual({
      ok: true,
      selected: [utxo('dd', 0, 10_000)],
      feeSats: 170,
      changeSats: 0,
      vbytes: 152,
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

    expect(amount).toBe(39_738);
    expect(
      selectCoinsLargestFirst({
        utxos,
        targetSats: amount,
        feeRateSatsPerVByte: 1,
      }),
    ).toMatchObject({ ok: true, feeSats: 262, changeSats: 0 });
  });

  it('returns zero for empty inputs or non-positive fee rates', () => {
    expect(maxSpendableSats({ utxos: [], feeRateSatsPerVByte: 1 })).toBe(0);
    expect(maxSpendableSats({ utxos: [utxo('ee', 0, 10_000)], feeRateSatsPerVByte: 0 })).toBe(0);
    expect(maxSpendableSats({ utxos: [utxo('ff', 0, 10_000)], feeRateSatsPerVByte: -1 })).toBe(0);
  });
});

describe('selectCoinsLargestFirstFixedFee', () => {
  it('returns explicit change with a caller supplied fee', () => {
    const result = selectCoinsLargestFirstFixedFee({
      utxos: [utxo('88', 0, 120_000), utxo('99', 1, 30_000)],
      targetSats: 100_000,
      feeSats: 1_000,
      fixedVbytes: 85,
      changeOutputVbytes: 43,
    });

    expect(result).toMatchObject({
      ok: true,
      feeSats: 1_000,
      changeSats: 19_000,
      vbytes: 195,
    });
  });

  it('rejects dust change instead of changing the explicit fee', () => {
    const result = selectCoinsLargestFirstFixedFee({
      utxos: [utxo('aa', 0, 10_000)],
      targetSats: 9_000,
      feeSats: 700,
      fixedVbytes: 85,
      changeOutputVbytes: 43,
    });

    expect(result).toEqual({
      ok: false,
      reason: 'DUST_CHANGE',
      available: 10_000,
      required: 10_246,
    });
  });

  it('returns exact-spend topology without a change output', () => {
    const result = selectCoinsLargestFirstFixedFee({
      utxos: [utxo('ab', 0, 10_000)],
      targetSats: 9_000,
      feeSats: 1_000,
      fixedVbytes: 85,
      changeOutputVbytes: 43,
    });

    expect(result).toEqual({
      ok: true,
      selected: [utxo('ab', 0, 10_000)],
      feeSats: 1_000,
      changeSats: 0,
      vbytes: 152,
    });
  });

  it('rejects empty UTXOs and non-positive fixed fees with typed failures', () => {
    expect(
      selectCoinsLargestFirstFixedFee({
        utxos: [],
        targetSats: 1_000,
        feeSats: 100,
      }),
    ).toEqual({ ok: false, reason: 'EMPTY_UTXOS', available: 0, required: 1_000 });

    expect(
      selectCoinsLargestFirstFixedFee({
        utxos: [utxo('ac', 0, 10_000)],
        targetSats: 1_000,
        feeSats: 0,
      }),
    ).toEqual({ ok: false, reason: 'INSUFFICIENT_FUNDS', available: 0, required: 1_000 });
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
