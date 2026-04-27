/**
 * Caravan multisig wallet config parser.
 *
 * Caravan (Unchained's open-source multisig coordinator) exports the
 * wallet configuration as JSON with the following canonical shape:
 *
 *   {
 *     "name": "Treasury",
 *     "addressType": "P2WSH",
 *     "network": "mainnet",
 *     "client": { "type": "public" },
 *     "quorum": { "requiredSigners": 2, "totalSigners": 3 },
 *     "extendedPublicKeys": [
 *       {
 *         "name": "Cosigner A",
 *         "bip32Path": "m/48'/0'/0'/2'",
 *         "xpub": "xpub...",
 *         "xfp":  "abcd1234",
 *         "method": "trezor"
 *       },
 *       ...
 *     ],
 *     "startingAddressIndex": 0
 *   }
 *
 * Asylia's own Caravan export adds a top-level `descriptor` /
 * `receiveDescriptor` / `changeDescriptor` triple for round-tripping.
 * The parser tolerates both shapes by ignoring unknown fields and only
 * requiring the values it needs to reconstruct the vault locally.
 *
 * The parser is intentionally strict on policy (`wsh-sortedmulti`,
 * mainnet) and on key shape (8-hex fingerprint, base58 xpub, BIP-32
 * derivation path) so an invalid file is rejected at the import
 * boundary instead of producing a broken DB row downstream.
 */
import {
  canonicalizeDerivationPath,
  describeNonMainnetXpub,
  detectExtendedPubkeyNetwork,
  isDerivationPathBody,
  isFingerprint,
  stripMasterPrefix,
} from '../descriptor/normalize';

import { MultisigImportError } from './types';
import type {
  ImportedSignerDevice,
  ParsedMultisigImport,
  ParsedSigner,
} from './types';

type CaravanRawKey = {
  name?: unknown;
  bip32Path?: unknown;
  xpub?: unknown;
  xfp?: unknown;
  method?: unknown;
};

type CaravanRawConfig = {
  name?: unknown;
  addressType?: unknown;
  network?: unknown;
  quorum?: unknown;
  extendedPublicKeys?: unknown;
  descriptor?: unknown;
};

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Map Caravan's `method` field onto the canonical
 * {@link ImportedSignerDevice} union. Caravan's own enum includes
 * `trezor`, `ledger`, `coldcard`, `hermit`, `public`, and `unknown`.
 */
function deviceFromMethod(method?: string): ImportedSignerDevice | undefined {
  if (!method) return undefined;
  const normalised = method.trim().toLowerCase();
  switch (normalised) {
    case 'trezor':
      return 'trezor';
    case 'ledger':
      return 'ledger';
    case 'coldcard':
      return 'coldcard';
    case 'bitbox':
    case 'bitbox02':
      return 'bitbox';
    case 'jade':
    case 'blockstream-jade':
      return 'jade';
    case 'specter':
    case 'specter-desktop':
      return 'specter';
    case 'public':
    case 'unknown':
    case 'hermit':
    case '':
      return 'unknown';
    default:
      return 'unknown';
  }
}

/**
 * Parse a Caravan multisig wallet configuration JSON document.
 *
 * Returns a {@link ParsedMultisigImport} suitable for handing to the
 * descriptor builder + dedup check. Throws {@link MultisigImportError}
 * with a precise message when any field is missing or malformed so the
 * caller can render an inline alert without wrapping the call site in
 * try/catch boilerplate.
 */
