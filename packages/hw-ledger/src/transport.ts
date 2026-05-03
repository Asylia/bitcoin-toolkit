/// <reference path="./webhid-types.d.ts" />
/// <reference path="./webbluetooth-types.d.ts" />
/**
 * Ledger browser transport manager.
 *
 * Ledger devices can expose themselves to the browser through two
 * official channels:
 *
 *   - WebHID over USB (`@ledgerhq/hw-transport-webhid`)
 *   - Web Bluetooth / BLE (`@ledgerhq/hw-transport-web-ble`)
 *
 * WebUSB works in older Ledger stacks but Ledger itself has deprecated
 * it for the Bitcoin app v2+, so Asylia intentionally wires only HID
 * and BLE.
 *
 * What this module owns:
 *
 *   - Opening a transport against a previously-authorised Ledger when
 *     the user returns to the app without having to re-prompt.
 *   - Triggering the browser permission picker on a user gesture when
 *     no authorised device is visible yet.
 *   - Closing the active transport (required — leaving a transport
 *     open blocks future calls because the device handle is exclusive).
 *   - Bubbling up a single, normalised `LedgerAdapterError` on any
 *     failure, so callers never see raw SDK exceptions.
 *
 * Design notes:
 *
 * - WebHID and Web Bluetooth both require a **user gesture** (`click`
 *   handler) to pop the picker on first pairing. The wizard calls into
 *   this module from inside a click handler; there is no
 *   try-now-ask-later workaround.
 * - We deliberately open and close a fresh transport for every flow
 *   instead of caching one across calls. The Ledger WebHID session is
 *   exclusive; keeping it open past the current modal starves other
 *   Ledger-aware pages (Ledger Live, Sparrow, …) until the user
 *   unplugs the device.
 * - The browser-level descriptor is mirrored into a small, stable
 *   shape so the rest of the package does not depend on browser
 *   experimental interfaces.
 */

import TransportWebHID from '@ledgerhq/hw-transport-webhid';
import TransportWebBLE from '@ledgerhq/hw-transport-web-ble';
import type Transport from '@ledgerhq/hw-transport';

import { asAdapterError, fromLedgerError } from './errors';
import { log } from './log';
import type {
  AdapterResult,
  LedgerTransportChannel,
  LedgerTransportPreference,
} from './types';

/**
 * Minimal HID descriptor fields Asylia cares about. Pulled from the
 * browser-native `HIDDevice` without dragging the DOM type into this
 * module's exported surface.
 */
export type LedgerHidInfo = {
  productName: string | null;
  vendorId: number | null;
  productId: number | null;
};

export type LedgerTransportOpenOptions = {
  /**
   * Transport channel requested by the caller. `auto` keeps the current
   * best-effort behaviour and is the default for existing call sites.
   */
  transport?: LedgerTransportPreference;
};

export type LedgerTransportInfo = LedgerHidInfo & {
  channel: LedgerTransportChannel | null;
  model: string;
};

/**
 * Ledger USB vendor id. Used by {@link hasAuthorisedLedgerDevice} to
 * tell a Ledger apart from any other HID peripheral the browser might
 * have authorised on the same origin.
 *
 * Sourced from the `@ledgerhq/devices` registry; kept inline to avoid
 * pulling that transitive dependency into the audit surface.
 */
const LEDGER_USB_VENDOR_ID = 0x2c97;
const WEBHID_PERMISSIONS_POLICY_CAUSE =
  'Permissions-Policy blocks WebHID for this document';

/**
 * Friendly product names per Ledger `productId`. The Ledger Bitcoin app
 * v2 is supported on Nano S Plus, Nano X, Stax, and Flex; older Nano S
 * is explicitly out of scope because the multisig policy flow requires
 * at least app v2.1.0.
 *
 * Values collected from `@ledgerhq/devices` and the Ledger docs. The
 * bottom 2 bytes of `productId` are reserved for the current BOLOS app
 * id, so we mask them out and match on the top 2 bytes alone.
 */
const MODEL_NAMES: Record<number, string> = {
  0x1000: 'Ledger Nano S',
  0x4000: 'Ledger Nano X',
  0x5000: 'Ledger Nano S Plus',
  0x6000: 'Ledger Stax',
  0x7000: 'Ledger Flex',
};

/** Thin WebHID transport handle Asylia uses. Opaque to callers. */
export type LedgerTransport = Transport;

