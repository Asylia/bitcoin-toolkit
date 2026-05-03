import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findAuthorisedLedgerBluetoothDevice: vi.fn(),
  findAuthorisedLedgerDevice: vi.fn(),
}));

vi.mock('./transport', () => ({
  findAuthorisedLedgerBluetoothDevice: mocks.findAuthorisedLedgerBluetoothDevice,
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
        webBluetoothAvailable: false,
        availableTransports: ['webhid'],
        recommendedTransport: 'webhid',
        browserFamily: 'chromium',
        previouslyAuthorised: true,
        previouslyAuthorisedTransport: 'webhid',
      }),
    ).toMatchObject({
      mode: 'ready_authorised',
      transport: 'webhid',
      actionHint: 'Unlock the device and open the Bitcoin app.',
    });
  });

  it('recommends Bluetooth when that is the only available transport', () => {
    expect(
      recommendationFromEnvironment({
        webHidAvailable: false,
        webBluetoothAvailable: true,
        availableTransports: ['webble'],
        recommendedTransport: 'webble',
        browserFamily: 'chromium',
        previouslyAuthorised: false,
        previouslyAuthorisedTransport: null,
      }),
    ).toMatchObject({
      mode: 'ready_picker',
      transport: 'webble',
      body: expect.stringContaining('Bluetooth'),
    });
  });

  it('routes unsupported browsers to install/switch guidance', () => {
    expect(
      recommendationFromEnvironment({
        webHidAvailable: false,
        webBluetoothAvailable: false,
        availableTransports: [],
        recommendedTransport: null,
        browserFamily: 'safari',
        previouslyAuthorised: false,
        previouslyAuthorisedTransport: null,
      }),
    ).toMatchObject({
      mode: 'blocked_install_required',
      headline: 'Safari cannot talk to a Ledger',
    });
  });

  it('detects authorised Chromium WebHID environments', async () => {
    mocks.findAuthorisedLedgerDevice.mockResolvedValue({ productId: 0x5000 });
    mocks.findAuthorisedLedgerBluetoothDevice.mockResolvedValue(null);
    vi.stubGlobal('window', { isSecureContext: true });
    vi.stubGlobal('navigator', {
      hid: {},
      userAgent: 'Mozilla/5.0 Chrome/124.0.0.0 Safari/537.36',
    });

    await expect(detectLedgerEnvironment()).resolves.toMatchObject({
      webHidAvailable: true,
      webBluetoothAvailable: false,
      availableTransports: ['webhid'],
      recommendedTransport: 'webhid',
      browserFamily: 'chromium',
      previouslyAuthorised: true,
      previouslyAuthorisedTransport: 'webhid',
      canReachDevice: true,
      recommendation: { mode: 'ready_authorised' },
    });
  });

  it('detects pure Bluetooth environments without touching WebHID', async () => {
    mocks.findAuthorisedLedgerBluetoothDevice.mockResolvedValue({ id: 'ble-1' });
    vi.stubGlobal('window', { isSecureContext: true });
    vi.stubGlobal('navigator', {
      bluetooth: {
        getAvailability: vi.fn(async () => true),
      },
      userAgent: 'Mozilla/5.0 Chrome/124.0.0.0 Safari/537.36',
    });

    await expect(detectLedgerEnvironment()).resolves.toMatchObject({
      webHidAvailable: false,
      webBluetoothAvailable: true,
      availableTransports: ['webble'],
      recommendedTransport: 'webble',
      browserFamily: 'chromium',
      previouslyAuthorised: true,
      previouslyAuthorisedTransport: 'webble',
      canReachDevice: true,
      recommendation: { mode: 'ready_authorised', transport: 'webble' },
    });
    expect(mocks.findAuthorisedLedgerDevice).not.toHaveBeenCalled();
  });

  it('treats Permissions-Policy blocked transports as unavailable', async () => {
    const allowsFeature = vi.fn((feature: string) => feature !== 'hid' && feature !== 'bluetooth');
    vi.stubGlobal('window', { isSecureContext: true });
    vi.stubGlobal('document', {
      permissionsPolicy: { allowsFeature },
    });
    vi.stubGlobal('navigator', {
      hid: {},
      bluetooth: {
        getAvailability: vi.fn(async () => true),
      },
      userAgent: 'Mozilla/5.0 Chrome/124.0.0.0 Safari/537.36',
    });

    await expect(detectLedgerEnvironment()).resolves.toMatchObject({
      webHidAvailable: false,
      webBluetoothAvailable: false,
      availableTransports: [],
      recommendedTransport: null,
      browserFamily: 'chromium',
      previouslyAuthorised: false,
      previouslyAuthorisedTransport: null,
      canReachDevice: false,
      recommendation: { mode: 'blocked_install_required' },
    });
    expect(allowsFeature).toHaveBeenCalledWith('hid');
    expect(allowsFeature).toHaveBeenCalledWith('bluetooth');
    expect(mocks.findAuthorisedLedgerDevice).not.toHaveBeenCalled();
    expect(mocks.findAuthorisedLedgerBluetoothDevice).not.toHaveBeenCalled();
  });

  it('blocks insecure or unsupported browser contexts without probing devices', async () => {
    vi.stubGlobal('window', { isSecureContext: false });
    vi.stubGlobal('navigator', {
      hid: {},
      userAgent: 'Mozilla/5.0 Firefox/125.0',
    });

    await expect(detectLedgerEnvironment()).resolves.toMatchObject({
      webHidAvailable: false,
      webBluetoothAvailable: false,
      availableTransports: [],
      recommendedTransport: null,
      browserFamily: 'firefox',
      previouslyAuthorised: false,
      previouslyAuthorisedTransport: null,
      canReachDevice: false,
      recommendation: { mode: 'blocked_install_required' },
    });
    expect(mocks.findAuthorisedLedgerDevice).not.toHaveBeenCalled();
    expect(mocks.findAuthorisedLedgerBluetoothDevice).not.toHaveBeenCalled();
  });
});
