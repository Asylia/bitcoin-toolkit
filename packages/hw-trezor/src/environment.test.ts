import { describe, expect, it } from 'vitest';

import { recommendationFromEnvironment } from './environment';

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
});
