import { TrezorConnect } from './sdk';
import { asAdapterError, fromTrezorFailure, fromUnknown } from './errors';
import { log } from './log';
import { signWshSortedMultiPsbt } from './sign';
import type { AdapterResult, TrezorAdapterError } from './types';
import { stripMasterPrefix } from '@asylia/btc-core';

type TrezorSignMessageApi = {
  signMessage(input: {
    path: string;
    message: string;
    coin?: string;
    hex?: boolean;
  }): Promise<
    | { success: true; payload: { address: string; signature: string } }
    | { success: false; payload?: { error?: string; code?: string } }
  >;
};

export type SignAuthChallengeInput = {
  authPath: string;
  message: string;
};

export type SignAuthChallengeResult = AdapterResult<{
  address: string;
  signature: string;
  message: string;
}>;

export type SignAuthProofInput = {
  psbtBase64: string;
  fingerprint: string;
  derivationRoot: string;
  xpub: string;
};

export type SignAuthProofResult = AdapterResult<{
  proofPsbtBase64: string;
  signedInputCount: number;
}>;

export async function signAuthProofWithTrezor(
  input: SignAuthProofInput,
): Promise<SignAuthProofResult> {
  const fingerprint = input.fingerprint.trim().toLowerCase();
  const derivationPath = stripMasterPrefix(input.derivationRoot.trim());
  const xpub = input.xpub.trim();
  if (!fingerprint || !derivationPath || !xpub || !input.psbtBase64.trim()) {
    return {
      ok: false,
      error: asAdapterError('invalid_path', 'signer proof PSBT, fingerprint, derivation root, and xpub are required'),
    };
  }

  const result = await signWshSortedMultiPsbt({
    psbtBase64: input.psbtBase64,
    vault: {
      requiredSignatures: 1,
      keys: [{ fingerprint, derivationPath, xpub }],
      coin: 'btc',
    },
    signerFingerprint: fingerprint,
    scriptType: 'p2wsh',
  });

  if (!result.ok) return result;
  return {
    ok: true,
    data: {
      proofPsbtBase64: result.data.psbtBase64,
      signedInputCount: result.data.signedInputCount,
    },
  };
}

export async function signAuthChallengeWithTrezor(
  input: SignAuthChallengeInput,
): Promise<SignAuthChallengeResult> {
  const authPath = input.authPath.trim();
  const message = input.message.trim();

  if (!authPath || !message) {
    return { ok: false, error: asAdapterError('invalid_path', 'auth path and message are required') };
  }

  const api = TrezorConnect as unknown as Partial<TrezorSignMessageApi>;
  if (typeof api.signMessage !== 'function') {
    return {
      ok: false,
      error: {
        code: 'unknown',
        message: 'This Trezor Connect build does not expose message signing.',
        cause: 'signMessage unavailable',
      } satisfies TrezorAdapterError,
    };
  }

  log.info('signAuthChallengeWithTrezor request', {
    authPath,
    messageLength: message.length,
  });

  try {
    const result = await api.signMessage({
      path: authPath,
      message,
      coin: 'btc',
    });

    if (!result.success) {
      return { ok: false, error: fromTrezorFailure(result) };
    }

    const address = result.payload.address.trim();
    const signature = result.payload.signature.trim();
    if (!address || !signature) {
      return {
        ok: false,
        error: {
          code: 'unknown',
          message: 'Trezor returned an empty authentication signature.',
          cause: 'empty address or signature',
        } satisfies TrezorAdapterError,
      };
    }

    log.info('signAuthChallengeWithTrezor success', {
      authPath,
      addressLength: address.length,
      signatureLength: signature.length,
    });
    return { ok: true, data: { address, signature, message } };
  } catch (cause) {
    return { ok: false, error: fromUnknown(cause) };
  }
}
