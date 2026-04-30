import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProviderRateLimitError } from '../types';
import { EsploraBaseProvider } from './esplora-base';

describe('EsploraBaseProvider', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('normalises base URLs and reads a single address', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      address: 'bc1qa',
      chain_stats: { funded_txo_sum: 10, spent_txo_sum: 3, tx_count: 1 },
      mempool_stats: { funded_txo_sum: 5, spent_txo_sum: 1, tx_count: 1 },
    }));
    const provider = new EsploraBaseProvider({
      baseUrl: 'https://mempool.example/api///',
      displayName: 'TEST',
    });

    await expect(provider.fetchSingle('bc1qa')).resolves.toMatchObject({
      address: 'bc1qa',
      balance_sats: 7,
      pending_sats: 4,
    });
    expect(fetchMock).toHaveBeenCalledWith('https://mempool.example/api/address/bc1qa', {
      headers: {},
    });
  });

  it('maps quota responses to ProviderRateLimitError and trips throttle cooldown', async () => {
    const throttle = {
      acquire: vi.fn(async () => true),
      release: vi.fn(),
      tripCooldown: vi.fn(),
    };
    fetchMock.mockResolvedValueOnce(
      new Response('slow down', {
        status: 429,
        headers: { 'retry-after': '3' },
      }),
    );
    const provider = new EsploraBaseProvider({
      baseUrl: 'https://mempool.example/api',
      displayName: 'TEST',
    });
    provider.bindThrottle(throttle as never);

    await expect(provider.fetchTipHeight()).rejects.toBeInstanceOf(ProviderRateLimitError);
    expect(throttle.acquire).toHaveBeenCalledWith(4_000);
    expect(throttle.tripCooldown).toHaveBeenCalledWith(3_000);
    expect(throttle.release).toHaveBeenCalledTimes(1);
  });

  it('treats throttle acquisition timeouts as rate-limit errors without extra cooldown', async () => {
    const throttle = {
      acquire: vi.fn(async () => false),
      release: vi.fn(),
      tripCooldown: vi.fn(),
    };
    const provider = new EsploraBaseProvider({
      baseUrl: 'https://mempool.example/api',
      displayName: 'TEST',
      throttleWaitMs: 10,
    });
    provider.bindThrottle(throttle as never);

    await expect(provider.fetchTipHeight()).rejects.toBeInstanceOf(ProviderRateLimitError);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(throttle.tripCooldown).not.toHaveBeenCalled();
    expect(throttle.release).not.toHaveBeenCalled();
  });

  it('rejects non-quota HTTP failures and malformed provider payloads', async () => {
    const provider = new EsploraBaseProvider({
      baseUrl: 'https://mempool.example/api',
      displayName: 'TEST',
    });

    fetchMock.mockResolvedValueOnce(new Response('offline', { status: 500 }));
    await expect(provider.fetchTipHeight()).rejects.toThrow('TEST returned 500');

    fetchMock.mockResolvedValueOnce(jsonResponse({ address: 'bc1qa' }));
    await expect(provider.fetchSingle('bc1qa')).rejects.toThrow('missing chain_stats');

    fetchMock.mockResolvedValueOnce(new Response('not-a-height'));
    await expect(provider.fetchTipHeight()).rejects.toThrow('Invalid TEST tip-height');

    fetchMock.mockResolvedValueOnce(new Response('abc'));
    await expect(provider.fetchRawTransaction(VALID_TXID)).rejects.toThrow('non-hex payload');

    fetchMock.mockResolvedValueOnce(new Response('not-a-txid'));
    await expect(provider.broadcastTransaction('00')).rejects.toThrow('non-txid payload');
  });

  it('fans out multi-address calls while preserving order', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(addressPayload('bc1qa', 1)))
      .mockResolvedValueOnce(jsonResponse(addressPayload('bc1qb', 2)));
    const provider = new EsploraBaseProvider({
      baseUrl: 'https://mempool.example/api',
      displayName: 'TEST',
      concurrency: 2,
    });

    await expect(provider.fetchMulti(['bc1qa', 'bc1qb'])).resolves.toEqual([
      expect.objectContaining({ address: 'bc1qa', balance_sats: 1 }),
      expect.objectContaining({ address: 'bc1qb', balance_sats: 2 }),
    ]);
  });
});

const VALID_TXID = '11'.repeat(32);

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    headers: { 'content-type': 'application/json' },
  });
}

function addressPayload(address: string, value: number) {
  return {
    address,
    chain_stats: { funded_txo_sum: value, spent_txo_sum: 0, tx_count: value },
    mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0, tx_count: 0 },
  };
}
