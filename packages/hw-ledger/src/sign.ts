/**
 * Ledger signing for Asylia `wsh(sortedmulti(...))` vault PSBTs.
 *
 * Ledger's Bitcoin app signs against a registered wallet policy rather
 * than a Trezor-style transaction description. Registration returns a
 * policy HMAC; signing rebuilds the same deterministic policy, verifies
 * that the connected Ledger is the signer the operator picked, passes
 * the PSBT and HMAC to `signPsbt`, then verifies every returned partial
 * signature before merging it back into the PSBT.
 */
import { Buffer } from 'buffer';
import { AppClient } from '@ledgerhq/ledger-bitcoin';
import {
  addPartialSignaturesToPsbt,
  inspectPsbtV2,
  PsbtInspectError,
  verifySegwitV0SignatureAgainstPubkey,
  type PartialSignatureToAdd,
  type PsbtBip32Derivation,
} from '@asylia/btc-core';

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
  SignPsbtInput,
  SignPsbtResult,
} from './types';

/** Drive a Ledger through the PSBT signing flow for an installed policy. */
export async function signWshSortedMultiPsbt(
  input: SignPsbtInput,
): Promise<AdapterResult<SignPsbtResult>> {
  const scriptType = input.scriptType ?? 'p2wsh';
  const requestedFingerprint = input.signerFingerprint.trim().toLowerCase();

  log.info('signWshSortedMultiPsbt start', {
    scriptType,
    requestedFingerprint,
    keyCount: input.vault.keys.length,
    requiredSignatures: input.vault.requiredSignatures,
    psbtLengthChars: input.psbtBase64.length,
    policyId: input.policyId ?? null,
    transport: input.transport ?? 'auto',
  });

  if (scriptType !== 'p2wsh') {
    return {
      ok: false,
      error: asAdapterError(
        'invalid_path',
        `Unsupported script type for Ledger signing: ${scriptType}`,
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

  let inspected;
  try {
    inspected = inspectPsbtV2(input.psbtBase64);
  } catch (cause) {
    return {
      ok: false,
      error: asAdapterError(
        'invalid_path',
        cause instanceof PsbtInspectError
          ? cause.message
          : `PSBT inspection failed: ${(cause as Error).message}`,
      ),
    };
  }

  const signableInputs = inspected.inputs.filter((psbtInput) =>
    psbtInput.bip32Derivation.some(
      (entry) => bytesToHex(entry.masterFingerprint) === requestedFingerprint,
    ),
  ).length;
  if (signableInputs === 0) {
    return {
      ok: false,
      error: asAdapterError(
        'invalid_path',
        'No PSBT input belongs to the connected Ledger signer — nothing to sign.',
      ),
    };
  }

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
      intent: 'Approve transaction signing',
    });

    const signatures = await client.signPsbt(
      input.psbtBase64,
      policy.data.policy,
      hmac.data,
      () => {
        log.info('signPsbt progress: partial signature produced');
      },
    );

    emitSyntheticLedgerEvent({
      phase: 'finalising',
      message: 'Transaction signing approved',
    });

    const toMerge: PartialSignatureToAdd[] = [];
    for (const [inputIndex, partial] of signatures) {
      if (
        !Number.isInteger(inputIndex) ||
        inputIndex < 0 ||
        inputIndex >= inspected.inputs.length
      ) {
        return {
          ok: false,
          error: asAdapterError(
            'unknown',
            `Ledger returned a signature for invalid input index ${inputIndex}.`,
          ),
        };
      }

      const pubkey = new Uint8Array(partial.pubkey);
      const signature = normaliseLedgerSignature(new Uint8Array(partial.signature));
      const owner = findDerivationForPubkey(
        inspected.inputs[inputIndex]!.bip32Derivation,
        pubkey,
      );
      if (!owner) {
        return {
          ok: false,
          error: asAdapterError(
            'unknown',
            `Ledger returned a signature for input ${inputIndex}, but the pubkey is not part of this PSBT input.`,
          ),
        };
      }

      const signedAsFingerprint = bytesToHex(owner.masterFingerprint);
      if (signedAsFingerprint !== requestedFingerprint) {
        return {
          ok: false,
          error: asAdapterError(
            'wrong_device',
            `expected ${requestedFingerprint}, signature belongs to ${signedAsFingerprint}`,
          ),
        };
      }
      if (
        !verifySegwitV0SignatureAgainstPubkey(
          inspected,
          inputIndex,
          pubkey,
          signature,
        )
      ) {
        return {
          ok: false,
          error: asAdapterError(
            'unknown',
            `The Ledger signature for input ${inputIndex} does not verify against the PSBT sighash.`,
          ),
        };
      }

      toMerge.push({ inputIndex, pubkey, signature });
    }

    if (toMerge.length === 0) {
      return {
        ok: false,
        error: asAdapterError(
          'unknown',
          'The Ledger approved the request but returned no signatures for this PSBT.',
        ),
      };
    }

    let merged: string;
    try {
      merged = addPartialSignaturesToPsbt(input.psbtBase64, toMerge);
    } catch (cause) {
      return {
        ok: false,
        error: asAdapterError(
          'unknown',
          cause instanceof Error
            ? cause.message
            : 'Could not merge Ledger signatures into the PSBT.',
        ),
      };
    }

    const device = buildDeviceInfo({
      transport,
      appName: app.data.appName,
      appVersion: app.data.appVersion,
    });

    log.info('signWshSortedMultiPsbt success', {
      signedInputCount: toMerge.length,
      requestedFingerprint,
      policyId: policy.data.policyId,
      device,
      psbtLengthChars: merged.length,
    });

    return {
      ok: true,
      data: {
        psbtBase64: merged,
        signedInputCount: toMerge.length,
        requestedFingerprint,
        signedAsFingerprint: requestedFingerprint,
        pivoted: false,
      },
    };
  } catch (cause) {
    log.error('signWshSortedMultiPsbt threw', { error: cause });
    return { ok: false, error: fromLedgerError(cause) };
  } finally {
    await closeLedgerTransport(transport);
  }
}

function parsePolicyHmac(
  value: string,
): AdapterResult<Buffer> {
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

function findDerivationForPubkey(
  entries: readonly PsbtBip32Derivation[],
  pubkey: Uint8Array,
): PsbtBip32Derivation | null {
  for (const entry of entries) {
    if (bytesEqual(entry.pubkey, pubkey)) return entry;
  }
  return null;
}

function normaliseLedgerSignature(signature: Uint8Array): Uint8Array {
  if (looksLikeDerSignature(signature)) return signature;
  if (
    signature.length > 0 &&
    signature[signature.length - 1] === 0x01 &&
    looksLikeDerSignature(signature.slice(0, -1))
  ) {
    return signature.slice(0, -1);
  }
  return signature;
}

function looksLikeDerSignature(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false;
  if (bytes[0] !== 0x30) return false;
  const sequenceLength = bytes[1];
  if (sequenceLength === undefined || sequenceLength + 2 !== bytes.length) {
    return false;
  }
  if (bytes[2] !== 0x02) return false;
  const rLength = bytes[3];
  if (rLength === undefined || rLength === 0) return false;
  const sTagIndex = 4 + rLength;
  if (sTagIndex + 2 > bytes.length) return false;
  if (bytes[sTagIndex] !== 0x02) return false;
  const sLength = bytes[sTagIndex + 1];
  if (sLength === undefined || sLength === 0) return false;
  return sTagIndex + 2 + sLength === bytes.length;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += (bytes[i] ?? 0).toString(16).padStart(2, '0');
  }
  return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
