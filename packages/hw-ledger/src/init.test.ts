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

  it('requires at least one browser Ledger transport in supported browser contexts', async () => {
    vi.stubGlobal('window', { isSecureContext: true });
    vi.stubGlobal('navigator', {});

    await expect(initLedger()).resolves.toMatchObject({
      ok: false,
      error: { code: 'transport_unavailable' },
    });
  });

  it('accepts pure Web Bluetooth contexts', async () => {
    vi.stubGlobal('window', { isSecureContext: true });
    vi.stubGlobal('navigator', { bluetooth: {} });

    await expect(initLedger({ transport: 'webble' })).resolves.toEqual({ ok: true, data: true });
  });

  it('blocks explicit transport requests when that channel is unavailable', async () => {
    vi.stubGlobal('window', { isSecureContext: true });
    vi.stubGlobal('navigator', { bluetooth: {} });

    await expect(initLedger({ transport: 'webhid' })).resolves.toMatchObject({
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
