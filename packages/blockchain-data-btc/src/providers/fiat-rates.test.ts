import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProviderRateLimitError, ProviderId } from '../types';
import { CoinbaseProvider } from './coinbase';
import { CoinGeckoProvider } from './coingecko';
import { KrakenProvider } from './kraken';

describe('fiat rates providers', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('normalises Coinbase rates and sends a stable user agent', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      data: {
        currency: 'BTC',
        rates: {
          USD: '100000.50',
          EUR: '90000',
        },
      },
    }));
    const provider = new CoinbaseProvider();

    await expect(provider.fetchFiatRates(['usd', 'EUR'])).resolves.toMatchObject({
      source: ProviderId.COINBASE,
      rates: {
        USD: 100000.5,
        EUR: 90000,
      },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.coinbase.com/v2/exchange-rates?currency=BTC',
      expect.objectContaining({
        headers: expect.objectContaining({
          'User-Agent': 'asylia-blockchain-data-btc',
        }),
      }),
    );
  });

  it('rejects malformed Coinbase bodies so failover can continue', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { currency: 'BTC', rates: {} } }));

    await expect(new CoinbaseProvider().fetchFiatRates(['USD']))
      .rejects.toThrow('returned no rates');
  });

  it('normalises CoinGecko currency requests and optional API-key headers', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      bitcoin: {
        usd: 100000,
        eur: 90000,
      },
    }));
    const provider = new CoinGeckoProvider({ apiKey: 'test-key' });

    await expect(provider.fetchFiatRates(['USD', 'EUR'])).resolves.toMatchObject({
      source: ProviderId.COINGECKO,
      rates: {
        USD: 100000,
        EUR: 90000,
      },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://pro-api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd%2Ceur',
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-cg-pro-api-key': 'test-key',
        }),
      }),
    );
  });

  it('maps quota responses to ProviderRateLimitError', async () => {
    fetchMock.mockResolvedValueOnce(new Response('slow down', {
      status: 429,
      headers: { 'retry-after': '2' },
    }));

    await expect(new CoinGeckoProvider().fetchFiatRates(['USD']))
      .rejects.toBeInstanceOf(ProviderRateLimitError);
  });

  it('surfaces Kraken API errors instead of caching empty snapshots', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      error: ['EQuery:Unknown asset pair'],
      result: {},
    }));

    await expect(new KrakenProvider().fetchFiatRates(['USD']))
      .rejects.toThrow('Kraken /Ticker error');
  });
});

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    headers: { 'content-type': 'application/json' },
  });
}
