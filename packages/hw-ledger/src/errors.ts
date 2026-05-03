/**
 * Error normalization.
 *
 * Translates raw Ledger SDK failure shapes into Asylia-friendly
 * `LedgerAdapterError` values. Centralised here so:
 *   - the wallet UI never has to pattern-match on vendor strings,
 *   - new failure modes can be wired in one place,
 *   - copy stays consistent across surfaces (dashboard, modal, vault flow).
 *
 * The mapping preserves a stable adapter code for callers while the logger
 * strips raw vendor payloads from console output.
 *
 * Ledger's failure surface is layered:
 *   1. **Transport-level** errors (`TransportOpenUserCancelled`,
 *      `DisconnectedDevice`, `TransportWebUSBGestureRequired`, …) thrown
 *      while opening / closing / exchanging APDUs.
 *   2. **APDU status words** returned by the device after a successful
 *      transport exchange — each a 16-bit code such as `0x6985`
 *      (user refused), `0x6B0C` (locked), `0x6A82` (app not open), …
 *   3. **Named SDK errors** wrapping (1) and (2) (`LockedDeviceError`,
 *      `UserRefusedOnDevice`, `TransportStatusError`).
 *
 * `fromLedgerError` accepts any value thrown by the transport or the
 * `@ledgerhq/ledger-bitcoin` `AppClient`, inspects its shape, and returns the
 * closest `LedgerErrorCode` with user-facing copy.
 */

import { log } from './log';
import type { LedgerAdapterError, LedgerErrorCode } from './types';

/**
 * Ledger APDU status words that Asylia's wizard has a specific story
 * for. Everything else bubbles up as `unknown`.
 *
 * Reference: `@ledgerhq/errors` `StatusCodes` and the `app-bitcoin-new`
 * status-word catalogue.
 */
const STATUS_WORD_MAP: Record<number, LedgerErrorCode> = {
  // Generic success path — never used for an error mapping, listed
  // only so maintainers know 0x9000 is not an error.
  // 0x9000: 'ok' (not an error; retained as documentation)
  0x5515: 'device_locked',
  0x6b0c: 'device_locked',
  0x6d00: 'app_not_open',
  0x6d02: 'app_not_open',
  0x6511: 'app_not_open',
  0x6a82: 'app_not_open',
  0x6a86: 'app_not_open',
  0x6807: 'wrong_app',
  0x6e00: 'wrong_app',
  0x6984: 'app_outdated',
  0x6985: 'cancelled',
  0x6986: 'cancelled',
  0x6a80: 'invalid_path',
  0x6b00: 'invalid_path',
  0x6a15: 'invalid_path',
  0x6d01: 'firmware_too_old',
  0x6f00: 'unknown',
};

/**
 * Named errors the Ledger transport + SDKs throw at us. We match on
 * `name` rather than `instanceof` so this module can avoid importing
 * `@ledgerhq/errors` at runtime (tree-shaking win + smaller audit
 * surface).
 */
const NAMED_ERROR_MAP: Record<string, LedgerErrorCode> = {
  LockedDeviceError: 'device_locked',
  TransportStatusError: 'unknown', // default; the SDK provides a more specific status word
  TransportOpenUserCancelled: 'cancelled',
  TransportWebUSBGestureRequired: 'gesture_required',
  TransportInterfaceNotAvailable: 'device_in_use',
  TransportRaceCondition: 'device_in_use',
  TransportExchangeTimeoutError: 'device_timeout',
  TimeoutTagged: 'device_timeout',
  DisconnectedDevice: 'device_disconnected',
  DisconnectedDeviceDuringOperation: 'device_disconnected',
  DeviceShouldStayInApp: 'app_not_open',
  DeviceOnDashboardExpected: 'wrong_app',
  BtcUnmatchedApp: 'wrong_app',
  UnresponsiveDeviceError: 'device_timeout',
  UpdateYourApp: 'app_outdated',
  FirmwareOrAppUpdateRequired: 'firmware_too_old',
  UserRefusedOnDevice: 'cancelled',
  UserRefusedAddress: 'cancelled',
  UserRefusedAllowManager: 'cancelled',
  UserRefusedFirmwareUpdate: 'cancelled',
  UserRefusedDeviceNameChange: 'cancelled',
  NotEnoughSpace: 'unknown',
  CantOpenDevice: 'transport_unavailable',
  NetworkError: 'transport_unavailable',
  NetworkDown: 'transport_unavailable',
};

/**
 * Short, actionable copy the wizard renders verbatim. Deliberately kept
 * free of Ledger-specific jargon for codes where no jargon helps the
 * user ("Something went wrong" is still better than the raw
 * `TransportStatusError 0x6f00`).
 */
