import { describe, expect, it, vi } from 'vitest';

import { ProviderConfigurationError, ProviderId, ProviderRateLimitError } from '../types';
import {
  EdgeFallbackProvider,
  type EdgeFallbackInvokeResult,
  type EdgeFallbackOp,
} from './edge-fallback';

describe('EdgeFallbackProvider', () => {
  it('dispatches without a throttle and validates every successful envelope', async () => {
    const invoke = vi.fn(async (payload: EdgeFallbackOp): Promise<EdgeFallbackInvokeResult> => {
      switch (payload.op) {
        case 'balance':
          return {
            error: null,
            data: {
              op: 'balance',
              balances: payload.addresses.map((address) => ({
                address,
                balance_sats: 1,
                pending_sats: 0,
                total_received_sats: 1,
                tx_count: 1,
              })),
            },
          };
        case 'utxos':
          return {
            error: null,
            data: {
              op: 'utxos',
              results: payload.addresses.map((address) => ({
                address,
                utxos: [
                  {
                    txid: VALID_TXID,
                    vout: 0,
                    valueSats: 5,
                    confirmed: true,
                    blockHeight: 800_000,
                  } as never,
                ],
              })),
            },
          };
        case 'txs':
          return {
            error: null,
            data: {
              op: 'txs',
              results: payload.addresses.map((address) => ({
                address,
                transactions: [],
              })),
            },
          };
        case 'tip':
          return { error: null, data: { op: 'tip', height: 800_001 } };
        case 'raw-tx':
          return { error: null, data: { op: 'raw-tx', txid: payload.txid, rawTxHex: '00' } };
        case 'fiat-rates':
          return {
            error: null,
            data: {
              op: 'fiat-rates',
              snapshot: {
                source: ProviderId.EDGE_FALLBACK,
                rates: { USD: 64_000 },
                fetchedAt: '2026-04-30T00:00:00.000Z',
              },
            },
          };
        case 'broadcast':
          return { error: null, data: { op: 'broadcast', txid: VALID_TXID } };
      }
    });
    const provider = new EdgeFallbackProvider({ invoke });

    await expect(provider.fetchSingle('bc1qa')).resolves.toMatchObject({ address: 'bc1qa' });
    await expect(provider.fetchMulti(['bc1qa', 'bc1qb'])).resolves.toHaveLength(2);
    await expect(provider.fetchUtxos(['bc1qa'])).resolves.toEqual([
      {
        address: 'bc1qa',
        utxos: [
          expect.objectContaining({
            address: 'bc1qa',
            valueSats: 5,
          }),
        ],
      },
    ]);
    await expect(provider.fetchTransactions(['bc1qa'])).resolves.toEqual([
      { address: 'bc1qa', transactions: [] },
    ]);
    await expect(provider.fetchTipHeight()).resolves.toBe(800_001);
    await expect(provider.fetchRawTransaction(VALID_TXID)).resolves.toBe('00');
    await expect(provider.fetchFiatRates(['USD'])).resolves.toMatchObject({
      rates: { USD: 64_000 },
    });
    await expect(provider.broadcastTransaction('00')).resolves.toBe(VALID_TXID);
  });

  it('defaults to the chain-data roles implemented by btc-chain-fallback', () => {
    expect(new EdgeFallbackProvider({ invoke: vi.fn() }).roles).toEqual([
      'read-balance',
      'read-utxos',
      'read-txs',
      'read-tip',
      'read-raw-tx',
      'broadcast',
    ]);
  });

  it('realigns UTXO and transaction buckets by address', async () => {
    const provider = new EdgeFallbackProvider({
      invoke: vi.fn(async (payload: EdgeFallbackOp): Promise<EdgeFallbackInvokeResult> => {
        if (payload.op === 'utxos') {
          return {
            error: null,
            data: {
              op: 'utxos',
              results: [...payload.addresses].reverse().map((address) => ({
                address,
                utxos: [
                  {
                    txid: VALID_TXID,
                    vout: 0,
                    valueSats: address === 'bc1qa' ? 1 : 2,
                    confirmed: true,
                    blockHeight: 800_000,
                  } as never,
                ],
              })),
            },
          };
        }
        if (payload.op === 'txs') {
          return {
            error: null,
            data: {
              op: 'txs',
              results: [...payload.addresses].reverse().map((address) => ({
                address,
                transactions: [
                  {
                    txid: address === 'bc1qa' ? '11'.repeat(32) : '22'.repeat(32),
                    vin: [],
                    vout: [],
                    feeSats: 1,
                    vbytes: 1,
                    status: { confirmed: false, blockHeight: null, blockTime: null },
                  },
                ],
              })),
            },
          };
        }
        return { error: null, data: { op: 'tip', height: 1 } };
      }),
    });

    await expect(provider.fetchUtxos(['bc1qa', 'bc1qb'])).resolves.toEqual([
      {
        address: 'bc1qa',
        utxos: [expect.objectContaining({ address: 'bc1qa', valueSats: 1 })],
      },
      {
        address: 'bc1qb',
        utxos: [expect.objectContaining({ address: 'bc1qb', valueSats: 2 })],
      },
    ]);
    await expect(provider.fetchTransactions(['bc1qa', 'bc1qb'])).resolves.toEqual([
      { address: 'bc1qa', transactions: [expect.objectContaining({ txid: '11'.repeat(32) })] },
      { address: 'bc1qb', transactions: [expect.objectContaining({ txid: '22'.repeat(32) })] },
    ]);
  });

  it('turns edge 429 errors into provider rate-limit errors and trips cooldown', async () => {
    const throttle = {
      acquire: vi.fn(async () => true),
      release: vi.fn(),
      tripCooldown: vi.fn(),
    };
    const provider = new EdgeFallbackProvider({
      invoke: vi.fn(async () => ({
        data: null,
        error: { message: 'too many requests', status: 429, retryAfterMs: 12_000 },
      })),
    });
    provider.bindThrottle(throttle as never);

    await expect(provider.fetchTipHeight()).rejects.toBeInstanceOf(ProviderRateLimitError);
    expect(throttle.tripCooldown).toHaveBeenCalledWith(12_000);
    expect(throttle.release).toHaveBeenCalledTimes(1);
  });

  it('turns edge 403 errors into provider configuration errors without cooldown', async () => {
    const throttle = {
      acquire: vi.fn(async () => true),
      release: vi.fn(),
      tripCooldown: vi.fn(),
    };
    const provider = new EdgeFallbackProvider({
      invoke: vi.fn(async () => ({
        data: null,
        error: { message: 'fallback forbidden', status: 403 },
      })),
    });
    provider.bindThrottle(throttle as never);

    await expect(provider.fetchTipHeight()).rejects.toBeInstanceOf(ProviderConfigurationError);
    expect(throttle.tripCooldown).not.toHaveBeenCalled();
    expect(throttle.release).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed envelopes and operation-specific invalid data', async () => {
    const provider = new EdgeFallbackProvider({
      invoke: vi.fn(async (): Promise<EdgeFallbackInvokeResult> => ({
        error: null,
        data: { op: 'tip', height: 1 },
      })),
    });
    await expect(provider.fetchSingle('bc1qa')).rejects.toThrow('unexpected envelope');

    await expect(
      new EdgeFallbackProvider({
        invoke: vi.fn(async () => ({
          data: null,
          error: { message: 'backend unavailable', status: 500 },
        })),
      }).fetchTipHeight(),
    ).rejects.toThrow('backend unavailable');

    await expect(
      edgeProvider({ op: 'balance', balances: [] }).fetchSingle('bc1qa'),
    ).rejects.toThrow('no balance');
    await expect(
      edgeProvider({ op: 'balance', balances: [balance('bc1qa')] }).fetchMulti([
        'bc1qa',
        'bc1qb',
      ]),
    ).rejects.toThrow('expected 2');
    await expect(edgeProvider({ op: 'tip', height: Number.NaN }).fetchTipHeight()).rejects.toThrow(
      'invalid tip height',
    );
    await expect(
      edgeProvider({ op: 'raw-tx', txid: '22'.repeat(32), rawTxHex: '00' }).fetchRawTransaction(
        VALID_TXID,
      ),
    ).rejects.toThrow('expected');
    await expect(
      edgeProvider({
        op: 'fiat-rates',
        snapshot: {
          source: ProviderId.EDGE_FALLBACK,
          rates: {},
          fetchedAt: '2026-04-30T00:00:00.000Z',
        },
      }).fetchFiatRates(['USD']),
    ).rejects.toThrow('empty fiat rates');
    await expect(
      edgeProvider({ op: 'broadcast', txid: 'not-a-txid' }).broadcastTransaction('00'),
    ).rejects.toThrow('non-txid');
  });
});

const VALID_TXID = '11'.repeat(32);

function edgeProvider(data: EdgeFallbackInvokeResult['data']): EdgeFallbackProvider {
  return new EdgeFallbackProvider({
    invoke: vi.fn(async () => ({ error: null, data })),
  });
}

function balance(address: string) {
  return {
    address,
    balance_sats: 1,
    pending_sats: 0,
    total_received_sats: 1,
    tx_count: 1,
  };
}
