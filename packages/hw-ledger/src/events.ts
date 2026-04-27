/// <reference path="./webhid-types.d.ts" />
/**
 * Live device-event subscriptions.
 *
 * Ledger does not ship an SDK-level event emitter comparable to
 * `@trezor/connect`'s `DEVICE_EVENT` / `UI_EVENT` / `TRANSPORT_EVENT`.
 * The wizard still wants a rich event stream — connection / disconnect,
 * "device is now running Bitcoin", "waiting for on-device approval" —
 * so this module synthesises one from the platform primitives:
 *
 *   - **`navigator.hid.onconnect` / `ondisconnect`** — native WebHID
 *     events fired when a device is plugged in / unplugged or when
 *     another tab releases the session.
 *   - **Transport-level events** from an open `TransportWebHID`
 *     (`on('disconnect')`). Fired when the device vanishes mid-
 *     operation, so the wizard can surface the failure before the
 *     current APDU call rejects.
 *   - **`ButtonRequest` beacons** — Ledger's Bitcoin app does not emit
 *     a button-request event (unlike Trezor); the wizard treats every
 *     `getExtendedPubkey` / `getMasterFingerprint` call as an implicit
 *     "look at the device screen" hint the moment the APDU is in
 *     flight. The service layer fires an `awaiting_button` event
 *     before the SDK call so the wizard can update its caption
 *     without waiting for a signal that will never come.
 *
 * The wallet UI does not need the raw WebHID events — it needs a
 * small, stable, Asylia-flavoured event vocabulary it can pattern-
 * match on. This module provides:
 *
 *   - `subscribeToLedgerEvents(handler)` — installs listeners and
 *     returns an `unsubscribe()` handle for `onUnmounted`.
 *   - `emitSyntheticLedgerEvent(event)` — used by the service layer
 *     to synthesise `awaiting_button` / `finalising` / `app_connected`
 *     transitions that do not originate from a WebHID event.
 *   - `LiveDevicePhase` / `LiveLedgerEvent` — the normalised event
 *     vocabulary the wizard renders against.
 *
 * The adapter never exposes the SDK's own event types directly.
 */

import { log } from './log';

/**
 * High-level lifecycle phases the wizard renders against. Mapped from
 * the underlying WebHID + service signals but framed in terms a UI
 * surface can directly express.
 *
 * - `device_connected`     — a Ledger came online (USB plug-in or
 *   another tab released the session).
 * - `device_disconnected`  — the device went away mid-flow.
 * - `app_connected`        — the Bitcoin app on the device answered
 *   `getAppAndVersion`. Synthesised by the service layer right after
 *   the first successful APDU.
 * - `awaiting_button`      — the device is expected to show a "tap
 *   to confirm" prompt on its own screen. Synthesised by the service
 *   layer when it issues `getExtendedPubkey` with `display: true`
 *   (which always prompts the user).
 * - `finalising`           — the user approved the export and the
 *   adapter is shaping the result / closing the transport.
 * - `transport_error`      — WebHID transport tore down or refused to
 *   open.
 */
export type LiveDevicePhase =
  | 'device_connected'
  | 'device_disconnected'
  | 'app_connected'
  | 'awaiting_button'
  | 'finalising'
  | 'transport_error';

/**
 * Subset of HID descriptor fields the wizard cares about. Mirrors
 * `LedgerHidInfo` in `transport.ts` but re-declared here so the event
 * consumer can use this module without importing the transport layer.
 */
export type LiveDeviceDescriptor = {
  productName: string | null;
  /** Friendly marketing name ("Ledger Nano X"), when resolvable. */
  model: string | null;
  vendorId: number | null;
  productId: number | null;
};

/**
 * Normalised event the wizard listens to. Every variant carries a
 * `phase` so the UI does not have to map vendor strings, plus the
 * fields useful for the inline coach text.
 */
export type LiveLedgerEvent =
  | {
      phase: 'device_connected' | 'device_disconnected';
      device: LiveDeviceDescriptor;
    }
  | {
      phase: 'app_connected';
      appName: string;
      appVersion: string;
    }
  | {
      phase: 'awaiting_button';
      /**
       * Free-form hint describing what the device is about to ask for.
       * Parallel to Trezor's `ButtonRequest_*` codes; kept loose so the
       * service layer can pick short, context-sensitive copy ("Confirm
       * export", "Approve transaction", …).
       */
      intent: string | null;
    }
  | {
      phase: 'finalising';
      message: string | null;
    }
  | {
      phase: 'transport_error';
      message: string;
    };

/** Handler signature. */
export type LiveLedgerEventHandler = (event: LiveLedgerEvent) => void;

/** Cleanup function returned by {@link subscribeToLedgerEvents}. */
export type UnsubscribeFn = () => void;

const LEDGER_USB_VENDOR_ID = 0x2c97;

