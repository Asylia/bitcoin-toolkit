/**
 * Trezor Connect bootstrap.
 *
 * `TrezorConnect.init` may only be called once per page load. This module
 * wraps that constraint behind an idempotent `initTrezor()` so the wallet
 * can call it as part of the "Add a key" flow without worrying whether
 * another surface (e.g. the create-vault flow) already did.
 *
 * Strategy:
 *   - The first caller wins and owns the in-flight init Promise.
 *   - Subsequent callers (concurrent or later) await the same Promise.
 *   - The result is cached so re-opening the modal is a no-op.
 *   - If init fails, the cached failure is cleared so a follow-up call
 *     can retry against a fresh state (e.g. after the user installs
 *     Trezor Bridge and reloads).
 *
 * Logging: every lifecycle step prints a structured `[hw-trezor]` line
 * to the console. When `debug` is enabled, the Trezor SDK itself also
 * prints its internal traffic — invaluable for diagnosing iframe /
 * transport problems that the Asylia error mapping cannot fully capture.
 */

import { asAdapterError, fromUnknown } from './errors';
import { log } from './log';
import { TrezorConnect } from './sdk';
import type { AdapterResult, TrezorManifest } from './types';

let pending: Promise<AdapterResult<true>> | null = null;
let initialized = false;

export type InitOptions = {
  manifest: TrezorManifest;
  /**
   * When `true`, forwards `debug: true` to `TrezorConnect.init` so the
   * SDK prints its own internal logs. Recommended for development.
   */
  debug?: boolean;
};

/**
 * Initialise Trezor Connect once per page. Safe to call from any number
 * of parallel call sites — only the first one actually runs the SDK init.
 *
 * Use the default `coreMode: 'auto'` so the SDK picks `iframe` when
 * Trezor Bridge is present (persistent connection, device events stream
 * back to the SPA) and `popup` otherwise (one popup per call, but works
 * cross-origin via WebUSB without Bridge).
 */
export async function initTrezor(
  options: InitOptions | TrezorManifest,
): Promise<AdapterResult<true>> {
  // Backwards-compat: accept either `{ manifest, debug }` or a bare
  // manifest object. Internally we always work with `InitOptions`.
  const normalized: InitOptions = isInitOptions(options)
    ? options
    : { manifest: options };

  if (initialized) {
    log.info('init skipped (already initialised)');
    return { ok: true, data: true };
  }
  if (pending) {
    log.info('init in flight, awaiting existing promise');
    return pending;
  }

  const { manifest, debug = false } = normalized;
  if (!manifest?.appName || !manifest?.appUrl || !manifest?.email) {
    log.error('manifest missing required fields', { manifest });
    return { ok: false, error: asAdapterError('manifest_required') };
  }

  log.info('init start', { manifest, debug });

  pending = (async (): Promise<AdapterResult<true>> => {
    try {
      await TrezorConnect.init({
        manifest,
        debug,
        // Postpone iframe creation until the first method call so the SDK
        // is not loaded into a cold page if the user never reaches the
        // Add Key flow.
        lazyLoad: true,
      });
      initialized = true;
      log.info('init success');
      return { ok: true, data: true };
    } catch (error: unknown) {
      const adapterError = fromUnknown(error, 'init_failed');
      log.error('init failed', { error, adapterError });
      return { ok: false, error: adapterError };
    } finally {
      // On failure, clear the cached promise so the next call can retry
      // (e.g. after the user installs Bridge or reloads). On success
      // `initialized` is already `true` so we never re-run init.
      if (!initialized) pending = null;
    }
  })();

  return pending;
}

function isInitOptions(value: InitOptions | TrezorManifest): value is InitOptions {
  return 'manifest' in (value as InitOptions);
}

/**
 * Visible for testing and for surfaces that want to dispose the SDK
 * (e.g. a future "sign out and forget Trezor" action). The Trezor SDK
 * has no first-class "destroy" hook for the web build, so this only
 * resets the local guards; a full reset still requires a page reload.
 */
export function _resetTrezorInitForTests(): void {
  pending = null;
  initialized = false;
}
