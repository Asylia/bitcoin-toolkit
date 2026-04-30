import { afterEach, describe, expect, it, vi } from 'vitest';

describe('Trezor SDK shim', () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('@trezor/connect-web');
  });

  it('uses the factory directly when the bundler already unwraps the default export', async () => {
    const factory = { init: vi.fn(), getPublicKey: vi.fn() };
    vi.doMock('@trezor/connect-web', () => ({
      default: factory,
    }));

    const { TrezorConnect } = await import('./sdk');
    expect(TrezorConnect).toBe(factory);
  });

  it('unwraps the nested default shape produced by some Vite prebundles', async () => {
    const factory = { init: vi.fn(), getPublicKey: vi.fn() };
    vi.doMock('@trezor/connect-web', () => ({
      default: { default: factory },
    }));

    const { TrezorConnect } = await import('./sdk');
    expect(TrezorConnect).toBe(factory);
  });
});
