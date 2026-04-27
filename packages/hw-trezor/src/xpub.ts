/**
 * xpub export.
 *
 * The single user-facing operation needed by the "Add a key" flow:
 *
 *   1. Read device features (label, model, firmware) so the wallet can
 *      show "Trezor Safe 3" on the dashboard without a second prompt.
 *   2. Ask the device for the BIP-32 extended public key at the
 *      requested derivation path. The user confirms the export on the
 *      device screen.
 *   3. Parse the BIP-380 descriptor returned by `getPublicKey` to
 *      extract the master fingerprint — the canonical identity of the
 *      key under BIP-380, and the value Asylia stores in the
 *      `V1_SignKeys.fingerprint` column.
 *
 * One device prompt per Asylia-side `addKey` call. Descendant addresses
 * for the script branch are derived client-side from `xpub`.
 */

import { asAdapterError, fromTrezorFailure, fromUnknown } from './errors';
import { log } from './log';
import { TrezorConnect } from './sdk';
import { xpubToMultisigZpub } from './slip132';
import type {
  AdapterResult,
  ExportRootInput,
  ExportRootResult,
  TrezorDeviceInfo,
  TrezorScriptType,
} from './types';

/**
 * Mapping from Asylia's script type tag onto Trezor's `scriptType` enum.
 *
 * Asylia is native-SegWit P2WSH multisig only — `wsh(sortedmulti(...))`.
 * Trezor's `getPublicKey` API has no dedicated `SPENDP2WSH` value
 * (multisig is wallet-side, not device-side, so the SDK exposes only
 * single-key script types). The closest match is `SPENDWITNESS`
 * (single-key P2WPKH, native SegWit), which gives us:
 *   - the right native-SegWit derivation policy on the device, and
 *   - the same raw key material that we would get for any other
 *     native-SegWit usage (the `xpub` body is script-agnostic).
 *
 * The wrapper Trezor returns in `descriptor` is therefore `wpkh(...)`
 * and the SLIP-132 segwit form it returns in `xpubSegwit` is `zpub`
 * (lowercase, single-key). Asylia post-processes the same key material
 * into the proper P2WSH-multisig form (`Zpub` via `xpubToMultisigZpub`)
 * for any user-facing display or export. The `wsh(sortedmulti(...))`
 * descriptor itself is built client-side from N collected `xpub`s.
 */
const SCRIPT_TYPE_MAP: Record<TrezorScriptType, 'SPENDWITNESS'> = {
  p2wsh: 'SPENDWITNESS',
};

/**
 * Mapping from Trezor's `internal_model` enum to a user-friendly product
 * name. Sourced from the official device-naming reference. Anything
 * unknown falls through to "Trezor" so the UI never renders an empty
 * model chip.
 *
 * https://docs.trezor.io/trezor-suite/misc/device-naming.html
 */
const MODEL_MAP: Record<string, string> = {
  T1B1: 'Trezor Model One',
  T2T1: 'Trezor Model T',
  T2B1: 'Trezor Safe 3',
  T3B1: 'Trezor Safe 3',
  T3T1: 'Trezor Safe 5',
  T3W1: 'Trezor Safe 7',
};

/**
 * Run the full flow: features + getPublicKey, normalised into Asylia's
 * `ExportRootResult`. The function is the only entry point the wallet
 * calls; everything below it is intentionally private to this package.
 */
