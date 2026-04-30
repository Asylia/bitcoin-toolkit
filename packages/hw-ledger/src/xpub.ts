/**
 * xpub export.
 *
 * The single user-facing operation needed by the "Add a key" flow:
 *
 *   1. Open a WebHID transport and construct an `AppClient` from
 *      `@ledgerhq/ledger-bitcoin` against it.
 *   2. Read the running app name + version via `getAppAndVersion`.
 *      Rejects early if the user is still on the BOLOS dashboard or
 *      has the wrong app open, so the wizard never ships an obscure
 *      `wrong_app` down the line.
 *   3. Ask the device for the master fingerprint via
 *      `getMasterFingerprint` — this does NOT prompt the user and
 *      gives the wizard the 8-hex identity Asylia persists in
 *      `V1_SignKeys.fingerprint`.
 *   4. Ask the device for the BIP-32 extended public key at the
 *      requested derivation path via `getExtendedPubkey`. The user
 *      confirms the export on the device screen.
 *
 * Two device prompts on a fresh pair (`getExtendedPubkey` shows a
 * "Confirm pubkey?" screen on every non-standard path); the Asylia
 * BIP-48 multisig root is treated as "standard" by the Bitcoin app v2
 * so in practice the prompt count collapses to one for the happy
 * path. Descendant addresses for the script branch are derived
 * client-side from `xpub`.
 */

import { AppClient } from '@ledgerhq/ledger-bitcoin';

import { asAdapterError, fromLedgerError } from './errors';
import {
  buildDeviceInfo,
  readAppMetadata,
  readFingerprint,
} from './app';
import {
  emitSyntheticLedgerEvent,
  type LiveLedgerEvent,
} from './events';
import { log } from './log';
import { xpubToMultisigZpub } from './slip132';
import {
  closeLedgerTransport,
  openLedgerTransport,
  type LedgerTransport,
} from './transport';
import type {
  AdapterResult,
  ExportRootInput,
  ExportRootResult,
} from './types';

/**
 * Run the full flow: open transport, check app, read fingerprint,
 * export xpub. Every short-circuit normalises the error and closes
 * the transport so subsequent calls can reopen cleanly.
 */
export async function exportLedgerRoot(
  input: ExportRootInput,
): Promise<AdapterResult<ExportRootResult>> {
  log.info('exportLedgerRoot start', {
    derivationPath: input.derivationPath,
    scriptType: input.scriptType,
    coin: input.coin ?? 'btc',
  });

  if (!isPlausibleBip32Path(input.derivationPath)) {
    return {
      ok: false,
      error: asAdapterError('invalid_path', input.derivationPath),
    };
  }

  const transportResult = await openLedgerTransport();
  if (!transportResult.ok) {
    log.error('exportLedgerRoot: transport open failed', {
      error: transportResult.error,
    });
    return transportResult;
  }
  const transport = transportResult.data;

  // Wire transport-level disconnect into the shared event stream so
  // the wizard can react to a mid-flow unplug before our next APDU
  // rejects.
  attachTransportDisconnectListener(transport);

  const client = new AppClient(transport);

  try {
    // 1. Check running app.
    const app = await readAppMetadata(client);
    if (!app.ok) return app;

    emitSyntheticLedgerEvent({
      phase: 'app_connected',
      appName: app.data.appName,
      appVersion: app.data.appVersion,
    });

    // 2. Master fingerprint. Silent — no device prompt.
    const fingerprintResult = await readFingerprint(client);
    if (!fingerprintResult.ok) return fingerprintResult;

    // 3. xpub export. This is the call that prompts the user on the
    //    physical device for non-standard paths. Broadcast a synthetic
    //    `awaiting_button` so the wizard can flip into "confirm on
    //    device" copy the moment the APDU is in flight.
    emitSyntheticLedgerEvent({
      phase: 'awaiting_button',
      intent: 'Confirm xpub export',
    });

    const xpubResult = await readXpub(client, input.derivationPath);
    if (!xpubResult.ok) return xpubResult;

    emitSyntheticLedgerEvent({
      phase: 'finalising',
      message: 'Public key export approved',
    });

    const xpubMultisig = xpubToMultisigZpub(xpubResult.data);
    if (xpubMultisig === null) {
      log.warn('xpub → Zpub conversion failed; storing legacy xpub only', {
        xpubPreview: xpubResult.data.slice(0, 12) + '…',
      });
    }

    const deviceInfo = buildDeviceInfo({
      transport,
      appName: app.data.appName,
      appVersion: app.data.appVersion,
    });

    log.info('exportLedgerRoot success', {
      masterFingerprint: fingerprintResult.data,
      derivationPath: input.derivationPath,
      device: deviceInfo,
      xpubMultisigPreview: xpubMultisig
        ? xpubMultisig.slice(0, 12) + '…'
        : '(conversion failed)',
    });

    return {
      ok: true,
      data: {
        xpub: xpubResult.data,
        xpubMultisig,
        masterFingerprint: fingerprintResult.data,
        derivationPath: input.derivationPath,
        scriptType: input.scriptType,
        device: deviceInfo,
      },
    };
  } catch (cause) {
    log.error('exportLedgerRoot threw', { error: cause });
    return { ok: false, error: fromLedgerError(cause) };
  } finally {
    await closeLedgerTransport(transport);
  }
}

