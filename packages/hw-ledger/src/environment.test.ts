import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findAuthorisedLedgerDevice: vi.fn(),
}));

vi.mock('./transport', () => ({
  findAuthorisedLedgerDevice: mocks.findAuthorisedLedgerDevice,
}));

import { detectLedgerEnvironment, recommendationFromEnvironment } from './environment';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('recommendationFromEnvironment', () => {
  it('marks an authorised WebHID Ledger as ready', () => {
    expect(
      recommendationFromEnvironment({
        webHidAvailable: true,
        browserFamily: 'chromium',
        previouslyAuthorised: true,
      }),
    ).toMatchObject({
      mode: 'ready_authorised',
      actionHint: 'Unlock the device and open the Bitcoin app.',
    });
  });

  it('routes unsupported browsers to install/switch guidance', () => {
    expect(
      recommendationFromEnvironment({
        webHidAvailable: false,
        browserFamily: 'safari',
        previouslyAuthorised: false,
      }),
    ).toMatchObject({
      mode: 'blocked_install_required',
      headline: 'Safari cannot talk to a Ledger',
    });
  });

  it('detects authorised Chromium WebHID environments', async () => {
    mocks.findAuthorisedLedgerDevice.mockResolvedValue({ productId: 0x5000 });
    vi.stubGlobal('window', { isSecureContext: true });
    vi.stubGlobal('navigator', {
      hid: {},
      userAgent: 'Mozilla/5.0 Chrome/124.0.0.0 Safari/537.36',
    });

    await expect(detectLedgerEnvironment()).resolves.toMatchObject({
      webHidAvailable: true,
      browserFamily: 'chromium',
      previouslyAuthorised: true,
      canReachDevice: true,
      recommendation: { mode: 'ready_authorised' },
    });
  });

  it('treats Permissions-Policy blocked WebHID as unavailable', async () => {
    const allowsFeature = vi.fn((feature: string) => feature !== 'hid');
    vi.stubGlobal('window', { isSecureContext: true });
    vi.stubGlobal('document', {
      permissionsPolicy: { allowsFeature },
    });
    vi.stubGlobal('navigator', {
      hid: {},
      userAgent: 'Mozilla/5.0 Chrome/124.0.0.0 Safari/537.36',
    });

    await expect(detectLedgerEnvironment()).resolves.toMatchObject({
      webHidAvailable: false,
      browserFamily: 'chromium',
      previouslyAuthorised: false,
      canReachDevice: false,
      recommendation: { mode: 'blocked_install_required' },
    });
    expect(allowsFeature).toHaveBeenCalledWith('hid');
    expect(mocks.findAuthorisedLedgerDevice).not.toHaveBeenCalled();
  });

  it('blocks insecure or unsupported browser contexts without probing devices', async () => {
    vi.stubGlobal('window', { isSecureContext: false });
    vi.stubGlobal('navigator', {
      hid: {},
      userAgent: 'Mozilla/5.0 Firefox/125.0',
    });

    await expect(detectLedgerEnvironment()).resolves.toMatchObject({
      webHidAvailable: false,
      browserFamily: 'firefox',
      previouslyAuthorised: false,
      canReachDevice: false,
      recommendation: { mode: 'blocked_install_required' },
    });
    expect(mocks.findAuthorisedLedgerDevice).not.toHaveBeenCalled();
  });
});