export async function exportTrezorRoot(
  input: ExportRootInput,
): Promise<AdapterResult<ExportRootResult>> {
  const coin = input.coin ?? 'btc';
  const scriptType = SCRIPT_TYPE_MAP[input.scriptType];

  log.info('exportTrezorRoot start', {
    derivationPath: input.derivationPath,
    scriptType: input.scriptType,
    sdkScriptType: scriptType,
    coin,
  });

  if (!isPlausibleBip32Path(input.derivationPath)) {
    return { ok: false, error: asAdapterError('invalid_path', input.derivationPath) };
  }

  // 1. Device descriptor. Required for the "Trezor Safe 3" chip we render
  //    on the dashboard. Failures here usually mean Bridge / WebUSB is
  //    unavailable, so they normalise to `transport_unavailable` /
  //    `device_not_found` for the user.
  const deviceResult = await readDeviceInfo();
  if (!deviceResult.ok) return deviceResult;

  // 2. xpub export. This is the call that prompts the user on the
  //    physical device.
  log.info('getPublicKey request', {
    path: input.derivationPath,
    coin,
    scriptType,
    timeoutMs: GET_PUBLIC_KEY_TIMEOUT_MS,
  });
  let response;
  try {
    response = await withTimeout(
      TrezorConnect.getPublicKey({
        path: input.derivationPath,
        coin,
        scriptType,
      }),
      GET_PUBLIC_KEY_TIMEOUT_MS,
      'getPublicKey',
    );
  } catch (error: unknown) {
    if (isTimeoutError(error)) {
      log.error('getPublicKey timed out', { timeoutMs: GET_PUBLIC_KEY_TIMEOUT_MS });
      return { ok: false, error: asAdapterError('device_timeout', `timeout after ${GET_PUBLIC_KEY_TIMEOUT_MS}ms`) };
    }
    log.error('getPublicKey threw', { error });
    return { ok: false, error: fromUnknown(error) };
  }

  if (!response.success) {
    log.error('getPublicKey failed', { response });
    return { ok: false, error: fromTrezorFailure(response) };
  }

  const payload = response.payload;
  log.info('getPublicKey success', {
    serializedPath: payload.serializedPath,
    depth: payload.depth,
    childNum: payload.childNum,
    fingerprint: payload.fingerprint,
    xpubPreview: payload.xpub.slice(0, 12) + '…',
    xpubSegwitPreview: payload.xpubSegwit
      ? payload.xpubSegwit.slice(0, 12) + '…'
      : '(none)',
    descriptorPreview: payload.descriptor?.slice(0, 80),
    hasDescriptor: typeof payload.descriptor === 'string',
  });

  const masterFingerprint = parseMasterFingerprint(payload.descriptor);
  if (!masterFingerprint) {
    log.error('descriptor missing — cannot derive master fingerprint', {
      descriptor: payload.descriptor,
      device: deviceResult.data,
    });
    return {
      ok: false,
      error: asAdapterError('descriptor_unavailable', payload.descriptor ?? '(missing)'),
    };
  }

  // Re-encode the xpub into the SLIP-132 P2WSH-multisig form (`Zpub`).
  // Trezor returns single-key forms (`xpub`, `zpub`) because its
  // getPublicKey API has no multisig script type — see SCRIPT_TYPE_MAP.
  // The conversion is lossless (only the version bytes change).
  const xpubMultisig = xpubToMultisigZpub(payload.xpub);
  if (xpubMultisig === null) {
    log.warn('xpub → Zpub conversion failed; storing legacy xpub only', {
      xpubPreview: payload.xpub.slice(0, 12) + '…',
    });
  }

  log.info('exportTrezorRoot success', {
    masterFingerprint,
    derivationPath: payload.serializedPath,
    device: deviceResult.data,
    xpubMultisigPreview: xpubMultisig
      ? xpubMultisig.slice(0, 12) + '…'
      : '(conversion failed)',
  });

  return {
    ok: true,
    data: {
      xpub: payload.xpub,
      xpubMultisig,
      ...(payload.xpubSegwit !== undefined ? { xpubSegwit: payload.xpubSegwit } : {}),
      masterFingerprint,
      derivationPath: payload.serializedPath,
      scriptType: input.scriptType,
      device: deviceResult.data,
    },
  };
}

