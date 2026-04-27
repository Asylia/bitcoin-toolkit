/**
 * Shared Ledger Bitcoin app helpers.
 *
 * The xpub export and wallet-policy registration flows both need the
 * same pre-flight: verify the running app, read the master fingerprint,
 * and shape a stable device descriptor for UI diagnostics. Keeping it
 * here prevents the two hardware flows from drifting apart.
 */
import type { AppClient } from 'ledger-bitcoin';

import { asAdapterError, fromLedgerError } from './errors';
import { log } from './log';
import {
  friendlyProductName,
  transportHidInfo,
  type LedgerTransport,
} from './transport';
import type { AdapterResult, LedgerDeviceInfo } from './types';

/**
 * Minimum Bitcoin app version that supports the multisig policy flow
 * Asylia needs for `wsh(sortedmulti(...))`. The `ledger-bitcoin`
 * client itself documents this as the lower bound for `AppClient`.
 */
export const MIN_BITCOIN_APP_VERSION = '2.1.0';

export async function readAppMetadata(
  client: AppClient,
): Promise<AdapterResult<{ appName: string; appVersion: string }>> {
  log.info('getAppAndVersion request');
  try {
    const info = await client.getAppAndVersion();
    log.info('getAppAndVersion success', info);
    if (info.name !== 'Bitcoin' && info.name !== 'Bitcoin Test') {
      return {
        ok: false,
        error: asAdapterError(
          info.name === 'BOLOS' ? 'app_not_open' : 'wrong_app',
          `app name: ${info.name}`,
        ),
      };
    }
    if (!isVersionAtLeast(info.version, MIN_BITCOIN_APP_VERSION)) {
      return {
        ok: false,
        error: asAdapterError(
          'app_outdated',
          `Bitcoin app ${info.version} < required ${MIN_BITCOIN_APP_VERSION}`,
        ),
      };
    }
    return { ok: true, data: { appName: info.name, appVersion: info.version } };
  } catch (cause) {
    log.error('getAppAndVersion threw', { error: cause });
    return { ok: false, error: fromLedgerError(cause, 'app_not_open') };
  }
}

export async function readFingerprint(
  client: AppClient,
): Promise<AdapterResult<string>> {
  log.info('getMasterFingerprint request');
  try {
    const fingerprint = await client.getMasterFingerprint();
    // Ledger returns an 8-hex string already. Normalise to lowercase
    // so the database identity stays case-insensitive.
    const normalised = fingerprint.trim().toLowerCase();
    if (!/^[0-9a-f]{8}$/.test(normalised)) {
      return {
        ok: false,
        error: asAdapterError(
          'descriptor_unavailable',
          `unexpected fingerprint shape: ${fingerprint}`,
        ),
      };
    }
    log.info('getMasterFingerprint success', { fingerprint: normalised });
    return { ok: true, data: normalised };
  } catch (cause) {
    log.error('getMasterFingerprint threw', { error: cause });
    return { ok: false, error: fromLedgerError(cause) };
  }
}

export function buildDeviceInfo(input: {
  transport: LedgerTransport;
  appName: string;
  appVersion: string;
}): LedgerDeviceInfo {
  const hid = transportHidInfo(input.transport);
  return {
    model: friendlyProductName(hid),
    productId: hid.productId,
    appName: input.appName,
    appVersion: input.appVersion,
  };
}

/**
 * Best-effort semver-ish comparison. Ledger app versions are always
 * `major.minor.patch` so a three-segment numeric parse is enough.
 */
function isVersionAtLeast(actual: string, required: string): boolean {
  const a = actual.split('.').map((part) => parseInt(part, 10));
  const r = required.split('.').map((part) => parseInt(part, 10));
  for (let i = 0; i < r.length; i += 1) {
    const av = a[i] ?? 0;
    const rv = r[i] ?? 0;
    if (Number.isNaN(av) || Number.isNaN(rv)) return false;
    if (av > rv) return true;
    if (av < rv) return false;
  }
  return true;
}