export function parseCaravanWalletConfig(text: string): ParsedMultisigImport {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new MultisigImportError('Caravan config file is empty.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (cause) {
    throw new MultisigImportError(
      `Caravan config is not valid JSON: ${(cause as Error).message}`,
    );
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new MultisigImportError('Caravan config must be a JSON object.');
  }
  const raw = parsed as CaravanRawConfig;

  // `addressType` must be present and explicitly P2WSH. Older Caravan
  // exports occasionally omit the field when the wallet was created
  // pre-SegWit; we refuse those because Asylia only supports
  // native-SegWit P2WSH multisig and silently inferring the type
  // would let a P2SH wallet through.
  const addressTypeRaw = asString(raw.addressType);
  if (!addressTypeRaw) {
    throw new MultisigImportError(
      'Caravan config is missing the required `addressType` field. Asylia only supports P2WSH multisig.',
    );
  }
  const addressType = addressTypeRaw.toUpperCase();
  if (addressType !== 'P2WSH') {
    throw new MultisigImportError(
      `Caravan config: \`addressType\` must be P2WSH (got ${addressTypeRaw}). Asylia only supports native-SegWit P2WSH multisig.`,
    );
  }

  const networkRaw = asString(raw.network);
  if (!networkRaw) {
    throw new MultisigImportError(
      'Caravan config is missing the required `network` field. Asylia only supports the Bitcoin mainnet.',
    );
  }
  const network = networkRaw.toLowerCase();
  if (network !== 'mainnet') {
    throw new MultisigImportError(
      `Caravan config: \`network\` must be mainnet (got ${networkRaw}). Asylia only supports the Bitcoin mainnet.`,
    );
  }

  const quorum = raw.quorum;
  if (typeof quorum !== 'object' || quorum === null) {
    throw new MultisigImportError('Caravan config is missing a `quorum` block.');
  }
  const required = (quorum as { requiredSigners?: unknown }).requiredSigners;
  const totalDeclared = (quorum as { totalSigners?: unknown }).totalSigners;
  if (typeof required !== 'number' || !Number.isInteger(required) || required < 1) {
    throw new MultisigImportError(
      'Caravan config: `quorum.requiredSigners` must be a positive integer.',
    );
  }

  const keys = raw.extendedPublicKeys;
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new MultisigImportError(
      'Caravan config is missing the `extendedPublicKeys` array.',
    );
  }
  if (keys.length < 2) {
    throw new MultisigImportError(
      `Caravan config: a multisig vault needs at least 2 cosigners (got ${keys.length}).`,
    );
  }
  if (
    typeof totalDeclared === 'number' &&
    Number.isInteger(totalDeclared) &&
    totalDeclared !== keys.length
  ) {
    throw new MultisigImportError(
      `Caravan config: \`quorum.totalSigners\` (${totalDeclared}) does not match \`extendedPublicKeys.length\` (${keys.length}).`,
    );
  }
  if (required > keys.length) {
    throw new MultisigImportError(
      `Caravan config: \`quorum.requiredSigners\` (${required}) exceeds the number of cosigners (${keys.length}).`,
    );
  }

  const seenIdentities = new Set<string>();
  const signers: ParsedSigner[] = keys.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new MultisigImportError(
        `Caravan config: cosigner #${index + 1} is not a JSON object.`,
      );
    }
    const key = entry as CaravanRawKey;
    const xfpRaw = asString(key.xfp);
    const fingerprint = xfpRaw?.trim().toLowerCase();
    if (!fingerprint || !isFingerprint(fingerprint)) {
      throw new MultisigImportError(
        `Caravan config: cosigner #${index + 1} is missing a valid \`xfp\` (8 hex characters).`,
      );
    }

    const pathRaw = asString(key.bip32Path);
    if (!pathRaw) {
      throw new MultisigImportError(
        `Caravan config: cosigner #${index + 1} is missing \`bip32Path\`.`,
      );
    }
    const derivationPath = canonicalizeDerivationPath(stripMasterPrefix(pathRaw));
    if (!isDerivationPathBody(derivationPath)) {
      throw new MultisigImportError(
        `Caravan config: cosigner #${index + 1} has a malformed \`bip32Path\` (${pathRaw}).`,
      );
    }

    const xpub = asString(key.xpub)?.trim();
    if (!xpub) {
      throw new MultisigImportError(
        `Caravan config: cosigner #${index + 1} is missing the extended public key.`,
      );
    }
    // Strict mainnet xpub guard. A tpub / vpub would otherwise slide
    // into the descriptor builder where `toCanonicalXpub` rejects it
    // with a generic "could not be canonicalised" message — surface
    // the targeted reason here so the operator knows exactly which
    // file to fix.
    const xpubNetwork = detectExtendedPubkeyNetwork(xpub);
    if (xpubNetwork !== 'mainnet') {
      throw new MultisigImportError(
        describeNonMainnetXpub(
          xpubNetwork,
          `Caravan config: cosigner #${index + 1}`,
        )!,
      );
    }

    // Catch a duplicate `(fingerprint, path)` early. The descriptor
    // builder also rejects duplicates further downstream, but at
    // that point the error string mentions "vault" which can confuse
    // an operator looking at a Caravan import dialog.
    const identityKey = `${fingerprint}:${derivationPath}`;
    if (seenIdentities.has(identityKey)) {
      throw new MultisigImportError(
        `Caravan config: cosigner #${index + 1} duplicates an earlier cosigner (fingerprint=${fingerprint}, path=${derivationPath || 'm'}).`,
      );
    }
    seenIdentities.add(identityKey);

    const name = asString(key.name)?.trim();
    const device = deviceFromMethod(asString(key.method));
    return {
      fingerprint,
      derivationPath,
      xpub,
      ...(name ? { name } : {}),
      ...(device ? { device } : {}),
    };
  });

  const name = asString(raw.name)?.trim() || 'Imported vault';
  const sourceDescriptor = asString(raw.descriptor)?.trim();

  return {
    name,
    scriptPolicy: 'wsh-sortedmulti',
    requiredSignatures: required,
    totalKeys: keys.length,
    signers,
    ...(sourceDescriptor ? { sourceDescriptor } : {}),
    source: 'caravan',
  };
}
