import { Buffer } from 'buffer';
import { AppClient, DefaultWalletPolicy } from '@ledgerhq/ledger-bitcoin';

import { readAppMetadata, readFingerprint } from './app';
import { asAdapterError, fromLedgerError } from './errors';
import { emitSyntheticLedgerEvent } from './events';
import { log } from './log';
import {
  closeLedgerTransport,
  openLedgerTransport,
} from './transport';
import type {
  AdapterResult,
  LedgerTransportPreference,
} from './types';

export type SignAuthChallengeInput = {
  authPath: string;
  message: string;
  transport?: LedgerTransportPreference;
};

export type SignAuthChallengeResult = AdapterResult<{
  address: string;
  signature: string;
  message: string;
}>;

/**
 * Sign the browser-bound Asylia login challenge with Ledger's Bitcoin app.
 *
 * Ledger's `signMessage` returns only the compact base64 signature, unlike
 * Trezor Connect which also echoes the signing address. To keep the server
 * verification contract identical across devices, the adapter first resolves
 * the native-SegWit auth address for the same BIP-84 path through the official
 * default wallet policy, then returns `{ address, signature, message }`.
 */
export async function signAuthChallengeWithLedger(
  input: SignAuthChallengeInput,
): Promise<SignAuthChallengeResult> {
  const parsedPath = parseAuthPath(input.authPath);
  const message = input.message.trim();

  if (!parsedPath.ok) return parsedPath;
  if (!message) {
    return {
      ok: false,
      error: asAdapterError('invalid_path', 'auth path and message are required'),
    };
  }

  log.info('signAuthChallengeWithLedger start', {
    authPath: parsedPath.data.authPath,
    authRoot: parsedPath.data.rootPath,
    messageLength: message.length,
    transport: input.transport ?? 'auto',
  });

  const transportResult = await openLedgerTransport({
    transport: input.transport ?? 'auto',
  });
  if (!transportResult.ok) {
    log.error('signAuthChallengeWithLedger: transport open failed', {
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

    const xpub = await readAuthRootXpub(client, parsedPath.data.rootPath);
    if (!xpub.ok) return xpub;

    const address = await readAuthAddress(client, {
      fingerprint: fingerprint.data,
      rootPathBody: parsedPath.data.rootPathBody,
      xpub: xpub.data,
      chain: parsedPath.data.chain,
      index: parsedPath.data.index,
    });
    if (!address.ok) return address;

    emitSyntheticLedgerEvent({
      phase: 'awaiting_button',
      intent: 'Sign login challenge',
    });

    const signature = await signMessage(client, {
      authPath: parsedPath.data.authPath,
      message,
    });
    if (!signature.ok) return signature;

    emitSyntheticLedgerEvent({
      phase: 'finalising',
      message: 'Login challenge signed',
    });

    log.info('signAuthChallengeWithLedger success', {
      authPath: parsedPath.data.authPath,
      addressLength: address.data.length,
      signatureLength: signature.data.length,
    });

    return {
      ok: true,
      data: {
        address: address.data,
        signature: signature.data,
        message,
      },
    };
  } catch (cause) {
    log.error('signAuthChallengeWithLedger threw', { error: cause });
    return { ok: false, error: fromLedgerError(cause) };
  } finally {
    await closeLedgerTransport(transport);
  }
}

type ParsedAuthPath = {
  authPath: string;
  rootPath: string;
  rootPathBody: string;
  chain: 0 | 1;
  index: number;
};

function parseAuthPath(path: string): AdapterResult<ParsedAuthPath> {
  const authPath = canonicalisePath(path);
  if (!/^m(\/[0-9]+(['h])?)*$/.test(authPath)) {
    return {
      ok: false,
      error: asAdapterError('invalid_path', `Malformed auth path: ${path}`),
    };
  }

  const segments = authPath.slice(2).split('/').filter(Boolean);
  if (segments.length < 3) {
    return {
      ok: false,
      error: asAdapterError('invalid_path', `Auth path must include an account root and address branch: ${path}`),
    };
  }

  const chain = parseNonHardenedSegment(segments[segments.length - 2]!);
  const index = parseNonHardenedSegment(segments[segments.length - 1]!);
  if (chain === null || (chain !== 0 && chain !== 1) || index === null) {
    return {
      ok: false,
      error: asAdapterError('invalid_path', `Auth path must end in a non-hardened 0/1 chain and index: ${path}`),
    };
  }

  const rootSegments = segments.slice(0, -2);
  const rootPathBody = rootSegments.join('/');
  return {
    ok: true,
    data: {
      authPath,
      rootPath: `m/${rootPathBody}`,
      rootPathBody,
      chain,
      index,
    },
  };
}

function canonicalisePath(path: string): string {
  return path
    .trim()
    .split('/')
    .map((part, index) => {
      if (index === 0) return part;
      return part.endsWith('h') ? `${part.slice(0, -1)}'` : part;
    })
    .join('/');
}

function parseNonHardenedSegment(segment: string): number | null {
  if (!/^[0-9]+$/.test(segment)) return null;
  const value = Number(segment);
  if (!Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

async function readAuthRootXpub(
  client: AppClient,
  rootPath: string,
): Promise<AdapterResult<string>> {
  log.info('getExtendedPubkey auth-root request', { rootPath });
  try {
    const xpub = await client.getExtendedPubkey(rootPath, false);
    if (typeof xpub !== 'string' || !xpub.startsWith('xpub')) {
      return {
        ok: false,
        error: asAdapterError(
          'descriptor_unavailable',
          `unexpected auth xpub shape: ${typeof xpub === 'string' ? xpub.slice(0, 8) : typeof xpub}…`,
        ),
      };
    }
    log.info('getExtendedPubkey auth-root success', {
      xpubPreview: xpub.slice(0, 12) + '…',
    });
    return { ok: true, data: xpub };
  } catch (cause) {
    log.error('getExtendedPubkey auth-root threw', { error: cause });
    return { ok: false, error: fromLedgerError(cause) };
  }
}

async function readAuthAddress(
  client: AppClient,
  input: {
    fingerprint: string;
    rootPathBody: string;
    xpub: string;
    chain: 0 | 1;
    index: number;
  },
): Promise<AdapterResult<string>> {
  const policy = new DefaultWalletPolicy(
    'wpkh(@0/**)',
    `[${input.fingerprint}/${input.rootPathBody}]${input.xpub}`,
  );

  log.info('getWalletAddress auth address request', {
    chain: input.chain,
    index: input.index,
  });
  try {
    const address = await client.getWalletAddress(
      policy,
      null,
      input.chain,
      input.index,
      false,
    );
    if (typeof address !== 'string' || !address.trim()) {
      return {
        ok: false,
        error: asAdapterError('descriptor_unavailable', 'empty auth address returned by Ledger'),
      };
    }
    log.info('getWalletAddress auth address success', {
      addressLength: address.trim().length,
    });
    return { ok: true, data: address.trim() };
  } catch (cause) {
    log.error('getWalletAddress auth address threw', { error: cause });
    return { ok: false, error: fromLedgerError(cause) };
  }
}

async function signMessage(
  client: AppClient,
  input: {
    authPath: string;
    message: string;
  },
): Promise<AdapterResult<string>> {
  log.info('signMessage auth request', {
    authPath: input.authPath,
    messageLength: input.message.length,
  });
  try {
    const signature = await client.signMessage(
      Buffer.from(input.message, 'utf8'),
      input.authPath,
    );
    if (typeof signature !== 'string' || !signature.trim()) {
      return {
        ok: false,
        error: asAdapterError('unknown', 'Ledger returned an empty authentication signature.'),
      };
    }
    log.info('signMessage auth success', {
      signatureLength: signature.trim().length,
    });
    return { ok: true, data: signature.trim() };
  } catch (cause) {
    log.error('signMessage auth threw', { error: cause });
    return { ok: false, error: fromLedgerError(cause) };
  }
}