/**
 * Probe `navigator.hid.getDevices()` for a previously-authorised Ledger
 * device. Returns the raw `HIDDevice` (typed loosely so this module
 * does not force consumers to add the DOM lib references) or `null`
 * when nothing suitable is around.
 *
 * Silent — no permission prompt, no side effects. Safe to call from
 * `onMounted` so the wizard can render an accurate "we already know
 * your Ledger" coach card instead of always starting from scratch.
 */
export async function findAuthorisedLedgerDevice(): Promise<HIDDevice | null> {
  if (typeof navigator === 'undefined' || !('hid' in navigator)) return null;
  try {
    const devices = await navigator.hid.getDevices();
    const ledger = devices.find(
      (device) => device.vendorId === LEDGER_USB_VENDOR_ID,
    );
    return ledger ?? null;
  } catch (cause) {
    if (isWebHidPermissionsPolicyError(cause)) {
      log.error('navigator.hid.getDevices blocked by Permissions-Policy', {
        error: cause instanceof Error ? cause.message : String(cause),
      });
      return null;
    }
    log.warn('navigator.hid.getDevices threw', {
      error: cause instanceof Error ? cause.message : String(cause),
    });
    return null;
  }
}

/** Boolean convenience around {@link findAuthorisedLedgerDevice}. */
export async function hasAuthorisedLedgerDevice(): Promise<boolean> {
  return (await findAuthorisedLedgerDevice()) !== null;
}

/**
 * Probe `navigator.bluetooth.getDevices()` for a previously-authorised
 * Bluetooth Ledger. Chrome exposes this without a picker when the
 * origin already has a grant; browsers that do not implement it simply
 * return `null` and can still pair through the BLE picker later.
 */
export async function findAuthorisedLedgerBluetoothDevice(): Promise<BluetoothDevice | null> {
  const bluetooth = getBluetoothApi();
  if (typeof bluetooth?.getDevices !== 'function') return null;
  try {
    const devices = await bluetooth.getDevices();
    return devices.find(isLikelyLedgerBluetoothDevice) ?? null;
  } catch (cause) {
    if (isBluetoothPermissionsPolicyError(cause)) {
      log.error('navigator.bluetooth.getDevices blocked by Permissions-Policy', {
        error: cause instanceof Error ? cause.message : String(cause),
      });
      return null;
    }
    log.warn('navigator.bluetooth.getDevices threw', {
      error: cause instanceof Error ? cause.message : String(cause),
    });
    return null;
  }
}

/** Boolean convenience around {@link findAuthorisedLedgerBluetoothDevice}. */
export async function hasAuthorisedLedgerBluetoothDevice(): Promise<boolean> {
  return (await findAuthorisedLedgerBluetoothDevice()) !== null;
}

/**
 * Open a WebHID transport. On the happy path returns a fresh transport
 * pointed at a Ledger; on failure returns a normalised adapter error.
 *
 * Must be called from a user gesture (e.g. inside an `@click` handler)
 * on the first run, because the browser only lets
 * `navigator.hid.requestDevice` open the picker from a trusted event.
 *
 * When a previously-authorised device is already visible, the function
 * reuses it and no picker pops — returning a transport transparently.
 */
export async function openLedgerTransport(
  options: LedgerTransportOpenOptions = {},
): Promise<
  AdapterResult<LedgerTransport>
> {
  const requested = options.transport ?? 'auto';
  log.info('transport open requested', { requested });

  if (requested === 'webhid') {
    return openLedgerHidTransport();
  }

  if (requested === 'webble') {
    return openLedgerBluetoothTransport();
  }

  const hidDevice = await findAuthorisedLedgerDevice();
  if (hidDevice) {
    return openLedgerHidTransport();
  }

  const bleDevice = await findAuthorisedLedgerBluetoothDevice();
  if (bleDevice) {
    return openLedgerBluetoothTransport({ device: bleDevice });
  }

  const hidAvailable = isWebHidApiAvailable();
  const bleAvailable = isWebBluetoothApiAvailable();

  if (hidAvailable) {
    return openLedgerHidTransport();
  }

  if (bleAvailable) {
    return openLedgerBluetoothTransport();
  }

  log.error('no ledger browser transport available');
  return {
    ok: false,
    error: asAdapterError(
      'transport_unavailable',
      'navigator.hid and navigator.bluetooth unavailable (unsupported browser / insecure context)',
    ),
  };
}

async function openLedgerHidTransport(): Promise<
  AdapterResult<LedgerTransport>
