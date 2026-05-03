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

  it('can bypass a settled value without duplicating an active refresh', async () => {
    const cache = new RequestCache();
    const deferred = deferredValue('fresh');
    const factory = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce('cached')
      .mockReturnValueOnce(deferred.promise);

    await expect(cache.getOrCreate('tip', factory, 1_000)).resolves.toBe('cached');
    expect(cache.has('tip')).toBe(true);

    const firstRefresh = cache.getOrCreate('tip', factory, 1_000, {
      bypassSettled: true,
    });
    const joinedRefresh = cache.getOrCreate('tip', factory, 1_000);

    expect(factory).toHaveBeenCalledTimes(2);
    expect(cache.inflightSize()).toBe(1);

    deferred.resolve();

    await expect(firstRefresh).resolves.toBe('fresh');
    await expect(joinedRefresh).resolves.toBe('fresh');
    expect(cache.settledSize()).toBe(1);
  });

  it('clears explicit keys, clears all entries, and prunes expired TTL values', async () => {
    const cache = new RequestCache();

    await cache.getOrCreate('a', () => Promise.resolve('one'), 1_000);
    await cache.getOrCreate('b', () => Promise.resolve('two'), 2_000);

    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(true);

    cache.clear('a');

    expect(cache.has('a')).toBe(false);
    expect(cache.has('b')).toBe(true);

    vi.advanceTimersByTime(2_001);

    expect(cache.has('b')).toBe(false);

    await cache.getOrCreate('c', () => Promise.resolve('three'), 1_000);
    await cache.getOrCreate('d', () => Promise.resolve('four'), 2_000);

    vi.advanceTimersByTime(1_001);
    cache.pruneExpired();

    expect(cache.has('c')).toBe(false);
    expect(cache.has('d')).toBe(true);

    cache.clearAll();

    expect(cache.has('d')).toBe(false);
    expect(cache.settledSize()).toBe(0);
    expect(cache.inflightSize()).toBe(0);
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
