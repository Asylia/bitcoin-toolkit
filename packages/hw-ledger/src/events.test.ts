import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const logMock = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('./log', () => ({ log: logMock }));

import { emitSyntheticLedgerEvent, subscribeToLedgerEvents } from './events';

describe('Ledger live events', () => {
  beforeEach(() => {
    logMock.info.mockClear();
    logMock.warn.mockClear();
    logMock.error.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('broadcasts synthetic events to active subscribers only', () => {
    const handler = vi.fn();

    emitSyntheticLedgerEvent({ phase: 'finalising', message: 'closing transport' });

    expect(handler).not.toHaveBeenCalled();

    const unsubscribe = subscribeToLedgerEvents(handler);

    emitSyntheticLedgerEvent({ phase: 'finalising', message: 'closing transport' });
    unsubscribe();
    unsubscribe();
    emitSyntheticLedgerEvent({ phase: 'finalising', message: 'ignored' });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({
      phase: 'finalising',
      message: 'closing transport',
    });
  });

  it('installs WebHID listeners and forwards Ledger connect/disconnect events', () => {
    const hid = hidEventTarget();
    const handler = vi.fn();

    vi.stubGlobal('navigator', { hid });

    const unsubscribe = subscribeToLedgerEvents(handler);

    expect(hid.addEventListener).toHaveBeenCalledWith('connect', expect.any(Function));
    expect(hid.addEventListener).toHaveBeenCalledWith('disconnect', expect.any(Function));

    hid.emit('connect', {
      vendorId: 0x2c97,
      productId: 0x5001,
      productName: 'Ledger Nano S Plus',
    });
    hid.emit('disconnect', {
      vendorId: 0x1234,
      productId: 0x4001,
      productName: 'Keyboard',
    });
    hid.emit('disconnect', {
      vendorId: 0x2c97,
      productId: 0x4001,
      productName: 'Ledger Nano X',
    });

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenNthCalledWith(1, {
      phase: 'device_connected',
      device: {
        productName: 'Ledger Nano S Plus',
        model: 'Ledger Nano S Plus',
        vendorId: 0x2c97,
        productId: 0x5001,
      },
    });
    expect(handler).toHaveBeenNthCalledWith(2, {
      phase: 'device_disconnected',
      device: {
        productName: 'Ledger Nano X',
        model: 'Ledger Nano X',
        vendorId: 0x2c97,
        productId: 0x4001,
      },
    });

    unsubscribe();

    expect(hid.removeEventListener).toHaveBeenCalledWith('connect', expect.any(Function));
    expect(hid.removeEventListener).toHaveBeenCalledWith('disconnect', expect.any(Function));
  });

  it('contains throwing subscribers so later listeners still receive events', () => {
    const throwingHandler = vi.fn(() => {
      throw new Error('render crashed');
    });
    const healthyHandler = vi.fn();
    const firstUnsubscribe = subscribeToLedgerEvents(throwingHandler);
    const secondUnsubscribe = subscribeToLedgerEvents(healthyHandler);

    emitSyntheticLedgerEvent({ phase: 'awaiting_button', intent: 'Confirm export' });

    expect(throwingHandler).toHaveBeenCalledTimes(1);
    expect(healthyHandler).toHaveBeenCalledWith({
      phase: 'awaiting_button',
      intent: 'Confirm export',
    });
    expect(logMock.error).toHaveBeenCalledWith(
      'event handler threw — swallowed to keep wire alive',
      expect.objectContaining({ phase: 'awaiting_button' }),
    );

    firstUnsubscribe();
    secondUnsubscribe();
  });

  it('logs missing or throwing HID listener setup without breaking subscriptions', () => {
    const missingHandler = vi.fn();

    const missingUnsubscribe = subscribeToLedgerEvents(missingHandler);
    missingUnsubscribe();

    expect(logMock.warn).toHaveBeenCalledWith(
      'cannot install hid listeners — navigator.hid missing',
    );

    vi.stubGlobal('navigator', {
      hid: {
        addEventListener: vi.fn(() => {
          throw new Error('policy blocked');
        }),
        removeEventListener: vi.fn(),
      },
    });

    const failingUnsubscribe = subscribeToLedgerEvents(vi.fn());
    failingUnsubscribe();

    expect(logMock.error).toHaveBeenCalledWith(
      'failed to install hid listeners',
      expect.objectContaining({ error: 'policy blocked' }),
    );
  });

  it('does not warn in pure Web Bluetooth contexts without HID globals', () => {
    vi.stubGlobal('navigator', { bluetooth: {} });

    const unsubscribe = subscribeToLedgerEvents(vi.fn());
    unsubscribe();

    expect(logMock.info).toHaveBeenCalledWith(
      'hid listeners skipped — Web Bluetooth has no global connect stream',
    );
    expect(logMock.warn).not.toHaveBeenCalledWith(
      'cannot install hid listeners — navigator.hid missing',
    );
  });
});

type HidEventName = 'connect' | 'disconnect';
type HidDeviceMock = Pick<HIDDevice, 'vendorId' | 'productId' | 'productName'>;

function hidEventTarget(): {
  addEventListener: ReturnType<typeof vi.fn>
  removeEventListener: ReturnType<typeof vi.fn>
  emit: (type: HidEventName, device: HidDeviceMock) => void
} {
  const listeners = new Map<HidEventName, (event: HIDConnectionEvent) => void>();

  return {
    addEventListener: vi.fn((type: HidEventName, listener: (event: HIDConnectionEvent) => void) => {
      listeners.set(type, listener);
    }),
    removeEventListener: vi.fn((type: HidEventName) => {
      listeners.delete(type);
    }),
    emit: (type: HidEventName, device: HidDeviceMock) => {
      listeners.get(type)?.({ device } as unknown as HIDConnectionEvent);
    },
  };
}