async function readDeviceInfo(): Promise<AdapterResult<TrezorDeviceInfo>> {
  log.info('getFeatures request');
  let response;
  try {
    response = await TrezorConnect.getFeatures();
  } catch (error: unknown) {
    log.error('getFeatures threw', { error });
    return { ok: false, error: fromUnknown(error) };
  }

  if (!response.success) {
    log.error('getFeatures failed', { response });
    return { ok: false, error: fromTrezorFailure(response) };
  }

  const features = response.payload;
  const internalModel = String(features.internal_model ?? 'UNKNOWN');
  const model = MODEL_MAP[internalModel] ?? 'Trezor';
  const firmware = `${features.major_version ?? 0}.${features.minor_version ?? 0}.${features.patch_version ?? 0}`;
  const label = (features.label ?? '').trim() || model;

  log.info('getFeatures success', {
    internalModel,
    model,
    firmware,
    label,
    deviceId: features.device_id,
  });

  // Stub-response heuristic: when Trezor Suite (or another browser tab)
  // holds an exclusive lock on the device, the connect-popup still
  // answers with `success: true` but every payload field is empty —
  // `internal_model = 'UNKNOWN'`, `firmware = 0.0.0`, `device_id = null`.
  // Continuing into `getPublicKey` from that state hangs indefinitely
  // because the popup has no real channel to the device. Bail out with
  // an actionable error instead.
  const looksLikeStub =
    internalModel === 'UNKNOWN' &&
    !features.device_id &&
    (features.major_version ?? 0) === 0;
  if (looksLikeStub) {
    log.error('getFeatures returned a stub — device probably locked by another app', {
      features,
    });
    return {
      ok: false,
      error: asAdapterError(
        'device_locked',
        'getFeatures returned UNKNOWN model with no device_id',
      ),
    };
  }

  return {
    ok: true,
    data: {
      label,
      model,
      internalModel,
      firmware,
    },
  };
}

/** Conservative ceiling for the user to confirm the export on-device. */
const GET_PUBLIC_KEY_TIMEOUT_MS = 90_000;

class TrezorTimeoutError extends Error {
  override readonly name = 'TrezorTimeoutError';
  constructor(operation: string, ms: number) {
    super(`${operation} timed out after ${ms}ms`);
  }
}

function isTimeoutError(value: unknown): value is TrezorTimeoutError {
  return value instanceof TrezorTimeoutError;
}

/**
 * Race a Trezor SDK promise against a hard wall-clock cap so the modal
 * never gets stuck on a popup that lost its channel (most commonly when
 * Trezor Suite grabs the device mid-call). The SDK itself has no such
 * client-side ceiling.
 */
function withTimeout<T>(p: Promise<T>, ms: number, operation: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const handle = setTimeout(() => reject(new TrezorTimeoutError(operation, ms)), ms);
    p.then(
      (value) => {
        clearTimeout(handle);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(handle);
        reject(error);
      },
    );
  });
}

/**
 * Pull the master fingerprint out of a BIP-380 descriptor.
 *
 * Trezor wraps the exported key in a script-kind expression, so the
 * key-origin block `[fingerprint/path]` shows up *inside* the wrapper,
 * not at position 0. Real shapes we get from the device:
 *
 *   `wpkh([d34db33f/48'/0'/0'/2']xpub6CY...)#checksum`
 *   `wsh(sortedmulti(2,[d34db33f/48'/0'/0'/2']xpub6CY..., …))#checksum`
 *   `[d34db33f/48'/0'/0'/2']xpub6CY...`              ← rare bare form
 *
 * The 8-character hex right after `[` is the BIP-380 master fingerprint
 * (the first key-origin block in the descriptor always belongs to the
 * key Trezor just exported). The next character must be one of the path
 * separators `/`, `'` or `h` so we never latch onto a random hex run
 * inside the xpub body.
 *
 * Returns `null` when no descriptor is present (Trezor Model One, very
 * old firmware) so the caller can surface a precise error instead of
 * inserting garbage.
 */
function parseMasterFingerprint(descriptor: string | undefined): string | null {
  if (!descriptor) return null;
  const match = /\[([0-9a-f]{8})(?=[/'h])/i.exec(descriptor);
  if (!match || !match[1]) return null;
  return match[1].toLowerCase();
}

/**
 * Cheap pre-flight on the derivation path. Mirrors the regex Asylia
 * stores in the `V1_SignKeys.derivation_root_format` CHECK constraint
 * so a malformed path is caught before it leaves the browser.
 */
function isPlausibleBip32Path(path: string): boolean {
  return /^m(\/[0-9]+(['h])?)*$/.test(path.trim());
}
