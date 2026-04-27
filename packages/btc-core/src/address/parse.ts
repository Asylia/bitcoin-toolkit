/**
 * Lightweight Bitcoin address parser used by the SPA's recipient
 * input fields.
 *
 * The function returns a tagged union so the caller can render UI
 * states without re-implementing the same prefix / checksum logic in
 * every form:
 *
 *   - `{ ok: true, type, address }`  — the address is well-formed and
 *      pays to a recognised script template on the requested network.
 *      `type` is one of the five mainnet templates Bitcoin Core
 *      accepts as standard outputs (`p2pkh`, `p2sh`, `p2wpkh`,
 *      `p2wsh`, `p2tr`). The `address` field carries the trimmed
 *      input verbatim so callers can assign it back into a form
 *      model without re-trimming.
 *   - `{ ok: false, code, message }` — validation failed. The `code`
 *      is a stable machine-readable enum the caller can branch on;
 *      the `message` is a short user-facing sentence ready for the
 *      input's error caption.
 *
 * Validation rules applied (in order):
 *
 *   1. Empty / whitespace-only input  → `empty`.
 *   2. Detect testnet / regtest / signet / litecoin prefixes from the
 *      bech32 HRP (`tb`, `bcrt`, `bcrtb`) or the obvious base58
 *      version bytes (`m…`, `n…`, `2…`)                        → `wrong_network`.
 *   3. Run `bitcoinjs-lib`'s `address.toOutputScript(addr, mainnet)`.
 *      That call performs the full bech32 / base58check decode,
 *      verifies the checksum, the version byte, the data length,
 *      and the network match in one shot. A failure here means the
 *      string is *almost* an address but the bytes do not line up
 *      (typo, copy-paste truncation, mixed-case bech32, …) →
 *      `invalid_format`.
 *   4. Look at the produced script bytes to decide which of the five
 *      standard templates they encode. Anything else (BIP-86 future
 *      script versions, non-standard scripts) is rejected with
 *      `unknown_type` — the wallet has no story for paying to one
 *      yet, and refusing here is safer than building an unspendable
 *      output downstream.
 *
 * The parser is deliberately permissive about whitespace: leading /
 * trailing spaces are stripped before validation so a paste from a
 * messenger / email client lands on the happy path.
 *
 * Exposed both as a re-export on the package barrel
 * (`@asylia/btc-core`) and inline below so deep imports keep
 * working from the existing test setup.
 */
import { Buffer } from 'buffer';
import { address as bitcoinAddress } from 'bitcoinjs-lib';

import { networkOf } from '../network';
import type { BitcoinNetwork } from '../types';

/**
 * One of the five output script templates Bitcoin Core treats as
 * standard. Values are lowercase by convention to match other
 * lowercase enums in the package (`'mainnet'`, `'wsh-sortedmulti'`).
 *
 * - `p2pkh`  — `1…` legacy pay-to-pubkey-hash (P2PKH)
 * - `p2sh`   — `3…` pay-to-script-hash (P2SH)
 * - `p2wpkh` — `bc1q…` (length 42) native SegWit v0 pubkey-hash
 * - `p2wsh`  — `bc1q…` (length 62) native SegWit v0 script-hash
 *              — this is the script template Asylia vaults pay from
 * - `p2tr`   — `bc1p…` (length 62) Taproot (SegWit v1)
 */
export type BitcoinAddressType = 'p2pkh' | 'p2sh' | 'p2wpkh' | 'p2wsh' | 'p2tr';

/**
 * Stable machine-readable failure codes returned by
 * {@link parseBitcoinAddress}. Callers branch on the code to render
 * different UI states without scraping the human-facing message.
 *
 * - `empty`          — trimmed input is the empty string. Typically
 *                      rendered as a neutral "no input yet" state
 *                      rather than an error.
 * - `wrong_network`  — the address decodes cleanly but targets a
 *                      different network than the one requested
 *                      (testnet / regtest / signet, or a non-Bitcoin
 *                      base58 prefix).
 * - `invalid_format` — the string does not decode at all (failed
 *                      bech32 / base58check checksum, illegal
 *                      character, mixed case, wrong length, …).
 * - `unknown_type`   — the address decodes onto mainnet but the
 *                      resulting script is not one of the five
 *                      standard templates we know how to spend.
 */
