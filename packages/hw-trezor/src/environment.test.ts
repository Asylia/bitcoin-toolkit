import { afterEach, describe, expect, it, vi } from 'vitest';

import { detectTrezorEnvironment, recommendationFromEnvironment } from './environment';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('recommendationFromEnvironment', () => {
  it('prefers Suite guidance when the local service looks Suite-backed', () => {
    expect(
      recommendationFromEnvironment({
        bridgePresent: true,
        bridgeVersion: '2.0.32',
        suiteLikely: true,
        webUsbAvailable: false,
        browserFamily: 'chromium',
      }),
    ).toMatchObject({
      mode: 'suite',
      headline: 'Trezor transport is already available',
    });
  });

  it('falls back to WebUSB popup guidance when Bridge is absent but WebUSB exists', () => {
    expect(
      recommendationFromEnvironment({
        bridgePresent: false,
        bridgeVersion: null,
        suiteLikely: null,
        webUsbAvailable: true,
        browserFamily: 'chromium',
      }),
    ).toMatchObject({
      mode: 'webusb_popup',
      headline: 'A Trezor popup will pair the device',
    });
  });

  it('treats Permissions-Policy blocked WebUSB as unavailable', async () => {
    const allowsFeature = vi.fn((feature: string) => feature !== 'usb');
    vi.stubGlobal('document', {
      permissionsPolicy: { allowsFeature },
    });
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('connection refused');
    }));
    vi.stubGlobal('navigator', {
      usb: {},
      userAgent: 'Mozilla/5.0 Chrome/124.0.0.0 Safari/537.36',
    });

    await expect(detectTrezorEnvironment()).resolves.toMatchObject({
      bridgePresent: false,
      webUsbAvailable: false,
      browserFamily: 'chromium',
      canReachDevice: false,
      recommendation: { mode: 'blocked_install_required' },
    });
    expect(allowsFeature).toHaveBeenCalledWith('usb');
  });

  it('marks Safari without Bridge or WebUSB as blocked', () => {
    expect(
      recommendationFromEnvironment({
        bridgePresent: false,
        bridgeVersion: null,
        suiteLikely: null,
        webUsbAvailable: false,
        browserFamily: 'safari',
      }),
    ).toMatchObject({
      mode: 'blocked_install_required',
      headline: 'Safari cannot talk to Trezor directly',
    });
  });

  it('detects Suite-backed Bridge responses', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({
        version: '2.0.32',
        runningInSuite: true,
      })),
    );
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('navigator', {
      usb: {},
      userAgent: 'Mozilla/5.0 Chrome/124.0.0.0 Safari/537.36',
    });

    await expect(detectTrezorEnvironment()).resolves.toMatchObject({
      bridgePresent: true,
      bridgeVersion: '2.0.32',
      suiteLikely: true,
      webUsbAvailable: true,
      browserFamily: 'chromium',
      canReachDevice: true,
      recommendation: { mode: 'suite' },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:21325/',
      expect.objectContaining({ method: 'GET', cache: 'no-store' }),
    );
  });

  it('falls back when Bridge probing fails and WebUSB is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('connection refused');
    }));
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 Firefox/125.0',
    });

    await expect(detectTrezorEnvironment()).resolves.toMatchObject({
      bridgePresent: false,
      bridgeVersion: null,
      suiteLikely: null,
      webUsbAvailable: false,
      browserFamily: 'firefox',
      canReachDevice: false,
      recommendation: { mode: 'blocked_install_required' },
    });
  });
});
