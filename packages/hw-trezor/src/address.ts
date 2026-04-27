/**
 * Trezor receive/change address display for Asylia multisig vaults.
 *
 * The device is asked to derive and show the address from the full
 * `wsh(sortedmulti(...))` multisig description and the selected
 * cosigner path. The returned address is compared with the wallet's
 * locally-derived address before the UI can mark the verification as
 * successful.
 */
import { bip32PathToAddressN } from '@asylia/btc-core';

import { asAdapterError, fromTrezorFailure, fromUnknown } from './errors';
import { log } from './log';
import {
  buildTrezorCosignerNodes,
  buildTrezorMultisigBlock,
  type TrezorMultisig,
} from './multisig';
import { TrezorConnect } from './sdk';
import type {
  AdapterResult,
  DisplayAddressInput,
  DisplayAddressResult,
  TrezorCoin,
  TrezorScriptType,
} from './types';

const SCRIPT_TYPE_MAP: Record<TrezorScriptType, 'SPENDWITNESS'> = {
  p2wsh: 'SPENDWITNESS',
};

/** Conservative ceiling for the user to confirm address display on-device. */
const GET_ADDRESS_TIMEOUT_MS = 90_000;

type TrezorGetAddressInput = {
  path: string;
  coin: TrezorCoin;
  scriptType: 'SPENDWITNESS';
  showOnTrezor: boolean;
  multisig: TrezorMultisig;
  address?: string;
};

type TrezorGetAddressResponse =
  | { success: true; payload: { address: string; path?: string; serializedPath?: string } }
  | { success: false; payload?: { error?: string; code?: string } };

type TrezorAddressClient = {
  getAddress(input: TrezorGetAddressInput): Promise<TrezorGetAddressResponse>;
};

/**
 * Ask Trezor Connect to display one multisig receive/change address and
 * verify that the address returned by the device matches the wallet UI.
 */
export async function displayWshSortedMultiAddress(
  input: DisplayAddressInput,
): Promise<AdapterResult<DisplayAddressResult>> {
  const coin = input.coin ?? 'btc';
  const scriptType = input.scriptType ?? 'p2wsh';
  const sdkScriptType = SCRIPT_TYPE_MAP[scriptType];
  const signerFingerprint = input.signerFingerprint.trim().toLowerCase();
  const expectedAddress = input.expectedAddress.trim();

  log.info('displayWshSortedMultiAddress start', {
    coin,
    scriptType,
    sdkScriptType,
    signerFingerprint,
    chain: input.chain,
    index: input.index,
    requiredSignatures: input.requiredSignatures,
    keyCount: input.keys.length,
  });

  if (scriptType !== 'p2wsh') {
    return {
      ok: false,
      error: asAdapterError(
        'invalid_path',
        `Unsupported script type for Trezor address display: ${scriptType}`,
      ),
    };
  }
  if (!/^[0-9a-f]{8}$/.test(signerFingerprint)) {
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
        'Expected address is required for Trezor address verification.',
      ),
    };
  }
  if (
    !Number.isInteger(input.requiredSignatures) ||
    input.requiredSignatures < 1 ||
    input.requiredSignatures > input.keys.length
  ) {
    return {
      ok: false,
      error: asAdapterError(
        'invalid_path',
        `Invalid threshold ${input.requiredSignatures} for ${input.keys.length} keys.`,
      ),
    };
  }

  const selectedKey = input.keys.find(
    (key) => key.fingerprint.trim().toLowerCase() === signerFingerprint,
  );
  if (!selectedKey) {
    return {
      ok: false,
      error: asAdapterError(
        'invalid_path',
        `No vault cosigner matches fingerprint ${signerFingerprint}.`,
      ),
    };
  }

  let cosignerNodes;
  let signerPath: string;
  let signerAddressN: number[];
  try {
    cosignerNodes = buildTrezorCosignerNodes(input.keys);
    signerPath = `${ensureLeadingMaster(selectedKey.derivationPath)}/${input.chain}/${input.index}`;
    signerAddressN = bip32PathToAddressN(signerPath);
  } catch (cause) {
    log.error('Trezor address display input parsing failed', { error: cause });
    return {
      ok: false,
      error: asAdapterError('invalid_path', (cause as Error).message),
    };
  }

  log.info('getAddress request', {
    path: signerPath,
    addressNLength: signerAddressN.length,
    coin,
    scriptType: sdkScriptType,
    timeoutMs: GET_ADDRESS_TIMEOUT_MS,
  });

  let response: TrezorGetAddressResponse;
  try {
    response = await withTimeout(
      (TrezorConnect as unknown as TrezorAddressClient).getAddress({
        path: signerPath,
        coin,
        scriptType: sdkScriptType,
        showOnTrezor: true,
        address: expectedAddress,
        multisig: buildTrezorMultisigBlock({
          cosignerNodes,
          requiredSignatures: input.requiredSignatures,
          chain: input.chain,
          index: input.index,
        }),
      }),
      GET_ADDRESS_TIMEOUT_MS,
      'getAddress',
    );
  } catch (error: unknown) {
    if (isTimeoutError(error)) {
      log.error('getAddress timed out', { timeoutMs: GET_ADDRESS_TIMEOUT_MS });
      return {
        ok: false,
        error: asAdapterError(
          'device_timeout',
          `timeout after ${GET_ADDRESS_TIMEOUT_MS}ms`,
        ),
      };
    }
    log.error('getAddress threw', { error });
    return { ok: false, error: fromUnknown(error) };
  }

  if (!response.success) {
    log.error('getAddress failed', { response });
    return { ok: false, error: fromTrezorFailure(response) };
  }

  const address = response.payload.address.trim();
  if (address !== expectedAddress) {
    return {
      ok: false,
      error: asAdapterError(
        'descriptor_unavailable',
        `address mismatch: expected ${expectedAddress}, got ${address}`,
      ),
    };
  }

  log.info('displayWshSortedMultiAddress success', {
    address,
    signerFingerprint,
    chain: input.chain,
    index: input.index,
    path: response.payload.serializedPath ?? response.payload.path ?? signerPath,
  });

  return {
    ok: true,
    data: {
      address,
      expectedAddress,
      chain: input.chain,
      index: input.index,
      signerFingerprint,
    },
  };
}

class TrezorTimeoutError extends Error {
  override readonly name = 'TrezorTimeoutError';
  constructor(operation: string, ms: number) {
    super(`${operation} timed out after ${ms}ms`);
  }
}

function isTimeoutError(value: unknown): value is TrezorTimeoutError {
  return value instanceof TrezorTimeoutError;
}

function withTimeout<T>(p: Promise<T>, ms: number, operation: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const handle = setTimeout(() => reject(new TrezorTimeoutError(operation, ms)), ms);
    p.then(
      (value) => {
        clearTimeout(handle);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(handle);
        reject(error);
      },
    );
  });
}

function ensureLeadingMaster(path: string): string {
  const trimmed = path.trim();
  if (trimmed === '' || trimmed === 'm' || trimmed === 'M') return 'm';
  if (trimmed.startsWith('m/') || trimmed.startsWith('M/')) return trimmed;
  return `m/${trimmed}`;
}
