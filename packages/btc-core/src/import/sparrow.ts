/**
 * Sparrow wallet config parser.
 *
 * Sparrow's `Export Wallet → Wallet Backup File` produces a JSON
 * document shaped like:
 *
 *   {
 *     "label": "Treasury",
 *     "policyType": "MULTI",
 *     "scriptType": "P2WSH",
 *     "keystores": [
 *       {
 *         "label": "Trezor T",
 *         "source": "HW_USB",
 *         "walletType": "TREZOR_T",
 *         "keyDerivation": {
 *           "masterFingerprint": "abcd1234",
 *           "derivationPath": "m/48'/0'/0'/2'"
 *         },
 *         "extendedPublicKey": "Zpub...",
 *         "deviceType": "trezor_t"
 *       },
 *       ...
 *     ],
 *     "defaultPolicy": {
 *       "name": "Default",
 *       "miniscript": "wsh(sortedmulti(2,@0/<0;1>/*,@1/<0;1>/*,@2/<0;1>/*))",
 *       "type": "WSH"
 *     }
 *   }
 *
 * Variations the parser tolerates so a wider range of Sparrow exports
 * (different versions, edited backups, our own export with a flat
 * `descriptor` field) all import successfully:
 *
 *   - `keystores[].masterFingerprint` / `keystores[].fingerprint` as a
 *     fallback when `keyDerivation.masterFingerprint` is missing.
 *   - `keystores[].derivation` as a fallback when
 *     `keyDerivation.derivationPath` is missing.
 *   - `keystores[].xpub` as a fallback when `extendedPublicKey` is
 *     absent (matches Asylia's own export).
 *   - Threshold lifted from `defaultPolicy.miniscript`'s
 *     `sortedmulti(N,...)` capture group, falling back to
 *     `quorum.threshold` when present.
 *
 * Strict where it matters: `policyType` (must be MULTI), `scriptType`
 * (must be P2WSH), and the per-key `(fingerprint, path, xpub)` are
 * validated up front so an invalid file is rejected at the import
 * boundary instead of producing a broken DB row downstream.
 */
import {
  canonicalizeDerivationPath,
  describeNonMainnetXpub,
  detectExtendedPubkeyNetwork,
  isDerivationPathBody,
  isFingerprint,
  requireAsyliaBip48Root,
  stripMasterPrefix,
} from '../descriptor/normalize';

import { MultisigImportError } from './types';
import type {
  ImportedSignerDevice,
  ParsedMultisigImport,
  ParsedSigner,
} from './types';

type SparrowKeyDerivation = {
  masterFingerprint?: unknown;
  derivationPath?: unknown;
};

type SparrowKeystore = {
  label?: unknown;
  walletType?: unknown;
  deviceType?: unknown;
  source?: unknown;
  extendedPublicKey?: unknown;
  xpub?: unknown;
  keyDerivation?: unknown;
  masterFingerprint?: unknown;
  fingerprint?: unknown;
  derivation?: unknown;
};

type SparrowDefaultPolicy = {
  miniscript?: unknown;
  type?: unknown;
};

type SparrowQuorum = {
  threshold?: unknown;
  members?: unknown;
};

type SparrowConfig = {
  label?: unknown;
  policyType?: unknown;
  scriptType?: unknown;
  keystores?: unknown;
  defaultPolicy?: unknown;
  quorum?: unknown;
  descriptor?: unknown;
  /**
   * Sparrow does not always emit a top-level `network` field, but
   * when it does we honour it as a hard mainnet gate. The xpub
   * version-byte check on each keystore is the actual safety net.
   */
  network?: unknown;
};

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Map Sparrow's `walletType` (or `deviceType`) onto the canonical
 * {@link ImportedSignerDevice} union. Sparrow uses macro-style
 * identifiers like `TREZOR_SAFE_5` or `LEDGER_NANO_X`; the parser
 * boils them down to the manufacturer because that is the only field
 * Asylia's `V1_SignKeys` table currently keys on.
 */
function deviceFromWalletType(walletType?: string): ImportedSignerDevice | undefined {
  if (!walletType) return undefined;
  const upper = walletType.trim().toUpperCase();
  if (upper.startsWith('TREZOR')) return 'trezor';
  if (upper.startsWith('LEDGER')) return 'ledger';
  if (upper.startsWith('COLDCARD')) return 'coldcard';
  if (upper.startsWith('BITBOX')) return 'bitbox';
  if (upper.startsWith('JADE') || upper.includes('BLOCKSTREAM')) return 'jade';
  if (upper.startsWith('SPECTER')) return 'specter';
  return 'unknown';
}

