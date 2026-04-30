import { afterEach, describe, expect, it, vi } from 'vitest';

import { _resetLedgerInitForTests, initLedger } from './init';

describe('initLedger', () => {
  afterEach(() => {
    _resetLedgerInitForTests();
    vi.unstubAllGlobals();
  });

  it('blocks insecure browser contexts before touching WebHID', async () => {
    vi.stubGlobal('window', {
      isSecureContext: false,
      location: { href: 'http://wallet.example.test' },
    });
    vi.stubGlobal('navigator', { hid: {} });

    await expect(initLedger()).resolves.toMatchObject({
      ok: false,
      error: { code: 'transport_unavailable' },
    });
  });

  it('requires navigator.hid in supported browser contexts', async () => {
    vi.stubGlobal('window', { isSecureContext: true });
    vi.stubGlobal('navigator', {});

    await expect(initLedger()).resolves.toMatchObject({
      ok: false,
      error: { code: 'transport_unavailable' },
    });
  });

  it('is idempotent after the environment has passed preflight', async () => {
    vi.stubGlobal('window', { isSecureContext: true });
    vi.stubGlobal('navigator', { hid: {} });

    await expect(initLedger({ debug: true })).resolves.toEqual({ ok: true, data: true });
    await expect(initLedger()).resolves.toEqual({ ok: true, data: true });
  });
});
