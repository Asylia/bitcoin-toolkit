/**
 * Ledger wallet-policy registration for Asylia multisig vaults.
 *
 * Ledger Bitcoin app v2 does not persist an arbitrary multisig wallet
 * internally. Instead, it asks the user to approve a deterministic
 * wallet policy and returns a `policyHmac`. Asylia stores that HMAC
 * next to the policy details, then reuses it later for address display
 * and PSBT signing.
 */
import { AppClient, WalletPolicy } from '@ledgerhq/ledger-bitcoin';
import {
  canonicalizeDerivationPath,
  stripMasterPrefix,
  toCanonicalXpub,
} from '@asylia/btc-core';

import {
  buildDeviceInfo,
  readAppMetadata,
  readFingerprint,
} from './app';
import { asAdapterError, fromLedgerError } from './errors';
import { emitSyntheticLedgerEvent } from './events';
import { log } from './log';
import {
  closeLedgerTransport,
  openLedgerTransport,
} from './transport';
import type {
  AdapterResult,
  LedgerWalletPolicyDetails,
  LedgerWalletPolicyInput,
  RegisterLedgerWalletPolicyResult,
} from './types';

type NormalisedPolicyKey = {
  fingerprint: string;
  derivationPath: string;
  xpub: string;
};

export type BuiltLedgerPolicy = LedgerWalletPolicyDetails & {
  policy: WalletPolicy;
};

/**
 * Build the deterministic Ledger policy preview without opening a device.
 * The UI uses this to decide whether a matching policy HMAC is already
 * stored for a recreated/imported vault.
 */
export function buildLedgerWalletPolicy(
  input: Omit<LedgerWalletPolicyInput, 'targetFingerprint'>,
): AdapterResult<LedgerWalletPolicyDetails> {
  const built = buildLedgerWalletPolicyForDevice(input);
  if (!built.ok) return built;
  const { policy: _policy, ...details } = built.data;
  return { ok: true, data: details };
}

/**
 * Build the Ledger SDK `WalletPolicy` together with the stable Asylia
 * details. Kept exported inside the package so signing can reuse the
 * exact same policy bytes as registration — policy id drift would make a
 * stored HMAC unusable and could ask the device to sign a different
 * wallet than the one the operator registered.
 */
export function buildLedgerWalletPolicyForDevice(input: {
  requiredSignatures: number;
  keys: readonly LedgerWalletPolicyInput['keys'][number][];
}): AdapterResult<BuiltLedgerPolicy> {
  return buildPolicy(input);
}

/**
 * Register the vault policy on the connected Ledger. The connected
 * device fingerprint must match the Ledger signer selected in the UI;
 * otherwise the operator could accidentally approve the right policy
 * on the wrong hardware wallet.
 */
export async function registerLedgerWalletPolicy(
  input: LedgerWalletPolicyInput,
): Promise<AdapterResult<RegisterLedgerWalletPolicyResult>> {
  log.info('registerLedgerWalletPolicy start', {
    requiredSignatures: input.requiredSignatures,
    totalKeys: input.keys.length,
    targetFingerprint: input.targetFingerprint,
    transport: input.transport ?? 'auto',
  });

  const built = buildLedgerWalletPolicyForDevice(input);
  if (!built.ok) return built;

  const transportResult = await openLedgerTransport({
    transport: input.transport ?? 'auto',
  });
  if (!transportResult.ok) {
    log.error('registerLedgerWalletPolicy: transport open failed', {
      error: transportResult.error,
    });
    return transportResult;
  }
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
    const target = input.targetFingerprint.trim().toLowerCase();
    if (fingerprint.data !== target) {
      return {
        ok: false,
        error: asAdapterError(
          'wrong_device',
          `expected ${target}, got ${fingerprint.data}`,
        ),
      };
    }

    emitSyntheticLedgerEvent({
      phase: 'awaiting_button',
      intent: 'Approve wallet policy',
    });

    const [policyId, policyHmac] = await client.registerWallet(
      built.data.policy,
    );
    const policyIdHex = bytesToHex(policyId);
    if (policyIdHex !== built.data.policyId) {
      return {
        ok: false,
        error: asAdapterError(
          'descriptor_unavailable',
          `policy id mismatch: expected ${built.data.policyId}, got ${policyIdHex}`,
        ),
      };
    }

    const device = buildDeviceInfo({
      transport,
      appName: app.data.appName,
      appVersion: app.data.appVersion,
    });

    log.info('registerLedgerWalletPolicy success', {
      policyName: built.data.policyName,
      policyId: built.data.policyId,
      fingerprint: fingerprint.data,
      device,
    });

    return {
      ok: true,
      data: {
        policyName: built.data.policyName,
        descriptorTemplate: built.data.descriptorTemplate,
        keyInfo: built.data.keyInfo,
        policyId: built.data.policyId,
        policyHmac: bytesToHex(policyHmac),
        registeredFingerprint: fingerprint.data,
        device,
      },
    };
  } catch (cause) {
    log.error('registerLedgerWalletPolicy threw', { error: cause });
    return { ok: false, error: fromLedgerError(cause) };
  } finally {
    await closeLedgerTransport(transport);
  }
}

