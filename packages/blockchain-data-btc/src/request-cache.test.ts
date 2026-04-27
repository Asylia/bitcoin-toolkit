import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RequestCache } from './request-cache';

describe('RequestCache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces concurrent callers onto one in-flight promise', async () => {
    const cache = new RequestCache();
    const deferred = deferredValue('fresh');
    const factory = vi.fn(() => deferred.promise);

    const first = cache.getOrCreate('balance:a', factory, 1_000);
    const second = cache.getOrCreate('balance:a', factory, 1_000);

    expect(factory).toHaveBeenCalledTimes(1);
    expect(cache.inflightSize()).toBe(1);

    deferred.resolve('fresh');

    await expect(first).resolves.toBe('fresh');
    await expect(second).resolves.toBe('fresh');
    expect(cache.inflightSize()).toBe(0);
    expect(cache.settledSize()).toBe(1);
  });

  it('serves settled values inside TTL and refreshes after expiry', async () => {
    const cache = new RequestCache();
    const factory = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce('first')
      .mockResolvedValueOnce('second');

    await expect(cache.getOrCreate('tip', factory, 1_000)).resolves.toBe('first');
    await expect(cache.getOrCreate('tip', factory, 1_000)).resolves.toBe('first');
    expect(factory).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1_001);

    await expect(cache.getOrCreate('tip', factory, 1_000)).resolves.toBe('second');
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('does not memoise failed requests', async () => {
    const cache = new RequestCache();
    const factory = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('upstream down'))
      .mockResolvedValueOnce('recovered');

    await expect(cache.getOrCreate('balance:a', factory, 1_000)).rejects.toThrow(
      'upstream down',
    );
    await expect(cache.getOrCreate('balance:a', factory, 1_000)).resolves.toBe(
      'recovered',
    );
    expect(factory).toHaveBeenCalledTimes(2);
  });
});

function deferredValue<T>(value: T): {
  promise: Promise<T>;
  resolve: (override?: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return {
    promise,
    resolve: (override = value) => resolve(override),
  };
}
