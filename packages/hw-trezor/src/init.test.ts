import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  init: vi.fn(),
}));

vi.mock('./sdk', () => ({
  TrezorConnect: {
    init: mocks.init,
  },
}));

import { _resetTrezorInitForTests, initTrezor } from './init';

type GlobalWithProcess = typeof globalThis & {
  process?: { env?: Record<string, string | undefined> };
};

const manifest = {
  appName: 'Asylia',
  appUrl: 'https://wallet.asylia.io',
  email: 'support@asylia.io',
};

describe('initTrezor', () => {
  let originalDebugEnv: string | undefined;

  beforeEach(() => {
    originalDebugEnv = (globalThis as GlobalWithProcess).process?.env?.ASYLIA_HW_DEBUG;
  });

  afterEach(() => {
    _resetTrezorInitForTests();
    mocks.init.mockReset();
    if ((globalThis as GlobalWithProcess).process?.env) {
      (globalThis as GlobalWithProcess).process!.env!.ASYLIA_HW_DEBUG = originalDebugEnv;
    }
    vi.restoreAllMocks();
  });

  it('rejects missing manifest fields before calling the SDK', async () => {
    await expect(initTrezor({ appName: '', appUrl: '', email: '' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'manifest_required' },
    });
    expect(mocks.init).not.toHaveBeenCalled();
  });

  it('logs only manifest presence during init validation', async () => {
    if ((globalThis as GlobalWithProcess).process?.env) {
      (globalThis as GlobalWithProcess).process!.env!.ASYLIA_HW_DEBUG = '1';
    }
    const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    mocks.init.mockResolvedValueOnce(undefined);

    await expect(initTrezor({ manifest, debug: true })).resolves.toEqual({
      ok: true,
      data: true,
    });
    _resetTrezorInitForTests();
    await expect(initTrezor({ appName: '', appUrl: '', email: '' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'manifest_required' },
    });

    const renderedLogs = JSON.stringify([...consoleInfo.mock.calls, ...consoleError.mock.calls]);
    expect(renderedLogs).toContain('hasManifest');
    expect(renderedLogs).not.toContain(manifest.appName);
    expect(renderedLogs).not.toContain(manifest.appUrl);
    expect(renderedLogs).not.toContain(manifest.email);
  });

  it('shares one SDK init across concurrent callers', async () => {
    mocks.init.mockResolvedValueOnce(undefined);

    const [first, second] = await Promise.all([
      initTrezor({ manifest, debug: true }),
      initTrezor({ manifest, debug: true }),
    ]);

    expect(first).toEqual({ ok: true, data: true });
    expect(second).toEqual({ ok: true, data: true });
    expect(mocks.init).toHaveBeenCalledTimes(1);
    expect(mocks.init).toHaveBeenCalledWith({
      manifest,
      debug: true,
      lazyLoad: true,
    });
  });

  it('clears failed init state so a later call can retry', async () => {
    mocks.init
      .mockRejectedValueOnce(new Error('iframe blocked'))
      .mockResolvedValueOnce(undefined);

    await expect(initTrezor({ manifest })).resolves.toMatchObject({
      ok: false,
      error: { code: 'init_failed' },
    });
    await expect(initTrezor({ manifest })).resolves.toEqual({ ok: true, data: true });
    expect(mocks.init).toHaveBeenCalledTimes(2);
  });
});
