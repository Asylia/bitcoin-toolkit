import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  openConnected: vi.fn(),
  request: vi.fn(),
}));

vi.mock('@ledgerhq/hw-transport-webhid', () => ({
  default: mocks,
}));

import {
  _LEDGER_USB_VENDOR_ID_FOR_TESTS,
  closeLedgerTransport,
  findAuthorisedLedgerDevice,
  friendlyProductName,
  openLedgerTransport,
  transportHidInfo,
} from './transport';

describe('Ledger WebHID transport', () => {
  beforeEach(() => {
    mocks.openConnected.mockReset();
    mocks.request.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('finds only previously authorised Ledger HID devices', async () => {
    const ledger = hidDevice({
      productName: 'Ledger Nano X',
      vendorId: _LEDGER_USB_VENDOR_ID_FOR_TESTS,
      productId: 0x4000,
    });
    vi.stubGlobal('navigator', {
      hid: {
        getDevices: vi.fn(async () => [
          hidDevice({ productName: 'Keyboard', vendorId: 0x1234, productId: 1 }),
          ledger,
        ]),
      },
    });

    await expect(findAuthorisedLedgerDevice()).resolves.toBe(ledger);
  });

  it('treats Permissions-Policy getDevices failures as no authorised device', async () => {
    vi.stubGlobal('navigator', {
      hid: {
        getDevices: vi.fn(async () => {
          throw new Error('Permissions policy blocks HID in this frame');
        }),
      },
    });

    await expect(findAuthorisedLedgerDevice()).resolves.toBeNull();
  });

  it('returns a normalized error when WebHID is unavailable', async () => {
    vi.stubGlobal('navigator', {});

    await expect(openLedgerTransport()).resolves.toMatchObject({
      ok: false,
      error: { code: 'transport_unavailable' },
    });
  });

  it('opens an existing grant before showing the picker', async () => {
    vi.stubGlobal('navigator', { hid: {} });
    const transport = {
      device: hidDevice({
        productName: 'Ledger Nano S Plus',
        vendorId: _LEDGER_USB_VENDOR_ID_FOR_TESTS,
        productId: 0x5000,
      }),
      close: vi.fn(),
    };
    mocks.openConnected.mockResolvedValueOnce(transport);

    await expect(openLedgerTransport()).resolves.toEqual({ ok: true, data: transport });
    expect(mocks.request).not.toHaveBeenCalled();
    expect(transportHidInfo(transport as never)).toMatchObject({
      productName: 'Ledger Nano S Plus',
      vendorId: _LEDGER_USB_VENDOR_ID_FOR_TESTS,
    });
    expect(friendlyProductName(transportHidInfo(transport as never))).toBe('Ledger Nano S Plus');
  });

  it('maps Permissions-Policy open failures without falling through to request()', async () => {
    vi.stubGlobal('navigator', { hid: {} });
    mocks.openConnected.mockRejectedValueOnce(new Error('Permissions Policy blocks hid'));

    await expect(openLedgerTransport()).resolves.toMatchObject({
      ok: false,
      error: { code: 'permission_denied' },
    });
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it('closes transports and swallows secondary close failures', async () => {
    const close = vi.fn(async () => {
      throw new Error('already closed');
    });

    await expect(closeLedgerTransport({ close } as never)).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(1);
  });
});

function hidDevice(input: {
  productName: string
  vendorId: number
  productId: number
}): HIDDevice {
  return input as HIDDevice;
}
