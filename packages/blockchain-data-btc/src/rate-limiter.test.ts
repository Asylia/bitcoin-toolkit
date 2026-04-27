import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultProviderConfig } from './config';
import { RateLimiterService } from './rate-limiter';
import { ProviderId } from './types';

describe('RateLimiterService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('enforces concurrency, release interval, and explicit cooldown gates', async () => {
    const limiter = new RateLimiterService({
      priority: [ProviderId.MEMPOOL_SPACE],
      rateLimits: {
        ...defaultProviderConfig.rateLimits,
        [ProviderId.MEMPOOL_SPACE]: {
          requests: 2,
          per: 1_000,
          minIntervalMs: 100,
          maxConcurrent: 1,
          coolDownMs: 5_000,
        },
      },
    });

    await expect(limiter.acquire(ProviderId.MEMPOOL_SPACE, 0)).resolves.toBe(true);
    expect(limiter.getInFlight(ProviderId.MEMPOOL_SPACE)).toBe(1);
    expect(limiter.canMakeRequest(ProviderId.MEMPOOL_SPACE)).toBe(false);

    const blocked = limiter.acquire(ProviderId.MEMPOOL_SPACE, 1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(blocked).resolves.toBe(false);

    limiter.release(ProviderId.MEMPOOL_SPACE);
    expect(limiter.getInFlight(ProviderId.MEMPOOL_SPACE)).toBe(0);
    expect(limiter.timeUntilAvailable(ProviderId.MEMPOOL_SPACE)).toBe(100);

    limiter.tripCooldown(ProviderId.MEMPOOL_SPACE, 10_000);
    expect(limiter.getCooldownRemainingMs(ProviderId.MEMPOOL_SPACE)).toBe(10_000);
    expect(limiter.canMakeRequest(ProviderId.MEMPOOL_SPACE)).toBe(false);
  });

  it('resets provider state and resolves queued waiters as missed permits', async () => {
    const limiter = new RateLimiterService({
      priority: [ProviderId.MEMPOOL_SPACE],
      rateLimits: {
        ...defaultProviderConfig.rateLimits,
        [ProviderId.MEMPOOL_SPACE]: {
          requests: 1,
          per: 1_000,
          minIntervalMs: 0,
          maxConcurrent: 1,
          coolDownMs: 1_000,
        },
      },
    });

    await expect(limiter.acquire(ProviderId.MEMPOOL_SPACE)).resolves.toBe(true);
    const queued = limiter.acquire(ProviderId.MEMPOOL_SPACE);

    limiter.reset(ProviderId.MEMPOOL_SPACE);

    await expect(queued).resolves.toBe(false);
    expect(limiter.getInFlight(ProviderId.MEMPOOL_SPACE)).toBe(0);
    expect(limiter.getCurrentRequestCount(ProviderId.MEMPOOL_SPACE)).toBe(0);
  });
});
