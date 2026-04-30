import { describe, expect, it } from 'vitest';

import {
  mapBlockchainDotCom,
  mapBlockchainDotComUnspent,
} from './blockchain-com';
import {
  mapBlockcypherBalance,
  mapBlockcypherTransaction,
  mapBlockcypherUtxo,
} from './blockcypher';
import {
  isoFromMempoolSpace,
  krakenPairListFor,
  mapBlockchainDotComTicker,
  mapCoinbaseExchangeRates,
  mapCoinGeckoSimplePrice,
  mapKrakenTicker,
  mapMempoolSpacePrices,
} from './fiat-rates';
import {
  mapEsploraAddress,
  mapEsploraTransaction,
  mapEsploraUtxo,
} from './esplora';

describe('chain-data mappers', () => {
  it('normalises Esplora balances, UTXOs, and transactions', () => {
    expect(mapEsploraAddress({
      address: 'bc1qaddr',
      chain_stats: {
        funded_txo_sum: 120_000,
        spent_txo_sum: 20_000,
        tx_count: 3,
      },
      mempool_stats: {
        funded_txo_sum: 5_000,
        spent_txo_sum: 10_000,
        tx_count: 1,
      },
    })).toEqual({
      address: 'bc1qaddr',
      balance_sats: 100_000,
      pending_sats: 0,
      total_received_sats: 120_000,
      tx_count: 3,
    });

    expect(mapEsploraUtxo('bc1qaddr', {
      txid: 'txid',
      vout: 1,
      value: 50_000,
      status: {
        confirmed: true,
        block_height: 800_000,
      },
    })).toMatchObject({
      txid: 'txid',
      valueSats: 50_000,
      confirmed: true,
      blockHeight: 800_000,
    });

    expect(mapEsploraTransaction({
      txid: 'txid',
      version: 2,
      locktime: 0,
      vin: [
        {
          txid: 'prev',
          vout: 0,
          prevout: {
            scriptpubkey: '0014',
            scriptpubkey_address: 'bc1qinput',
            value: 60_000,
          },
        },
        { txid: 'coinbase', vout: 0, prevout: null, is_coinbase: true },
      ],
      vout: [
        { scriptpubkey: '0014', scriptpubkey_address: 'bc1qoutput', value: 58_500 },
        { scriptpubkey: '6a', value: 0 },
      ],
      size: 140,
      weight: 561,
      fee: 1_500,
      status: {
        confirmed: true,
        block_height: 800_001,
        block_time: 1_775_000_000,
      },
    })).toMatchObject({
      txid: 'txid',
      feeSats: 1_500,
      vbytes: 141,
      status: {
        confirmed: true,
        blockHeight: 800_001,
        blockTime: '2026-03-31T23:33:20.000Z',
      },
      vin: [
        { address: 'bc1qinput', valueSats: 60_000 },
        { address: null, valueSats: 0 },
      ],
      vout: [
        { address: 'bc1qoutput', valueSats: 58_500 },
        { address: null, valueSats: 0 },
      ],
    });
  });

  it('normalises Blockchain.com and Blockcypher provider quirks', () => {
    expect(mapBlockchainDotCom({
      address: 'bc1qaddr',
      final_balance: 42_000,
      total_received: 50_000,
      n_tx: 2,
    })).toEqual({
      address: 'bc1qaddr',
      balance_sats: 42_000,
      pending_sats: 0,
      total_received_sats: 50_000,
      tx_count: 2,
    });
    expect(mapBlockchainDotComUnspent('bc1qaddr', {
      tx_hash_big_endian: 'txid',
      tx_output_n: 2,
      value: 25_000,
      confirmations: 0,
      script: '0014',
    })).toMatchObject({
      confirmed: false,
      blockHeight: null,
    });

    expect(mapBlockcypherBalance({
      address: 'bc1qaddr',
      balance: 100_000,
      unconfirmed_balance: -20_000,
      total_received: 150_000,
      n_tx: 4,
      unconfirmed_n_tx: 1,
    })).toMatchObject({
      balance_sats: 100_000,
      pending_sats: 0,
    });
    expect(mapBlockcypherUtxo('bc1qaddr', {
      tx_hash: 'txid',
      tx_input_n: -1,
      tx_output_n: 0,
      value: 90_000,
      block_height: -1,
    }, true)).toMatchObject({
      confirmed: false,
      blockHeight: null,
    });
    expect(mapBlockcypherTransaction({
      hash: 'txid',
      block_height: -1,
      received: '2026-04-30T07:00:00.000Z',
      fees: 1_000,
      size: 190,
      inputs: [{ addresses: ['bc1qin'], output_value: 50_000 }],
      outputs: [{ addresses: ['bc1qout'], value: 49_000 }],
    })).toMatchObject({
      txid: 'txid',
      status: {
        confirmed: false,
        blockHeight: null,
        blockTime: null,
      },
      vbytes: 190,
    });
  });

  it('projects fiat rates from every provider shape', () => {
    expect(mapMempoolSpacePrices({
      time: 1_775_000_000,
      USD: 64_000,
      eur: 60_000,
      GBP: 0,
    }, ['usd', 'EUR', 'GBP'])).toEqual({
      USD: 64_000,
      EUR: 60_000,
    });
    expect(isoFromMempoolSpace({ time: 1_775_000_000 })).toBe(
      '2026-03-31T23:33:20.000Z',
    );
    expect(mapCoinbaseExchangeRates({
      data: {
        currency: 'BTC',
        rates: {
          USD: '64000.5',
          EUR: 'not-a-number',
        },
      },
    }, ['USD', 'EUR'])).toEqual({ USD: 64000.5 });
    expect(mapCoinGeckoSimplePrice({
      bitcoin: { usd: 64_000, eur: 60_000 },
    }, ['USD'])).toEqual({ USD: 64_000 });
    expect(krakenPairListFor(['usd', 'USD', 'chf'])).toBe('XBTUSD,XBTCHF');
    expect(mapKrakenTicker({
      result: {
        XXBTZUSD: { c: ['64000', '1'] },
        XBTCHF: { c: ['59000.25', '1'] },
      },
    }, ['USD', 'CHF', 'EUR'])).toEqual({
      USD: 64_000,
      CHF: 59000.25,
    });
  });

  it('covers mapper edge cases that protect provider failover decisions', () => {
    expect(mapEsploraAddress({
      address: 'bc1qpending',
      chain_stats: {
        funded_txo_sum: 10_000,
        spent_txo_sum: 4_000,
        tx_count: 1,
      },
      mempool_stats: {
        funded_txo_sum: 7_000,
        spent_txo_sum: 1_000,
        tx_count: 1,
      },
    })).toMatchObject({
      balance_sats: 6_000,
      pending_sats: 6_000,
    });

    expect(mapBlockcypherBalance({
      address: 'bc1qaddr',
      balance: 100_000,
      unconfirmed_balance: 12_345,
      total_received: 150_000,
      n_tx: 4,
      unconfirmed_n_tx: 1,
    })).toMatchObject({
      pending_sats: 12_345,
    });

    expect(mapBlockchainDotComTicker({
      USD: { last: 64_000, '15m': 63_000 },
      EUR: { '15m': 60_000 },
      GBP: { last: 0, '15m': -1 },
    }, ['usd', 'EUR', 'GBP'])).toEqual({
      USD: 64_000,
      EUR: 60_000,
    });

    expect(mapMempoolSpacePrices({
      time: 1_775_000_000,
      USD: 0,
      EUR: -1,
      CHF: 59_000,
    }, ['USD', 'EUR'])).toEqual({});

    expect(mapKrakenTicker({
      result: {
        UNKNOWN: { c: ['1', '1'] },
        XXBTZUSD: { c: ['not-a-number', '1'] },
        XXBTZEUR: {},
      },
    }, ['USD', 'EUR'])).toEqual({});
  });

  it('falls back to the current time when mempool price timestamps are invalid', () => {
    const before = Date.now();
    const iso = isoFromMempoolSpace({});
    const after = Date.now();
    const parsed = Date.parse(iso);

    expect(parsed).toBeGreaterThanOrEqual(before);
    expect(parsed).toBeLessThanOrEqual(after);
  });
});
