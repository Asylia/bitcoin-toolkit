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

  it('builds explicit typed adapter errors', () => {
    expect(asAdapterError('invalid_path', "m/48'/0'")).toMatchObject({
      code: 'invalid_path',
      cause: "m/48'/0'",
    });
  });
});
