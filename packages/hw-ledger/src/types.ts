/**
 * Public types for the Asylia Ledger adapter.
 *
 * These shapes are intentionally Asylia-specific (camelCase, no LedgerHQ
 * SDK leak) so the wallet UI never imports `@ledgerhq/*` or
 * `ledger-bitcoin` directly. The adapter is the only audited boundary
 * between the wallet code and the vendor SDKs.
 */

/**
 * Multisig script type Asylia exports root xpubs for.
 *
 * Asylia is **native-SegWit only**: the only supported value is `'p2wsh'`
 * (`wsh(sortedmulti(...))`) at BIP-48 `script_type = 2'`. Nested SegWit
 * (`p2sh-p2wsh`, `sh(wsh(...))`) is intentionally NOT supported and not
 * on the roadmap — narrowing the surface to one script keeps the audit
 * boundary, the UI, and the address derivation pipeline small.
 *
 * The symmetric type exists in `@asylia/hw-trezor`; keeping a distinct
 * name here (`LedgerScriptType`) avoids accidental cross-imports between
 * the two hardware packages.
 */
export type LedgerScriptType = 'p2wsh';

/**
 * Coin string Asylia asks the Ledger Bitcoin app to work with. Today we
 * only export for `'btc'` (mainnet); testnet is a future toggle.
 *
 * Ledger's Bitcoin app does not take a `coin` parameter the way Trezor
 * does — the testnet app is a separate on-device application altogether.
 * The field is kept on the Asylia side for symmetry with
 * `@asylia/hw-trezor` and forward-compatibility with the future
 * mainnet/testnet switcher.
 */
export type LedgerCoin = 'btc' | 'test';

/** Input contract for `exportLedgerRoot`. */
export type ExportRootInput = {
  /** Full BIP-32 path the device should export (e.g. `m/48'/0'/0'/2'`). */
  derivationPath: string;
  /** Script type at the path; selects the correct xpub serialization. */
  scriptType: LedgerScriptType;
  /** Defaults to `'btc'` (mainnet). */
  coin?: LedgerCoin;
};

/** One cosigner entry used to construct a Ledger wallet policy. */
export type LedgerWalletPolicyKey = {
  /** Lowercase 8-character master fingerprint. */
  fingerprint: string;
  /** BIP-32 root path for the account xpub (`m/48'/0'/0'/2'`). */
  derivationPath: string;
  /** Account-level extended public key in xpub or SLIP-132 form. */
  xpub: string;
};

/** Input contract for `buildLedgerWalletPolicy` and `registerLedgerWalletPolicy`. */
export type LedgerWalletPolicyInput = {
  /** Threshold (`N` in `N-of-T`). */
  requiredSignatures: number;
  /** Cosigning keys. Sorted internally so import order does not matter. */
  keys: readonly LedgerWalletPolicyKey[];
  /**
   * Fingerprint of the Ledger signer the user is installing this policy
   * onto. Registration refuses to continue if another Ledger is connected.
   */
  targetFingerprint: string;
};

/** Deterministic preview of the policy that will be shown on the Ledger. */
export type LedgerWalletPolicyDetails = {
  policyName: string;
  descriptorTemplate: string;
  keyInfo: readonly string[];
  policyId: string;
};

/** Successful Ledger wallet-policy registration payload. */
export type RegisterLedgerWalletPolicyResult = LedgerWalletPolicyDetails & {
  policyHmac: string;
  registeredFingerprint: string;
  device: LedgerDeviceInfo;
};

/** Inputs accepted by `signWshSortedMultiPsbt`. */
export type SignPsbtInput = {
  /** Base64-encoded PSBT v2 to sign. */
  psbtBase64: string;
  /** Vault context — same keys + threshold used during policy registration. */
  vault: Omit<LedgerWalletPolicyInput, 'targetFingerprint'>;
  /**
   * Fingerprint of the Ledger signer selected in the UI. The adapter
   * refuses to continue if the connected device reports a different
   * master fingerprint.
   */
  signerFingerprint: string;
  /** 32-byte HMAC returned by `registerLedgerWalletPolicy`, hex encoded. */
  policyHmac: string;
  /** Optional policy id echo from storage; checked against the rebuilt policy. */
  policyId?: string;
  /** Echo of the script type for forward-compatibility; only `'p2wsh'` today. */
  scriptType?: LedgerScriptType;
};

