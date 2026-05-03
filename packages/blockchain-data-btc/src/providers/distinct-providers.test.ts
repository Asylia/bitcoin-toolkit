import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FIXTURE_ADDRESS_A,
  FIXTURE_ADDRESS_B,
  FIXTURE_TXID,
  blockchainDotComFixtures,
  blockcypherFixtures,
} from '../__fixtures__/providers';
import { ProviderRateLimitError } from '../types';
import { BlockchainDotComProvider } from './blockchain-dot-com';
import { BlockcypherProvider } from './blockcypher';

describe('distinct public chain-data providers', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('BlockchainDotComProvider', () => {
    it('reads multi-address balances in request order even when the API reorders rows', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({
        addresses: [
          {
            ...blockchainDotComFixtures.balance,
            address: FIXTURE_ADDRESS_B,
            final_balance: 200_000,
            total_received: 250_000,
            n_tx: 3,
          },
          blockchainDotComFixtures.balance,
        ],
      }));
      const provider = new BlockchainDotComProvider({ apiKey: 'paid-key' });

      await expect(provider.fetchMulti([FIXTURE_ADDRESS_A, FIXTURE_ADDRESS_B])).resolves.toEqual([
        {
          address: FIXTURE_ADDRESS_A,
          balance_sats: 100_000,
          pending_sats: 0,
          total_received_sats: 150_000,
          tx_count: 2,
        },
        {
          address: FIXTURE_ADDRESS_B,
          balance_sats: 200_000,
          pending_sats: 0,
          total_received_sats: 250_000,
          tx_count: 3,
        },
      ]);
      expect(fetchMock).toHaveBeenCalledWith(
        `https://blockchain.info/multiaddr?active=${FIXTURE_ADDRESS_A}|${FIXTURE_ADDRESS_B}&api_key=paid-key`,
        undefined,
      );
    });

    it('rejects malformed multi-address envelopes before balances can be misattributed', async () => {
      const provider = new BlockchainDotComProvider();

      fetchMock.mockResolvedValueOnce(jsonResponse({ addresses: [blockchainDotComFixtures.balance] }));
      await expect(provider.fetchMulti([FIXTURE_ADDRESS_A, FIXTURE_ADDRESS_B]))
        .rejects.toThrow('expected 2');

      fetchMock.mockResolvedValueOnce(jsonResponse({
        addresses: [{ ...blockchainDotComFixtures.balance, address: FIXTURE_ADDRESS_B }],
      }));
      await expect(provider.fetchSingle(FIXTURE_ADDRESS_A))
        .rejects.toThrow(`missing entry for address ${FIXTURE_ADDRESS_A}`);
    });

    it('maps per-address UTXO buckets and treats Blockchain.com empty buckets as 500 responses', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({
          unspent_outputs: [blockchainDotComFixtures.unspent],
        }))
        .mockResolvedValueOnce(new Response('No free outputs to spend', { status: 500 }));
      const provider = new BlockchainDotComProvider({ apiKey: 'paid-key' });

      await expect(provider.fetchUtxos([FIXTURE_ADDRESS_A, FIXTURE_ADDRESS_B])).resolves.toEqual([
        {
          address: FIXTURE_ADDRESS_A,
          utxos: [
            {
              txid: FIXTURE_TXID,
              vout: 0,
              valueSats: 100_000,
              address: FIXTURE_ADDRESS_A,
              confirmed: true,
              blockHeight: null,
            },
          ],
        },
        { address: FIXTURE_ADDRESS_B, utxos: [] },
      ]);
      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        `https://blockchain.info/unspent?active=${FIXTURE_ADDRESS_A}&api_key=paid-key`,
        undefined,
      );
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        `https://blockchain.info/unspent?active=${FIXTURE_ADDRESS_B}&api_key=paid-key`,
        undefined,
      );
    });

    it('maps ticker rates, rejects empty intersections, and posts raw transactions as form data', async () => {
      const provider = new BlockchainDotComProvider({ apiKey: 'paid-key' });

      fetchMock.mockResolvedValueOnce(jsonResponse({
        USD: { last: 100_000 },
        EUR: { '15m': 91_000 },
        CHF: { last: 0 },
      }));
      await expect(provider.fetchFiatRates(['usd', 'EUR', 'CHF'])).resolves.toMatchObject({
        rates: {
          USD: 100_000,
          EUR: 91_000,
        },
      });
      expect(fetchMock).toHaveBeenLastCalledWith(
        'https://blockchain.info/ticker?api_key=paid-key',
        undefined,
      );

      fetchMock.mockResolvedValueOnce(jsonResponse({ USD: { last: 100_000 } }));
      await expect(provider.fetchFiatRates(['NOK'])).rejects.toThrow('returned no rates');

      fetchMock.mockResolvedValueOnce(new Response('Transaction Submitted'));
      await expect(provider.broadcastTransaction('deadbeef')).resolves.toBe('');
      const [, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
      expect(fetchMock).toHaveBeenLastCalledWith(
        'https://blockchain.info/pushtx',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        }),
      );
      expect(new URLSearchParams(String(init.body)).get('tx')).toBe('deadbeef');
      expect(new URLSearchParams(String(init.body)).get('api_key')).toBe('paid-key');
    });

    it('turns quota responses and throttle timeouts into provider rate-limit errors', async () => {
      const throttle = {
        acquire: vi.fn(async () => true),
        release: vi.fn(),
        tripCooldown: vi.fn(),
      };
      fetchMock.mockResolvedValueOnce(new Response('quota', {
        status: 429,
        headers: { 'retry-after': '4' },
      }));
      const limited = new BlockchainDotComProvider({ throttleWaitMs: 25 });
      limited.bindThrottle(throttle as never);

      await expect(limited.fetchSingle(FIXTURE_ADDRESS_A)).rejects.toBeInstanceOf(ProviderRateLimitError);
      expect(throttle.acquire).toHaveBeenCalledWith(25);
      expect(throttle.tripCooldown).toHaveBeenCalledWith(4_000);
      expect(throttle.release).toHaveBeenCalledTimes(1);

      const blockedThrottle = {
        acquire: vi.fn(async () => false),
        release: vi.fn(),
        tripCooldown: vi.fn(),
      };
      const blocked = new BlockchainDotComProvider({ throttleWaitMs: 10 });
      blocked.bindThrottle(blockedThrottle as never);

      await expect(blocked.fetchSingle(FIXTURE_ADDRESS_A)).rejects.toMatchObject({
        name: 'ProviderRateLimitError',
        retryAfterMs: 0,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(blockedThrottle.release).not.toHaveBeenCalled();
    });
  });

  describe('BlockcypherProvider', () => {
    it('maps balances, appends tokens, and clamps negative pending balances', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({
        ...blockcypherFixtures.balance,
        unconfirmed_balance: -25_000,
      }));
      const provider = new BlockcypherProvider({ token: 'paid-token' });

      await expect(provider.fetchSingle(FIXTURE_ADDRESS_A)).resolves.toEqual({
        address: FIXTURE_ADDRESS_A,
        balance_sats: 100_000,
        pending_sats: 0,
        total_received_sats: 150_000,
        tx_count: 2,
      });
      expect(fetchMock).toHaveBeenCalledWith(
        `https://api.blockcypher.com/v1/btc/main/addrs/${FIXTURE_ADDRESS_A}/balance?token=paid-token`,
        undefined,
      );
    });

    it('fans out balance reads and preserves caller order', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(blockcypherFixtures.balance))
        .mockResolvedValueOnce(jsonResponse({
          ...blockcypherFixtures.balance,
          address: FIXTURE_ADDRESS_B,
          balance: 200_000,
        }));
      const provider = new BlockcypherProvider({ concurrency: 2 });

      await expect(provider.fetchMulti([FIXTURE_ADDRESS_A, FIXTURE_ADDRESS_B])).resolves.toEqual([
        expect.objectContaining({ address: FIXTURE_ADDRESS_A, balance_sats: 100_000 }),
        expect.objectContaining({ address: FIXTURE_ADDRESS_B, balance_sats: 200_000 }),
      ]);
    });

    it('maps confirmed and pending UTXO references into one address bucket', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({
        address: FIXTURE_ADDRESS_A,
        txrefs: [blockcypherFixtures.utxo],
        unconfirmed_txrefs: [
          {
            ...blockcypherFixtures.utxo,
            tx_hash: '22'.repeat(32),
            tx_output_n: 1,
            block_height: -1,
            value: 25_000,
          },
        ],
      }));
      const provider = new BlockcypherProvider({ token: 'paid-token' });

      await expect(provider.fetchUtxos([FIXTURE_ADDRESS_A])).resolves.toEqual([
        {
          address: FIXTURE_ADDRESS_A,
          utxos: [
            {
              txid: FIXTURE_TXID,
              vout: 0,
              valueSats: 100_000,
              address: FIXTURE_ADDRESS_A,
              confirmed: true,
              blockHeight: 800_000,
            },
            {
              txid: '22'.repeat(32),
              vout: 1,
              valueSats: 25_000,
              address: FIXTURE_ADDRESS_A,
              confirmed: false,
              blockHeight: null,
            },
          ],
        },
      ]);
      expect(fetchMock).toHaveBeenCalledWith(
        `https://api.blockcypher.com/v1/btc/main/addrs/${FIXTURE_ADDRESS_A}?unspentOnly=true&includeScript=false&token=paid-token`,
        undefined,
      );
    });

    it('normalises transactions, tip height, and broadcast txids', async () => {
      const broadcastTxid = '33'.repeat(32);
      const provider = new BlockcypherProvider({ token: 'paid-token' });

      fetchMock.mockResolvedValueOnce(jsonResponse({
        address: FIXTURE_ADDRESS_A,
        txs: [
          {
            hash: FIXTURE_TXID,
            block_height: 800_001,
            confirmed: '2026-01-01T00:00:00.000Z',
            fees: 1_000,
            size: 180,
            vsize: 123,
            inputs: [
              { addresses: [FIXTURE_ADDRESS_A], output_value: 101_000 },
              { output_value: 0 },
            ],
            outputs: [
              { addresses: [FIXTURE_ADDRESS_B], value: 100_000 },
              { value: 0, script_type: 'null-data' },
            ],
          },
        ],
      }));
      await expect(provider.fetchTransactions([FIXTURE_ADDRESS_A])).resolves.toEqual([
        {
          address: FIXTURE_ADDRESS_A,
          transactions: [
            {
              txid: FIXTURE_TXID,
              feeSats: 1_000,
              vbytes: 123,
              status: {
                confirmed: true,
                blockHeight: 800_001,
                blockTime: '2026-01-01T00:00:00.000Z',
              },
              vin: [
                { address: FIXTURE_ADDRESS_A, valueSats: 101_000 },
                { address: null, valueSats: 0 },
              ],
              vout: [
                { address: FIXTURE_ADDRESS_B, valueSats: 100_000 },
                { address: null, valueSats: 0 },
              ],
            },
          ],
        },
      ]);
      expect(fetchMock).toHaveBeenLastCalledWith(
        `https://api.blockcypher.com/v1/btc/main/addrs/${FIXTURE_ADDRESS_A}/full?limit=50&token=paid-token`,
        undefined,
      );

      fetchMock.mockResolvedValueOnce(jsonResponse({ height: 825_000 }));
      await expect(provider.fetchTipHeight()).resolves.toBe(825_000);

      fetchMock.mockResolvedValueOnce(jsonResponse({ tx: { hash: broadcastTxid } }));
      await expect(provider.broadcastTransaction('deadbeef')).resolves.toBe(broadcastTxid);
      expect(fetchMock).toHaveBeenLastCalledWith(
        'https://api.blockcypher.com/v1/btc/main/txs/push?token=paid-token',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tx: 'deadbeef' }),
        }),
      );
    });

    it('rejects malformed payloads and releases throttles around provider failures', async () => {
      const provider = new BlockcypherProvider();

      fetchMock.mockResolvedValueOnce(jsonResponse({ balance: 1 }));
      await expect(provider.fetchSingle(FIXTURE_ADDRESS_A)).rejects.toThrow('missing address');

      fetchMock.mockResolvedValueOnce(jsonResponse({ height: '825000' }));
      await expect(provider.fetchTipHeight()).rejects.toThrow('missing height');

      fetchMock.mockResolvedValueOnce(jsonResponse({ tx: { hash: 'not-a-txid' } }));
      await expect(provider.broadcastTransaction('deadbeef')).rejects.toThrow('without a txid');

      const throttle = {
        acquire: vi.fn(async () => true),
        release: vi.fn(),
        tripCooldown: vi.fn(),
      };
      fetchMock.mockResolvedValueOnce(new Response('quota', {
        status: 403,
        headers: { 'retry-after': '5' },
      }));
      const limited = new BlockcypherProvider({ throttleWaitMs: 25 });
      limited.bindThrottle(throttle as never);

      await expect(limited.fetchTipHeight()).rejects.toBeInstanceOf(ProviderRateLimitError);
      expect(throttle.acquire).toHaveBeenCalledWith(25);
      expect(throttle.tripCooldown).toHaveBeenCalledWith(5_000);
      expect(throttle.release).toHaveBeenCalledTimes(1);
    });
  });
});

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    headers: { 'content-type': 'application/json' },
  });
}
