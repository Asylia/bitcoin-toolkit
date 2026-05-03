/**
 * Ledger receive/change address display for Asylia multisig policies.
 *
 * Ledger's Bitcoin app does not accept an arbitrary address string for
 * display. For multisig wallets it derives the address from the registered
 * wallet policy plus the stored policy HMAC, then shows that device-derived
 * address on the secure screen. The wallet compares the returned value with
 * the software-derived address before telling the user the address is safe.
 */
import { Buffer } from 'buffer';
import { AppClient } from '@ledgerhq/ledger-bitcoin';

import {
  buildDeviceInfo,
  readAppMetadata,
  readFingerprint,
} from './app';
import { asAdapterError, fromLedgerError } from './errors';
import { emitSyntheticLedgerEvent } from './events';
import { log } from './log';
import { buildLedgerWalletPolicyForDevice } from './policy';
import {
  closeLedgerTransport,
  openLedgerTransport,
} from './transport';
import type {
  AdapterResult,
  DisplayAddressInput,
  DisplayAddressResult,
} from './types';

/**
 * Ask the connected Ledger to display one address from a registered
 * `wsh(sortedmulti(...))` wallet policy, then verify the returned address
 * against the wallet's expected value.
 */
export async function displayWshSortedMultiAddress(
  input: DisplayAddressInput,
): Promise<AdapterResult<DisplayAddressResult>> {
  const scriptType = input.scriptType ?? 'p2wsh';
  const requestedFingerprint = input.signerFingerprint.trim().toLowerCase();
  const expectedAddress = input.expectedAddress.trim();

  log.info('displayWshSortedMultiAddress start', {
    scriptType,
    requestedFingerprint,
    keyCount: input.vault.keys.length,
    requiredSignatures: input.vault.requiredSignatures,
    policyId: input.policyId ?? null,
    chain: input.chain,
    index: input.index,
    transport: input.transport ?? 'auto',
  });

  if (scriptType !== 'p2wsh') {
    return {
      ok: false,
      error: asAdapterError(
        'invalid_path',
        `Unsupported script type for Ledger address display: ${scriptType}`,
      ),
    };
  }
  if (!/^[0-9a-f]{8}$/.test(requestedFingerprint)) {
    return {
      ok: false,
      error: asAdapterError(
        'invalid_path',
        `Master fingerprint must be 8 lowercase hex characters (got "${input.signerFingerprint}").`,
      ),
    };
  }
  if (input.chain !== 0 && input.chain !== 1) {
    return {
      ok: false,
      error: asAdapterError(
        'invalid_path',
        `Address chain must be 0 or 1 (got ${input.chain as number}).`,
      ),
    };
  }
  if (!Number.isInteger(input.index) || input.index < 0) {
    return {
      ok: false,
      error: asAdapterError(
        'invalid_path',
        `Address index must be a non-negative integer (got ${input.index}).`,
      ),
    };
  }
  if (!expectedAddress) {
    return {
      ok: false,
      error: asAdapterError(
        'invalid_path',
        'Expected address is required for Ledger address verification.',
      ),
    };
  }

  const policy = buildLedgerWalletPolicyForDevice(input.vault);
  if (!policy.ok) return policy;
  const expectedPolicyId = input.policyId?.trim().toLowerCase();
  if (expectedPolicyId && expectedPolicyId !== policy.data.policyId) {
    return {
      ok: false,
      error: asAdapterError(
        'descriptor_unavailable',
        `policy id mismatch: expected ${expectedPolicyId}, rebuilt ${policy.data.policyId}`,
      ),
    };
  }

  const hmac = parsePolicyHmac(input.policyHmac);
  if (!hmac.ok) return hmac;

  const transportResult = await openLedgerTransport({
    transport: input.transport ?? 'auto',
  });
  if (!transportResult.ok) return transportResult;
  const transport = transportResult.data;
  const client = new AppClient(transport);

  try {
    const app = await readAppMetadata(client);
    if (!app.ok) return app;
    emitSyntheticLedgerEvent({
      phase: 'app_connected',
      appName: app.data.appName,
      appVersion: app.data.appVersion,
    });

    const fingerprint = await readFingerprint(client);
    if (!fingerprint.ok) return fingerprint;
    if (fingerprint.data !== requestedFingerprint) {
      return {
        ok: false,
        error: asAdapterError(
          'wrong_device',
          `expected ${requestedFingerprint}, got ${fingerprint.data}`,
        ),
      };
    }

    emitSyntheticLedgerEvent({
      phase: 'awaiting_button',
      intent: 'Verify receive address',
    });

    const address = await client.getWalletAddress(
      policy.data.policy,
      hmac.data,
      input.chain,
      input.index,
      true,
    );

    emitSyntheticLedgerEvent({
      phase: 'finalising',
      message: 'Address display approved',
    });

    if (address !== expectedAddress) {
      return {
        ok: false,
        error: asAdapterError(
          'descriptor_unavailable',
          `address mismatch: expected ${expectedAddress}, got ${address}`,
        ),
      };
    }

    const device = buildDeviceInfo({
      transport,
      appName: app.data.appName,
      appVersion: app.data.appVersion,
    });

    log.info('displayWshSortedMultiAddress success', {
      address,
      policyId: policy.data.policyId,
      requestedFingerprint,
      chain: input.chain,
      index: input.index,
      device,
    });

    return {
      ok: true,
      data: {
        address,
        expectedAddress,
        chain: input.chain,
        index: input.index,
        signerFingerprint: requestedFingerprint,
        policyId: policy.data.policyId,
        device,
      },
    };
  } catch (cause) {
    log.error('displayWshSortedMultiAddress threw', { error: cause });
    return { ok: false, error: fromLedgerError(cause) };
  } finally {
    await closeLedgerTransport(transport);
  }
}

function parsePolicyHmac(value: string): AdapterResult<Buffer> {
  const hex = value.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    return {
      ok: false,
      error: asAdapterError(
        'descriptor_unavailable',
        'Ledger policy HMAC must be a 32-byte hex string.',
      ),
    };
  }
  return { ok: true, data: Buffer.from(hex, 'hex') };
}
