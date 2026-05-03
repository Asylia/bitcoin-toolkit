import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (event: unknown) => void;

const sdkMock = vi.hoisted(() => {
  const listeners = new Map<string, Set<Listener>>();
  return {
    listeners,
    on: vi.fn((type: string, listener: Listener) => {
      const bucket = listeners.get(type) ?? new Set<Listener>();
      bucket.add(listener);
      listeners.set(type, bucket);
    }),
    off: vi.fn((type: string, listener: Listener) => {
      listeners.get(type)?.delete(listener);
    }),
    emit: (type: string, event: unknown) => {
      for (const listener of listeners.get(type) ?? []) {
        listener(event);
      }
    },
  };
});

const logMock = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('./sdk', () => ({
  TrezorConnect: {
    on: sdkMock.on,
    off: sdkMock.off,
  },
}));

vi.mock('./log', () => ({ log: logMock }));

import { subscribeToTrezorEvents } from './events';

describe('Trezor live events', () => {
  beforeEach(() => {
    sdkMock.listeners.clear();
    sdkMock.on.mockClear();
    sdkMock.off.mockClear();
    logMock.info.mockClear();
    logMock.warn.mockClear();
    logMock.error.mockClear();
  });

  afterEach(() => {
    sdkMock.listeners.clear();
  });

  it('registers and removes device, transport, and UI listeners idempotently', () => {
    const unsubscribe = subscribeToTrezorEvents(vi.fn());

    expect(sdkMock.on).toHaveBeenCalledWith('DEVICE_EVENT', expect.any(Function));
    expect(sdkMock.on).toHaveBeenCalledWith('TRANSPORT_EVENT', expect.any(Function));
    expect(sdkMock.on).toHaveBeenCalledWith('UI_EVENT', expect.any(Function));

    unsubscribe();
    unsubscribe();

    expect(sdkMock.off).toHaveBeenCalledTimes(3);
    expect(sdkMock.off).toHaveBeenCalledWith('DEVICE_EVENT', expect.any(Function));
    expect(sdkMock.off).toHaveBeenCalledWith('TRANSPORT_EVENT', expect.any(Function));
    expect(sdkMock.off).toHaveBeenCalledWith('UI_EVENT', expect.any(Function));
  });

  it('normalises device and transport events into the wallet event vocabulary', () => {
    const handler = vi.fn();
    const unsubscribe = subscribeToTrezorEvents(handler);
    const device = {
      label: '  Vault signer  ',
      features: {
        internal_model: 'T3T1',
        major_version: 2,
        minor_version: 7,
        patch_version: 1,
      },
    };

    sdkMock.emit('DEVICE_EVENT', { type: 'device-connect', payload: device });
    sdkMock.emit('DEVICE_EVENT', {
      type: 'button',
      payload: {
        code: 'ButtonRequest_PublicKey',
        device,
      },
    });
    sdkMock.emit('TRANSPORT_EVENT', {
      type: 'transport-start',
      payload: { type: 'BridgeTransport', version: '3.0.0' },
    });
    sdkMock.emit('TRANSPORT_EVENT', {
      type: 'transport-error',
      payload: { error: 'Bridge unavailable' },
    });

    expect(handler).toHaveBeenNthCalledWith(1, {
      phase: 'device_connected',
      device: {
        label: 'Vault signer',
        model: 'Trezor Safe 5',
        internalModel: 'T3T1',
        firmware: '2.7.1',
      },
    });
    expect(handler).toHaveBeenNthCalledWith(2, {
      phase: 'awaiting_button',
      device: {
        label: 'Vault signer',
        model: 'Trezor Safe 5',
        internalModel: 'T3T1',
        firmware: '2.7.1',
      },
      buttonCode: 'ButtonRequest_PublicKey',
    });
    expect(handler).toHaveBeenNthCalledWith(3, {
      phase: 'transport_started',
      transportType: 'BridgeTransport',
      transportVersion: '3.0.0',
    });
    expect(handler).toHaveBeenNthCalledWith(4, {
      phase: 'transport_error',
      message: 'Bridge unavailable',
    });

    unsubscribe();
  });

  it('normalises UI prompts and tolerates sparse device descriptors', () => {
    const handler = vi.fn();
    const unsubscribe = subscribeToTrezorEvents(handler);

    sdkMock.emit('UI_EVENT', {
      type: 'ui-request_permission',
      payload: { device: { features: { internal_model: 'T9X9' } } },
    });
    sdkMock.emit('UI_EVENT', { type: 'ui-request_pin', payload: {} });
    sdkMock.emit('UI_EVENT', { type: 'ui-request_passphrase', payload: {} });
    sdkMock.emit('UI_EVENT', { type: 'ui-request_passphrase_on_device', payload: {} });
    sdkMock.emit('UI_EVENT', {
      type: 'ui-button',
      payload: { code: 'ButtonRequest_Address' },
    });

    expect(handler).toHaveBeenNthCalledWith(1, {
      phase: 'awaiting_permission',
      device: {
        label: null,
        model: 'Trezor',
        internalModel: 'T9X9',
        firmware: null,
      },
    });
    expect(handler).toHaveBeenNthCalledWith(2, {
      phase: 'awaiting_pin',
      device: null,
    });
    expect(handler).toHaveBeenNthCalledWith(3, {
      phase: 'awaiting_passphrase',
      device: null,
    });
    expect(handler).toHaveBeenNthCalledWith(4, {
      phase: 'awaiting_passphrase_on_device',
      device: null,
    });
    expect(handler).toHaveBeenNthCalledWith(5, {
      phase: 'awaiting_button',
      device: null,
      buttonCode: 'ButtonRequest_Address',
    });

    unsubscribe();
  });

  it('swallows handler failures and ignores malformed SDK events', () => {
    const handler = vi.fn(() => {
      throw new Error('component unmounted mid-event');
    });
    const unsubscribe = subscribeToTrezorEvents(handler);

    expect(() => {
      sdkMock.emit('DEVICE_EVENT', null);
      sdkMock.emit('DEVICE_EVENT', { type: '' });
      sdkMock.emit('DEVICE_EVENT', { type: 'device-disconnect', payload: null });
    }).not.toThrow();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(logMock.error).toHaveBeenCalledWith(
      'event handler threw — swallowed to keep wire alive',
      expect.objectContaining({ phase: 'device_disconnected' }),
    );

    unsubscribe();
  });
});
