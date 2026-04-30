import { describe, expect, it, vi } from 'vitest';

import { pMap, parseRetryAfterMs } from './utils';

describe('parseRetryAfterMs', () => {
  it('parses delta seconds and rejects empty or non-positive values', () => {
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs('')).toBeNull();
    expect(parseRetryAfterMs('  ')).toBeNull();
    expect(parseRetryAfterMs('0')).toBeNull();
    expect(parseRetryAfterMs('-1')).toBeNull();
    expect(parseRetryAfterMs('1.5')).toBe(1_500);
  });

  it('parses future HTTP dates and rejects past or malformed dates', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-30T12:00:00.000Z'));

    expect(parseRetryAfterMs('Thu, 30 Apr 2026 12:00:05 GMT')).toBe(5_000);
    expect(parseRetryAfterMs('Thu, 30 Apr 2026 11:59:59 GMT')).toBeNull();
    expect(parseRetryAfterMs('not a date')).toBeNull();

    vi.useRealTimers();
  });
});

describe('pMap', () => {
  it('preserves input order while running with bounded concurrency', async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    const result = await pMap([3, 1, 2], 2, async (value) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return value * 10;
    });

    expect(result).toEqual([30, 10, 20]);
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });

  it('clamps concurrency and propagates task failures', async () => {
    await expect(pMap([1, 2], 0, async (value) => value)).resolves.toEqual([1, 2]);
    await expect(
      pMap([1, 2, 3], 10, async (value) => {
        if (value === 2) throw new Error('boom');
        return value;
      }),
    ).rejects.toThrow('boom');
  });
});