/** Inputs accepted by `displayWshSortedMultiAddress`. */
export type DisplayAddressInput = {
  /** Vault context — same keys + threshold used during policy registration. */
  vault: Omit<LedgerWalletPolicyInput, 'targetFingerprint'>;
  /**
   * Fingerprint of the Ledger signer selected in the UI. The adapter
   * refuses to display an address if a different Ledger is connected.
   */
  signerFingerprint: string;
  /** 32-byte HMAC returned by `registerLedgerWalletPolicy`, hex encoded. */
  policyHmac: string;
  /** Optional policy id echo from storage; checked against the rebuilt policy. */
  policyId?: string;
  /** Receive (`0`) or change (`1`) branch. */
  chain: 0 | 1;
  /** Non-negative address index on the selected branch. */
  index: number;
  /** Address already derived by the wallet UI, used as a strict post-flight check. */
  expectedAddress: string;
  /** Echo of the script type for forward-compatibility; only `'p2wsh'` today. */
  scriptType?: LedgerScriptType;
};

/** Successful Ledger address display payload. */
export type DisplayAddressResult = {
  /** Address returned by the Ledger Bitcoin app after on-device display. */
  address: string;
  /** Wallet-derived address the caller asked the device to verify. */
  expectedAddress: string;
  /** Receive (`0`) or change (`1`) branch that produced the address. */
  chain: 0 | 1;
  /** Address index shown on the device. */
  index: number;
  /** Master fingerprint the caller asked the Ledger to verify as. */
  signerFingerprint: string;
  /** Rebuilt policy id used for this display request. */
  policyId: string;
  /** Device descriptor; useful for success copy and support diagnostics. */
  device: LedgerDeviceInfo;
};

/** Successful signing payload. Mirrors the Trezor adapter result shape. */
export type SignPsbtResult = {
  /** Updated PSBT v2 base64 with the new partial signatures attached. */
  psbtBase64: string;
  /** Number of inputs the device actually signed. */
  signedInputCount: number;
  /** Master fingerprint the caller asked the Ledger to sign as. */
  requestedFingerprint: string;
  /** Master fingerprint proven by the returned partial signatures. */
  signedAsFingerprint: string;
  /**
   * Always false for Ledger: the adapter pre-checks the connected
   * device fingerprint before requesting signatures.
   */
  pivoted: false;
};

/** Device descriptor returned with every successful export. */
export type LedgerDeviceInfo = {
  /**
   * Product name resolved from the HID descriptor. Picks the marketing
   * name Ledger customers recognise ("Nano S Plus", "Stax", …) and falls
   * back to the generic "Ledger" chip when the descriptor is absent.
   */
  model: string;
  /**
   * Raw `productId` from the HID descriptor (hex integer, e.g. `0x5000`).
   * Kept so support diagnostics can pin down exactly which variant the
   * user paired without parsing vendor strings.
   */
  productId: number | null;
  /**
   * Name of the app currently running on the device. `"Bitcoin"` on
   * the happy path; `"BOLOS"` or some other string when the user is
   * still on the dashboard or in a different coin app.
   */
  appName: string;
  /** Version string of the running app (`"2.2.3"`), when readable. */
  appVersion: string;
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
   * public key are identical. `null` only if the SLIP-132 conversion
   * failed (malformed `xpub`).
   */
  xpubMultisig: string | null;
  /** Lowercase 8-character hex master fingerprint (BIP-380 identity). */
  masterFingerprint: string;
  /** Echo of the path that was exported. */
  derivationPath: string;
  /** Echo of the requested script type. */
  scriptType: LedgerScriptType;
  /** Device descriptor; useful for the "Ledger Nano X" chip on the dashboard. */
  device: LedgerDeviceInfo;
};

/**
 * Asylia-normalized failure modes. Every Ledger SDK / status-word error
 * is mapped to one of these so the UI can react with consistent copy
 * and never has to pattern-match on raw vendor strings.
 *
 * Kept intentionally parallel to `TrezorErrorCode` so the wallet UI's
 * recovery vocabulary is shared across both device families — the two
 * wizards use the same "Try again / Re-check environment / Update
 * firmware" affordances even though the underlying SDKs differ.
 */
export type LedgerErrorCode =
  | 'init_failed'
  | 'cancelled'
  | 'device_disconnected'
  | 'device_not_found'
  | 'device_in_use'
  | 'device_locked'
  | 'device_timeout'
  | 'app_not_open'
  | 'wrong_app'
  | 'wrong_device'
  | 'app_outdated'
  | 'firmware_too_old'
  | 'descriptor_unavailable'
  | 'invalid_path'
  | 'transport_unavailable'
  | 'permission_denied'
  | 'gesture_required'
  | 'unknown';

export type LedgerAdapterError = {
  code: LedgerErrorCode;
  message: string;
  /** The original SDK code / status word, kept for diagnostics. Never shown to the user. */
  cause?: string;
};

/** Result discriminant used by every exported async function. */
export type AdapterResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: LedgerAdapterError };
