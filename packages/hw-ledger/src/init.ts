/**
 * Ledger SDK bootstrap.
 *
 * Unlike Trezor's `TrezorConnect.init`, the Ledger stack does not ship
 * a blocking bootstrap call — `ledger-bitcoin`'s `AppClient` is cheap
 * to construct and the WebHID transport opens lazily. The file still
 * exists so the service layer can keep a single "ready for device
 * traffic" gate with symmetric call sites to `@asylia/hw-trezor`'s
 * `initTrezor()`.
 *
 * Currently the only side-effect is a runtime check that the page is
 * served in a secure context — WebHID is only exposed over HTTPS (or
 * localhost) and any call from a non-secure origin fails with an
 * obscure `SecurityError`. Detecting this early gives the wallet a
 * precise `transport_unavailable` error instead of an opaque one later.
 */

import { asAdapterError } from './errors';
import { log } from './log';
import type { AdapterResult } from './types';

let initialized = false;

export type LedgerInitOptions = {
  /**
   * Reserved for forward-compatibility. No Ledger SDK today emits
   * debug traces comparable to `@trezor/connect`'s `debug: true`;
   * accepting the flag keeps call sites in the wallet symmetric.
   */
  debug?: boolean;
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

  log.info('init start', { options });

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

  if (typeof navigator === 'undefined' || !('hid' in navigator)) {
    log.error('init failed: navigator.hid missing');
    return {
      ok: false,
      error: asAdapterError(
        'transport_unavailable',
        'navigator.hid unavailable — use a Chromium-based browser with WebHID support',
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
