/**
 * `@asylia/shared-types` — domain types shared across the Asylia platform.
 *
 * Discriminated unions and narrow interfaces for the first-class Asylia
 * domain objects:
 *
 *   - vault, signer, cosigner
 *   - descriptor, derivation path, fingerprint
 *   - UTXO, address, amount (sats vs btc)
 *   - PSBT proposal, status transitions
 *   - audit log entry, timeline event
 *
 * Every consumer (`@asylia/wallet`, `@asylia/btc-core`, `@asylia/hw-*`,
 * future server tools, future Capacitor signer) imports from this package
 * so the type model stays consistent across boundaries.
 */

export const ASYLIA_SHARED_TYPES_VERSION = "0.0.0-dev" as const;