const MODEL_NAMES: Record<number, string> = {
  0x1000: 'Ledger Nano S',
  0x4000: 'Ledger Nano X',
  0x5000: 'Ledger Nano S Plus',
  0x6000: 'Ledger Stax',
  0x7000: 'Ledger Flex',
};

/**
 * Module-level fan-out used by {@link emitSyntheticLedgerEvent}.
 * Stored on a singleton so the service layer can broadcast events
 * without holding a handle on every active subscriber.
 */
const subscribers = new Set<LiveLedgerEventHandler>();

/**
 * Subscribe to the Ledger live event stream. Idempotent for a given
 * handler reference: calling `subscribe(h)` twice installs two
 * listeners and the returned cleanup removes both. The recommended
 * pattern is always one mount-time subscribe + one unmount-time
 * unsubscribe.
 */
export function subscribeToLedgerEvents(
  handler: LiveLedgerEventHandler,
): UnsubscribeFn {
  log.info('event subscribe');
  subscribers.add(handler);

  // Install raw WebHID listeners the first time someone subscribes,
  // tear them down when the last subscriber leaves. Keeping the wires
  // scoped to active subscriptions avoids a silent module-level
  // listener that stays alive after the app unmounts its last wizard.
  ensureHidListenersInstalled();

  let alreadyDisposed = false;
  return (): void => {
    if (alreadyDisposed) return;
    alreadyDisposed = true;
    log.info('event unsubscribe');
    subscribers.delete(handler);
    if (subscribers.size === 0) {
      tearDownHidListeners();
    }
  };
}

/**
 * Broadcast an event that originates from the service layer rather
 * than from WebHID. Used for `app_connected` / `awaiting_button`
 * synthetic beacons which the raw HID wire cannot provide.
 *
 * Safe to call with no active subscribers (no-op).
 */
export function emitSyntheticLedgerEvent(event: LiveLedgerEvent): void {
  if (subscribers.size === 0) return;
  log.info('synthetic event', { phase: event.phase });
  dispatch(event);
}

// ---------- internals ------------------------------------------------

let hidListenersInstalled = false;

function ensureHidListenersInstalled(): void {
  if (hidListenersInstalled) return;
  if (typeof navigator === 'undefined' || !('hid' in navigator)) {
    log.warn('cannot install hid listeners — navigator.hid missing');
    return;
  }

  // `navigator.hid` is an EventTarget with `onconnect` / `ondisconnect`
  // properties. Attach both listeners; HID deduplicates per-origin so
  // installing them twice is fine, but we still keep the idempotent
  // guard for tidiness.
  try {
    navigator.hid.addEventListener('connect', handleHidConnect);
    navigator.hid.addEventListener('disconnect', handleHidDisconnect);
    hidListenersInstalled = true;
    log.info('hid listeners installed');
  } catch (cause) {
    log.error('failed to install hid listeners', {
      error: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

function tearDownHidListeners(): void {
  if (!hidListenersInstalled) return;
  if (typeof navigator === 'undefined' || !('hid' in navigator)) return;
  try {
    navigator.hid.removeEventListener('connect', handleHidConnect);
    navigator.hid.removeEventListener('disconnect', handleHidDisconnect);
    hidListenersInstalled = false;
    log.info('hid listeners removed');
  } catch (cause) {
    log.warn('failed to remove hid listeners', {
      error: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

function handleHidConnect(event: HIDConnectionEvent): void {
  const device = event.device;
  if (!isLedgerDevice(device)) return;
  log.info('hid connect event', {
    productId: device.productId,
    productName: device.productName,
  });
  dispatch({ phase: 'device_connected', device: describeDevice(device) });
}

function handleHidDisconnect(event: HIDConnectionEvent): void {
  const device = event.device;
  if (!isLedgerDevice(device)) return;
  log.info('hid disconnect event', {
    productId: device.productId,
    productName: device.productName,
  });
  dispatch({ phase: 'device_disconnected', device: describeDevice(device) });
}

function isLedgerDevice(device: HIDDevice | null | undefined): boolean {
  return !!device && device.vendorId === LEDGER_USB_VENDOR_ID;
}

function describeDevice(device: HIDDevice): LiveDeviceDescriptor {
  const productId = device.productId ?? null;
  const masked = productId !== null ? (productId & 0xff00) : null;
  const model =
    (masked !== null ? MODEL_NAMES[masked] : undefined) ??
    (productId !== null ? MODEL_NAMES[productId] : undefined) ??
    null;
  return {
    productName: device.productName ?? null,
    model,
    vendorId: device.vendorId ?? null,
    productId,
  };
}

/** Fan-out helper with error containment. */
function dispatch(event: LiveLedgerEvent): void {
  for (const handler of subscribers) {
    try {
      handler(event);
    } catch (cause) {
      log.error('event handler threw — swallowed to keep wire alive', {
        phase: event.phase,
        error: cause,
      });
    }
  }
}
