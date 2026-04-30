/**
 * `@asylia/hw-ledger` — Ledger adapter for the Asylia wallet.
 *
 * Wraps `@ledgerhq/ledger-bitcoin` (the official Bitcoin app v2+ client) and
 * `@ledgerhq/hw-transport-webhid` behind an Asylia-shaped adapter so
 * the wallet SPA never imports a LedgerHQ package directly. The
 * package is the single audited boundary between the wallet code and
 * the vendor SDKs.
 *
 * Public API surface (everything else is private to this package):
 *
 *   - `initLedger(options?)` — idempotent pre-flight (secure-origin +
 *     WebHID availability guard).
 *   - `exportLedgerRoot({ derivationPath, scriptType })` — single
 *     user-facing flow that returns `{ xpub, masterFingerprint, device }`
 *     after opening a WebHID session, verifying the running Bitcoin
 *     app version, and reading the BIP-48 multisig root.
 *   - `buildLedgerWalletPolicy(input)` /
 *     `registerLedgerWalletPolicy(input)` — deterministic multisig
 *     wallet-policy preview + on-device approval, returning the
 *     policy HMAC Asylia must persist for future Ledger signing.
 *   - `signWshSortedMultiPsbt(input)` — reuses a stored policy HMAC
 *     to collect on-device Ledger signatures and merge them into a
 *     PSBT.
 *   - `detectLedgerEnvironment()` — pure probe that reports WebHID
 *     support, browser family, and whether the user has already
 *     authorised a Ledger on this origin.
 *   - `subscribeToLedgerEvents(handler)` — live stream combining raw
 *     `navigator.hid.onconnect/ondisconnect` events with synthetic
 *     `app_connected` / `awaiting_button` / `finalising` beacons emitted by the
 *     export flow.
 *   - Public types covering inputs, results, and the normalised error
 *     shape the wallet UI renders.
 *
 * Audits should focus on this package, not on the wallet SPA,
 * because every byte of the device wire-protocol that touches the
 * user's funds passes through here.
 */

export { initLedger, type LedgerInitOptions } from './init';
export { exportLedgerRoot } from './xpub';
export { displayWshSortedMultiAddress } from './address';
export { signWshSortedMultiPsbt } from './sign';
export {
  buildLedgerWalletPolicy,
  registerLedgerWalletPolicy,
} from './policy';
export {
  detectLedgerEnvironment,
  recommendationFromEnvironment,
  type LedgerBrowserFamily,
  type LedgerEnvironment,
  type LedgerRecommendation,
} from './environment';
export {
  subscribeToLedgerEvents,
  emitSyntheticLedgerEvent,
  type LiveDeviceDescriptor,
  type LiveDevicePhase,
  type LiveLedgerEvent,
  type LiveLedgerEventHandler,
  type UnsubscribeFn,
} from './events';
export {
  findAuthorisedLedgerDevice,
  hasAuthorisedLedgerDevice,
  friendlyProductName,
  type LedgerHidInfo,
} from './transport';
export type {
  AdapterResult,
  ExportRootInput,
  ExportRootResult,
  LedgerAdapterError,
  LedgerCoin,
  LedgerDeviceInfo,
  LedgerErrorCode,
  LedgerScriptType,
  LedgerWalletPolicyDetails,
  LedgerWalletPolicyInput,
  LedgerWalletPolicyKey,
  RegisterLedgerWalletPolicyResult,
  DisplayAddressInput,
  DisplayAddressResult,
  SignPsbtInput,
  SignPsbtResult,
} from './types';

export const ASYLIA_HW_LEDGER_VERSION = '0.1.0-dev' as const;