> {
  if (!isWebHidApiAvailable()) {
    log.error('webhid unavailable — navigator.hid not present');
    return {
      ok: false,
      error: asAdapterError(
        'transport_unavailable',
        'navigator.hid unavailable (Safari / Firefox / insecure context)',
      ),
    };
  }

  // Fast path: if the user already granted permission on this origin
  // we can open the device silently and avoid any picker flicker.
  try {
    const existing = await TransportWebHID.openConnected();
    if (existing) {
      log.info('webhid transport opened via existing grant', {
        descriptor: describeDevice(existing.device),
      });
      return { ok: true, data: existing };
    }
  } catch (cause) {
    if (isWebHidPermissionsPolicyError(cause)) {
      log.error('webhid openConnected blocked by Permissions-Policy', {
        error: cause instanceof Error ? cause.message : String(cause),
      });
      return {
        ok: false,
        error: asAdapterError(
          'permission_denied',
          WEBHID_PERMISSIONS_POLICY_CAUSE,
        ),
      };
    }
    // `openConnected` tolerates no-device as a `null` return but can still
    // throw when the device is held by another tab. Fall through to the
    // request path instead of surfacing the error immediately — the
    // request picker renders a better "pick another device" message.
    log.warn('webhid openConnected threw; falling back to request()', {
      error: cause instanceof Error ? cause.message : String(cause),
    });
  }

  // Slow path: ask the user to pick a device. Requires a user gesture.
  try {
    const transport = await TransportWebHID.request();
    log.info('webhid transport opened via picker', {
      descriptor: describeDevice(transport.device),
    });
    return { ok: true, data: transport };
  } catch (cause) {
    log.error('webhid request() threw', {
      error: cause instanceof Error ? cause.message : String(cause),
    });
    if (isWebHidPermissionsPolicyError(cause)) {
      return {
        ok: false,
        error: asAdapterError(
          'permission_denied',
          WEBHID_PERMISSIONS_POLICY_CAUSE,
        ),
      };
    }
    return { ok: false, error: fromLedgerError(cause, 'transport_unavailable') };
  }
}

async function openLedgerBluetoothTransport(input: {
  device?: BluetoothDevice;
} = {}): Promise<AdapterResult<LedgerTransport>> {
  if (!isWebBluetoothApiAvailable()) {
    log.error('web bluetooth unavailable — navigator.bluetooth not present');
    return {
      ok: false,
      error: asAdapterError(
        'transport_unavailable',
        'navigator.bluetooth unavailable (unsupported browser / insecure context)',
      ),
    };
  }

  try {
    const device = input.device ?? (await requestLedgerBluetoothDevice());
    const transport = await TransportWebBLE.open(device);
    log.info('webble transport opened', {
      descriptor: describeBluetoothDevice(device),
    });
    return { ok: true, data: transport };
  } catch (cause) {
    log.error('webble open threw', {
      error: cause instanceof Error ? cause.message : String(cause),
    });
    if (isBluetoothPermissionsPolicyError(cause)) {
      return {
        ok: false,
        error: asAdapterError(
          'permission_denied',
          'Permissions-Policy blocks Web Bluetooth for this document',
        ),
      };
    }
    return { ok: false, error: fromLedgerError(cause, 'transport_unavailable') };
  }
}

/**
 * Close a transport handle, swallowing secondary errors. Safe to call
 * from a `finally` block even if the open itself failed — the
 * underlying SDK no-ops on double-close.
 */
