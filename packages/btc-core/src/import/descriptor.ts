/**
 * BIP-380 descriptor import parser.
 *
 * Accepts the canonical output of every flavour of "give me my vault as
 * a descriptor" tooling Asylia targets:
 *
 *   - A single multipath descriptor with the BIP-389 chain wildcard:
 *
 *       wsh(sortedmulti(2,
 *         [abcd1234/48'/0'/0'/2']xpub.../<0;1>/*,
 *         [bcde2345/48'/0'/0'/2']xpub.../<0;1>/*,
 *         [cdef3456/48'/0'/0'/2']xpub.../<0;1>/*
 *       ))#checksum
 *
 *   - A receive + change pair on two lines, the form Bitcoin Core
 *     emits straight out of `getdescriptorinfo` and the form Asylia
 *     itself ships in its Bitcoin Core export:
 *
 *       wsh(sortedmulti(2,...))/0/*#sumA
 *       wsh(sortedmulti(2,...))/1/*#sumB
 *
 *   - A Bitcoin Core `importdescriptors` JSON payload (object or
 *     array) — exactly the shape `VaultSettingsView` writes when the
 *     operator picks "Bitcoin Core descriptor" in the export panel:
 *
 *       [
 *         { "desc": "wsh(...)/0/*#sum", "internal": false, ... },
 *         { "desc": "wsh(...)/1/*#sum", "internal": true,  ... }
 *       ]
 *
 * The parser is strict on policy (`wsh(sortedmulti(...))` only,
 * mainnet-style xpubs, BIP-380 checksum verified when present) so
 * malformed input is rejected at the boundary with a precise
 * `MultisigImportError` instead of producing a broken vault row
 * downstream. Hardened-letter notation (`48h`) is normalised onto the
 * apostrophe form (`48'`) so the imported cosigners line up with
 * Asylia's existing key registry.
 */
import { descriptorChecksum } from '../descriptor/checksum';
import {
  canonicalizeDerivationPath,
  describeNonMainnetXpub,
  detectExtendedPubkeyNetwork,
  isDerivationPathBody,
  isFingerprint,
  requireAsyliaBip48Root,
} from '../descriptor/normalize';

import { MultisigImportError } from './types';
import type { ParsedMultisigImport, ParsedSigner } from './types';

const MULTIPATH_SUFFIX = '/<0;1>/*' as const;
const RECEIVE_SUFFIX = '/0/*' as const;
const CHANGE_SUFFIX = '/1/*' as const;

type DescriptorSuffix =
  | typeof MULTIPATH_SUFFIX
  | typeof RECEIVE_SUFFIX
  | typeof CHANGE_SUFFIX;

type ParsedKey = {
  fingerprint: string;
  /** Derivation path body (no leading `m/`), apostrophe-canonical. */
  derivationPath: string;
  /** Extended public key, verbatim from the descriptor. */
  xpub: string;
};

type ParsedDescriptorBody = {
  threshold: number;
  keys: readonly ParsedKey[];
  suffix: DescriptorSuffix;
};

type CoreDescriptorEntry = {
  desc?: unknown;
  internal?: unknown;
};

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Verify and strip the BIP-380 `#checksum` suffix from a descriptor
 * string. Returns the body without the checksum. The checksum is
 * optional (some workflows hand-edit descriptors and drop it); when
 * present it must match the BIP-380 polynomial or we refuse the
 * input — silently accepting a wrong checksum would defeat the whole
 * purpose of the safeguard.
 */
function verifyAndStripChecksum(input: string, label: string): string {
  const idx = input.indexOf('#');
  if (idx === -1) return input;
  const body = input.slice(0, idx);
  const provided = input.slice(idx + 1).trim();
  const expected = descriptorChecksum(body);
  if (expected === null) {
    throw new MultisigImportError(
      `${label}: descriptor body contains characters outside the BIP-380 alphabet.`,
    );
  }
  if (expected !== provided) {
    throw new MultisigImportError(
      `${label}: descriptor checksum mismatch (expected #${expected}, got #${provided}).`,
    );
  }
  return body;
}

/**
 * Split the comma-separated key list inside a `sortedmulti(...)` call.
 * The descriptor format does not use commas inside a key entry, but we
 * still track bracket / paren depth so a future format change (say,
 * BIP-389 multipath inside `[fp/...]`) cannot tear a key in half.
 */
function splitTopLevelKeys(input: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of input) {
    if (ch === '[' || ch === '(' || ch === '<') depth += 1;
    else if (ch === ']' || ch === ')' || ch === '>') depth -= 1;
    if (ch === ',' && depth === 0) {
      if (current.length > 0) out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.length > 0) out.push(current);
  return out;
}

/**
 * Parse one `[fp/path]xpub<suffix>` cosigner entry. Returns the key
 * material plus the chain/index suffix used so the caller can verify
 * every key in the descriptor agrees on a single chain wildcard.
 */
