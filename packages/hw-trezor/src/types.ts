/**
 * Public types for the Asylia Trezor adapter.
 *
 * These shapes are intentionally Asylia-specific (camelCase, no Trezor SDK
 * leak) so the wallet UI never imports `@trezor/connect-web` directly. The
 * adapter is the only audited boundary between the wallet code and the
 * vendor SDK.
 */
import type { DescriptorKey } from '@asylia/btc-core';

/**
 * Asylia-supplied manifest, forwarded to `TrezorConnect.init`. Trezor
 * mandates appName, appUrl and email so they can reach the integrator if
 * something needs to be coordinated. The values are public — they appear
 * inside the Trezor Connect popup for the user to verify.
 */
export type TrezorManifest = {
  appName: string;
  appUrl: string;
  email: string;
};

/**
 * Multisig script type Asylia exports root xpubs for.
 * Mapped 1:1 to the Trezor `scriptType` enum in {@link xpub.ts}.
 *
 * Asylia is **native-SegWit only**: the only supported value is `'p2wsh'`
 * (`wsh(sortedmulti(...))`) at BIP-48 `script_type = 2'`. Nested SegWit
 * (`p2sh-p2wsh`, `sh(wsh(...))`) is intentionally NOT supported and not
 * on the roadmap — narrowing the surface to one script keeps the audit
 * boundary, the UI, and the address derivation pipeline small.
 */
export type TrezorScriptType = 'p2wsh';

/**
 * Coin string passed to Trezor Connect (`coins.json` `shortcut`). Asylia
 * is mainnet-only today; testnet is a future toggle.
 */
export type TrezorCoin = 'btc' | 'test';

/** Input contract for {@link exportTrezorRoot}. */
export type ExportRootInput = {
  /** Full BIP-32 path the device should export (e.g. `m/48'/0'/0'/2'`). */
  derivationPath: string;
  /** Script type at the path; selects the correct xpub serialization. */
  scriptType: TrezorScriptType;
  /** Defaults to `'btc'` (mainnet). */
  coin?: TrezorCoin;
};

/** Device descriptor returned with every successful export. */
export type TrezorDeviceInfo = {
  /** User-set device label, or a graceful fallback like "Trezor Safe 3". */
  label: string;
  /** Human-friendly product name. Derived from `internalModel`. */
  model: string;
  /** Raw internal model identifier from the device (e.g. `"T2B1"`). */
  internalModel: string;
  /** Firmware version in `major.minor.patch` form. */
  firmware: string;
};

/** Successful export payload. */
export type ExportRootResult = {
  /**
   * BIP-32 base58 extended public key at the requested path, in the
   * universal `xpub` form (no SLIP-132 script semantic). This is the
   * value Asylia persists in `V1_SignKeys.xpub` because every Bitcoin
   * tooling library accepts it.
   */
  xpub: string;
  /**
   * Same key material as `xpub`, re-encoded with the SLIP-132 `Zpub`
   * version bytes for P2WSH multisig display / export. Only the first
   * 4 base58 bytes differ from `xpub`; the underlying chain code and
   * public key are identical. Use this when handing the key to
   * multisig-aware tools (Sparrow, Caravan, descriptor wallets) or
   * when rendering the key to the user. `null` only if the SLIP-132
   * conversion failed (malformed `xpub`).
   */
  xpubMultisig: string | null;
  /**
   * Optional SLIP-132 `zpub` form returned directly by Trezor for the
   * `SPENDWITNESS` script type. This is the SINGLE-KEY (P2WPKH)
   * encoding — useful for diagnostics ("what would Trezor Suite show
   * the user?"), not for multisig display. Prefer `xpubMultisig` for
   * anything user-facing in a multisig context.
   */
  xpubSegwit?: string;
  /** Lowercase 8-character hex master fingerprint (BIP-380 identity). */
  masterFingerprint: string;
  /** Echo of the path that was exported, normalized through the device. */
  derivationPath: string;
  /** Echo of the requested script type. */
  scriptType: TrezorScriptType;
  /** Device descriptor; useful for the "model" label on the dashboard. */
  device: TrezorDeviceInfo;
};

/** Inputs accepted by `displayWshSortedMultiAddress`. */
export type DisplayAddressInput = {
  /** Threshold (`m` in `m-of-n`). */
  requiredSignatures: number;
  /** Cosigning keys in the same order the descriptor lists them. */
  keys: readonly DescriptorKey[];
  /** Fingerprint of the signer the operator selected in the wallet UI. */
  signerFingerprint: string;
  /** Receive (`0`) or change (`1`) branch. */
  chain: 0 | 1;
  /** Non-negative address index on the selected branch. */
  index: number;
  /** Address already derived by the wallet UI, used as a strict post-flight check. */
  expectedAddress: string;
  /** Defaults to `'btc'` (mainnet). */
  coin?: TrezorCoin;
  /** Echo of the script type for forward-compatibility; only `'p2wsh'` today. */
  scriptType?: TrezorScriptType;
};

/** Successful Trezor address display payload. */
export type DisplayAddressResult = {
  /** Address returned by Trezor Connect after on-device display. */
  address: string;
  /** Wallet-derived address the caller asked the device to verify. */
  expectedAddress: string;
  /** Receive (`0`) or change (`1`) branch that produced the address. */
  chain: 0 | 1;
  /** Address index shown on the device. */
  index: number;
  /** Fingerprint of the signer the operator selected in the wallet UI. */
  signerFingerprint: string;
};

/**
 * Asylia-normalized failure modes. Every Trezor SDK error is mapped to
 * one of these so the UI can react with consistent copy and never has to
 * pattern-match on raw vendor strings.
 */
export type TrezorErrorCode =
  | 'init_failed'
  | 'manifest_required'
  | 'cancelled'
  | 'device_disconnected'
  | 'device_not_found'
  | 'device_in_use'
  | 'device_locked'
  | 'device_timeout'
  | 'firmware_too_old'
  | 'descriptor_unavailable'
  | 'invalid_multisig'
  | 'invalid_path'
  | 'message_signing_forbidden_path'
  | 'transport_unavailable'
  | 'unknown';

export type TrezorAdapterError = {
  code: TrezorErrorCode;
  message: string;
  /** The original SDK code, kept for diagnostics. Never shown to the user. */
  cause?: string;
};

/** Result discriminant used by every exported async function. */
export type AdapterResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: TrezorAdapterError };
