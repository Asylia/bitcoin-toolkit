import { Buffer } from 'buffer';
import { networks, payments } from 'bitcoinjs-lib';
import { describe, expect, it } from 'vitest';

import {
  describeBitcoinAddressType,
  parseBitcoinAddress,
} from '../index';
import { bip32 } from '../crypto/ecc';

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
    const taprootNode = bip32().fromSeed(Buffer.alloc(32, 5), networks.bitcoin)
      .derivePath("m/86'/0'/0'/0/0");
    const p2tr = payments.p2tr({
      internalPubkey: Buffer.from(taprootNode.publicKey.subarray(1, 33)),
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
    expect(parseBitcoinAddress(p2tr)).toEqual({
      ok: true,
      type: 'p2tr',
      address: p2tr,
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

  it('returns wrong_network before generic checksum errors for obvious non-mainnet addresses', () => {
    expect(parseBitcoinAddress('mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn')).toMatchObject({
      ok: false,
      code: 'wrong_network',
    });
    expect(parseBitcoinAddress('2N2JD6wb56AfK4tfmM6PwdVmoYk2dCKf4Br')).toMatchObject({
      ok: false,
      code: 'wrong_network',
    });
    expect(parseBitcoinAddress('bcrt1qexample')).toMatchObject({
      ok: false,
      code: 'wrong_network',
    });
  });

  it('rejects non-string inputs without throwing', () => {
    expect(parseBitcoinAddress(null as unknown as string)).toMatchObject({
      ok: false,
      code: 'invalid_format',
    });
  });
});

describe('describeBitcoinAddressType', () => {
  it('renders user-facing labels for known output templates', () => {
    expect(describeBitcoinAddressType('p2pkh')).toBe('Legacy (P2PKH)');
    expect(describeBitcoinAddressType('p2wsh')).toBe('Native SegWit Multisig (P2WSH)');
    expect(describeBitcoinAddressType('p2tr')).toBe('Taproot (P2TR)');
  });
});
