import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProviderRateLimitError, ProviderId } from '../types';
import { CoinbaseProvider } from './coinbase';
import { CoinGeckoProvider } from './coingecko';
import { KrakenProvider } from './kraken';
import { MempoolSpaceProvider } from './mempool-space';

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

  it('normalises Mempool.space rates, timestamp, and optional bearer auth', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      time: 1_767_225_600,
      USD: 100000,
      eur: 91000.5,
      CHF: 0,
    }));
    const provider = new MempoolSpaceProvider({ apiKey: 'paid-key' });

    await expect(provider.fetchFiatRates(['usd', 'EUR', 'CHF'])).resolves.toEqual({
      source: ProviderId.MEMPOOL_SPACE,
      rates: {
        USD: 100000,
        EUR: 91000.5,
      },
      fetchedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(fetchMock).toHaveBeenCalledWith('https://mempool.space/api/v1/prices', {
      headers: { Authorization: 'Bearer paid-key' },
    });
  });

  it('rejects empty Mempool.space rate intersections', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ time: 1_767_225_600, USD: 100000 }));

    await expect(new MempoolSpaceProvider().fetchFiatRates(['NOK'])).rejects.toThrow(
      'Mempool.space /v1/prices returned no rates',
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

  it('trips Coinbase cooldowns and releases throttle permits on quota responses', async () => {
    fetchMock.mockResolvedValueOnce(new Response('quota', {
      status: 403,
      headers: { 'retry-after': '3' },
    }));
    const throttle = {
      acquire: vi.fn(async () => true),
      release: vi.fn(),
      tripCooldown: vi.fn(),
    };
    const provider = new CoinbaseProvider({ throttleWaitMs: 25 });

    provider.bindThrottle(throttle as never);

    await expect(provider.fetchFiatRates(['USD'])).rejects.toMatchObject({
      name: 'ProviderRateLimitError',
      retryAfterMs: 3_000,
    });
    expect(throttle.acquire).toHaveBeenCalledWith(25);
    expect(throttle.tripCooldown).toHaveBeenCalledWith(3_000);
    expect(throttle.release).toHaveBeenCalledTimes(1);
  });

  it('fails fast when Coinbase cannot acquire a throttle permit', async () => {
    const throttle = {
      acquire: vi.fn(async () => false),
      release: vi.fn(),
      tripCooldown: vi.fn(),
    };
    const provider = new CoinbaseProvider({ throttleWaitMs: 10 });

    provider.bindThrottle(throttle as never);

    await expect(provider.fetchFiatRates(['USD'])).rejects.toMatchObject({
      name: 'ProviderRateLimitError',
      retryAfterMs: 0,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(throttle.release).not.toHaveBeenCalled();
  });

  it('normalises Kraken ticker rates and query pairs', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      error: [],
      result: {
        XXBTZUSD: { c: ['101000.25', '1.5'] },
        XXBTZEUR: { c: ['92000', '2'] },
      },
    }));

    await expect(new KrakenProvider().fetchFiatRates(['usd', 'EUR'])).resolves.toMatchObject({
      source: ProviderId.KRAKEN,
      rates: {
        USD: 101000.25,
        EUR: 92000,
      },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.kraken.com/0/public/Ticker?pair=XBTUSD%2CXBTEUR',
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: 'application/json' }),
      }),
    );
  });

  it('rejects Kraken requests with no supported fiat pairs before fetching', async () => {
    await expect(new KrakenProvider().fetchFiatRates([])).rejects.toThrow(
      'no recognised pairs',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces non-ok Kraken responses as provider failures', async () => {
    fetchMock.mockResolvedValueOnce(new Response('maintenance', { status: 503 }));

    await expect(new KrakenProvider().fetchFiatRates(['USD'])).rejects.toThrow(
      'Kraken /Ticker returned 503',
    );
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
