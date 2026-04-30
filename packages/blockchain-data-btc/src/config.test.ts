import { describe, expect, it } from 'vitest';

import { defaultProviderConfig, getProviderRateLimit } from './config';
import { ProviderId } from './types';

describe('defaultProviderConfig', () => {
  it('keeps provider priority unique and rate-limited', () => {
    const priority = defaultProviderConfig.priority;

    expect(new Set(priority).size).toBe(priority.length);
    for (const providerId of Object.values(ProviderId)) {
      expect(priority, `${providerId} should be in the default priority walk`).toContain(providerId);
      expect(getProviderRateLimit(providerId)).toMatchObject({
        requests: expect.any(Number),
        per: expect.any(Number),
        minIntervalMs: expect.any(Number),
        maxConcurrent: expect.any(Number),
        coolDownMs: expect.any(Number),
      });
      expect(getProviderRateLimit(providerId).requests).toBeGreaterThan(0);
      expect(getProviderRateLimit(providerId).per).toBeGreaterThan(0);
      expect(getProviderRateLimit(providerId).maxConcurrent).toBeGreaterThan(0);
    }
  });

  it('keeps the paid edge fallback as the last-resort provider', () => {
    expect(defaultProviderConfig.priority.at(-1)).toBe(ProviderId.EDGE_FALLBACK);
  });
});
