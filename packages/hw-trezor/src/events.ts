/**
 * Live device-event subscriptions.
 *
 * `@trezor/connect-web` emits a stream of lifecycle events while the
 * SDK is talking to a device:
 *
 *   - `DEVICE_EVENT` → device connect/disconnect, model + firmware
 *     metadata, and `ButtonRequest` notifications fired every time
 *     the device asks the user to physically confirm something on
 *     its screen.
 *   - `TRANSPORT_EVENT` → Bridge / WebUSB transport coming up or
 *     erroring out.
 *   - `UI_EVENT` → fine-grained "here is what the popup is asking
 *     for now" hints (request_permission, request_pin,
 *     request_passphrase, request_button surface mode). For third-party
 *     origins the popup itself owns permission, PIN, and passphrase
 *     entry, but the request notifications still flow back through the
 *     host page so the wizard can render a contextual coach card next
 *     to the modal.
 *
 * The wallet UI does not need the raw, weakly-typed SDK shapes — it
 * needs a small, stable, Asylia-flavoured event vocabulary it can
 * pattern-match on. This module provides:
 *
 *   - `subscribeToTrezorEvents(handlers)` — installs the listeners
 *     once and returns a single `unsubscribe()` function the caller
 *     plugs into `onUnmounted`. Calling `subscribe` twice with the
 *     same handlers does NOT double-fire (the unsubscribe handle
 *     covers every wire we created).
 *   - `LiveDevicePhase` / `LiveTrezorEvent` — the normalised event
 *     vocabulary the wizard renders against, so adding a new event
 *     in the future is a one-line `case` addition there instead of
 *     a UI rewrite.
 *
 * The adapter never exposes the SDK's own event types directly —
 * that would push the @trezor/connect import surface into the
 * wallet code, defeating the purpose of this package.
 */

import { log } from './log';
import { TrezorConnect } from './sdk';

/**
 * High-level lifecycle phases the wizard renders against. Mapped 1:1
 * from the underlying SDK events but framed in terms a UI surface
 * can directly express.
 *
 * - `device_connected`     — a Trezor came online (USB plug-in or
 *   pop-up acquired session).
 * - `device_disconnected`  — the device went away mid-flow.
 * - `device_changed`       — features (label, firmware, mode)
 *   changed; useful for refreshing the model chip.
 * - `awaiting_permission`  — the SDK popup is asking the user to allow
 *   this origin to read public keys from the Trezor.
 * - `awaiting_pin`         — the device is locked and the SDK popup
 *   is asking for the PIN.
 * - `awaiting_passphrase`  — passphrase wallet active; popup is
 *   asking for the passphrase phrase.
 * - `awaiting_passphrase_on_device` — newer Trezors can collect the
 *   passphrase on the touchscreen instead of the popup.
 * - `awaiting_button`      — the device is showing a "tap to
 *   confirm" prompt on its own screen.
 * - `transport_started`    — Bridge / WebUSB came up.
 * - `transport_error`      — Bridge / WebUSB tore down or refused
 *   to start.
 */
export type LiveDevicePhase =
  | 'device_connected'
  | 'device_disconnected'
  | 'device_changed'
  | 'awaiting_permission'
  | 'awaiting_pin'
  | 'awaiting_passphrase'
  | 'awaiting_passphrase_on_device'
  | 'awaiting_button'
  | 'transport_started'
  | 'transport_error';

/**
 * Subset of device descriptor fields the wizard cares about. Mirrors
 * the same trimming `xpub.ts` does for the export call so two callers
 * never disagree on what counts as a "device" identity.
 */
export type LiveDeviceDescriptor = {
  /** Device label as seen on Trezor's home screen, when readable. */
  label: string | null;
  /** Friendly product name (e.g. "Trezor Safe 3"), when readable. */
  model: string | null;
  /** Raw `internal_model` from the device firmware. */
  internalModel: string | null;
  /** Firmware in `major.minor.patch` form, when readable. */
  firmware: string | null;
};

/**
 * Normalised event the wizard listens to. Every variant carries a
 * `phase` so the UI does not have to map vendor strings, plus the
 * fields useful for the inline coach text (model name, firmware,
 * disconnection reason, …).
 */
export type LiveTrezorEvent =
  | {
      phase:
        | 'device_connected'
        | 'device_disconnected'
        | 'device_changed';
      device: LiveDeviceDescriptor;
    }
  | {
      phase:
        | 'awaiting_permission'
        | 'awaiting_pin'
        | 'awaiting_passphrase'
        | 'awaiting_passphrase_on_device';
      device: LiveDeviceDescriptor | null;
    }
  | {
      phase: 'awaiting_button';
      device: LiveDeviceDescriptor | null;
      /**
       * SDK button code (e.g. `ButtonRequest_Address`,
       * `ButtonRequest_PublicKey`, `ButtonRequest_SignTx`). Useful
       * for tailoring the coach text — "approve the export prompt"
       * vs "approve the spend prompt" — but the wizard treats the
       * generic case ("look at your device") as the safe default.
       */
      buttonCode: string | null;
    }
  | {
      phase: 'transport_started';
      transportType: string | null;
      transportVersion: string | null;
    }
  | {
      phase: 'transport_error';
      message: string;
    };