function parseKeyOrigin(
  text: string,
  index: number,
): { key: ParsedKey; suffix: DescriptorSuffix } {
  const trimmed = text.trim();
  // [fingerprint(/derivationPath)?]xpub(/suffix)
  const match =
    /^\[([0-9a-fA-F]{8})((?:\/[0-9]+(?:['h])?)*)\]([1-9A-HJ-NP-Za-km-z]+)(\/.+)$/.exec(
      trimmed,
    );
  if (!match) {
    throw new MultisigImportError(
      `Descriptor: cosigner #${index + 1} does not match the [fingerprint/path]xpub/suffix format.`,
    );
  }
  const [, fpRaw, pathWithSlash, xpubRaw, suffix] = match;
  const fingerprint = (fpRaw ?? '').toLowerCase();
  if (!isFingerprint(fingerprint)) {
    throw new MultisigImportError(
      `Descriptor: cosigner #${index + 1} fingerprint is malformed.`,
    );
  }

  // The capture starts with a leading `/` whenever the path is
  // non-empty (`/48h/0h/0h/2h`). A bare `[fp]xpub` is also valid
  // (root key with no further derivation) and arrives as an empty
  // string here.
  const pathBody = (pathWithSlash ?? '').startsWith('/')
    ? (pathWithSlash ?? '').slice(1)
    : (pathWithSlash ?? '');
  const derivationPath = canonicalizeDerivationPath(pathBody);
  if (derivationPath !== '' && !isDerivationPathBody(derivationPath)) {
    throw new MultisigImportError(
      `Descriptor: cosigner #${index + 1} derivation path "${pathBody}" is malformed.`,
    );
  }
  const asyliaRoot = requireAsyliaBip48Root(
    derivationPath,
    `Descriptor: cosigner #${index + 1}`,
    (message) => new MultisigImportError(message),
  );

  const xpub = (xpubRaw ?? '').trim();
  // Use the network-aware detector so a tpub / vpub surfaces a
  // precise "testnet not supported" message instead of the generic
  // "not valid base58check" fallback `toCanonicalXpub` would produce
  // (since it now returns null for any non-mainnet variant).
  const xpubNetwork = detectExtendedPubkeyNetwork(xpub);
  if (xpubNetwork !== 'mainnet') {
    throw new MultisigImportError(
      describeNonMainnetXpub(
        xpubNetwork,
        `Descriptor: cosigner #${index + 1}`,
      )!,
    );
  }

  let parsedSuffix: DescriptorSuffix;
  if (suffix === MULTIPATH_SUFFIX) parsedSuffix = MULTIPATH_SUFFIX;
  else if (suffix === RECEIVE_SUFFIX) parsedSuffix = RECEIVE_SUFFIX;
  else if (suffix === CHANGE_SUFFIX) parsedSuffix = CHANGE_SUFFIX;
  else {
    throw new MultisigImportError(
      `Descriptor: cosigner #${index + 1} has unsupported chain/index suffix "${suffix}". Expected /<0;1>/*, /0/*, or /1/*.`,
    );
  }

  return {
    key: { fingerprint, derivationPath: asyliaRoot, xpub },
    suffix: parsedSuffix,
  };
}

/**
 * Parse the `wsh(sortedmulti(...))` body of a single descriptor. The
 * `#checksum` suffix must already be stripped (and verified) by the
 * caller — see {@link verifyAndStripChecksum}.
 */
function parseDescriptorBody(body: string, label: string): ParsedDescriptorBody {
  const wshMatch = /^wsh\((.*)\)$/.exec(body);
  if (!wshMatch) {
    throw new MultisigImportError(
      `${label}: descriptor must be wrapped in wsh(...). Asylia only supports native-SegWit P2WSH multisig.`,
    );
  }
  const inner = wshMatch[1] ?? '';

  if (inner.startsWith('sh(') || inner.startsWith('wsh(')) {
    throw new MultisigImportError(
      `${label}: nested script wrappers (sh(wsh(...)), wsh(wsh(...))) are not supported.`,
    );
  }

  const sortedMatch = /^sortedmulti\((\d+),(.+)\)$/.exec(inner);
  if (!sortedMatch) {
    if (/^multi\(/.test(inner)) {
      throw new MultisigImportError(
        `${label}: ordered multi(...) is not supported. Asylia uses sortedmulti so cosigner order does not change addresses.`,
      );
    }
    throw new MultisigImportError(
      `${label}: inner script must be sortedmulti(N,...).`,
    );
  }

  const threshold = Number.parseInt(sortedMatch[1] ?? '', 10);
  if (!Number.isInteger(threshold) || threshold < 1) {
    throw new MultisigImportError(
      `${label}: sortedmulti threshold must be a positive integer.`,
    );
  }

  const keysSegment = sortedMatch[2] ?? '';
  const keyParts = splitTopLevelKeys(keysSegment);
  if (keyParts.length < 2) {
    throw new MultisigImportError(
      `${label}: a multisig vault needs at least 2 cosigners (got ${keyParts.length}).`,
    );
  }
  if (threshold > keyParts.length) {
    throw new MultisigImportError(
      `${label}: threshold ${threshold} exceeds the cosigner count (${keyParts.length}).`,
    );
  }

  const keys: ParsedKey[] = [];
  const seenIdentities = new Set<string>();
  let suffix: DescriptorSuffix | null = null;
  keyParts.forEach((part, index) => {
    const { key, suffix: keySuffix } = parseKeyOrigin(part, index);
    const identity = `${key.fingerprint}:${key.derivationPath}`;
    if (seenIdentities.has(identity)) {
      throw new MultisigImportError(
        `${label}: cosigner #${index + 1} duplicates an earlier cosigner (fingerprint=${key.fingerprint}, path=${key.derivationPath || 'm'}). sortedmulti rejects duplicate keys.`,
      );
    }
    seenIdentities.add(identity);
    keys.push(key);
    if (suffix === null) {
      suffix = keySuffix;
    } else if (suffix !== keySuffix) {
      throw new MultisigImportError(
        `${label}: cosigner #${index + 1} uses chain/index suffix "${keySuffix}" but earlier keys use "${suffix}". All cosigners in one descriptor must share the same suffix.`,
      );
    }
  });

  if (suffix === null) {
    // Unreachable in practice — `splitTopLevelKeys` returns at least
    // one entry, so the forEach loop must have set `suffix`. Keep the
    // explicit branch so the type checker can narrow `suffix` to the
    // non-null union below.
    throw new MultisigImportError(`${label}: could not determine the chain/index suffix.`);
  }

  return { threshold, keys, suffix };
}

/**
 * Pull descriptor strings out of a Bitcoin Core `importdescriptors`
 * payload. Returns `null` when the input doesn't look like that
 * shape so the caller can fall back to plain-text parsing.
 */
function extractCoreDescriptors(text: string): string[] | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  let entries: CoreDescriptorEntry[];
  if (Array.isArray(parsed)) {
    entries = parsed.filter(
      (entry): entry is CoreDescriptorEntry =>
        typeof entry === 'object' && entry !== null && !Array.isArray(entry),
    );
  } else if (
    typeof parsed === 'object' &&
    parsed !== null &&
    'desc' in (parsed as Record<string, unknown>)
  ) {
    entries = [parsed as CoreDescriptorEntry];
  } else {
    return null;
  }

  const descs: string[] = [];
  for (const entry of entries) {
    const desc = asString(entry.desc);
    if (desc) descs.push(desc.trim());
  }
  return descs.length > 0 ? descs : null;
}

/**
 * Helper: do two key lists describe the same set of cosigners? Used
 * to validate that the receive and change branches of a pair input
 * agree on the underlying key material before they get merged into
 * one canonical multipath descriptor.
 */
function sameKeySet(a: readonly ParsedKey[], b: readonly ParsedKey[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const ka = a[i];
    const kb = b[i];
    if (!ka || !kb) return false;
    if (
      ka.fingerprint !== kb.fingerprint ||
      ka.derivationPath !== kb.derivationPath ||
      ka.xpub !== kb.xpub
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Reduce one or more parsed descriptors down to the threshold + key
 * set that uniquely identifies the vault.
 *
 * Accepted shapes:
 *   - One multipath descriptor (`...<0;1>/*`) — used as-is.
 *   - One single-branch descriptor (`/0/*` or `/1/*`) — synthesised
 *     into a multipath since `sortedmulti`'s on-chain script is
 *     identical across chains.
 *   - One receive + one change descriptor — both branches must
 *     match on threshold and key set; the multipath is synthesised.
 *   - Multiple descriptors that all describe the same vault (e.g.
 *     Asylia's text export which ships the multipath + the two
 *     branches in one file). Every descriptor must agree on the
 *     threshold and the cosigner set; redundant duplicates are
 *     ignored.
 *
 * Anything else — disagreeing thresholds, mismatched cosigner sets,
 * two descriptors that share the same single-branch suffix — is
 * rejected with a precise message so the operator can see exactly
 * which inputs disagreed.
 */
function reconcileDescriptors(parsed: ParsedDescriptorBody[]): ParsedDescriptorBody {
  const reference = parsed[0];
  if (parsed.length === 0 || !reference) {
    throw new MultisigImportError('Descriptor input has no descriptor entries.');
  }

  // Every additional descriptor must describe the same vault.
  for (let i = 1; i < parsed.length; i += 1) {
    const candidate = parsed[i];
    if (!candidate) continue;
    if (candidate.threshold !== reference.threshold) {
      throw new MultisigImportError(
        `Descriptor inputs disagree on threshold (descriptor #1 says ${reference.threshold}, descriptor #${i + 1} says ${candidate.threshold}).`,
      );
    }
    if (!sameKeySet(candidate.keys, reference.keys)) {
      throw new MultisigImportError(
        `Descriptor inputs disagree on the cosigner set (descriptor #1 vs descriptor #${i + 1}).`,
      );
    }
  }

  const suffixes = new Set(parsed.map((entry) => entry.suffix));

  // A multipath line wins — it already covers both chains, so any
  // adjacent /0/* or /1/* siblings are redundant copies (the shape
  // Asylia's own Bitcoin Core export ships).
  if (suffixes.has(MULTIPATH_SUFFIX)) {
    return {
      threshold: reference.threshold,
      keys: reference.keys,
      suffix: MULTIPATH_SUFFIX,
    };
  }

  // No multipath line. Accept a single branch (we synthesise the
  // multipath because sortedmulti is chain-agnostic) or a complete
  // receive + change pair.
  if (parsed.length === 1) {
    return {
      threshold: reference.threshold,
      keys: reference.keys,
      suffix: MULTIPATH_SUFFIX,
    };
  }

  if (suffixes.has(RECEIVE_SUFFIX) && suffixes.has(CHANGE_SUFFIX)) {
    return {
      threshold: reference.threshold,
      keys: reference.keys,
      suffix: MULTIPATH_SUFFIX,
    };
  }

  const suffixList = Array.from(suffixes).join(', ');
  throw new MultisigImportError(
    `Descriptor input does not cover both chains (suffixes seen: ${suffixList}). Provide a multipath descriptor or a /0/* (receive) + /1/* (change) pair.`,
  );
}

/**
 * Parse a BIP-380 descriptor (or pair, or Bitcoin Core JSON) into the
 * shared {@link ParsedMultisigImport} shape consumed by Asylia's
 * create-vault flow.
 *
 * Accepted inputs:
 *
 *   - A single multipath descriptor (`.../<0;1>/*#checksum`).
 *   - A receive + change pair separated by a newline.
 *   - A Bitcoin Core `importdescriptors` JSON payload (object or
 *     array of `{ desc, internal, ... }` entries).
 *
 * Throws {@link MultisigImportError} with a precise message on every
 * validation failure — empty input, malformed body, mismatched
 * checksum, mixed chain suffixes, mismatched key sets across the
 * receive/change pair, etc.
 */
export function parseDescriptorImport(text: string): ParsedMultisigImport {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new MultisigImportError('Descriptor input is empty.');
  }

  // Try the Bitcoin Core JSON shape first because it is the format
  // the Asylia settings export ships and the file extension (`.json`)
  // makes it the most common drag-drop.
  const coreDescs = extractCoreDescriptors(trimmed);
  const rawDescriptors =
    coreDescs ??
    trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      // Skip blank lines and `#`-prefixed comments. Bitcoin Core
      // doesn't write comments itself, but Asylia's own descriptor
      // sheet (and many tutorials / hand-prepared backups) uses
      // `# header` lines to label the receive / change blocks. The
      // checksum separator is also `#`, so a literal `#checksum`
      // sits *inside* the descriptor body — we only filter lines
      // that *start* with `#`, never lines that contain one.
      .filter((line) => line.length > 0 && !line.startsWith('#'));

  if (rawDescriptors.length === 0) {
    throw new MultisigImportError(
      'Could not find any descriptor in the input. Paste a wsh(sortedmulti(...)) string or drop a Bitcoin Core importdescriptors JSON file.',
    );
  }

  const parsedBodies = rawDescriptors.map((line, idx) => {
    const label =
      rawDescriptors.length === 1 ? 'Descriptor' : `Descriptor #${idx + 1}`;
    const body = verifyAndStripChecksum(line, label);
    return parseDescriptorBody(body, label);
  });

  const reconciled = reconcileDescriptors(parsedBodies);

  const signers: ParsedSigner[] = reconciled.keys.map((key) => ({
    fingerprint: key.fingerprint,
    derivationPath: key.derivationPath,
    xpub: key.xpub,
  }));

  // The descriptor format itself never carries a wallet name, so we
  // hand the consumer a calm placeholder. The modal already lets the
  // operator override it before the import event fires, and the
  // create-vault flow falls back to this string only when the
  // operator left the field blank.
  return {
    name: 'Imported descriptor vault',
    scriptPolicy: 'wsh-sortedmulti',
    requiredSignatures: reconciled.threshold,
    totalKeys: reconciled.keys.length,
    signers,
    sourceDescriptor: rawDescriptors[0],
    source: 'descriptor',
  };
}
