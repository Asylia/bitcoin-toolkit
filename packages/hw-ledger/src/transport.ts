/// <reference path="./webhid-types.d.ts" />
/**
 * WebHID transport manager.
 *
 * Ledger devices expose themselves to the browser as HID peripherals.
 * The modern, supported path is `@ledgerhq/hw-transport-webhid` —
 * WebUSB works too but Ledger itself has deprecated it for the Bitcoin
 * app v2+, so Asylia only wires up WebHID.
 *
 * What this module owns:
 *
 *   - Opening a WebHID transport against a previously-authorised Ledger
 *     when the user returns to the app without having to re-prompt.
 *   - Triggering the permission picker (`navigator.hid.requestDevice`)
 *     on a user gesture when no authorised device is visible yet.
 *   - Closing the active transport (required — leaving a transport
 *     open blocks any future call because WebHID locks the device
 *     handle exclusively).
 *   - Bubbling up a single, normalised `LedgerAdapterError` on any
 *     failure, so callers never see raw SDK exceptions.
 *
 * Design notes:
 *
 * - WebHID requires a **user gesture** (`click` handler) to pop the
 *   picker. The wizard calls into this module from inside a click
 *   handler; there is no try-now-ask-later workaround.
 * - We deliberately open and close a fresh transport for every flow
 *   instead of caching one across calls. The Ledger WebHID session is
 *   exclusive; keeping it open past the current modal starves other
 *   Ledger-aware pages (Ledger Live, Sparrow, …) until the user
 *   unplugs the device.
 * - The HID-level device descriptor is mirrored into a small, stable
 *   `LedgerHidInfo` shape so the rest of the package does not depend
 *   on the browser `HIDDevice` interface.
 */

import TransportWebHID from '@ledgerhq/hw-transport-webhid';
import type Transport from '@ledgerhq/hw-transport';

import { asAdapterError, fromLedgerError } from './errors';
import { log } from './log';
import type { AdapterResult } from './types';

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
export async function openLedgerTransport(): Promise<
  AdapterResult<LedgerTransport>
> {
  if (typeof navigator === 'undefined' || !('hid' in navigator)) {
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
    log.info('webhid transport closed');
  } catch (cause) {
    log.warn('webhid close threw — swallowing', {
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

function isWebHidPermissionsPolicyError(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause);
  const lower = message.toLowerCase();
  return lower.includes('permissions policy') && lower.includes('hid');
}

/** Visible for tests. Exposes the vendor id without leaking `@ledgerhq/devices`. */
export const _LEDGER_USB_VENDOR_ID_FOR_TESTS = LEDGER_USB_VENDOR_ID;