export type BitcoinAddressParseError =
  | 'empty'
  | 'wrong_network'
  | 'invalid_format'
  | 'unknown_type';

/**
 * Result of {@link parseBitcoinAddress}. Tagged union: `ok: true`
 * carries the detected `type` plus the trimmed `address`, `ok:
 * false` carries the failure `code` and a short user-facing
 * `message` ready to drop into a form caption.
 */
export type ParsedBitcoinAddress =
  | { ok: true; type: BitcoinAddressType; address: string }
  | { ok: false; code: BitcoinAddressParseError; message: string };

// HRP of the bech32 prefixes we explicitly recognise. The `bc` HRP
// is the only value we accept for a positive parse; the others let
// us produce the precise `wrong_network` message rather than the
// generic `invalid_format` you would otherwise get from
// `toOutputScript`.
const MAINNET_BECH32_HRP = 'bc';
const NON_MAINNET_BECH32_HRPS: ReadonlySet<string> = new Set([
  'tb', // testnet
  'bcrt', // regtest
  'bcrtb', // some legacy regtest prefixes — best effort
  'sb', // signet (informal HRP, defensive)
]);

// Base58 leading characters of the most common non-mainnet prefixes.
// Bitcoin Core mainnet prefixes are `1` (P2PKH) and `3` (P2SH); the
// `m`, `n`, `2` set covers testnet / regtest / signet, all of which
// share the same base58 version bytes.
const NON_MAINNET_BASE58_LEADING_CHARS: ReadonlySet<string> = new Set([
  'm',
  'n',
  '2',
]);

/**
 * Standard segwit v0 / v1 program lengths in bytes. Used to decide
 * which script template a successful `bc1` decode corresponds to —
 * the witness version is exposed by `address.fromBech32`, the
 * program length differentiates pubkey-hash from script-hash inside
 * the same version.
 */
const SEGWIT_V0_PUBKEY_HASH_LEN = 20;
const SEGWIT_V0_SCRIPT_HASH_LEN = 32;
const SEGWIT_V1_TAPROOT_LEN = 32;

/**
 * Parse and classify a Bitcoin address string.
 *
 * Trims the input first so a paste with surrounding whitespace
 * still lands on the happy path. Returns the {@link
 * ParsedBitcoinAddress} tagged union — see the module-level doc
 * comment for the full rule set.
 *
 * The function does not throw: every malformed input is reported as
 * an `ok: false` result with a stable `code` and a user-facing
 * `message`. This keeps the call site pure: form components can
 * branch on the result inside a `computed` without `try` / `catch`.
 *
 * Today only `network: 'mainnet'` is supported; the parameter is
 * still required so the API stays forward-compatible with a future
 * testnet toggle. Calling with any other value is treated as
 * mainnet — the package only declares mainnet today and the
 * narrowed type prevents unsupported values at compile time.
 */
export function parseBitcoinAddress(
  raw: string,
  network: BitcoinNetwork = 'mainnet',
): ParsedBitcoinAddress {
  if (typeof raw !== 'string') {
    return {
      ok: false,
      code: 'invalid_format',
      message: 'Address must be a text value.',
    };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return {
      ok: false,
      code: 'empty',
      message: 'Recipient address is required.',
    };
  }

  // Early `wrong_network` detection. Both branches below decide on
  // surface clues alone (the bech32 HRP or the leading base58
  // character) so the message is precise even when `toOutputScript`
  // would also have rejected the address with a less specific
  // checksum error.
  const lower = trimmed.toLowerCase();
  const hrpMatch = /^([a-z]{2,5})1/.exec(lower);
  if (hrpMatch && hrpMatch[1] && NON_MAINNET_BECH32_HRPS.has(hrpMatch[1])) {
    return {
      ok: false,
      code: 'wrong_network',
      message: 'This is a testnet / regtest / signet address. Asylia is mainnet-only today.',
    };
  }
  const firstChar = trimmed.charAt(0);
  if (NON_MAINNET_BASE58_LEADING_CHARS.has(firstChar)) {
    return {
      ok: false,
      code: 'wrong_network',
      message: 'This looks like a testnet address. Asylia is mainnet-only today.',
    };
  }

  // Reject mixed-case bech32 explicitly. BIP-173 forbids mixed case;
  // `toOutputScript` would also reject it but the canned message
  // ("Mixed-case string") leaks too much library jargon. Only
  // applied to bech32 candidates so legacy `1…` / `3…` addresses
  // are unaffected.
  if (lower.startsWith(`${MAINNET_BECH32_HRP}1`)) {
    if (trimmed !== lower && trimmed !== trimmed.toUpperCase()) {
      return {
        ok: false,
        code: 'invalid_format',
        message: 'bech32 addresses must be all lower or all upper case.',
      };
    }
  }

  // Run the heavyweight check. A success here proves: the encoding
  // round-trips, the checksum verifies, the data length matches the
  // version, the prefix belongs to the requested network, and the
  // result corresponds to a real on-chain script.
  let scriptPubKey: Buffer;
  try {
    scriptPubKey = Buffer.from(
      bitcoinAddress.toOutputScript(trimmed, networkOf(network)),
    );
  } catch {
    return {
      ok: false,
      code: 'invalid_format',
      message: 'This does not look like a valid Bitcoin address.',
    };
  }

  const type = classifyOutputScript(trimmed, scriptPubKey);
  if (type === null) {
    return {
      ok: false,
      code: 'unknown_type',
      message: 'Unsupported address type. Asylia can only pay to standard P2PKH, P2SH, P2WPKH, P2WSH, or P2TR outputs.',
    };
  }

  return { ok: true, type, address: trimmed };
}

