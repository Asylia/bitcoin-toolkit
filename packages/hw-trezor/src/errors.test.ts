import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { asAdapterError, fromTrezorFailure, fromUnknown } from './errors';

describe('Trezor error normalisation', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it('maps SDK failure codes to wallet-facing adapter errors', () => {
    expect(
      fromTrezorFailure({
        payload: {
          code: 'Device_Disconnected',
          error: 'Device disconnected during action',
        },
      }),
    ).toMatchObject({
      code: 'device_disconnected',
      cause: 'Device_Disconnected: Device disconnected during action',
    });
  });

  it('infers common transport errors from thrown messages', () => {
    expect(fromUnknown(new Error('transport is not available'))).toMatchObject({
      code: 'transport_unavailable',
    });
  });

  it('infers failure codes from messages when the SDK omits a code', () => {
    expect(fromTrezorFailure({ payload: { error: 'manifest is missing' } })).toMatchObject({
      code: 'manifest_required',
    });
    expect(fromTrezorFailure({ payload: { error: 'iframe not initialized' } })).toMatchObject({
      code: 'init_failed',
    });
    expect(fromTrezorFailure({ payload: { error: 'firmware too old' } })).toMatchObject({
      code: 'firmware_too_old',
    });
    expect(fromTrezorFailure({ payload: { error: 'Forbidden key path' } })).toMatchObject({
      code: 'message_signing_forbidden_path',
    });
    expect(fromTrezorFailure({ payload: { error: 'Invalid multisig parameters' } })).toMatchObject({
      code: 'invalid_multisig',
    });
  });

  it('infers device-specific thrown errors from free-form messages', () => {
    expect(fromUnknown('device disconnected')).toMatchObject({ code: 'device_disconnected' });
    expect(fromUnknown('device not found')).toMatchObject({ code: 'device_not_found' });
    expect(fromUnknown('device used in another session')).toMatchObject({
      code: 'device_in_use',
    });
  });

  it('builds explicit typed adapter errors', () => {
    expect(asAdapterError('invalid_path', "m/48'/0'")).toMatchObject({
      code: 'invalid_path',
      cause: "m/48'/0'",
    });
  });
});
