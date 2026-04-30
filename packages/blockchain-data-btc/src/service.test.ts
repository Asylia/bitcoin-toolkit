import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Provider } from './providers/base';
import { BlockchainDataService } from './service';
import {
  ProviderId,
  ProviderRateLimitError,
  type AddressTransactions,
  type AddressUtxos,
  type FiatRatesSnapshot,
  type NormalizedAddressBalance,
  type NormalizedTransaction,
} from './types';

describe('BlockchainDataService', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it('fails over to the next provider and records the dev trail', async () => {
    const failingFetchSingle = vi.fn(async () => {
      throw new Error('primary offline');
    });
    const fallbackFetchSingle = vi.fn(async (address: string) => balance(address, 42));
    const service = new BlockchainDataService({
      providers: {
        [ProviderId.MEMPOOL_SPACE]: {
          roles: ['read-balance'],
          fetchSingle: failingFetchSingle,
        },
        [ProviderId.BLOCKSTREAM_INFO]: {
          roles: ['read-balance'],
          fetchSingle: fallbackFetchSingle,
        },
      },
      priority: [ProviderId.MEMPOOL_SPACE, ProviderId.BLOCKSTREAM_INFO],
      devMode: true,
      enableDeduplication: false,
    });

    const response = await service.getSingle('bc1qprimary');

    expect(failingFetchSingle).toHaveBeenCalledTimes(1);
    expect(fallbackFetchSingle).toHaveBeenCalledWith('bc1qprimary');
    expect(response).toMatchObject({
      address: 'bc1qprimary',
      balance_sats: 42,
      provider: ProviderId.BLOCKSTREAM_INFO,
      dev_info: {
        data_providers_used: [ProviderId.MEMPOOL_SPACE, ProviderId.BLOCKSTREAM_INFO],
      },
    });
  });

  it('prefers bulk-capable providers for multi-address reads and preserves caller order', async () => {
    const esploraFetchMulti = vi.fn(async (addresses: readonly string[]) =>
      addresses.map((address, index) => balance(address, index + 1)),
    );
    const bulkFetchMulti = vi.fn(async (addresses: readonly string[]) => [
      balance(addresses[1]!, 20),
      balance(addresses[0]!, 10),
    ]);
    const service = new BlockchainDataService({
      providers: {
        [ProviderId.MEMPOOL_SPACE]: multiProvider(esploraFetchMulti),
        [ProviderId.BLOCKCHAIN_DOT_COM]: {
          ...multiProvider(bulkFetchMulti),
          bulkCapable: true,
        },
      },
      priority: [ProviderId.MEMPOOL_SPACE, ProviderId.BLOCKCHAIN_DOT_COM],
    });

    const first = await service.getMulti(['bc1qb', 'bc1qa']);
    const second = await service.getMulti(['bc1qa', 'bc1qb']);

    expect(esploraFetchMulti).not.toHaveBeenCalled();
    expect(bulkFetchMulti).toHaveBeenCalledTimes(1);
    expect(bulkFetchMulti).toHaveBeenCalledWith(['bc1qa', 'bc1qb']);
    expect(first.balances.map((entry) => entry.address)).toEqual(['bc1qb', 'bc1qa']);
    expect(first.summary).toMatchObject({
      total_balance_sats: 30,
      total_pending_sats: 0,
      total_received_sats: 30,
      address_count: 2,
    });
    expect(second.balances.map((entry) => entry.address)).toEqual(['bc1qa', 'bc1qb']);
  });

  it('rejects malformed provider responses before returning them to callers', async () => {
    const service = new BlockchainDataService({
      providers: {
        [ProviderId.MEMPOOL_SPACE]: multiProvider(async () => [balance('bc1qonly', 1)]),
      },
      priority: [ProviderId.MEMPOOL_SPACE],
      enableDeduplication: false,
    });

    await expect(service.getMulti(['bc1qone', 'bc1qtwo'])).rejects.toThrow(
      'NO_PROVIDER_AVAILABLE',
    );
  });

  it('skips cooled-down providers without calling them', async () => {
    const cooledDown = vi.fn(async () => balance('bc1qprimary', 1));
    const fallback = vi.fn(async (address: string) => balance(address, 2));
    const service = new BlockchainDataService({
      providers: {
        [ProviderId.MEMPOOL_SPACE]: {
          roles: ['read-balance'],
          fetchSingle: cooledDown,
        },
        [ProviderId.BLOCKSTREAM_INFO]: {
          roles: ['read-balance'],
          fetchSingle: fallback,
        },
      },
      priority: [ProviderId.MEMPOOL_SPACE, ProviderId.BLOCKSTREAM_INFO],
      devMode: true,
      enableDeduplication: false,
    });
    service.getRateLimiter().tripCooldown(ProviderId.MEMPOOL_SPACE, 2_000);

    const response = await service.getSingle('bc1qprimary');

    expect(cooledDown).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledWith('bc1qprimary');
    expect(response.dev_info?.data_providers_used).toEqual([
      ProviderId.MEMPOOL_SPACE,
      ProviderId.BLOCKSTREAM_INFO,
    ]);
  });

  it('fails over after explicit provider rate-limit errors', async () => {
    const rateLimited = vi.fn(async () => {
      throw new ProviderRateLimitError('slow down', 1_000);
    });
    const fallback = vi.fn(async (address: string) => balance(address, 7));
    const service = new BlockchainDataService({
      providers: {
        [ProviderId.MEMPOOL_SPACE]: {
          roles: ['read-balance'],
          fetchSingle: rateLimited,
        },
        [ProviderId.BLOCKSTREAM_INFO]: {
          roles: ['read-balance'],
          fetchSingle: fallback,
        },
      },
      priority: [ProviderId.MEMPOOL_SPACE, ProviderId.BLOCKSTREAM_INFO],
      devMode: true,
      enableDeduplication: false,
    });

    const response = await service.getSingle('bc1qratelimited');

    expect(response).toMatchObject({
      address: 'bc1qratelimited',
      balance_sats: 7,
      provider: ProviderId.BLOCKSTREAM_INFO,
    });
    expect(response.dev_info?.data_providers_used).toEqual([
      ProviderId.MEMPOOL_SPACE,
      ProviderId.BLOCKSTREAM_INFO,
    ]);
  });

  it('excludes unsupported providers from the dev provider trail', async () => {
    const unsupported = vi.fn(async () => balance('bc1qunsupported', 1));
    const supported = vi.fn(async (address: string) => balance(address, 9));
    const service = new BlockchainDataService({
      providers: {
        [ProviderId.MEMPOOL_SPACE]: {
          roles: ['read-tip'],
          fetchSingle: unsupported,
        },
        [ProviderId.BLOCKSTREAM_INFO]: {
          roles: ['read-balance'],
          fetchSingle: supported,
        },
      },
      priority: [ProviderId.MEMPOOL_SPACE, ProviderId.BLOCKSTREAM_INFO],
      devMode: true,
      enableDeduplication: false,
    });

    const response = await service.getSingle('bc1qunsupported');

    expect(unsupported).not.toHaveBeenCalled();
    expect(response.dev_info?.data_providers_used).toEqual([ProviderId.BLOCKSTREAM_INFO]);
  });

  it('realigns UTXO and transaction buckets by address and rejects missing buckets', async () => {
    const service = new BlockchainDataService({
      providers: {
        [ProviderId.MEMPOOL_SPACE]: {
          roles: ['read-utxos', 'read-txs'],
          fetchUtxos: vi.fn(async () => [
            utxoBucket('bc1qb', 2),
            utxoBucket('bc1qa', 1),
          ]),
          fetchTransactions: vi.fn(async () => [
            txBucket('bc1qb', 2),
            txBucket('bc1qa', 1),
          ]),
        },
      },
      priority: [ProviderId.MEMPOOL_SPACE],
    });

    await expect(service.getUtxos(['bc1qa', 'bc1qb'])).resolves.toMatchObject({
      results: [{ address: 'bc1qa' }, { address: 'bc1qb' }],
      summary: { address_count: 2, utxo_count: 2, total_value_sats: 3 },
    });
    await expect(service.getTransactions(['bc1qa', 'bc1qb'])).resolves.toMatchObject({
      results: [{ address: 'bc1qa' }, { address: 'bc1qb' }],
      summary: { address_count: 2, transaction_count: 2 },
    });

    const missing = new BlockchainDataService({
      providers: {
        [ProviderId.MEMPOOL_SPACE]: {
          roles: ['read-utxos'],
          fetchUtxos: vi.fn(async () => [utxoBucket('bc1qa', 1), utxoBucket('bc1qc', 3)]),
        },
      },
      priority: [ProviderId.MEMPOOL_SPACE],
      enableDeduplication: false,
    });

    await expect(missing.getUtxos(['bc1qa', 'bc1qb'])).rejects.toThrow(
      'missing UTXO bucket for address bc1qb',
    );
  });

  it('respects force refreshes while keeping address-set cache keys canonical', async () => {
    const fetchMulti = vi.fn(async (addresses: readonly string[]) =>
      addresses.map((address, index) => balance(address, index + fetchMulti.mock.calls.length)),
    );
    const service = new BlockchainDataService({
      providers: {
        [ProviderId.MEMPOOL_SPACE]: multiProvider(fetchMulti),
      },
      priority: [ProviderId.MEMPOOL_SPACE],
    });

    const first = await service.getMulti(['bc1qb', 'bc1qa']);
    const second = await service.getMulti(['bc1qa', 'bc1qb']);
    const forced = await service.getMulti(['bc1qa', 'bc1qb'], { force: true });

    expect(fetchMulti).toHaveBeenCalledTimes(2);
    expect(fetchMulti).toHaveBeenNthCalledWith(1, ['bc1qa', 'bc1qb']);
    expect(first.balances.map((entry) => entry.address)).toEqual(['bc1qb', 'bc1qa']);
    expect(second.balances.map((entry) => entry.address)).toEqual(['bc1qa', 'bc1qb']);
    expect(forced.summary.total_balance_sats).toBeGreaterThan(second.summary.total_balance_sats);
  });

  it('can disable request deduplication for callers that need raw provider hits', async () => {
    const fetchSingle = vi.fn(async (address: string) => balance(address, 1));
    const service = new BlockchainDataService({
      providers: {
        [ProviderId.MEMPOOL_SPACE]: {
          roles: ['read-balance'],
          fetchSingle,
        },
      },
      priority: [ProviderId.MEMPOOL_SPACE],
      enableDeduplication: false,
    });

    await Promise.all([service.getSingle('bc1qraw'), service.getSingle('bc1qraw')]);

    expect(service.getRequestCache()).toBeNull();
    expect(fetchSingle).toHaveBeenCalledTimes(2);
  });

  it('validates fiat-rate requests and caches currency sets case-insensitively', async () => {
    const emptyRates = vi.fn(async (): Promise<FiatRatesSnapshot> => ({
      source: ProviderId.COINBASE,
      rates: {},
      fetchedAt: '2026-04-30T00:00:00.000Z',
    }));
    const fallback = vi.fn(async (): Promise<FiatRatesSnapshot> => ({
      source: ProviderId.KRAKEN,
      rates: { USD: 64_000, EUR: 60_000 },
      fetchedAt: '2026-04-30T00:00:00.000Z',
    }));
    const service = new BlockchainDataService({
      providers: {
        [ProviderId.COINBASE]: {
          roles: ['read-fiat-rates'],
          fetchFiatRates: emptyRates,
        },
        [ProviderId.KRAKEN]: {
          roles: ['read-fiat-rates'],
          fetchFiatRates: fallback,
        },
      },
      priority: [ProviderId.COINBASE, ProviderId.KRAKEN],
    });

    await expect(service.getFiatRates([])).rejects.toThrow(
      'At least one currency must be requested.',
    );
    await expect(service.getFiatRates(['usd', 'EUR'])).resolves.toMatchObject({
      rates: { USD: 64_000, EUR: 60_000 },
    });
    await expect(service.getFiatRates(['EUR', 'USD'])).resolves.toMatchObject({
      rates: { USD: 64_000, EUR: 60_000 },
    });
    expect(emptyRates).toHaveBeenCalledTimes(1);
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it('validates raw transaction txids and provider hex payloads', async () => {
    const badHex = vi.fn(async () => 'xyz');
    const goodHex = vi.fn(async () => 'AABB');
    const service = new BlockchainDataService({
      providers: {
        [ProviderId.MEMPOOL_SPACE]: {
          roles: ['read-raw-tx'],
          fetchRawTransaction: badHex,
        },
        [ProviderId.BLOCKSTREAM_INFO]: {
          roles: ['read-raw-tx'],
          fetchRawTransaction: goodHex,
        },
      },
      priority: [ProviderId.MEMPOOL_SPACE, ProviderId.BLOCKSTREAM_INFO],
    });
    const txid = 'AA'.repeat(32);

    await expect(service.getRawTransaction('not-a-txid')).rejects.toThrow('Invalid txid');
    const first = await service.getRawTransaction(txid);
    const second = await service.getRawTransaction(txid.toLowerCase());

    expect(first).toEqual({ txid: txid.toLowerCase(), rawTxHex: 'aabb' });
    expect(second).toEqual(first);
    expect(badHex).toHaveBeenCalledTimes(1);
    expect(goodHex).toHaveBeenCalledTimes(1);
  });

  it('broadcasts without cache and verifies provider txid echoes', async () => {
    const expectedTxid = '11'.repeat(32);
    const wrongEcho = vi.fn(async () => '22'.repeat(32));
    const emptyEcho = vi.fn(async () => '');
    const service = new BlockchainDataService({
      providers: {
        [ProviderId.MEMPOOL_SPACE]: {
          roles: ['broadcast'],
          broadcastTransaction: wrongEcho,
        },
        [ProviderId.BLOCKSTREAM_INFO]: {
          roles: ['broadcast'],
          broadcastTransaction: emptyEcho,
        },
      },
      priority: [ProviderId.MEMPOOL_SPACE, ProviderId.BLOCKSTREAM_INFO],
      devMode: true,
    });

    const first = await service.broadcastTransaction('00', expectedTxid);
    const second = await service.broadcastTransaction('00', expectedTxid);

    expect(first).toMatchObject({
      txid: expectedTxid,
      provider: ProviderId.BLOCKSTREAM_INFO,
      dev_info: {
        providers_attempted: [ProviderId.MEMPOOL_SPACE, ProviderId.BLOCKSTREAM_INFO],
      },
    });
    expect(second.txid).toBe(expectedTxid);
    expect(wrongEcho).toHaveBeenCalledTimes(2);
    expect(emptyEcho).toHaveBeenCalledTimes(2);
  });
});

function multiProvider(
  fetchMulti: (addresses: readonly string[]) => Promise<NormalizedAddressBalance[]>,
): Provider {
  return {
    roles: ['read-balance'],
    fetchMulti,
  };
}

function balance(address: string, value: number): NormalizedAddressBalance {
  return {
    address,
    balance_sats: value,
    pending_sats: 0,
    total_received_sats: value,
    tx_count: value > 0 ? 1 : 0,
  };
}

function utxoBucket(address: string, value: number): AddressUtxos {
  return {
    address,
    utxos: [
      {
        address,
        txid: `${value}`.repeat(64).slice(0, 64),
        vout: 0,
        valueSats: value,
        confirmed: true,
        blockHeight: 800_000,
      },
    ],
  };
}

function txBucket(address: string, value: number): AddressTransactions {
  return {
    address,
    transactions: [transaction(value)],
  };
}

function transaction(value: number): NormalizedTransaction {
  return {
    txid: `${value}`.repeat(64).slice(0, 64),
    vin: [{ address: 'bc1qin', valueSats: value + 1 }],
    vout: [{ address: 'bc1qout', valueSats: value }],
    feeSats: 1,
    vbytes: 100,
    status: {
      confirmed: true,
      blockHeight: 800_000,
      blockTime: '2026-04-30T00:00:00.000Z',
    },
  };
}