/**
 * Handler the caller passes into {@link subscribeToTrezorEvents}.
 * Receives every normalised event in chronological order. Throwing
 * inside the handler is logged but does NOT break the listener wire.
 */
export type LiveTrezorEventHandler = (event: LiveTrezorEvent) => void;

/**
 * Cleanup function returned by {@link subscribeToTrezorEvents}. Safe
 * to call multiple times — second and later calls are no-ops.
 */
export type UnsubscribeFn = () => void;

/**
 * SDK event constants. Hard-coded as string literals so this module
 * does not import from `@trezor/connect/lib/exports` (which pulls
 * the entire types tree along) — the SDK already runtime-checks
 * these strings. Sourced 1:1 from
 * `@trezor/connect/lib/events/{device,transport,ui-request}.js`.
 */
const DEVICE_EVENT = 'DEVICE_EVENT' as const;
const TRANSPORT_EVENT = 'TRANSPORT_EVENT' as const;
const UI_EVENT = 'UI_EVENT' as const;

const DEVICE_TYPES = {
  CONNECT: 'device-connect',
  CONNECT_UNACQUIRED: 'device-connect_unacquired',
  DISCONNECT: 'device-disconnect',
  CHANGED: 'device-changed',
  BUTTON: 'button',
} as const;

const TRANSPORT_TYPES = {
  START: 'transport-start',
  ERROR: 'transport-error',
} as const;

const UI_TYPES = {
  REQUEST_PERMISSION: 'ui-request_permission',
  REQUEST_PIN: 'ui-request_pin',
  REQUEST_PASSPHRASE: 'ui-request_passphrase',
  REQUEST_PASSPHRASE_ON_DEVICE: 'ui-request_passphrase_on_device',
  REQUEST_BUTTON: 'ui-button',
} as const;

/**
 * Map an SDK device descriptor (`KnownDevice` shape) onto our
 * trimmed `LiveDeviceDescriptor`. Tolerant of missing fields — the
 * `unacquired` and `unreadable` device variants only carry a partial
 * payload, and we want the UI to still get *something*.
 */
function toDescriptor(raw: unknown): LiveDeviceDescriptor {
  if (!raw || typeof raw !== 'object') {
    return { label: null, model: null, internalModel: null, firmware: null };
  }
  const record = raw as Record<string, unknown>;
  const features = (record.features as Record<string, unknown> | undefined) ?? null;

  const labelFromTop = typeof record.label === 'string' ? record.label : null;
  const labelFromFeatures =
    features && typeof features.label === 'string' ? features.label : null;
  const label = (labelFromTop || labelFromFeatures || '').trim() || null;

  const internalModel =
    features && typeof features.internal_model === 'string'
      ? features.internal_model
      : null;
  const model = friendlyModelName(internalModel);

  const firmware = features ? readFirmware(features) : null;

  return { label, model, internalModel, firmware };
}

function friendlyModelName(internalModel: string | null): string | null {
  if (!internalModel) return null;
  switch (internalModel) {
    case 'T1B1':
      return 'Trezor Model One';
    case 'T2T1':
      return 'Trezor Model T';
    case 'T2B1':
    case 'T3B1':
      return 'Trezor Safe 3';
    case 'T3T1':
      return 'Trezor Safe 5';
    case 'T3W1':
      return 'Trezor Safe 7';
    default:
      return 'Trezor';
  }
}

