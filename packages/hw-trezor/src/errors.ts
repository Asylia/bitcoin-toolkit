/**
 * Error normalization.
 *
 * Translates raw Trezor Connect failure shapes into Asylia-friendly
 * `TrezorAdapterError` values. Centralised here so:
 *   - the wallet UI never has to pattern-match on vendor strings,
 *   - new failure modes can be wired in one place,
 *   - copy stays consistent across surfaces (dashboard, modal, vault flow).
 *
 * The mapping preserves a stable adapter code for callers while the logger
 * strips raw vendor payloads from console output.
 */

import { log } from './log';
import type { TrezorAdapterError, TrezorErrorCode } from './types';

/**
 * Minimal shape of an Unsuccessful Trezor Connect response. We deliberately
 * avoid importing `Unsuccessful` from the SDK so this module can be tree-
 * shaken away from places that never see one (e.g. tests).
 */
export type RawTrezorFailure = {
  payload?: { error?: string; code?: string };
};

const CODE_MAP: Partial<Record<string, TrezorErrorCode>> = {
  Init_NotInitialized: 'init_failed',
  Init_AlreadyInitialized: 'init_failed',
  Init_IframeBlocked: 'init_failed',
  Init_IframeTimeout: 'init_failed',
  Init_ManifestMissing: 'manifest_required',
  Popup_ConnectionMissing: 'transport_unavailable',
  Transport_Missing: 'transport_unavailable',
  Method_PermissionsNotGranted: 'cancelled',
  Method_Cancel: 'cancelled',
  Method_Interrupted: 'cancelled',
  Method_InvalidParameter: 'invalid_path',
  Method_NotAllowed: 'invalid_path',
  Device_NotFound: 'device_not_found',
  Device_Disconnected: 'device_disconnected',
  Device_UsedElsewhere: 'device_in_use',
  Device_CallInProgress: 'device_in_use',
  Device_FwException: 'firmware_too_old',
  Device_MissingCapability: 'firmware_too_old',
};

const MESSAGES: Record<TrezorErrorCode, string> = {
  init_failed:
    'Could not initialise Trezor Connect. Reload the page and try again.',
  manifest_required:
    'Trezor Connect manifest is missing. This is a configuration error in the application.',
  cancelled: 'The request was cancelled on the device or in the Trezor popup.',
  device_disconnected:
    'The Trezor was disconnected before the request finished. Reconnect and try again.',
  device_not_found:
    'No Trezor was detected. Plug the device in and unlock it with your PIN.',
  device_in_use:
    'The Trezor is busy with another request. Finish or cancel it before retrying.',
  device_locked:
    'Trezor Suite (or another tab) is holding the device. Close every other Trezor app and try again — only one program can talk to the device at a time.',
  device_timeout:
    'The device did not respond in time. Make sure the Trezor is unlocked and confirm the export prompt on the device screen.',
  firmware_too_old:
    'This Trezor firmware does not support multisig export. Update the device firmware in Trezor Suite and try again.',
  descriptor_unavailable:
    'This Trezor model cannot return the BIP-380 descriptor needed for multisig. Use a Trezor Model T, Safe 3, Safe 5, or Safe 7.',
  invalid_path:
    'The derivation path the wallet requested was rejected by the device.',
  transport_unavailable:
    'Could not reach the Trezor. Install Trezor Bridge or try again in a Chromium-based browser with WebUSB enabled.',
  unknown: 'Something went wrong while talking to the Trezor.',
};

/** Build a normalized error from a Trezor Connect Unsuccessful response. */
export function fromTrezorFailure(failure: RawTrezorFailure): TrezorAdapterError {
  const sdkCode = failure.payload?.code ?? '';
  const sdkMessage = failure.payload?.error ?? '';
  const code: TrezorErrorCode = CODE_MAP[sdkCode] ?? guessFromMessage(sdkMessage);
  const error: TrezorAdapterError = {
    code,
    message: MESSAGES[code],
    cause: composeCause(sdkCode, sdkMessage),
  };
  log.error('sdk failure normalised', { sdkCode, sdkMessage, normalised: error, raw: failure });
  return error;
}

/** Build a normalized error from any thrown JS value (network, init, etc.). */
export function fromUnknown(value: unknown, fallback: TrezorErrorCode = 'unknown'): TrezorAdapterError {
  const message = value instanceof Error ? value.message : String(value);
  const stack = value instanceof Error ? value.stack : undefined;
  const code: TrezorErrorCode = guessFromMessage(message) || fallback;
  const error: TrezorAdapterError = {
    code,
    message: MESSAGES[code],
    cause: message || undefined,
  };
  log.error('thrown error normalised', { message, stack, normalised: error, raw: value });
  return error;
}

/** Build an explicitly-typed error when we already know the code. */
export function asAdapterError(
  code: TrezorErrorCode,
  cause?: string,
): TrezorAdapterError {
  const error: TrezorAdapterError = { code, message: MESSAGES[code], cause };
  log.error('explicit adapter error', { normalised: error });
  return error;
}

function composeCause(sdkCode: string, sdkMessage: string): string | undefined {
  if (sdkCode && sdkMessage) return `${sdkCode}: ${sdkMessage}`;
  return sdkCode || sdkMessage || undefined;
}

// Some Trezor error responses arrive without a `code`, just a free-form
// `error` string. Cover the common ones so the user still gets a precise
// message instead of falling through to "Something went wrong".
function guessFromMessage(message: string): TrezorErrorCode {
  const lower = message.toLowerCase();
  if (!lower) return 'unknown';
  if (lower.includes('cancel') || lower.includes('permissions not granted'))
    return 'cancelled';
  if (lower.includes('manifest')) return 'manifest_required';
  if (lower.includes('iframe') || lower.includes('not initialized'))
    return 'init_failed';
  if (lower.includes('disconnect')) return 'device_disconnected';
  if (lower.includes('not found')) return 'device_not_found';
  if (lower.includes('used in another')) return 'device_in_use';
  if (lower.includes('transport')) return 'transport_unavailable';
  if (lower.includes('firmware')) return 'firmware_too_old';
  return 'unknown';
}
