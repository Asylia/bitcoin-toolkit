import { describe, expect, it, vi } from 'vitest';

import { ProviderId, ProviderRateLimitError } from '../types';
import {
  FIXTURE_ADDRESS_A,
  FIXTURE_ADDRESS_B,
  FIXTURE_RAW_TX_HEX,
  FIXTURE_TXID,
} from '../__fixtures__/providers';
import {
  EdgeFallbackProvider,
  type EdgeFallbackInvokeResult,
  type EdgeFallbackOp,
} from './edge-fallback';

describe('provider contract suite', () => {
  it('verifies EdgeFallbackProvider preserves address identity and validates raw/broadcast/rates contracts', async () => {
    const provider = contractEdgeProvider();
    const addresses = [FIXTURE_ADDRESS_A, FIXTURE_ADDRESS_B];

    await expect(provider.fetchMulti(addresses)).resolves.toEqual(
      addresses.map((address) => expect.objectContaining({ address })),
    );
    await expect(provider.fetchUtxos(addresses)).resolves.toEqual(
      addresses.map((address) => ({
        address,
        utxos: [expect.objectContaining({ address, txid: FIXTURE_TXID })],
      })),
    );
    await expect(provider.fetchTransactions(addresses)).resolves.toEqual(
      addresses.map((address) => ({
        address,
        transactions: [expect.objectContaining({ txid: FIXTURE_TXID })],
      })),
    );
    await expect(provider.fetchRawTransaction(FIXTURE_TXID)).resolves.toBe(FIXTURE_RAW_TX_HEX);
    await expect(provider.broadcastTransaction(FIXTURE_RAW_TX_HEX)).resolves.toBe(FIXTURE_TXID);
    expect(provider.roles).not.toContain('read-fiat-rates');
    await expect(provider.fetchFiatRates(['USD'])).resolves.toMatchObject({
      rates: { USD: 64_000 },
    });
  });

  it('requires explicit failures for empty rates and rate-limit cooldowns', async () => {
    await expect(
      new EdgeFallbackProvider({
        invoke: vi.fn(async (): Promise<EdgeFallbackInvokeResult> => ({
          error: null,
          data: {
            op: 'fiat-rates',
            snapshot: {
              source: ProviderId.EDGE_FALLBACK,
              rates: {},
              fetchedAt: '2026-04-30T00:00:00.000Z',
            },
          },
        })),
      }).fetchFiatRates(['USD']),
    ).rejects.toThrow('empty fiat rates');

    const throttle = {
      acquire: vi.fn(async () => true),
      release: vi.fn(),
      tripCooldown: vi.fn(),
    };
    const limited = new EdgeFallbackProvider({
      invoke: vi.fn(async () => ({
        data: null,
        error: { message: 'quota', status: 429, retryAfterMs: 30_000 },
      })),
    });
    limited.bindThrottle(throttle as never);

    await expect(limited.fetchTipHeight()).rejects.toBeInstanceOf(ProviderRateLimitError);
    expect(throttle.tripCooldown).toHaveBeenCalledWith(30_000);
    expect(throttle.release).toHaveBeenCalledTimes(1);
  });
});

function contractEdgeProvider(): EdgeFallbackProvider {
  return new EdgeFallbackProvider({
    invoke: vi.fn(async (payload: EdgeFallbackOp): Promise<EdgeFallbackInvokeResult> => {
      switch (payload.op) {
        case 'balance':
          return {
            error: null,
            data: {
              op: 'balance',
              balances: payload.addresses.map((address) => ({
                address,
                balance_sats: 100_000,
                pending_sats: 0,
                total_received_sats: 150_000,
                tx_count: 2,
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
                    txid: FIXTURE_TXID,
                    vout: 0,
                    valueSats: 100_000,
                    address,
                    confirmed: true,
                    blockHeight: 800_000,
                  },
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
                transactions: [
                  {
                    txid: FIXTURE_TXID,
                    vin: [{ address, valueSats: 150_000 }],
                    vout: [{ address: FIXTURE_ADDRESS_B, valueSats: 140_000 }],
                    feeSats: 10_000,
                    vbytes: 140,
                    status: {
                      confirmed: true,
                      blockHeight: 800_001,
                      blockTime: '2026-04-30T00:00:00.000Z',
                    },
                  },
                ],
              })),
            },
          };
        case 'tip':
          return { error: null, data: { op: 'tip', height: 800_001 } };
        case 'raw-tx':
          return { error: null, data: { op: 'raw-tx', txid: payload.txid, rawTxHex: FIXTURE_RAW_TX_HEX } };
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
          return { error: null, data: { op: 'broadcast', txid: FIXTURE_TXID } };
      }
    }),
  });
}
