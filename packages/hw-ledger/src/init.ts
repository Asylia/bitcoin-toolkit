/**
 * Ledger SDK bootstrap.
 *
 * Unlike Trezor's `TrezorConnect.init`, the Ledger stack does not ship
 * a blocking bootstrap call — `@ledgerhq/ledger-bitcoin`'s `AppClient` is cheap
 * to construct and the WebHID transport opens lazily. The file still
 * exists so the service layer can keep a single "ready for device
 * traffic" gate with symmetric call sites to `@asylia/hw-trezor`'s
 * `initTrezor()`.
 *
 * Currently the only side-effect is a runtime check that the page is
 * served in a secure context and has at least one Ledger browser
 * transport available. WebHID and Web Bluetooth are only exposed over
 * HTTPS (or localhost), and calls from a non-secure origin fail with
 * obscure `SecurityError`s. Detecting this early gives the wallet a
 * precise `transport_unavailable` error instead of an opaque one later.
 */

import { asAdapterError } from './errors';
import { log } from './log';
import type { AdapterResult, LedgerTransportPreference } from './types';

let initialized = false;

export type LedgerInitOptions = {
  /**
   * Reserved for forward-compatibility. No Ledger SDK today emits
   * debug traces comparable to `@trezor/connect`'s `debug: true`;
   * accepting the flag keeps call sites in the wallet symmetric.
   */
  debug?: boolean;
  /** Browser transport channel to preflight. Defaults to `'auto'`. */
  transport?: LedgerTransportPreference;
};

/**
 * Idempotent init. The first call validates the environment; later
 * calls are no-ops so any surface (AddKeyModal, create-vault flow,
 * signing modal) can call this defensively at the top of its flow
 * without worrying about other surfaces having done it first.
 */
export async function initLedger(
  options: LedgerInitOptions = {},
): Promise<AdapterResult<true>> {
  if (initialized) {
    log.info('init skipped (already initialised)');
    return { ok: true, data: true };
  }

  const transport = options.transport ?? 'auto';
  log.info('init start', { options: { ...options, transport } });

  // WebHID and the related device APIs only exist on secure origins.
  if (typeof window !== 'undefined' && window.isSecureContext === false) {
    log.error('init failed: insecure context', {
      location: window.location?.href,
    });
    return {
      ok: false,
      error: asAdapterError(
        'transport_unavailable',
        'window.isSecureContext is false — WebHID is unavailable on non-HTTPS origins',
      ),
    };
  }

  if (!hasRequestedTransport(transport)) {
    log.error('init failed: requested transport missing', { transport });
    return {
      ok: false,
      error: asAdapterError(
        'transport_unavailable',
        transport === 'webble'
          ? 'navigator.bluetooth unavailable — use a browser with Web Bluetooth support'
          : transport === 'webhid'
            ? 'navigator.hid unavailable — use a Chromium-based browser with WebHID support'
            : 'navigator.hid and navigator.bluetooth unavailable — use a browser with WebHID or Web Bluetooth support',
      ),
    };
  }

  initialized = true;
  log.info('init success');
  return { ok: true, data: true };
}

/**
 * Visible for tests and for surfaces that want to rerun the pre-flight
 * (e.g. after a page-level reload or a switch between HTTPS origins).
 * The Ledger WebHID transport has no destroy hook — closing the
 * transport is handled per-flow in `transport.ts`.
 */
export function _resetLedgerInitForTests(): void {
  initialized = false;
}

function hasRequestedTransport(transport: LedgerTransportPreference): boolean {
  if (typeof navigator === 'undefined') return false;
  const browserNavigator = navigator as unknown as Record<string, unknown>;
  const hasHid = 'hid' in browserNavigator;
  const hasBluetooth = 'bluetooth' in browserNavigator;
  if (transport === 'webhid') return hasHid;
  if (transport === 'webble') return hasBluetooth;
  return hasHid || hasBluetooth;
}