async function readXpub(
  client: AppClient,
  derivationPath: string,
): Promise<AdapterResult<string>> {
  log.info('getExtendedPubkey request', { derivationPath });
  try {
    // `display: true` forces the Ledger to render the derivation path
    // on its secure screen and refuses to return an xpub until the
    // user physically approves. Asylia deliberately opts into this
    // even for "standard" paths (BIP-48 multisig is allowed silent
    // export by the Bitcoin app v2) because:
    //
    //   - It matches Trezor's behaviour — both device families prompt
    //     on `exportRoot`, so the UX stepper's "Approve on device"
    //     step is truthful across the entire add-key flow.
    //   - It proves physical possession. A silent export would let a
    //     malicious site exfiltrate the xpub of an already-paired
    //     device without the user noticing. The xpub alone cannot
    //     spend funds, but it reveals every past and future receive
    //     address on the branch; refusing the export silently is the
    //     only way to keep that surface private.
    //   - It turns the "gave Asylia a WebHID grant once" permission
    //     into a per-key explicit consent, which is the right bar for
    //     onboarding a cosigner.
    //
    // On device the prompt reads "Confirm public key" / "Path" /
    // "Continue" / "Reject". Rejecting returns status word `0x6985`,
    // which our error mapper resolves to `cancelled` and the wizard
    // surfaces through the standard retry affordance.
    const xpub = await client.getExtendedPubkey(derivationPath, true);
    if (typeof xpub !== 'string' || !xpub.startsWith('xpub')) {
      return {
        ok: false,
        error: asAdapterError(
          'descriptor_unavailable',
          `unexpected xpub shape: ${typeof xpub === 'string' ? xpub.slice(0, 8) : typeof xpub}…`,
        ),
      };
    }
    log.info('getExtendedPubkey success', {
      xpubPreview: xpub.slice(0, 12) + '…',
    });
    return { ok: true, data: xpub };
  } catch (cause) {
    log.error('getExtendedPubkey threw', { error: cause });
    return { ok: false, error: fromLedgerError(cause) };
  }
}

/**
 * Cheap pre-flight on the derivation path. Mirrors the regex Asylia
 * stores in the `V1_SignKeys.derivation_root_format` CHECK constraint
 * so a malformed path is caught before it leaves the browser.
 */
function isPlausibleBip32Path(path: string): boolean {
  return /^m(\/[0-9]+(['h])?)*$/.test(path.trim());
}

/**
 * Wire the transport's own disconnect event into the shared event
 * stream. The WebHID transport emits `'disconnect'` when the device
 * is unplugged mid-APDU or another tab grabs the session. Without
 * this hook the wizard would only see the disconnect through the
 * `navigator.hid` listeners — which also fire, but slightly later
 * and with less transport context.
 */
function attachTransportDisconnectListener(transport: LedgerTransport): void {
  // `Transport.on` is typed loosely upstream (event name is a free
  // string). Casting to the narrow shape we need avoids dragging the
  // full transport type surface into consumers.
  type MaybeEmitter = {
    on?: (event: string, cb: (err: unknown) => void) => void;
  };
  const emitter = transport as unknown as MaybeEmitter;
  if (typeof emitter.on !== 'function') return;
  emitter.on('disconnect', (reason) => {
    const event: LiveLedgerEvent = {
      phase: 'transport_error',
      message:
        reason instanceof Error
          ? reason.message
          : typeof reason === 'string'
            ? reason
            : 'Transport disconnected',
    };
    log.warn('transport disconnect event', { message: event.message });
    emitSyntheticLedgerEvent(event);
  });
}