const MESSAGES: Record<LedgerErrorCode, string> = {
  init_failed:
    'Could not initialise the Ledger connection. Reload the page and try again.',
  cancelled:
    'The request was cancelled on the device. You can retry whenever you are ready.',
  device_disconnected:
    'The Ledger was disconnected before the request finished. Reconnect and try again.',
  device_not_found:
    'No Ledger was detected. Plug the device in and unlock it with your PIN.',
  device_in_use:
    'The Ledger is busy with another request. Close other wallet tabs or Ledger Live before retrying.',
  device_locked:
    'The Ledger is locked. Unlock it with your PIN, then try again.',
  device_timeout:
    'The device did not respond in time. Make sure the Ledger is unlocked and the Bitcoin app is open.',
  app_not_open:
    'Open the Bitcoin app on your Ledger before connecting. The dashboard or a different app is currently active.',
  wrong_app:
    'A different app is open on the Ledger. Quit it and open the Bitcoin app, then try again.',
  wrong_device:
    'This is not the Ledger signer registered on the vault. Connect the matching Ledger and try again.',
  app_outdated:
    'The Bitcoin app on the Ledger is too old. Update it in Ledger Live (minimum version 2.1.0), then retry.',
  firmware_too_old:
    'This Ledger firmware does not support multisig export. Update the device firmware in Ledger Live and try again.',
  descriptor_unavailable:
    'The Ledger could not return the multisig descriptor needed for this flow. Update the Bitcoin app and retry.',
  invalid_path:
    'The derivation path the wallet requested was rejected by the device.',
  transport_unavailable:
    'Could not reach the Ledger. Use a Chromium-based browser with WebHID over USB or Web Bluetooth enabled, then connect the device directly.',
  permission_denied:
    'The browser has no permission to talk to the Ledger. Grant device access when prompted and try again.',
  gesture_required:
    'Your browser requires a user gesture to open the Ledger. Click Connect again to pick the device.',
  unknown: 'Something went wrong while talking to the Ledger.',
};

/**
 * Main entry: build a normalized error from any value thrown by the
 * transport or the `AppClient`. The function is pure (no side effects
 * beyond the `log.error` line) and deterministic — the same input
 * always maps to the same `LedgerAdapterError`.
 */
export function fromLedgerError(
  value: unknown,
  fallback: LedgerErrorCode = 'unknown',
): LedgerAdapterError {
  const shape = inspectError(value);
  const code = pickCode(shape) ?? fallback;
  const error: LedgerAdapterError = {
    code,
    message: MESSAGES[code],
    cause: composeCause(shape),
  };
  log.error('sdk failure normalised', {
    shape,
    normalised: error,
    raw: serializeRaw(value),
  });
  return error;
}

/** Build an explicitly-typed error when we already know the code. */
export function asAdapterError(
  code: LedgerErrorCode,
  cause?: string,
): LedgerAdapterError {
  const error: LedgerAdapterError = { code, message: MESSAGES[code], cause };
  log.error('explicit adapter error', { normalised: error });
  return error;
}

/**
 * Shape the raw thrown value into a uniform record so the rest of the
 * mapping logic can stay small and branchless.
 */
type ErrorShape = {
  name: string | null;
  message: string | null;
  statusCode: number | null;
  statusText: string | null;
};

function inspectError(value: unknown): ErrorShape {
  if (!value || typeof value !== 'object') {
    return {
      name: null,
      message: typeof value === 'string' ? value : null,
      statusCode: null,
      statusText: null,
    };
  }
  const record = value as Record<string, unknown>;
  const name = typeof record.name === 'string' ? record.name : null;
  const message = typeof record.message === 'string' ? record.message : null;
  const statusCode =
    typeof record.statusCode === 'number' ? record.statusCode : null;
  const statusText =
    typeof record.statusText === 'string' ? record.statusText : null;
  return { name, message, statusCode, statusText };
}

function pickCode(shape: ErrorShape): LedgerErrorCode | null {
  // Status-word mapping is the most specific signal; try that first.
  if (shape.statusCode !== null) {
    const fromStatus = STATUS_WORD_MAP[shape.statusCode];
    if (fromStatus) return fromStatus;
  }

  if (shape.name) {
    const fromName = NAMED_ERROR_MAP[shape.name];
    if (fromName) return fromName;
  }

  if (shape.message) {
    const fromMessage = guessFromMessage(shape.message);
    if (fromMessage) return fromMessage;
  }

  return null;
}

/**
 * Some Ledger errors arrive without a status word or a named class.
 * Cover the free-form strings the SDK tends to produce so the user
 * still gets a precise message instead of falling through to
 * "Something went wrong".
 */
function guessFromMessage(message: string): LedgerErrorCode | null {
  const lower = message.toLowerCase();
  if (!lower) return null;
  if (
    lower.includes('no device selected') ||
    lower.includes('no ledger device') ||
    lower.includes('no devices found')
  ) {
    return 'device_not_found';
  }
  if (lower.includes('gesture') || lower.includes('user activation')) {
    return 'gesture_required';
  }
  if (
    lower.includes('already in use') ||
    lower.includes('busy') ||
    lower.includes('race')
  ) {
    return 'device_in_use';
  }
  if (lower.includes('permission') || lower.includes('not allowed')) {
    return 'permission_denied';
  }
  if (
    lower.includes('disconnected') ||
    lower.includes('disconnect') ||
    lower.includes('device unplugged')
  ) {
    return 'device_disconnected';
  }
  if (lower.includes('locked')) {
    return 'device_locked';
  }
  if (
    lower.includes('webusb') ||
    lower.includes('webhid') ||
    lower.includes('bluetooth') ||
    lower.includes('transport')
  ) {
    return 'transport_unavailable';
  }
  if (lower.includes('timeout')) {
    return 'device_timeout';
  }
  if (lower.includes('cancel') || lower.includes('refused')) {
    return 'cancelled';
  }
  if (lower.includes('app not open') || lower.includes('open bitcoin')) {
    return 'app_not_open';
  }
  if (lower.includes('wrong app')) {
    return 'wrong_app';
  }
  return null;
}

function composeCause(shape: ErrorShape): string | undefined {
  const pieces: string[] = [];
  if (shape.name) pieces.push(shape.name);
  if (shape.statusCode !== null) {
    pieces.push(`0x${shape.statusCode.toString(16).padStart(4, '0')}`);
  }
  if (shape.message) pieces.push(shape.message);
  return pieces.join(' — ') || undefined;
}

function serializeRaw(value: unknown): unknown {
  if (!value) return value;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }
  return value;
}