/**
 * Pull the `m` from a `wsh(sortedmulti(m,...))` miniscript / descriptor
 * body. Tolerates surrounding whitespace, BIP-389 multipath wrappers,
 * and the older `multi(...)` keyword that some Sparrow versions use
 * for "ordered multisig" wallets (rejected explicitly because Asylia
 * is sortedmulti-only).
 */
function thresholdFromMiniscript(miniscript: string): number | undefined {
  const sorted = miniscript.match(/sortedmulti\s*\(\s*(\d+)\s*,/i);
  if (sorted) return Number.parseInt(sorted[1] ?? '', 10);
  const ordered = miniscript.match(/(?<![a-z])multi\s*\(\s*(\d+)\s*,/i);
  if (ordered) {
    throw new MultisigImportError(
      'Sparrow config uses ordered `multi(...)`. Asylia is sortedmulti-only.',
    );
  }
  return undefined;
}

/**
 * Parse a Sparrow wallet backup JSON document.
 *
 * Returns a {@link ParsedMultisigImport} suitable for handing to the
 * descriptor builder + dedup check. Throws {@link MultisigImportError}
 * with a precise message when any field is missing or malformed.
 */
export function parseSparrowWalletConfig(text: string): ParsedMultisigImport {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new MultisigImportError('Sparrow config file is empty.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (cause) {
    throw new MultisigImportError(
      `Sparrow config is not valid JSON: ${(cause as Error).message}`,
    );
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new MultisigImportError('Sparrow config must be a JSON object.');
  }
  const raw = parsed as SparrowConfig;

  // `policyType` and `scriptType` MUST be present and explicitly
  // multisig + P2WSH. A missing field would let a single-sig wallet
  // backup or a P2SH variant slip through and produce broken
  // descriptors downstream.
  const policyTypeRaw = asString(raw.policyType);
  if (!policyTypeRaw) {
    throw new MultisigImportError(
      'Sparrow config is missing the required `policyType` field. Asylia only supports multisig wallets.',
    );
  }
  const policyType = policyTypeRaw.toUpperCase();
  if (policyType !== 'MULTI') {
    throw new MultisigImportError(
      `Sparrow config: \`policyType\` must be MULTI (got ${policyTypeRaw}). Asylia only supports multisig wallets.`,
    );
  }

  const scriptTypeRaw = asString(raw.scriptType);
  if (!scriptTypeRaw) {
    throw new MultisigImportError(
      'Sparrow config is missing the required `scriptType` field. Asylia only supports P2WSH multisig.',
    );
  }
  const scriptType = scriptTypeRaw.toUpperCase();
  if (scriptType !== 'P2WSH') {
    throw new MultisigImportError(
      `Sparrow config: \`scriptType\` must be P2WSH (got ${scriptTypeRaw}). Asylia only supports native-SegWit P2WSH multisig.`,
    );
  }

  // Optional top-level network field: if present, must be mainnet.
  // The per-keystore xpub version check below is the actual hard
  // network gate; the field check just gives a clearer error when
  // someone exports a testnet wallet from Sparrow.
  const networkRaw = asString(raw.network);
  if (networkRaw && networkRaw.toLowerCase() !== 'mainnet') {
    throw new MultisigImportError(
      `Sparrow config: \`network\` must be mainnet (got ${networkRaw}). Asylia only supports the Bitcoin mainnet.`,
    );
  }

  const keystores = raw.keystores;
  if (!Array.isArray(keystores) || keystores.length === 0) {
    throw new MultisigImportError(
      'Sparrow config is missing the `keystores` array.',
    );
  }
  if (keystores.length < 2) {
    throw new MultisigImportError(
      `Sparrow config: a multisig vault needs at least 2 cosigners (got ${keystores.length}).`,
    );
  }

  // Threshold sourcing: prefer the explicit `quorum.threshold` field
  // (newer Sparrow versions), fall back to parsing the
  // `defaultPolicy.miniscript` capture (older versions and stripped
  // backups), and finally to a top-level `descriptor` we can scan for
  // the same pattern.
  let requiredSignatures: number | undefined;
  const quorum = raw.quorum as SparrowQuorum | undefined;
  if (quorum && typeof quorum.threshold === 'number') {
    requiredSignatures = quorum.threshold;
  }
  if (requiredSignatures === undefined) {
    const policy = raw.defaultPolicy as SparrowDefaultPolicy | undefined;
    const miniscript = asString(policy?.miniscript);
    if (miniscript) {
      const parsedThreshold = thresholdFromMiniscript(miniscript);
      if (parsedThreshold !== undefined) requiredSignatures = parsedThreshold;
    }
  }
  if (requiredSignatures === undefined) {
    const descriptor = asString(raw.descriptor);
    if (descriptor) {
      const parsedThreshold = thresholdFromMiniscript(descriptor);
      if (parsedThreshold !== undefined) requiredSignatures = parsedThreshold;
    }
  }
  if (requiredSignatures === undefined) {
    throw new MultisigImportError(
      'Sparrow config: could not determine the signature threshold (missing `quorum.threshold`, `defaultPolicy.miniscript`, and `descriptor`).',
    );
  }
  if (
    !Number.isInteger(requiredSignatures) ||
    requiredSignatures < 1 ||
    requiredSignatures > keystores.length
  ) {
    throw new MultisigImportError(
      `Sparrow config: signature threshold (${requiredSignatures}) is out of range for ${keystores.length} cosigners.`,
    );
  }

  const seenIdentities = new Set<string>();
  const signers: ParsedSigner[] = keystores.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new MultisigImportError(
        `Sparrow config: cosigner #${index + 1} is not a JSON object.`,
      );
    }
    const keystore = entry as SparrowKeystore;
    const derivation = (keystore.keyDerivation ?? {}) as SparrowKeyDerivation;

    const fingerprintRaw =
      asString(derivation.masterFingerprint) ??
      asString(keystore.masterFingerprint) ??
      asString(keystore.fingerprint);
    const fingerprint = fingerprintRaw?.trim().toLowerCase();
    if (!fingerprint || !isFingerprint(fingerprint)) {
      throw new MultisigImportError(
        `Sparrow config: cosigner #${index + 1} is missing a valid master fingerprint (8 hex characters).`,
      );
    }

    const pathRaw =
      asString(derivation.derivationPath) ?? asString(keystore.derivation);
    if (!pathRaw) {
      throw new MultisigImportError(
        `Sparrow config: cosigner #${index + 1} is missing the BIP-32 derivation path.`,
      );
    }
    const derivationPath = canonicalizeDerivationPath(stripMasterPrefix(pathRaw));
    if (!isDerivationPathBody(derivationPath)) {
      throw new MultisigImportError(
        `Sparrow config: cosigner #${index + 1} has a malformed derivation path (${pathRaw}).`,
      );
    }
    const asyliaRoot = requireAsyliaBip48Root(
      derivationPath,
      `Sparrow config: cosigner #${index + 1}`,
      (message) => new MultisigImportError(message),
    );

    const xpub =
      asString(keystore.extendedPublicKey)?.trim() ??
      asString(keystore.xpub)?.trim();
    if (!xpub) {
      throw new MultisigImportError(
        `Sparrow config: cosigner #${index + 1} is missing the extended public key.`,
      );
    }
    // Strict mainnet xpub guard. Vpub / tpub keystores would
    // otherwise convert to a syntactically valid descriptor and
    // produce mainnet bech32 addresses from testnet seed material.
    const xpubNetwork = detectExtendedPubkeyNetwork(xpub);
    if (xpubNetwork !== 'mainnet') {
      throw new MultisigImportError(
        describeNonMainnetXpub(
          xpubNetwork,
          `Sparrow config: cosigner #${index + 1}`,
        )!,
      );
    }

    const identityKey = `${fingerprint}:${asyliaRoot}`;
    if (seenIdentities.has(identityKey)) {
      throw new MultisigImportError(
        `Sparrow config: cosigner #${index + 1} duplicates an earlier cosigner (fingerprint=${fingerprint}, path=${derivationPath || 'm'}).`,
      );
    }
    seenIdentities.add(identityKey);

    const name = asString(keystore.label)?.trim();
    const device =
      deviceFromWalletType(asString(keystore.walletType)) ??
      deviceFromWalletType(asString(keystore.deviceType));
    const modelHint = asString(keystore.walletType)?.trim() ||
      asString(keystore.deviceType)?.trim();

    return {
      fingerprint,
      derivationPath: asyliaRoot,
      xpub,
      ...(name ? { name } : {}),
      ...(device ? { device } : {}),
      ...(modelHint ? { modelHint } : {}),
    };
  });

  const name = asString(raw.label)?.trim() || 'Imported vault';
  const sourceDescriptor =
    asString(raw.descriptor)?.trim() ||
    asString((raw.defaultPolicy as SparrowDefaultPolicy | undefined)?.miniscript)?.trim();

  return {
    name,
    scriptPolicy: 'wsh-sortedmulti',
    requiredSignatures,
    totalKeys: keystores.length,
    signers,
    ...(sourceDescriptor ? { sourceDescriptor } : {}),
    source: 'sparrow',
  };
}