/**
 * Map the script bytes produced by `address.toOutputScript` onto
 * one of the five standard templates. Returns `null` for anything
 * else (future witness versions, non-standard outputs) so the
 * caller surfaces an `unknown_type` error rather than silently
 * accepting an output the wallet cannot reason about.
 *
 * The `address` argument is used only to read the bech32 witness
 * version byte (segwit v0 vs v1) — base58 templates are detected
 * purely from the script bytes.
 */
function classifyOutputScript(
  address: string,
  script: Buffer,
): BitcoinAddressType | null {
  // P2PKH: OP_DUP OP_HASH160 <20> <hash> OP_EQUALVERIFY OP_CHECKSIG
  if (
    script.length === 25 &&
    script[0] === 0x76 && // OP_DUP
    script[1] === 0xa9 && // OP_HASH160
    script[2] === 0x14 && // PUSH 20 bytes
    script[23] === 0x88 && // OP_EQUALVERIFY
    script[24] === 0xac // OP_CHECKSIG
  ) {
    return 'p2pkh';
  }

  // P2SH: OP_HASH160 <20> <hash> OP_EQUAL
  if (
    script.length === 23 &&
    script[0] === 0xa9 && // OP_HASH160
    script[1] === 0x14 && // PUSH 20 bytes
    script[22] === 0x87 // OP_EQUAL
  ) {
    return 'p2sh';
  }

  // SegWit branches: read the witness version off the bech32 decode
  // so we can split v0 and v1 cleanly. `fromBech32` throws for
  // legacy addresses (which we have already classified above).
  const lower = address.toLowerCase();
  if (lower.startsWith(`${MAINNET_BECH32_HRP}1`)) {
    let decoded: { version: number; data: Uint8Array } | null = null;
    try {
      decoded = bitcoinAddress.fromBech32(address);
    } catch {
      decoded = null;
    }
    if (decoded) {
      if (decoded.version === 0) {
        if (decoded.data.length === SEGWIT_V0_PUBKEY_HASH_LEN) return 'p2wpkh';
        if (decoded.data.length === SEGWIT_V0_SCRIPT_HASH_LEN) return 'p2wsh';
      }
      if (decoded.version === 1 && decoded.data.length === SEGWIT_V1_TAPROOT_LEN) {
        return 'p2tr';
      }
    }
  }

  return null;
}

/**
 * Human-readable label for one of the five recognised templates.
 * Used by the SPA to surface "Detected: Native SegWit (P2WPKH)" or
 * similar captions next to the recipient input.
 */
export function describeBitcoinAddressType(type: BitcoinAddressType): string {
  switch (type) {
    case 'p2pkh':
      return 'Legacy (P2PKH)';
    case 'p2sh':
      return 'Wrapped SegWit / Multisig (P2SH)';
    case 'p2wpkh':
      return 'Native SegWit (P2WPKH)';
    case 'p2wsh':
      return 'Native SegWit Multisig (P2WSH)';
    case 'p2tr':
      return 'Taproot (P2TR)';
  }
}