function buildPolicy(input: {
  requiredSignatures: number;
  keys: readonly LedgerWalletPolicyInput['keys'][number][];
}): AdapterResult<BuiltLedgerPolicy> {
  if (
    !Number.isInteger(input.requiredSignatures) ||
    input.requiredSignatures < 1 ||
    input.requiredSignatures > input.keys.length
  ) {
    return {
      ok: false,
      error: asAdapterError(
        'descriptor_unavailable',
        `invalid threshold ${input.requiredSignatures} for ${input.keys.length} keys`,
      ),
    };
  }

  const normalised = normaliseKeys(input.keys);
  if (!normalised.ok) return normalised;

  const descriptorTemplate = `wsh(sortedmulti(${input.requiredSignatures},${normalised.data
    .map((_key, index) => `@${index}/**`)
    .join(',')}))`;
  const keyInfo = normalised.data.map(
    (key) => `[${key.fingerprint}/${key.derivationPath}]${key.xpub}`,
  );
  const policyName = buildPolicyName({
    requiredSignatures: input.requiredSignatures,
    totalKeys: normalised.data.length,
    descriptorTemplate,
    keyInfo,
  });
  const policy = new WalletPolicy(policyName, descriptorTemplate, keyInfo);

  return {
    ok: true,
    data: {
      policy,
      policyName,
      descriptorTemplate,
      keyInfo,
      policyId: bytesToHex(policy.getId()),
    },
  };
}

function normaliseKeys(
  keys: readonly LedgerWalletPolicyInput['keys'][number][],
): AdapterResult<NormalisedPolicyKey[]> {
  const out: NormalisedPolicyKey[] = [];

  for (const [index, key] of keys.entries()) {
    const fingerprint = key.fingerprint.trim().toLowerCase();
    if (!/^[0-9a-f]{8}$/.test(fingerprint)) {
      return {
        ok: false,
        error: asAdapterError(
          'descriptor_unavailable',
          `key ${index + 1}: invalid fingerprint ${key.fingerprint}`,
        ),
      };
    }

    const xpub = toCanonicalXpub(key.xpub.trim());
    if (!xpub) {
      return {
        ok: false,
        error: asAdapterError(
          'descriptor_unavailable',
          `key ${index + 1}: invalid xpub`,
        ),
      };
    }

    out.push({
      fingerprint,
      derivationPath: canonicalizeDerivationPath(
        stripMasterPrefix(key.derivationPath.trim()),
      ),
      xpub,
    });
  }

  out.sort((a, b) => {
    if (a.xpub !== b.xpub) return a.xpub < b.xpub ? -1 : 1;
    if (a.fingerprint !== b.fingerprint) {
      return a.fingerprint < b.fingerprint ? -1 : 1;
    }
    if (a.derivationPath !== b.derivationPath) {
      return a.derivationPath < b.derivationPath ? -1 : 1;
    }
    return 0;
  });

  return { ok: true, data: out };
}

function buildPolicyName(input: {
  requiredSignatures: number;
  totalKeys: number;
  descriptorTemplate: string;
  keyInfo: readonly string[];
}): string {
  const suffix = fnv1a32(
    `${input.descriptorTemplate}|${input.keyInfo.join('|')}`,
  )
    .toString(16)
    .padStart(8, '0');
  return `Asylia ${input.requiredSignatures}-of-${input.totalKeys} ${suffix}`;
}

/**
 * Non-cryptographic display disambiguator for the Ledger policy name.
 * Security comes from the policy id / HMAC returned by the device; this
 * suffix only helps humans tell similarly-shaped policies apart.
 */
function fnv1a32(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function bytesToHex(value: Uint8Array): string {
  return Array.from(value)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