export async function closeLedgerTransport(
  transport: LedgerTransport | null | undefined,
): Promise<void> {
  if (!transport) return;
  try {
    await transport.close();
    log.info('ledger transport closed', {
      channel: transportChannel(transport),
    });
  } catch (cause) {
    log.warn('ledger transport close threw — swallowing', {
      error: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

/** Pull the HID descriptor off an opened `TransportWebHID` instance. */
export function transportHidInfo(transport: LedgerTransport): LedgerHidInfo {
  // `@ledgerhq/hw-transport-webhid` exposes `.device` on the instance;
  // older transports (BLE, speculos, …) don't. Keep the read defensive.
  const maybeWithDevice = transport as unknown as { device?: HIDDevice };
  const device = maybeWithDevice.device ?? null;
  return describeDevice(device);
}

/** Browser-agnostic transport descriptor used for user-facing device metadata. */
export function transportDeviceInfo(transport: LedgerTransport): LedgerTransportInfo {
  const channel = transportChannel(transport);
  if (channel === 'webble') {
    const info = describeBluetoothTransport(transport);
    return {
      productName: info.productName,
      vendorId: null,
      productId: null,
      channel,
      model: info.productName ?? 'Ledger',
    };
  }

  const hid = transportHidInfo(transport);
  return {
    ...hid,
    channel,
    model: friendlyProductName(hid),
  };
}

/**
 * Resolve the Ledger product name from a raw HID descriptor. Uses the
 * top 2 bytes of `productId` to skip the BOLOS app suffix (the device
 * changes `productId` depending on which app is currently open).
 *
 * Falls back to the descriptor's `productName` and finally to the
 * generic "Ledger" string so the UI never renders an empty chip.
 */
export function friendlyProductName(info: LedgerHidInfo | null): string {
  if (!info) return 'Ledger';
  if (info.productId !== null) {
    const masked = (info.productId & 0xff00) as number;
    const byMask = MODEL_NAMES[masked];
    if (byMask) return byMask;
    const exact = MODEL_NAMES[info.productId];
    if (exact) return exact;
  }
  if (info.productName) return info.productName;
  return 'Ledger';
}

function describeDevice(device: HIDDevice | null): LedgerHidInfo {
  if (!device) {
    return { productName: null, vendorId: null, productId: null };
  }
  return {
    productName: device.productName ?? null,
    vendorId: device.vendorId ?? null,
    productId: device.productId ?? null,
  };
}

function describeBluetoothDevice(device: BluetoothDevice | null): {
  id: string | null;
  name: string | null;
} {
  if (!device) return { id: null, name: null };
  return {
    id: device.id ?? null,
    name: device.name ?? null,
  };
}

function describeBluetoothTransport(transport: LedgerTransport): {
  productName: string | null;
} {
  const maybeBle = transport as unknown as {
    device?: { name?: string | null };
    deviceModel?: { productName?: string | null };
  };
  return {
    productName:
      maybeBle.deviceModel?.productName ??
      maybeBle.device?.name ??
      null,
  };
}

function transportChannel(transport: LedgerTransport): LedgerTransportChannel | null {
  const maybeTransport = transport as unknown as {
    device?: unknown;
    deviceModel?: unknown;
  };
  if (maybeTransport.deviceModel) return 'webble';
  if (maybeTransport.device) return 'webhid';
  return null;
}

function getBluetoothApi(): Bluetooth | null {
  if (typeof navigator === 'undefined') return null;
  return navigator.bluetooth ?? null;
}

function isWebHidApiAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'hid' in navigator;
}

function isWebBluetoothApiAvailable(): boolean {
  return getBluetoothApi() !== null;
}

async function requestLedgerBluetoothDevice(): Promise<BluetoothDevice> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let subscription: { unsubscribe: () => void } | null = null;
    const settle = (
      callback: () => void,
    ): void => {
      if (settled) return;
      settled = true;
      try {
        subscription?.unsubscribe();
      } catch {
        // Best-effort cleanup only; the SDK listener is one-shot.
      }
      callback();
    };

    try {
      subscription = TransportWebBLE.listen({
        next: (event: { type?: string; descriptor?: BluetoothDevice }) => {
          if (event.type !== 'add' || !event.descriptor) return;
          settle(() => resolve(event.descriptor as BluetoothDevice));
        },
        error: (cause: unknown) => {
          settle(() => reject(cause));
        },
        complete: () => {
          settle(() => reject(new Error('No Ledger Bluetooth device selected')));
        },
      });
    } catch (cause) {
      settle(() => reject(cause));
    }
  });
}

function isLikelyLedgerBluetoothDevice(device: BluetoothDevice): boolean {
  const name = device.name?.toLowerCase() ?? '';
  return (
    name.includes('ledger') ||
    name.includes('nano x') ||
    name.includes('stax') ||
    name.includes('flex')
  );
}

function isWebHidPermissionsPolicyError(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause);
  const lower = message.toLowerCase();
  return lower.includes('permissions policy') && lower.includes('hid');
}

function isBluetoothPermissionsPolicyError(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause);
  const lower = message.toLowerCase();
  return lower.includes('permissions policy') && lower.includes('bluetooth');
}

/** Visible for tests. Exposes the vendor id without leaking `@ledgerhq/devices`. */
export const _LEDGER_USB_VENDOR_ID_FOR_TESTS = LEDGER_USB_VENDOR_ID;
