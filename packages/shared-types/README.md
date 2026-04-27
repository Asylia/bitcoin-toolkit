# @asylia/shared-types

**Status:** scaffolded, not yet implemented.

Shared domain types for the Asylia platform. Types-only package — no
runtime code. Every consumer imports from here so the type model is
identical across the wallet, the BTC core, the hardware adapters, and any
future server tooling.

## Why a separate package

- **One vocabulary.** A `Vault`, a `Signer`, a `PsbtProposal`,
  a `DerivationPath`, an `Amount` should have exactly one definition the
  whole platform agrees on.
- **No runtime cost.** Pure types vanish at build time; consumers pay
  nothing in shipped JavaScript.
- **Auditable contract.** When the wallet, the BTC core, and the hardware
  adapters all import from one types package, an auditor can verify the
  shapes flowing across each boundary by reading a single file tree.

## Why MIT

The types describe the public boundary of every other auditable Asylia
package, so they share that licensing posture. MIT matches the rest of the
crypto tooling ecosystem.

## Public distribution

This package is part of the public `Asylia/bitcoin-toolkit` export. Changes
merged into the private monorepo are synchronized there for audit and review.

## Planned scope

Borrowed from the existing Asylia reference codebases (see the root README
"Reuse map" section), the package will host:

- `vault.ts` — `Vault`, `VaultStatus`, `VaultMetadata`.
- `signer.ts` — `Signer`, `SignerKind` (Trezor, Ledger, ...),
  `SignerCapabilities`.
- `descriptor.ts` — `Descriptor`, `DescriptorPolicy` (`2-of-3`, ...),
  `DescriptorChecksum`.
- `derivation.ts` — `DerivationPath`, `Fingerprint`, `Xpub`.
- `psbt.ts` — `PsbtProposal`, `PsbtStatus`, `PsbtTimelineEvent`.
- `amount.ts` — branded `Sats` / `Btc` types so unit confusion is a
  compile-time error.
- `errors.ts` — discriminated `AsyliaError` union surfaced across
  boundaries.

## Not in scope

- Runtime functions (those live in `@asylia/btc-core` and the adapters).
- Any third-party SDK shapes — those stay inside the adapter that owns
  them.

## License

MIT — see [`LICENSE`](./LICENSE).
