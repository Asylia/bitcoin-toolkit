/**
 * Elliptic-curve provider for `bip32` and `bitcoinjs-lib`.
 *
 * Both libraries delegate any operation that needs the secp256k1
 * curve (BIP-32 derivation, x-only pubkey tweaking for Taproot, …)
 * to a pluggable provider that the host application has to wire in.
 * We use `@bitcoinerlab/secp256k1` here because it is pure JavaScript
 * (no WASM loader, no native binary) and therefore works in every
 * browser and bundler we care about without runtime gymnastics —
 * see the note in the bitcoinjs-lib README about WASM-related
 * compatibility issues.
 *
 * The performance cost (slower than the WASM `tiny-secp256k1`) only
 * shows up for high-volume taproot signing, which Asylia does not do
 * client-side; descriptor derivation does at most one EC point
 * compression per address.
 */
import * as ecc from '@bitcoinerlab/secp256k1';
import { BIP32Factory, type BIP32API } from 'bip32';
import { initEccLib } from 'bitcoinjs-lib';

// `bitcoinjs-lib` lazily resolves its ECC pointer the first time a
// caller touches a Taproot-aware codepath (e.g. `address.toOutputScript`
// on a `bc1p…` recipient). Without this side-effect call the library
// throws "No ECC Library provided" at runtime — a confusing error to
// surface from the SendModal when the operator pastes a P2TR address.
// Calling it at module load time is safe (idempotent) and ensures
// every public entry point of `@asylia/btc-core` finds the curve
// already wired in: every consumer either reaches `bip32()` directly
// or imports a module that does (`psbt/build.ts`, `address/derive.ts`),
// so this init runs before any Bitcoin primitive is touched.
initEccLib(ecc);

let cached: BIP32API | null = null;

/**
 * Lazily-built singleton BIP-32 factory. Re-using one factory across the
 * package keeps every consumer pinned to the same ECC implementation
 * and avoids the (small but non-zero) cost of re-validating the
 * provider on each call.
 */
export function bip32(): BIP32API {
  if (cached === null) cached = BIP32Factory(ecc);
  return cached;
}