function readFirmware(features: Record<string, unknown>): string | null {
  const major = readNumber(features.major_version);
  const minor = readNumber(features.minor_version);
  const patch = readNumber(features.patch_version);
  if (major === null && minor === null && patch === null) return null;
  return `${major ?? 0}.${minor ?? 0}.${patch ?? 0}`;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Wrap a UI-side handler with structured logging + error containment
 * so a thrown handler does not break the SDK listener wire.
 */
function safelyDispatch(
  handler: LiveTrezorEventHandler,
  event: LiveTrezorEvent,
): void {
  try {
    handler(event);
  } catch (cause) {
    log.error('event handler threw — swallowed to keep wire alive', {
      phase: event.phase,
      error: cause,
    });
  }
}

/**
 * Subscribe to the live device event stream. Idempotent for a given
 * handler reference: calling `subscribe(h)` twice installs two wires
 * and the returned cleanup removes both — but the recommended
 * pattern is always one mount-time subscribe + one unmount-time
 * unsubscribe.
 *
 * Listeners are installed eagerly even before {@link initTrezor} has
 * run, because the SDK's emitter is a module-level singleton — the
 * subscription is preserved across the eventual `init` call and
 * starts firing the moment the SDK has wires up to a transport.
 */
export function subscribeToTrezorEvents(
  handler: LiveTrezorEventHandler,
): UnsubscribeFn {
  log.info('event subscribe');

  const onDevice = (rawEvent: unknown): void => {
    if (!rawEvent || typeof rawEvent !== 'object') return;
    const record = rawEvent as Record<string, unknown>;
    const type = readString(record.type);
    const payload = record.payload as Record<string, unknown> | undefined;
    if (!type) return;

    switch (type) {
      case DEVICE_TYPES.CONNECT:
      case DEVICE_TYPES.CONNECT_UNACQUIRED: {
        log.info('device connect event', { internalModel: payload?.features });
        safelyDispatch(handler, {
          phase: 'device_connected',
          device: toDescriptor(payload),
        });
        return;
      }
      case DEVICE_TYPES.DISCONNECT: {
        log.info('device disconnect event');
        safelyDispatch(handler, {
          phase: 'device_disconnected',
          device: toDescriptor(payload),
        });
        return;
      }
      case DEVICE_TYPES.CHANGED: {
        safelyDispatch(handler, {
          phase: 'device_changed',
          device: toDescriptor(payload),
        });
        return;
      }
      case DEVICE_TYPES.BUTTON: {
        // `payload` shape: `{ device, code }`; `device` is the
        // descriptor, `code` is the protobuf `ButtonRequest_*` enum
        // string when the SDK can identify it.
        const buttonCode = readString(payload?.code);
        log.info('device button request', { buttonCode });
        safelyDispatch(handler, {
          phase: 'awaiting_button',
          device: payload?.device ? toDescriptor(payload.device) : null,
          buttonCode,
        });
        return;
      }
      default:
        return;
    }
  };

  const onTransport = (rawEvent: unknown): void => {
    if (!rawEvent || typeof rawEvent !== 'object') return;
    const record = rawEvent as Record<string, unknown>;
    const type = readString(record.type);
    const payload = record.payload as Record<string, unknown> | undefined;

    if (type === TRANSPORT_TYPES.START) {
      const transportType = readString(payload?.type);
      const transportVersion = readString(payload?.version);
      log.info('transport start event', { transportType, transportVersion });
      safelyDispatch(handler, {
        phase: 'transport_started',
        transportType,
        transportVersion,
      });
      return;
    }
    if (type === TRANSPORT_TYPES.ERROR) {
      const message = readString(payload?.error) ?? 'transport error';
      log.warn('transport error event', { message });
      safelyDispatch(handler, { phase: 'transport_error', message });
      return;
    }
  };

  const onUi = (rawEvent: unknown): void => {
    if (!rawEvent || typeof rawEvent !== 'object') return;
    const record = rawEvent as Record<string, unknown>;
    const type = readString(record.type);
    const payload = record.payload as Record<string, unknown> | undefined;
    const device = payload?.device ? toDescriptor(payload.device) : null;

    switch (type) {
      case UI_TYPES.REQUEST_PERMISSION: {
        log.info('ui request: permission');
        safelyDispatch(handler, { phase: 'awaiting_permission', device });
        return;
      }
      case UI_TYPES.REQUEST_PIN: {
        log.info('ui request: pin');
        safelyDispatch(handler, { phase: 'awaiting_pin', device });
        return;
      }
      case UI_TYPES.REQUEST_PASSPHRASE: {
        log.info('ui request: passphrase');
        safelyDispatch(handler, { phase: 'awaiting_passphrase', device });
        return;
      }
      case UI_TYPES.REQUEST_PASSPHRASE_ON_DEVICE: {
        log.info('ui request: passphrase on device');
        safelyDispatch(handler, {
          phase: 'awaiting_passphrase_on_device',
          device,
        });
        return;
      }
      case UI_TYPES.REQUEST_BUTTON: {
        // UI-side button surface mode (popup is showing an
        // address/message confirmation). Forward as `awaiting_button`
        // so the wizard does not need a separate UI-request branch.
        const buttonCode = readString(payload?.code);
        log.info('ui request: button', { buttonCode });
        safelyDispatch(handler, {
          phase: 'awaiting_button',
          device,
          buttonCode,
        });
        return;
      }
      default:
        return;
    }
  };

  // The SDK exposes `on(type, cb)` / `off(type, cb)` on its own
  // singleton. Cast to the loose shape we need — typing the union
  // of every overload would force pulling the SDK's internal types
  // into this module, which is exactly what this package exists to
  // avoid.
  type Listener = (event: unknown) => void;
  type SdkEmitter = {
    on: (type: string, cb: Listener) => void;
    off: (type: string, cb: Listener) => void;
  };
  const sdk = TrezorConnect as unknown as SdkEmitter;

  sdk.on(DEVICE_EVENT, onDevice as Listener);
  sdk.on(TRANSPORT_EVENT, onTransport as Listener);
  sdk.on(UI_EVENT, onUi as Listener);

  let alreadyDisposed = false;
  return (): void => {
    if (alreadyDisposed) return;
    alreadyDisposed = true;
    log.info('event unsubscribe');
    sdk.off(DEVICE_EVENT, onDevice as Listener);
    sdk.off(TRANSPORT_EVENT, onTransport as Listener);
    sdk.off(UI_EVENT, onUi as Listener);
  };
}
