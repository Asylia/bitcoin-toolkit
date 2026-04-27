import { Buffer } from 'buffer';
import { networks, payments } from 'bitcoinjs-lib';
import { describe, expect, it } from 'vitest';

import {
  describeBitcoinAddressType,
  parseBitcoinAddress,
} from '../index';

describe('parseBitcoinAddress', () => {
  it('classifies standard mainnet address templates', () => {
    const p2pkh = payments.p2pkh({
      hash: Buffer.alloc(20, 1),
      network: networks.bitcoin,
    }).address!;
    const p2sh = payments.p2sh({
      hash: Buffer.alloc(20, 2),
      network: networks.bitcoin,
    }).address!;
    const p2wpkh = payments.p2wpkh({
      hash: Buffer.alloc(20, 3),
      network: networks.bitcoin,
    }).address!;
    const p2wsh = payments.p2wsh({
      hash: Buffer.alloc(32, 4),
      network: networks.bitcoin,
    }).address!;

    expect(parseBitcoinAddress(` ${p2pkh} `)).toEqual({
      ok: true,
      type: 'p2pkh',
      address: p2pkh,
    });
    expect(parseBitcoinAddress(p2sh)).toEqual({ ok: true, type: 'p2sh', address: p2sh });
    expect(parseBitcoinAddress(p2wpkh)).toEqual({
      ok: true,
      type: 'p2wpkh',
      address: p2wpkh,
    });
    expect(parseBitcoinAddress(p2wsh)).toEqual({
      ok: true,
      type: 'p2wsh',
      address: p2wsh,
    });
  });

  it('returns stable error codes for common invalid inputs', () => {
    expect(parseBitcoinAddress('   ')).toMatchObject({ ok: false, code: 'empty' });
    expect(parseBitcoinAddress('tb1qexample')).toMatchObject({
      ok: false,
      code: 'wrong_network',
    });
    expect(parseBitcoinAddress('bc1Qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080')).toMatchObject({
      ok: false,
      code: 'invalid_format',
    });
    expect(parseBitcoinAddress('x-not-a-bitcoin-address')).toMatchObject({
      ok: false,
      code: 'invalid_format',
    });
  });
});

describe('describeBitcoinAddressType', () => {
  it('renders user-facing labels for known output templates', () => {
    expect(describeBitcoinAddressType('p2pkh')).toBe('Legacy (P2PKH)');
    expect(describeBitcoinAddressType('p2wsh')).toBe('Native SegWit Multisig (P2WSH)');
  });
});
