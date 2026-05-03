import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  hidOpenConnected: vi.fn(),
  hidRequest: vi.fn(),
  bleListen: vi.fn(),
  bleOpen: vi.fn(),
}));

vi.mock('@ledgerhq/hw-transport-webhid', () => ({
  default: {
    openConnected: mocks.hidOpenConnected,
    request: mocks.hidRequest,
  },
}));

vi.mock('@ledgerhq/hw-transport-web-ble', () => ({
  default: {
    listen: mocks.bleListen,
    open: mocks.bleOpen,
  },
}));

import {
  _LEDGER_USB_VENDOR_ID_FOR_TESTS,
  closeLedgerTransport,
  findAuthorisedLedgerBluetoothDevice,
  findAuthorisedLedgerDevice,
  friendlyProductName,
  openLedgerTransport,
  transportDeviceInfo,
  transportHidInfo,
} from './transport';

describe('Ledger WebHID transport', () => {
  beforeEach(() => {
    mocks.hidOpenConnected.mockReset();
    mocks.hidRequest.mockReset();
    mocks.bleListen.mockReset();
    mocks.bleOpen.mockReset();
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
    mocks.hidOpenConnected.mockResolvedValueOnce(transport);

    await expect(openLedgerTransport()).resolves.toEqual({ ok: true, data: transport });
    expect(mocks.hidRequest).not.toHaveBeenCalled();
    expect(transportHidInfo(transport as never)).toMatchObject({
      productName: 'Ledger Nano S Plus',
      vendorId: _LEDGER_USB_VENDOR_ID_FOR_TESTS,
    });
    expect(friendlyProductName(transportHidInfo(transport as never))).toBe('Ledger Nano S Plus');
  });

  it('maps Permissions-Policy open failures without falling through to request()', async () => {
    vi.stubGlobal('navigator', { hid: {} });
    mocks.hidOpenConnected.mockRejectedValueOnce(new Error('Permissions Policy blocks hid'));

    await expect(openLedgerTransport()).resolves.toMatchObject({
      ok: false,
      error: { code: 'permission_denied' },
    });
    expect(mocks.hidRequest).not.toHaveBeenCalled();
  });

  it('finds previously authorised Bluetooth Ledgers by browser grant', async () => {
    const ledger = bluetoothDevice({ id: 'ble-1', name: 'Ledger Nano X' });
    vi.stubGlobal('navigator', {
      bluetooth: {
        getDevices: vi.fn(async () => [
          bluetoothDevice({ id: 'speaker-1', name: 'Kitchen speaker' }),
          ledger,
        ]),
      },
    });

    await expect(findAuthorisedLedgerBluetoothDevice()).resolves.toBe(ledger);
  });

  it('opens a pure Web Bluetooth transport when WebHID is unavailable', async () => {
    const device = bluetoothDevice({ id: 'ble-1', name: 'Ledger Nano X' });
    const transport = {
      device,
      deviceModel: { productName: 'Ledger Nano X' },
      close: vi.fn(),
    };
    vi.stubGlobal('navigator', { bluetooth: {} });
    mocks.bleListen.mockImplementationOnce((observer) => {
      observer.next({ type: 'add', descriptor: device });
      observer.complete();
      return { unsubscribe: vi.fn() };
    });
    mocks.bleOpen.mockResolvedValueOnce(transport);

    await expect(openLedgerTransport({ transport: 'webble' })).resolves.toEqual({
      ok: true,
      data: transport,
    });
    expect(mocks.bleListen).toHaveBeenCalledTimes(1);
    expect(mocks.bleOpen).toHaveBeenCalledWith(device);
    expect(transportDeviceInfo(transport as never)).toMatchObject({
      channel: 'webble',
      model: 'Ledger Nano X',
      productId: null,
    });
  });

  it('reuses an authorised Bluetooth grant in auto mode before opening a picker', async () => {
    const device = bluetoothDevice({ id: 'ble-1', name: 'Ledger Stax' });
    const transport = {
      device,
      deviceModel: { productName: 'Ledger Stax' },
      close: vi.fn(),
    };
    vi.stubGlobal('navigator', {
      hid: {
        getDevices: vi.fn(async () => []),
      },
      bluetooth: {
        getDevices: vi.fn(async () => [device]),
      },
    });
    mocks.bleOpen.mockResolvedValueOnce(transport);

    await expect(openLedgerTransport()).resolves.toEqual({
      ok: true,
      data: transport,
    });
    expect(mocks.hidOpenConnected).not.toHaveBeenCalled();
    expect(mocks.hidRequest).not.toHaveBeenCalled();
    expect(mocks.bleListen).not.toHaveBeenCalled();
    expect(mocks.bleOpen).toHaveBeenCalledWith(device);
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

function bluetoothDevice(input: {
  id: string
  name: string
}): BluetoothDevice {
  return input as BluetoothDevice;
}
