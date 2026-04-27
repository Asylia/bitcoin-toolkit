import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Provider } from './providers/base';
import { BlockchainDataService } from './service';
import {
  ProviderId,
  type NormalizedAddressBalance,
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
