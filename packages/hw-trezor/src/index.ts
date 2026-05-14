/**
 * `@asylia/hw-trezor` — Trezor Connect adapter for the Asylia wallet.
 *
 * Public API surface (everything else is private to this package):
 *
 *   - `initTrezor(manifest)` — idempotent SDK bootstrap.
 *   - `exportTrezorRoot({ derivationPath, scriptType })` — single
 *     user-facing flow that returns `{ xpub, masterFingerprint, device }`
 *     after one device prompt.
 *   - `signWshSortedMultiPsbt({ psbtBase64, vault, signerFingerprint })`
 *     — sign a PSBT v2 spend produced by `@asylia/btc-core`. The
 *     adapter handles the PSBT → Trezor protobuf translation,
 *     drives the device, and merges the partial signatures back into
 *     the PSBT.
 *   - Public types covering inputs, results, and the normalized error
 *     shape the wallet UI renders.
 *
 * Wraps `@trezor/connect-web`. Audits should focus on this package, not
 * on the wallet SPA, because every byte of the device wire-protocol that
 * touches the user's funds passes through here.
 */

export { initTrezor, type InitOptions } from './init';
export { exportTrezorRoot } from './xpub';
export { displayWshSortedMultiAddress } from './address';
export {
  signAuthProofWithTrezor,
  signAuthChallengeWithTrezor,
  type SignAuthProofInput,
  type SignAuthProofResult,
  type SignAuthChallengeInput,
  type SignAuthChallengeResult,
} from './auth';
export {
  signWshSortedMultiPsbt,
  type SignPsbtInput,
  type SignPsbtResult,
  type SignVault,
} from './sign';
export {
  detectTrezorEnvironment,
  recommendationFromEnvironment,
  type TrezorBrowserFamily,
  type TrezorEnvironment,
  type TrezorRecommendation,
} from './environment';
export {
  subscribeToTrezorEvents,
  type LiveDeviceDescriptor,
  type LiveDevicePhase,
  type LiveTrezorEvent,
  type LiveTrezorEventHandler,
  type UnsubscribeFn,
} from './events';
export type {
  AdapterResult,
  DisplayAddressInput,
  DisplayAddressResult,
  ExportRootInput,
  ExportRootResult,
  TrezorAdapterError,
  TrezorCoin,
  TrezorDeviceInfo,
  TrezorErrorCode,
  TrezorManifest,
  TrezorScriptType,
} from './types';

export const ASYLIA_HW_TREZOR_VERSION = '0.1.0' as const;
