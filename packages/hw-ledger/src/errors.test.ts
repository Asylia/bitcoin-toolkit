import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { asAdapterError, fromLedgerError } from './errors';

describe('Ledger error normalisation', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it('maps status words before generic SDK names', () => {
    const error = fromLedgerError({
      name: 'TransportStatusError',
      statusCode: 0x6985,
      message: 'Condition of use not satisfied',
    });

    expect(error).toMatchObject({
      code: 'cancelled',
      cause: 'TransportStatusError — 0x6985 — Condition of use not satisfied',
    });
  });

  it('maps browser gesture failures to actionable copy', () => {
    expect(
      fromLedgerError({
        name: 'TransportWebUSBGestureRequired',
        message: 'user gesture required',
      }),
    ).toMatchObject({
      code: 'gesture_required',
    });
  });

  it('builds explicit typed adapter errors', () => {
    expect(asAdapterError('wrong_device', 'expected deadbeef')).toMatchObject({
      code: 'wrong_device',
      cause: 'expected deadbeef',
    });
  });
});
